/**
 * Antigravity 套餐额度取数（Cloud Code Assist quota summary）。
 *
 * 数据面（用户 2026-10-16 明确选择 A 方案，放宽「bundle 不读 OAuth 凭据」约束）：
 * 1. 读官方 CLI 登录态 `~/.gemini/antigravity-cli/antigravity-oauth-token`；
 * 2. access token 过期时用其中的 refresh_token 向 Google OAuth token 端点换新
 *    （client 元数据取自官方二进制或 AGY_OAUTH_CLIENT_ID/SECRET 环境变量）；
 * 3. 调用 Cloud Code Assist 的 `loadCodeAssist` → `retrieveUserQuotaSummary`。
 *
 * 边界（保持克制）：
 * - **只读凭据，绝不写回**：刷新出的 access token 只在内存里用，不改官方登录文件；
 * - 任何错误消息在进入快照/日志前都过 `redactSensitiveText`，token 材料一律不出现在
 *   返回值、错误文本与诊断里；
 * - 失败不抛穿线，而是返回 `status: 'error'` 的快照，让 UI 显示可读原因。
 *
 * API 形态取自官方协议与公开实现的**事实**（端点、字段名、0..1 的
 * remainingFraction），代码为本项目原创实现。
 */
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redactSensitiveText } from './redact.js'
import { resolveInstallRoot, versionCachePaths, DEFAULT_ACP_SERVER_VERSION } from './binary.js'
import { agyCliCandidates } from './agy-cli.js'

/** Cloud Code Assist 内部端点前缀（方法以 `:method` 拼接，POST JSON）。 */
export const CODE_ASSIST_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal'
/** Google OAuth 2.0 token 端点（换发 access token）。 */
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
/** 官方 CLI 登录态文件（只读）。 */
export const TOKEN_SUBPATH = ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'] as const

/** 提前多少毫秒视为「将过期」并触发换发。 */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000
/** 额度快照的内存缓存时长（毫秒）。 */
export const QUOTA_CACHE_MS = 300_000
/**
 * 单次 HTTP 取数（换发 token 与 Cloud Code Assist 请求）的上限（毫秒）。
 *
 * 缺这条会让「代理不通 / 网络挂起」变成永久失败：`quota-remote` 把并发的
 * `read()` 合并到同一个在途 promise 上，挂死的请求会让额度药丸一直停在
 * 「读取中」，连手动刷新也救不回来（它只是在等同一个 promise）。
 */
export const QUOTA_HTTP_TIMEOUT_MS = 20_000

export type QuotaErrorCode =
  | 'token-missing'
  | 'token-expired'
  | 'refresh-unavailable'
  | 'refresh-failed'
  | 'request-failed'
  | 'bad-response'

/** 一个额度窗口（如「5 小时」「每周」）。 */
export interface QuotaBucket {
  name: string
  description?: string
  /** 窗口语义标识（官方字段 window，如 `5h`）。 */
  window?: string
  /** 剩余比例，0..1；官方未报告时缺省。 */
  remainingFraction?: number
  /** 剩余百分比（remainingFraction * 100，两位小数）。 */
  remainingPct?: number
  /** 配额重置时间（ISO 8601）。 */
  resetTime?: string
  disabled: boolean
}

/** 一组额度（如「Gemini 模型」组）。 */
export interface QuotaGroup {
  name: string
  description?: string
  buckets: QuotaBucket[]
}

/** 官方 AI Credits 独立快照；未知或失败绝不伪装成零余额。 */
export interface CreditsSnapshot {
  status: 'ok' | 'unavailable' | 'error'
  updatedAt: string
  remainingCredits?: number
  planName?: string
  stale?: boolean
  staleReason?: string
  error?: { code: 'cli-unavailable' | 'no-credit-info' | 'unsupported' | 'request-failed' | 'bad-response'; message: string }
}

