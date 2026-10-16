/**
 * 出网代理环境变量构造。
 *
 * 官方 `agy_acp_server` 自己出网（Google OAuth + Cloud Code Assist），DSH 的
 * `subprocess` 会 scrub 父环境，因此代理只能以**显式环境变量**注入子进程。
 *
 * 两处必须遵守的约束：
 * 1. 本插件的私有 MCP 桥绑定在 `127.0.0.1`，工具调用走 loopback。开了代理
 *    而没有 NO_PROXY，官方进程会把 MCP 请求也丢给代理，工具回合直接卡死。
 *    因此本地上地址始终并入 NO_PROXY，用户填的排除列表只做追加。
 * 2. 官方栈是 Python（google-api-core / requests → urllib）在 Windows 上运行，
 *    主要读**大写** `*_PROXY`；小写键是给可能存在的 POSIX 风格读取者兜底，
 *    两者都写以免出现「一半流量走代理、一半直连」。
 */

/** 插件侧代理配置（与 settings.ts 的字段一一对应）。 */
export interface ProxySettings {
  /** 代理地址，如 `http://127.0.0.1:7890`、`socks5://127.0.0.1:7891`。 */
  url?: string | undefined
  /** 逗号分隔的排除列表，如 `10.0.0.0/8,*.internal`。 */
  bypass?: string | undefined
}

/** 规范化后的代理配置。 */
export interface ResolvedProxy {
  url: string
  bypass: string
}

/** 代理地址非法时抛出（调用方负责包成 LlmError）。 */
export class ProxyConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProxyConfigError'
  }
}

/** 始终绕过代理的本机地址：私有 MCP 桥在 127.0.0.1，且官方进程也要连本机 OAuth 回调。 */
const ALWAYS_BYPASS = ['localhost', '127.0.0.1', '::1'] as const

/** 支持的协议前缀；其余按 http 处理（多数本地代理默认是 http 混合端口）。 */
const KNOWN_PROTOCOLS = ['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:'] as const

/**
 * 错误信息里不能出现代理密码：把 `scheme://user:pass@host` 的 userinfo 替换掉。
 * 凭据仍按用户填写原样写入子进程环境变量，只是不进日志/错误回显。
 */
function redactUserInfo(value: string): string {
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1***@')
}

/**
 * 规范化用户填写的代理地址：去空白、补全缺失的 scheme、校验协议、保留认证信息。
 * 空字符串视为「不用代理」，返回 undefined。
 */
export function normalizeProxyUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim() ?? ''
  if (trimmed === '') return undefined
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new ProxyConfigError(`代理地址无法解析：${redactUserInfo(trimmed)}（示例：http://127.0.0.1:7890）`)
  }
  const protocol = parsed.protocol.toLowerCase()
  if (!KNOWN_PROTOCOLS.includes(protocol as (typeof KNOWN_PROTOCOLS)[number])) {
    throw new ProxyConfigError(`不支持的代理协议 ${parsed.protocol}（支持 ${KNOWN_PROTOCOLS.map((item) => item.replace(':', '')).join('、')}）`)
  }
  if (!parsed.hostname) {
    throw new ProxyConfigError(`代理地址缺少主机名：${redactUserInfo(trimmed)}（示例：http://127.0.0.1:7890）`)
  }
  // host 含端口、不含 userinfo，因此认证部分要自己拼回去。
  const credentials = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
    : ''
  return `${protocol}//${credentials}${parsed.host}`
}

/**
 * 合并用户排除列表与本机地址：用户条目在前（去重、忽略空项），本机条目在后，
 * 保证 loopback 一定绕过代理。
 */
export function resolveProxyBypass(raw: string | undefined): string {
  const entries: string[] = []
  for (const part of (raw ?? '').split(',')) {
    const entry = part.trim()
    if (entry !== '' && !entries.includes(entry)) entries.push(entry)
  }
  for (const entry of ALWAYS_BYPASS) {
    if (!entries.includes(entry)) entries.push(entry)
  }
  return entries.join(',')
}

/**
 * 把代理配置解析为可直接 spawn 的形态。url 为空返回 undefined（不注入任何变量，
 * 官方进程直连）；否则返回规范化后的 url 与合并过的 bypass。
 */
export function resolveProxy(settings: ProxySettings | undefined): ResolvedProxy | undefined {
  const url = normalizeProxyUrl(settings?.url)
  if (!url) return undefined
  return { url, bypass: resolveProxyBypass(settings?.bypass) }
}

/**
 * 生成注入官方子进程的代理环境变量；无代理时返回 undefined。
 *
 * 大小写各写一份：Windows 上的 Python 读大写，POSIX 风格读取者读小写。
 * `ALL_PROXY`/`all_proxy` 覆盖 socks 场景（urllib 的通用出口）。
 */
export function buildProxyEnv(settings: ProxySettings | undefined): NodeJS.ProcessEnv | undefined {
  const resolved = resolveProxy(settings)
  if (!resolved) return undefined
  return {
    HTTP_PROXY: resolved.url,
    HTTPS_PROXY: resolved.url,
    ALL_PROXY: resolved.url,
    NO_PROXY: resolved.bypass,
    http_proxy: resolved.url,
    https_proxy: resolved.url,
    all_proxy: resolved.url,
    no_proxy: resolved.bypass,
  }
}

/**
 * 进程自身的代理环境（用户为整台机器/终端导出的那一套）——插件未配置 proxyUrl
 * 时的兜底。
 *
 * 为什么需要转发：DSH 的 `subprocess` 会 scrub 父环境，用户导出的 `*_PROXY`
 * **不会**自动到达官方子进程；不转发就会出现「宿主走代理、官方进程直连」的
 * 分裂路由（本机直连 Google 是不通的，表现为认证/模型请求超时）。
 *
 * 只转发用户确实写过的名字（大小写成对补齐），一个都没有时返回 undefined
 * （直连，不无中生有）。NO_PROXY 始终并入 loopback 条目：私有 MCP 桥与官方
 * OAuth 回调都在 127.0.0.1。
 */
export function ambientProxyEnv(
  parent: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv | undefined {
  const pick = (names: readonly string[]): string | undefined => {
    for (const name of names) {
      const value = parent[name]
      if (value && value.trim().length > 0) return value.trim()
    }
    return undefined
  }
  const generic = pick(['all_proxy', 'ALL_PROXY'])
  const httpProxy = pick(['http_proxy', 'HTTP_PROXY']) ?? generic
  const httpsProxy = pick(['https_proxy', 'HTTPS_PROXY']) ?? generic
  if (!httpProxy && !httpsProxy) return undefined
  const bypass = resolveProxyBypass(pick(['no_proxy', 'NO_PROXY']))
  const env: NodeJS.ProcessEnv = { NO_PROXY: bypass, no_proxy: bypass }
  if (httpProxy) {
    env.HTTP_PROXY = httpProxy
    env.http_proxy = httpProxy
  }
  if (httpsProxy) {
    env.HTTPS_PROXY = httpsProxy
    env.https_proxy = httpsProxy
  }
  if (generic) {
    env.ALL_PROXY = generic
    env.all_proxy = generic
  }
  return env
}
