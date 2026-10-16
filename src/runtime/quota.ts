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
import { resolveCacheDir, versionCachePaths, DEFAULT_ACP_SERVER_VERSION } from './binary.js'

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

/** 额度快照：成功带 groups/plan，失败带 error，二者不混用。 */
export interface QuotaSnapshot {
  status: 'ok' | 'error'
  /** 取数时间（ISO 8601）。 */
  updatedAt: string
  /** 订阅档位名（loadCodeAssist 的 paidTier/currentTier.name）。 */
  plan?: string
  groups: QuotaGroup[]
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
  /** 候选官方二进制路径（用于提取 OAuth client 元数据）。 */
  binaryPaths?: readonly string[]
  baseUrl?: string
  tokenUrl?: string
}

function defaultReadFile(path: string): Promise<string> {
  return readFile(path, 'utf8')
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
  return {
    accessToken: pick('access_token') ?? pick('AccessToken') ?? outer('access_token') ?? outer('AccessToken'),
    refreshToken: pick('refresh_token') ?? outer('refresh_token'),
    expiry: pick('expiry') ?? outer('expiry'),
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

/** 官方二进制里内嵌的安装型 OAuth 客户端元数据（公开标识）。 */
const CLIENT_ID_PATTERN = /\d+-[a-z0-9]+\.apps\.googleusercontent\.com/g
const CLIENT_SECRET_PATTERN = /GOCSPX-[A-Za-z0-9_-]{28}/g

/** 从官方二进制文本里提取 client 元数据；取不到返回 undefined（不猜值）。 */
export function parseOAuthClientFromBinary(text: string): OAuthClientMeta | undefined {
  const ids = text.match(CLIENT_ID_PATTERN) ?? []
  const secrets = text.match(CLIENT_SECRET_PATTERN) ?? []
  // 与官方 CLI 同源的最后一条 client id 最可能是当前在用的；secret 只有一个候选即用。
  for (const clientId of [...ids].reverse()) {
    for (const clientSecret of secrets) return { clientId, clientSecret }
  }
  return undefined
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
  const readFileImpl = deps.readFileImpl ?? defaultReadFile
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
  const cacheDir = deps.cacheDir ?? resolveCacheDir({ DSH_HOME: env.DSH_HOME }, deps.homedir)
  const { extractDir } = versionCachePaths(cacheDir, DEFAULT_ACP_SERVER_VERSION)
  const names = process.platform === 'win32'
    ? ['agy_acp_server.exe', 'agy.exe']
    : ['agy_acp_server', 'agy']
  const out: string[] = []
  try {
    for (const entry of await readdir(extractDir)) {
      if (names.includes(entry)) out.push(join(extractDir, entry))
    }
  } catch {
    // 缓存目录不存在：跳过。
  }
  const localAppData = env.LOCALAPPDATA
  if (localAppData && localAppData.trim().length > 0) out.push(join(localAppData, 'agy', 'bin', 'agy.exe'))
  out.push(join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'))
  out.push(join(home, '.local', 'bin', 'agy'))
  out.push(join(home, 'bin', 'agy'))
  return out
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
  const response = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) {
    throw new QuotaError('refresh-failed', `换发 access token 失败（HTTP ${response.status}）`)
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
  constructor(code: QuotaErrorCode, message: string) {
    super(message)
    this.name = 'QuotaError'
    this.code = code
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
      if (error instanceof QuotaError && error.code === 'request-failed' && error.message.includes('HTTP 401')) {
        return retryAfterRefresh(state, stamp, deps)
      }
      if (error instanceof QuotaError && error.code === 'request-failed' && error.message.includes('HTTP 403')) {
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
    })
  } catch (error) {
    throw new QuotaError('request-failed', `请求 ${method} 失败：${describeError(error)}`)
  }
  if (!response.ok) {
    throw new QuotaError('request-failed', `${method} 失败（HTTP ${response.status}）`)
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