/** 额度快照：成功带 groups/plan，失败带 error；credits 有独立状态。 */
export interface QuotaSnapshot {
  status: 'ok' | 'error'
  /** 取数时间（ISO 8601）。 */
  updatedAt: string
  /** 本次刷新失败，展示的是上一次成功的数据（`staleReason` 说明失败原因）。 */
  stale?: boolean
  staleReason?: string
  /** 订阅档位名（loadCodeAssist 的 paidTier/currentTier.name）。 */
  plan?: string
  groups: QuotaGroup[]
  credits?: CreditsSnapshot
  error?: { code: QuotaErrorCode; message: string }
}

/** 登录态文件里我们只认这几项，其余（id_token 等）一律不读不用。 */
export interface QuotaTokenState {
  accessToken?: string
  refreshToken?: string
  expiry?: string
}

/** OAuth 客户端元数据（官方安装型客户端的公开标识，不是用户凭据）。 */
export interface OAuthClientMeta {
  clientId: string
  clientSecret: string
}

/** 取数依赖面：全部可注入，测试用假实现，不碰真实网络与真实凭据。 */
export interface QuotaDeps {
  fetchImpl?: typeof fetch
  readFileImpl?: (path: string) => Promise<string>
  env?: Readonly<Record<string, string | undefined>>
  now?: () => number
  homedir?: () => string
  cacheDir?: string
  /** 可执行文件安装根；与模型/额度的数据 cacheDir 分开。 */
  installRoot?: string
  /** 设置中显式选择的官方 CLI 路径，优先于环境变量和 PATH。 */
  cliPath?: string
  /** 候选官方二进制路径（用于提取 OAuth client 元数据）。 */
  binaryPaths?: readonly string[]
  /**
   * 目标 ACP server 版本（用于在缓存目录里定位已解压的官方二进制）。
   * 缺省为 {@link DEFAULT_ACP_SERVER_VERSION}。
   */
  acpVersion?: string
  baseUrl?: string
  tokenUrl?: string
  /** 单次 HTTP 请求上限（毫秒）；缺省 {@link QUOTA_HTTP_TIMEOUT_MS}。 */
  httpTimeoutMs?: number
}

function defaultReadFile(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

/**
 * 读官方二进制用于正则提取 client 元数据：按 latin1 解码。
 * 目标串全是 ASCII，latin1 逐字节映射，结果与 utf8 等价；而 utf8 解码 200MB 级
 * 二进制要 ~700ms（实测），latin1 只要 ~60ms。
 */
function defaultReadBinary(path: string): Promise<string> {
  return readFile(path, 'latin1')
}

/**
 * 本次请求实际生效的超时（毫秒）。非正数视为「未设置」并回落到默认值。
 *
 * 不做「传 0 就等于关掉超时」的开关：关掉后并发 read() 又会合并到一个挂死的
 * 在途 promise 上，额度药丸永久停在读取中——那正是这条超时要修的故障。
 */
function effectiveTimeoutMs(deps: QuotaDeps): number {
  const configured = deps.httpTimeoutMs
  return configured !== undefined && configured > 0 ? configured : QUOTA_HTTP_TIMEOUT_MS
}

/**
 * 取数请求的超时信号。宿主 Node 都带 `AbortSignal.timeout`；测试环境的
 * fetch 替身不接信号时也不会受影响（它自己立即返回）。
 */
function timeoutSignal(deps: QuotaDeps): AbortSignal {
  return AbortSignal.timeout(effectiveTimeoutMs(deps))
}

/** 毫秒转人类可读时长：不足 1 秒时保留毫秒，避免出现「超过 0 秒」。 */
function formatTimeout(ms: number): string {
  return ms >= 1_000 ? `${Math.round(ms / 1_000)} 秒` : `${ms} 毫秒`
}

/** 超时与网络异常都归一成可读文本；不含请求 URL（可能带 userinfo）。 */
function describeRequestError(method: string, error: unknown, deps: QuotaDeps): string {
  // `AbortSignal.timeout()` 抛的是 TimeoutError；AbortError 则可能来自调用方主动
  // 取消。两者都不该报成「超时」，否则排查时会去查网络而漏掉真正的取消来源。
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `${method} 请求超过 ${formatTimeout(effectiveTimeoutMs(deps))}未完成；请检查网络或代理设置`
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return `${method} 请求在完成前被中止`
  }
  return `请求 ${method} 失败：${describeError(error)}`
}

