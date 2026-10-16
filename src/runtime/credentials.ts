/**
 * 官方 ACP server 的登录态导入（`~/.gemini/antigravity-acp/`）。
 *
 * ## 为什么由本插件准备这两个文件
 *
 * 官方 server 自带的登录方式是浏览器 OAuth（ACP `authenticate` + 本机回调）。
 * 用户明确要求「不要拉起登录界面」，改用**已在本机登录过的官方 CLI 凭据**导入：
 * CLI 的登录态在 `~/.gemini/antigravity-cli/antigravity-oauth-token`（本模块只读，
 * 永不改写），换发一颗 access token 后落成 ACP server 认的 `acp_token.json`。
 * 同时写好 `settings.json` 的 `auth.type = oauth-personal`，server 启动时即从该文件
 * 推断认证方式（实测日志：`Selected auth method 'oauth-personal' inferred from
 * settings.json`），**无需再发 `authenticate` 请求**——该请求在没有交互式浏览器时
 * 会一直挂着。
 *
 * ## 与 DSH 沙箱的关系
 *
 * 凭据目录在用户 profile 下（中等完整性），需要调用方进程能写。插件随宿主以
 * 正常完整性运行时没问题；若宿主把插件也降权（Low 完整性），写入会失败——本模块
 * 把这种情况收敛成 `ready: false` + `note`，由调用方退回浏览器登录流程，不抛异常。
 *
 * ## 红线
 *
 * - CLI 凭据文件**只读**，绝不写回；
 * - token 全文不进日志、不进错误消息；
 * - 不硬编码任何账号/项目标识：`project_id` 只从既有文件继承或由注入的解析器取得。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'
import { parseTokenState, refreshAccessToken, resolveOAuthClient } from './quota.js'
import type { OAuthClientMeta, QuotaTokenState } from './quota.js'

/** 凭据目录（相对 home）。 */
export const ACP_HOME_SUBPATH = ['.gemini', 'antigravity-acp'] as const
/** CLI 登录态文件（只读来源）。 */
export const CLI_TOKEN_SUBPATH = ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'] as const
export const ACP_TOKEN_FILENAME = 'acp_token.json'
export const ACP_SETTINGS_FILENAME = 'settings.json'
export const ACP_TOKEN_URI = 'https://oauth2.googleapis.com/token'
/** 官方 consumer 登录态所需 scope（与 CLI 同源）。 */
export const ACP_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/aicode',
] as const
/** ACP server 从 settings.json 推断的认证方式 id。 */
export const ACP_AUTH_TYPE = 'oauth-personal'

/** `acp_token.json` 的规范形态（CredentialInfo 六字段 + 可选 access token 缓存）。 */
export interface AcpCredentialDocument {
  client_id: string
  client_secret: string
  refresh_token: string
  token_uri: string
  scopes: readonly string[]
  project_id?: string
  /** google-auth 序列化形态的 access token；带上可省掉 server 侧一次静默换发。 */
  token?: string
  expiry?: string
}

export interface BuildAcpCredentialInput {
  client: OAuthClientMeta
  state: QuotaTokenState
  /** 已知项目 id；未知则省略，由 server 自行 loadCodeAssist 解析。 */
  projectId?: string
  tokenUri?: string
}

/*
 * project_id 不硬编码：账号/项目标识属于用户环境，不能写进产品。
 * 已知时（既有文件继承或注入解析器给出）才带上；未知时省略，由 server 自己解析。
 */
export function buildAcpCredentialDocument(input: BuildAcpCredentialInput): AcpCredentialDocument {
  if (!input.state.refreshToken) {
    throw new Error('登录态里没有 refresh_token，无法生成 acp_token.json')
  }
  const document: AcpCredentialDocument = {
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
    refresh_token: input.state.refreshToken,
    token_uri: input.tokenUri ?? ACP_TOKEN_URI,
    scopes: [...ACP_SCOPES],
  }
  if (input.projectId) document.project_id = input.projectId
  if (input.state.accessToken) document.token = input.state.accessToken
  if (input.state.expiry) document.expiry = input.state.expiry
  return document
}

