/**
 * 让插件自己发出的 HTTPS 请求（二进制下载、OAuth 换发、Cloud Code Assist 额度）
 * 也走插件配置的 `proxyUrl`。
 *
 * 背景：Node 的 `fetch` 不读 `HTTP_PROXY`。宿主（dsh-http-proxy）只按**启动环境**
 * 给全局 undici dispatcher 装代理；插件设置页里填的 `proxyUrl` 此前只传给了子进程，
 * 插件自身的 `fetch` 完全没用上——直连不通 Google 的机器上，下载与换发会一直挂着。
 *
 * 显式配置代理时，依赖加载、协议或连接失败均报错，不退回其它出口。
 * 只有未配置代理或目标明确在 bypass 列表时使用宿主 fetch。
 */
import type { ResolvedProxy } from './proxy-env.js'
import { ProxyConfigError } from './proxy-env.js'

/** 只描述用到的 undici 面，避免依赖其类型。 */
export interface UndiciLike {
  ProxyAgent: new (options: { uri: string; token?: string; username?: string; password?: string }) => { close?(): Promise<void>; destroy?(): Promise<void> }
  fetch: (input: string, init?: Record<string, unknown>) => Promise<Response>
}

export type ManagedFetch = typeof fetch & { close(): Promise<void> }
export const PROXY_CLOSE_TIMEOUT_MS = 2_000

export interface ProxiedFetchDeps {
  /** 加载 undici；失败返回 undefined。测试注入替身。 */
  loadUndici?: () => Promise<UndiciLike | undefined>
  /** 直连/宿主路由所用的 fetch；默认全局 fetch。 */
  fallback?: typeof fetch
}

async function defaultLoadUndici(): Promise<UndiciLike | undefined> {
  try {
    const module = (await import('undici')) as unknown as Partial<UndiciLike>
    if (typeof module.ProxyAgent === 'function' && typeof module.fetch === 'function') return module as UndiciLike
    return undefined
  } catch {
    return undefined
  }
}

/** undici 8 支持 SOCKS5，域名由代理解析，因此 socks5h 可映射到 socks5。 */
function isSupportedProxy(url: string): boolean {
  return /^(https?|socks5h?):\/\//i.test(url)
}

/**
 * 排除列表匹配：精确主机、`*.x` / `.x` 后缀。CIDR 等复杂写法不支持（这里的目标
 * 只有固定的 Google 域名，列表主要用来放行 loopback）。
 */
export function matchesBypass(hostname: string, bypass: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  for (const raw of bypass.split(',')) {
    let entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    // 不把 IPv6 的最后一段误当成端口；有端口的 IPv6 必须带方括号。
    if (entry.startsWith('[')) entry = /^\[([^\]]+)\](?::\d+)?$/.exec(entry)?.[1] ?? entry
    else if (entry.split(':').length === 2) entry = entry.replace(/:\d+$/, '')
    if (entry === host) return true
    if (entry.startsWith('*.') && host.endsWith(entry.slice(1))) return true
    if (entry.startsWith('.') && host.endsWith(entry)) return true
  }
  return false
}

export function createProxiedFetch(proxy: ResolvedProxy | undefined, deps: ProxiedFetchDeps = {}): ManagedFetch {
  const fallback = deps.fallback ?? ((input, init) => globalThis.fetch(input, init))
  if (!proxy) return Object.assign(((input, init) => fallback(input, init)) as typeof fetch, { close: async () => undefined })
  if (!isSupportedProxy(proxy.url)) throw new ProxyConfigError('插件请求支持 HTTP、HTTPS、SOCKS5 代理；不支持 SOCKS4')
  const load = deps.loadUndici ?? defaultLoadUndici
  let closed = false
  let prepared: Promise<{ undici: UndiciLike; agent: { close?(): Promise<void>; destroy?(): Promise<void> } }> | undefined
  const prepare = (): NonNullable<typeof prepared> => {
    prepared ??= load().catch(() => undefined).then((undici) => {
      if (!undici) throw new ProxyConfigError('无法加载代理传输依赖 undici；请求未发送，请重新安装插件')
      try {
        const uri = new URL(proxy.url)
        if (uri.protocol === 'socks5h:') uri.protocol = 'socks5:'
        // SOCKS5 认证由 undici 从 URL 中读取，不使用 HTTP Proxy-Authorization。
        if (uri.protocol === 'socks5:') return { undici, agent: new undici.ProxyAgent({
          uri: uri.href, username: decodeURIComponent(uri.username), password: decodeURIComponent(uri.password),
        }) }
        const token = uri.username || uri.password
          ? `Basic ${Buffer.from(`${decodeURIComponent(uri.username)}:${decodeURIComponent(uri.password)}`).toString('base64')}`
          : undefined
        uri.username = ''
        uri.password = ''
        return { undici, agent: new undici.ProxyAgent({ uri: uri.href, ...(token ? { token } : {}) }) }
      } catch {
        throw new ProxyConfigError('无法初始化代理传输；请求未发送，请检查代理设置')
      }
    })
    return prepared
  }
  const doFetch: typeof fetch = async (input, init) => {
    if (closed) throw new ProxyConfigError('代理传输已关闭；请求未发送')
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let hostname = ''
    try {
      hostname = new URL(url).hostname
    } catch {
      throw new ProxyConfigError('请求地址无效；请求未发送')
    }
    if (matchesBypass(hostname, proxy.bypass)) return fallback(input, init)
    const route = await prepare()
    if (closed) throw new ProxyConfigError('代理传输已关闭；请求未发送')
    const requestInit = input instanceof Request ? {
      method: input.method, headers: input.headers, body: input.body,
      signal: input.signal, redirect: input.redirect, credentials: input.credentials,
      cache: input.cache, integrity: input.integrity, keepalive: input.keepalive,
      referrer: input.referrer, referrerPolicy: input.referrerPolicy, duplex: 'half',
    } : {}
    return route.undici.fetch(url, { ...requestInit, ...(init as Record<string, unknown> | undefined), dispatcher: route.agent })
  }
  let closing: Promise<void> | undefined
  return Object.assign(doFetch, { close: () => {
    closed = true
    closing ??= (async () => {
      const stop = (async () => {
        const route = await prepared?.catch(() => undefined)
        if (!route) return
        // close() 等待消费完响应体；错误状态响应通常尚未消费，必须主动销毁连接。
        await (route.agent.destroy ? route.agent.destroy() : route.agent.close?.())
      })()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          stop,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new ProxyConfigError('代理连接回收超时')), PROXY_CLOSE_TIMEOUT_MS)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    })()
    return closing
  } })
}