/** 解析登录态文件：兼容嵌套 `token.{...}` 与平铺两种历史形态。 */
export function parseTokenState(raw: unknown): QuotaTokenState {
  const root = isRecord(raw) ? raw : {}
  const token = isRecord(root.token) ? root.token : root
  const pick = (key: string): string | undefined => {
    const value = token[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const outer = (key: string): string | undefined => {
    const value = root[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  // 平铺形态下 token === root，`pick` 已经覆盖外层；再去查一次是纯重复。
  // 三个字段统一走这条路径，否则只有 accessToken 被优化、另两个仍会重复查询。
  const readOuter = (key: string): string | undefined => (token === root ? undefined : outer(key))
  const first = (nested: string, flat: string): string | undefined => pick(nested) ?? readOuter(flat)
  return {
    accessToken: pick('access_token') ?? pick('AccessToken') ?? readOuter('access_token') ?? readOuter('AccessToken'),
    refreshToken: first('refresh_token', 'refresh_token'),
    expiry: first('expiry', 'expiry'),
  }
}

/** 是否还可直接使用（缺 expiry 视为不过期，由调用方按请求失败再兜底）。 */
export function isTokenUsable(state: QuotaTokenState, nowMs: number, marginMs = TOKEN_EXPIRY_MARGIN_MS): boolean {
  if (!state.accessToken) return false
  if (!state.expiry) return true
  const expiresAt = Date.parse(state.expiry)
  if (Number.isNaN(expiresAt)) return true
  return expiresAt - nowMs > marginMs
}

/** 从官方二进制文本里提取 client 元数据（正则即时编译匹配，不留模块级全局状态）；取不到返回 undefined（不猜值）。 */
export function parseOAuthClientFromBinary(text: string): OAuthClientMeta | undefined {
  const ids = text.match(/\d+-[a-z0-9]+\.apps\.googleusercontent\.com/g) ?? []
  const secrets = text.match(/GOCSPX-[A-Za-z0-9_-]{28}/g) ?? []
  if (ids.length === 0 || secrets.length === 0) return undefined
  // 与官方 CLI 同源的最后一条 client id 最可能是当前在用的。
  const clientId = ids[ids.length - 1] as string
  // 多份元数据同时存在时必须按「相邻出现」配对，不能固定取第一条 secret：
  // 那样配出来的 id/secret 可能来自不同的 client，换发会被 OAuth 端点拒绝。
  // 单份元数据时（实测官方 CLI 就是这种）本规则退化为直接命中。
  const anchor = text.lastIndexOf(clientId)
  // 同一 secret 在二进制里可能出现多次（多个 client 共用或打包重复）：只取首次
  // 出现会落到 anchor 之前，让本该配上的那份被误判成「在 id 之前」。因此先找
  // anchor 之后的出现位置，找不到再回退到首次出现。
  const positions = secrets.map((secret) => {
    const afterAnchor = text.indexOf(secret, anchor + 1)
    return { secret, at: afterAnchor >= 0 ? afterAnchor : text.indexOf(secret) }
  })
  // 同一份元数据里 secret 紧跟 id；多份时按文档顺序取该 id 之后的第一个 secret，
  // 之后没有了才回退到它之前的最后一个（极少数只写 secret 的打包形态）。
  const after = positions.filter((entry) => entry.at > anchor).sort((a, b) => a.at - b.at)[0]
  const chosen = after ?? positions.filter((entry) => entry.at >= 0).sort((a, b) => b.at - a.at)[0]
  return chosen === undefined ? undefined : { clientId, clientSecret: chosen.secret }
}

/**
 * 解析 OAuth client 元数据：环境变量优先，其次扫描官方二进制。
 * 两者都拿不到就返回 undefined —— 由调用方报「无法换发 token」，绝不编造 client。
 */
export async function resolveOAuthClient(deps: QuotaDeps = {}): Promise<OAuthClientMeta | undefined> {
  const env = deps.env ?? process.env
  const clientId = env.AGY_OAUTH_CLIENT_ID?.trim()
  const clientSecret = env.AGY_OAUTH_CLIENT_SECRET?.trim()
  if (clientId && clientSecret) return { clientId, clientSecret }
  const readFileImpl = deps.readFileImpl ?? defaultReadBinary
  for (const candidate of await candidateBinaryPaths(deps)) {
    try {
      const text = await readFileImpl(candidate)
      const meta = parseOAuthClientFromBinary(text)
      if (meta) return meta
    } catch {
      // 读不到就试下一个候选；提取失败不是致命错误。
    }
  }
  return undefined
}

/** 官方二进制候选：缓存里的 agy_acp_server + 本机官方 agy CLI。
 *
 * 实测（2026-10-16，本机）：OAuth client 元数据只随 **agy CLI** 发行，
 * `agy_acp_server.exe` 里没有；因此两个来源都要扫，扫不到就报
 * `refresh-unavailable`，绝不猜 client。
 */
async function candidateBinaryPaths(deps: QuotaDeps): Promise<string[]> {
  if (deps.binaryPaths) return [...deps.binaryPaths]
  const home = (deps.homedir ?? homedir)()
  const env = deps.env ?? process.env
  const installRoot = deps.installRoot ?? resolveInstallRoot(env, process.platform, () => home)
  const { extractDir } = versionCachePaths(installRoot, deps.acpVersion ?? DEFAULT_ACP_SERVER_VERSION)
  const names = process.platform === 'win32'
    ? ['agy.exe', 'agy_acp_server.exe', 'agy-acp-server.exe']
    : ['agy', 'agy_acp_server.par', 'agy_acp_server', 'agy-acp-server']
  // 官方 agy CLI 才携带 client 元数据，排最前；缓存里的 ACP server 只是兜底
  // （每次白扫它要多读 80MB+）。
  const out = [...agyCliCandidates(env, home, deps.cliPath)]
  if (env.AGY_ACP_BIN?.trim()) out.push(env.AGY_ACP_BIN.trim())
  const scan = async (directory: string, depth: number): Promise<void> => {
    try {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && names.includes(entry.name)) out.push(join(directory, entry.name))
        else if (entry.isDirectory() && depth < 2) await scan(join(directory, entry.name), depth + 1)
      }
    } catch {
      // 缓存目录不存在：跳过。
    }
  }
  await scan(extractDir, 0)
  return [...new Set(out)]
}

/** 用 refresh_token 换发 access_token（只在内存中使用，不写回登录文件）。 */
export async function refreshAccessToken(
  state: QuotaTokenState,
  client: OAuthClientMeta,
  deps: QuotaDeps = {},
): Promise<QuotaTokenState> {
  if (!state.refreshToken) {
    throw new QuotaError('token-expired', '登录态里没有 refresh_token，无法换发')
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const tokenUrl = deps.tokenUrl ?? OAUTH_TOKEN_URL
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: state.refreshToken,
  })
  let response: Response
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: timeoutSignal(deps),
    })
  } catch (error) {
    // 不把 tokenUrl 带进消息：URL 本身不带凭据，但错误文本只保留可行动信息。
    throw new QuotaError('refresh-failed', describeRequestError('换发 access token', error, deps))
  }
  if (!response.ok) {
    throw new QuotaError('refresh-failed', `换发 access token 失败（HTTP ${response.status}）`, response.status)
  }
  const payload = await readJson(response)
  const issued = isRecord(payload) ? payload : {}
  const accessToken = typeof issued.access_token === 'string' ? issued.access_token : undefined
  if (!accessToken) {
    throw new QuotaError('refresh-failed', '换发响应里没有 access_token')
  }
  const expiresIn = typeof issued.expires_in === 'number' ? issued.expires_in : 3600
  return {
    accessToken,
    refreshToken: typeof issued.refresh_token === 'string' ? issued.refresh_token : state.refreshToken,
    expiry: new Date((deps.now ?? Date.now)() + expiresIn * 1000).toISOString(),
  }
}