/** settings.json 形态：只声明认证方式，不碰用户的 gcp 等字段。 */
export function buildAcpSettingsDocument(): { auth: { type: string } } {
  return { auth: { type: ACP_AUTH_TYPE } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判定既有 `acp_token.json` 是否已含可用刷新凭据（六字段齐备即可，token 可缺）。 */
export function readAcpCredentialState(raw: unknown): {
  usable: boolean
  projectId?: string
  state: QuotaTokenState
} {
  const root = isRecord(raw) ? raw : {}
  const text = (key: string): string | undefined => {
    const value = root[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const state: QuotaTokenState = {
    accessToken: text('token'),
    refreshToken: text('refresh_token'),
    expiry: text('expiry'),
  }
  const usable =
    Boolean(text('client_id')) &&
    Boolean(text('client_secret')) &&
    Boolean(text('refresh_token')) &&
    Boolean(text('token_uri'))
  return { usable, projectId: text('project_id'), state }
}

/** 读取既有 settings.json 的 auth.type；不存在/不可解析返回 undefined。 */
export function readSettingsAuthType(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined
  const auth = raw.auth
  if (!isRecord(auth)) return undefined
  const type = auth.type
  return typeof type === 'string' && type.length > 0 ? type : undefined
}

export type AcpCredentialStatus = 'existing' | 'refreshed' | 'imported' | 'unavailable'

export interface AcpCredentialResult {
  /** true = 登录态已就绪，调用方可以跳过 ACP `authenticate`。 */
  ready: boolean
  status: AcpCredentialStatus
  /** settings.json 里最终生效的认证方式。 */
  authType: string
  tokenPath: string
  settingsPath: string
  /** 本次是否新写了 settings.json。 */
  settingsWritten: boolean
  /** 失败原因（已脱敏，绝不含 token）；ready 为 true 时为 undefined。 */
  note?: string
}

export interface AcpCredentialDeps {
  homedir?: () => string
  env?: Readonly<Record<string, string | undefined>>
  /** 换发 access token；默认用 quota.ts 的 OAuth 刷新。 */
  refresh?: (state: QuotaTokenState, client: OAuthClientMeta) => Promise<QuotaTokenState>
  /** 解析 OAuth client 元数据；默认走 quota.ts（env 覆盖 → 官方二进制内嵌）。 */
  resolveClient?: (env: Readonly<Record<string, string | undefined>>) => Promise<OAuthClientMeta | undefined>
  /** 解析项目 id；默认不解析（省略 project_id，由 server 自行解析）。 */
  resolveProjectId?: (accessToken: string) => Promise<string | undefined>
  readFileImpl?: (path: string) => Promise<string>
  writeFileImpl?: (path: string, data: string) => Promise<void>
  mkdirImpl?: (path: string) => Promise<void>
  now?: () => number
  /** 既有 access token 距过期不足该毫秒数时提前换发。 */
  freshnessMarginMs?: number
}

const DEFAULT_FRESHNESS_MARGIN_MS = 60_000

async function readJsonOrUndefined(
  path: string,
  read: (path: string) => Promise<string>,
): Promise<unknown> {
  try {
    return JSON.parse(await read(path)) as unknown
  } catch {
    return undefined
  }
}

function tokenStillFresh(state: QuotaTokenState, nowMs: number, marginMs: number): boolean {
  if (!state.accessToken) return false
  if (!state.expiry) return true
  const expiry = Date.parse(state.expiry)
  if (Number.isNaN(expiry)) return true
  return expiry - nowMs > marginMs
}

/**
 * 准备 `acp_token.json` 与 `settings.json`。永不抛异常：任何准备失败都收敛成
 * `ready: false`，让调用方退回官方浏览器登录流程。
 */
export async function ensureAcpCredentials(deps: AcpCredentialDeps = {}): Promise<AcpCredentialResult> {
  const home = deps.homedir?.() ?? osHomedir()
  const env = deps.env ?? process.env
  const read = deps.readFileImpl ?? ((path: string) => readFile(path, 'utf8'))
  const write = deps.writeFileImpl ?? ((path: string, data: string) => writeFile(path, data, 'utf8'))
  const makeDir = deps.mkdirImpl ?? ((path: string) => mkdir(path, { recursive: true }).then(() => undefined))
  const now = deps.now ?? Date.now
  const margin = deps.freshnessMarginMs ?? DEFAULT_FRESHNESS_MARGIN_MS
  const acpDir = join(home, ...ACP_HOME_SUBPATH)
  const tokenPath = join(acpDir, ACP_TOKEN_FILENAME)
  const settingsPath = join(acpDir, ACP_SETTINGS_FILENAME)
  const cliTokenPath = join(home, ...CLI_TOKEN_SUBPATH)

  const existingRaw = await readJsonOrUndefined(tokenPath, read)
  const existing = readAcpCredentialState(existingRaw)
  const settingsRaw = await readJsonOrUndefined(settingsPath, read)
  const settingsAuthType = readSettingsAuthType(settingsRaw)
  const authType = settingsAuthType ?? ACP_AUTH_TYPE

  const base: Omit<AcpCredentialResult, 'ready' | 'status' | 'settingsWritten' | 'note'> = {
    authType,
    tokenPath,
    settingsPath,
  }

  /*
   * 降级判据：换发/写盘失败时，只要磁盘上**已有**一份含 refresh_token 的可用凭据，
   * 就仍然算 ready —— 官方 server 自己会走静默换发（实测该路径可用），
   * 我们没有理由因为自己多做的一次换发失败而把可用的登录态判成不可用。
   * 只有磁盘上确实没有可用凭据时才 ready: false，交由调用方退回浏览器登录流程。
   */
  const degrade = (note: string, settingsWritten: boolean): AcpCredentialResult =>
    existing.usable
      ? { ...base, ready: true, status: 'existing', settingsWritten, note }
      : { ...base, ready: false, status: 'unavailable', settingsWritten, note }

  // settings.json 只在不存在的场合补写；已有内容（含 gcp 字段或别的认证方式）一律尊重。
  let settingsWritten = false
  if (settingsAuthType === undefined) {
    try {
      await makeDir(acpDir)
      await write(settingsPath, `${JSON.stringify(buildAcpSettingsDocument(), null, 2)}\n`)
      settingsWritten = true
    } catch (error) {
      return {
        ...base,
        ready: false,
        status: 'unavailable',
        settingsWritten: false,
        note: `无法写 settings.json：${describeFsError(error)}`,
      }
    }
  }

  // 非 oauth-personal 的认证方式由用户自选，凭据不由本插件负责。
  if (authType !== ACP_AUTH_TYPE) {
    return { ...base, ready: true, status: 'existing', settingsWritten }
  }

  // 既有 access token 仍新鲜：直接可用，不动文件。
  if (existing.usable && tokenStillFresh(existing.state, now(), margin)) {
    return { ...base, ready: true, status: 'existing', settingsWritten }
  }

  // 需要换发：refresh_token 来源依次为既有文件 → CLI 登录态。
  let source: AcpCredentialStatus = existing.usable ? 'refreshed' : 'imported'
  let state = existing.state
  if (!state.refreshToken) {
    const cliRaw = await readJsonOrUndefined(cliTokenPath, read)
    const cliState = parseTokenState(cliRaw)
    if (!cliState.refreshToken) {
      return {
        ...base,
        ready: false,
        status: 'unavailable',
        settingsWritten,
        note: '未找到可导入的官方登录态（CLI 登录文件不存在或无 refresh_token）',
      }
    }
    state = cliState
    source = 'imported'
  }

  let client: OAuthClientMeta | undefined
  try {
    client = deps.resolveClient ? await deps.resolveClient(env) : await resolveOAuthClient({ env })
  } catch {
    client = undefined
  }
  if (!client) {
    return degrade(
      '无法确定官方 OAuth 客户端标识（可用 AGY_OAUTH_CLIENT_ID / AGY_OAUTH_CLIENT_SECRET 指定）',
      settingsWritten,
    )
  }

  let refreshed: QuotaTokenState
  try {
    refreshed = deps.refresh
      ? await deps.refresh(state, client)
      : await refreshWithDefaults(state, client, env)
  } catch (error) {
    return degrade(`换发 access token 失败：${describeFsError(error)}`, settingsWritten)
  }

  // project_id 依次取：既有文件 → 注入的解析器（默认不解析，交给 server 自己解析）。
  let projectId = existing.projectId
  if (!projectId && deps.resolveProjectId && refreshed.accessToken) {
    try {
      projectId = await deps.resolveProjectId(refreshed.accessToken)
    } catch {
      projectId = undefined
    }
  }

  try {
    await makeDir(acpDir)
    const document = buildAcpCredentialDocument({ client, state: refreshed, projectId })
    await write(tokenPath, `${JSON.stringify(document, null, 2)}\n`)
  } catch (error) {
    return degrade(`无法写 acp_token.json：${describeFsError(error)}`, settingsWritten)
  }
  return { ...base, ready: true, status: source, settingsWritten }
}

/** 默认换发实现：走 quota.ts 的 OAuth 刷新（fetch 由宿主装好代理 dispatcher）。 */
async function refreshWithDefaults(
  state: QuotaTokenState,
  client: OAuthClientMeta,
  env: Readonly<Record<string, string | undefined>>,
): Promise<QuotaTokenState> {
  return refreshAccessToken(state, client, { env })
}

/** 错误文案只保留类型与消息，绝不回显任何 token 片段。 */
function describeFsError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message.slice(0, 200)}`
  return String(error).slice(0, 200)
}