/** 带错误码的取数失败；message 里不含凭据。 */
export class QuotaError extends Error {
  readonly code: QuotaErrorCode
  /**
   * 上游 HTTP 状态码（换发 token 与 Cloud Code Assist 请求）。
   *
   * 401/403 后的「换发再试一次」必须按这个字段判断，不能去匹配 message：
   * 文案随时会改，改一次就静默丢掉重试。非 HTTP 失败（网络、JSON、缺字段）
   * 为 undefined。
   */
  readonly status: number | undefined

  constructor(code: QuotaErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'QuotaError'
    this.code = code
    this.status = status
  }
}

/** `loadCodeAssist` 响应里我们只认项目 id 与档位名。 */
export interface CodeAssistProject {
  projectId: string
  plan?: string
}

/** 拉取 Code Assist 项目与订阅档位。 */
export async function loadCodeAssist(accessToken: string, deps: QuotaDeps = {}): Promise<CodeAssistProject> {
  const payload = await postCodeAssist('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }, accessToken, deps)
  const projectId = typeof payload.cloudaicompanionProject === 'string' ? payload.cloudaicompanionProject : ''
  if (!projectId) {
    throw new QuotaError('bad-response', 'loadCodeAssist 未返回 cloudaicompanionProject')
  }
  const tiers = [payload.paidTier, payload.currentTier]
  const plan = tiers
    .map((tier) => (isRecord(tier) && typeof tier.name === 'string' ? tier.name : undefined))
    .find((name) => name)
  return { projectId, ...(plan === undefined ? {} : { plan }) }
}

/** 解析额度汇总响应（groups/buckets）。 */
export function parseQuotaSummary(raw: unknown): QuotaGroup[] {
  const root = isRecord(raw) ? raw : {}
  const rawGroups = Array.isArray(root.groups) ? root.groups : []
  return rawGroups.filter(isRecord).map((group) => {
    const rawBuckets = Array.isArray(group.buckets) ? group.buckets : []
    return {
      name: firstString(group.displayName) ?? '额度',
      ...(firstString(group.description) === undefined ? {} : { description: firstString(group.description) }),
      buckets: rawBuckets.filter(isRecord).map((bucket) => {
        const fraction = normalizeFraction(bucket.remainingFraction)
        return {
          name: firstString(bucket.displayName) ?? firstString(bucket.bucketId) ?? '额度',
          ...(firstString(bucket.description) === undefined ? {} : { description: firstString(bucket.description) }),
          ...(firstString(bucket.window) === undefined ? {} : { window: firstString(bucket.window) }),
          ...(fraction === undefined ? {} : { remainingFraction: fraction, remainingPct: Math.round(fraction * 10000) / 100 }),
          ...(firstString(bucket.resetTime) === undefined ? {} : { resetTime: firstString(bucket.resetTime) }),
          disabled: bucket.disabled === true,
        }
      }),
    }
  })
}

/** 取一份额度快照（内存缓存 + 过期 token 换发 + 401/403 重试一次）。 */
export async function fetchQuotaSnapshot(
  cache: { value?: QuotaSnapshot; at?: number },
  deps: QuotaDeps = {},
): Promise<QuotaSnapshot> {
  const now = deps.now ?? Date.now
  const cached = cache.value
  if (cached && cache.at !== undefined && now() - cache.at < QUOTA_CACHE_MS && cached.status === 'ok') {
    return cached
  }
  const snapshot = await fetchQuotaSnapshotUncached(deps)
  cache.value = snapshot
  cache.at = now()
  return snapshot
}

async function fetchQuotaSnapshotUncached(deps: QuotaDeps): Promise<QuotaSnapshot> {
  const now = deps.now ?? Date.now
  const stamp = () => new Date(now()).toISOString()
  try {
    const readFileImpl = deps.readFileImpl ?? defaultReadFile
    const home = (deps.homedir ?? homedir)()
    const tokenPath = join(home, ...TOKEN_SUBPATH)
    let state: QuotaTokenState
    try {
      state = parseTokenState(JSON.parse(await readFileImpl(tokenPath)))
    } catch {
      return failure(stamp(), 'token-missing', '读不到官方 CLI 登录态（antigravity-oauth-token）')
    }
    if (!state.accessToken && !state.refreshToken) {
      return failure(stamp(), 'token-missing', '官方 CLI 登录态里没有可用 token，请先在 Antigravity 登录')
    }
    if (!isTokenUsable(state, now())) {
      const client = await resolveOAuthClient(deps)
      if (!client) {
        return failure(stamp(), 'refresh-unavailable', 'access token 已过期且无法取得 OAuth client 元数据（可设 AGY_OAUTH_CLIENT_ID/SECRET）')
      }
      try {
        state = await refreshAccessToken(state, client, deps)
      } catch (error) {
        return failure(stamp(), 'refresh-failed', describeError(error))
      }
    }
    const accessToken = state.accessToken as string
    try {
      const project = await loadCodeAssist(accessToken, deps)
      const summary = await postCodeAssist('retrieveUserQuotaSummary', { project: project.projectId }, accessToken, deps)
      return {
        status: 'ok',
        updatedAt: stamp(),
        ...(project.plan === undefined ? {} : { plan: project.plan }),
        groups: parseQuotaSummary(summary),
      }
    } catch (error) {
      // 401/403：token 被上游拒绝（可能刚换发也失效），换发一次再试。
      if (error instanceof QuotaError && error.code === 'request-failed'
        && (error.status === 401 || error.status === 403)) {
        return retryAfterRefresh(state, stamp, deps)
      }
      return failure(stamp(), errorCodeOf(error), describeError(error))
    }
  } catch (error) {
    return failure(stamp(), errorCodeOf(error), describeError(error))
  }
}

async function retryAfterRefresh(
  state: QuotaTokenState,
  stamp: () => string,
  deps: QuotaDeps,
): Promise<QuotaSnapshot> {
  try {
    const client = await resolveOAuthClient(deps)
    if (!client) return failure(stamp(), 'refresh-unavailable', '请求被拒（401/403）且无法取得 OAuth client 元数据')
    const refreshed = await refreshAccessToken(state, client, deps)
    const project = await loadCodeAssist(refreshed.accessToken as string, deps)
    const summary = await postCodeAssist(
      'retrieveUserQuotaSummary',
      { project: project.projectId },
      refreshed.accessToken as string,
      deps,
    )
    return {
      status: 'ok',
      updatedAt: stamp(),
      ...(project.plan === undefined ? {} : { plan: project.plan }),
      groups: parseQuotaSummary(summary),
    }
  } catch (error) {
    return failure(stamp(), errorCodeOf(error), describeError(error))
  }
}

async function postCodeAssist(
  method: string,
  payload: Record<string, unknown>,
  accessToken: string,
  deps: QuotaDeps,
): Promise<Record<string, unknown>> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const base = (deps.baseUrl ?? CODE_ASSIST_BASE_URL).replace(/\/+$/, '')
  let response: Response
  try {
    response = await fetchImpl(`${base}:${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: timeoutSignal(deps),
    })
  } catch (error) {
    throw new QuotaError('request-failed', describeRequestError(method, error, deps))
  }
  if (!response.ok) {
    throw new QuotaError('request-failed', `${method} 失败（HTTP ${response.status}）`, response.status)
  }
  const body = await readJson(response)
  return isRecord(body) ? body : {}
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new QuotaError('bad-response', '响应不是合法 JSON')
  }
}

function failure(updatedAt: string, code: QuotaErrorCode, message: string): QuotaSnapshot {
  return { status: 'error', updatedAt, groups: [], error: { code, message: redactSensitiveText(message) } }
}

function errorCodeOf(error: unknown): QuotaErrorCode {
  return error instanceof QuotaError ? error.code : 'request-failed'
}

function describeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeFraction(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < 0 || value > 1) return undefined
  return value
}
