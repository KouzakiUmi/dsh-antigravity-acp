/**
 * 让插件自己发出的 HTTPS 请求（二进制下载、OAuth 换发、Cloud Code Assist 额度）
 * 也走插件配置的 `proxyUrl`。
 *
 * 背景：Node 的 `fetch` 不读 `HTTP_PROXY`。宿主（dsh-http-proxy）只按**启动环境**
 * 给全局 undici dispatcher 装代理；插件设置页里填的 `proxyUrl` 此前只传给了子进程，
 * 插件自身的 `fetch` 完全没用上——直连不通 Google 的机器上，下载与换发会一直挂着。
 *
 * 做法：运行时按需加载 `undici`（它是 `dsh-subprocess → dsh-http-proxy` 的传递依赖，
 * 不是本包声明的依赖，所以不静态 import、不改 package.json），用 `ProxyAgent` 发请求。
 * 以下任一情况都回退到全局 `fetch`（即宿主按环境变量装的那套路由），绝不因此让
 * 请求失败：未配置代理 / 代理是 socks 等 undici ProxyAgent 不支持的协议 /
 * 目标命中排除列表 / undici 加载失败。
 */
import type { ResolvedProxy } from './proxy-env.js'

/** 只描述用到的 undici 面，避免依赖其类型。 */
export interface UndiciLike {
  ProxyAgent: new (options: { uri: string }) => unknown
  fetch: (input: string, init?: Record<string, unknown>) => Promise<Response>
}

export interface ProxiedFetchDeps {
  /** 加载 undici；失败返回 undefined。测试注入替身。 */
  loadUndici?: () => Promise<UndiciLike | undefined>
  /** 直连/宿主路由所用的 fetch；默认全局 fetch。 */
  fallback?: typeof fetch
}

async function defaultLoadUndici(): Promise<UndiciLike | undefined> {
  try {
    // 变量说明符：不让打包器/类型检查把它当成静态依赖。
    const specifier = 'undici'
    const module = (await import(specifier)) as Partial<UndiciLike>
    if (typeof module.ProxyAgent === 'function' && typeof module.fetch === 'function') return module as UndiciLike
    return undefined
  } catch {
    return undefined
  }
}

/** undici ProxyAgent 能用的代理协议（socks 不在其中）。 */
function isHttpProxy(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * 排除列表匹配：精确主机、`*.x` / `.x` 后缀。CIDR 等复杂写法不支持（这里的目标
 * 只有固定的 Google 域名，列表主要用来放行 loopback）。
 */
export function matchesBypass(hostname: string, bypass: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  for (const raw of bypass.split(',')) {
    let entry = raw.trim().toLowerCase().replace(/^\[|\]$/g, '')
    if (!entry) continue
    // 若用户填写的排除条目包含端口（如 127.0.0.1:8080），剥离端口部分以便与 hostname 对齐
    const colonIdx = entry.lastIndexOf(':')
    if (colonIdx > 0 && /^\d+$/.test(entry.slice(colonIdx + 1))) {
      entry = entry.slice(0, colonIdx)
    }
    if (entry === host) return true
    if (entry.startsWith('*.') && host.endsWith(entry.slice(1))) return true
    if (entry.startsWith('.') && host.endsWith(entry)) return true
  }
  return false
}

export function createProxiedFetch(proxy: ResolvedProxy | undefined, deps: ProxiedFetchDeps = {}): typeof fetch {
  const fallback = deps.fallback ?? ((input, init) => globalThis.fetch(input, init))
  if (!proxy || !isHttpProxy(proxy.url)) return fallback
  const load = deps.loadUndici ?? defaultLoadUndici
  let prepared: Promise<{ undici: UndiciLike; agent: unknown } | undefined> | undefined
  const prepare = (): Promise<{ undici: UndiciLike; agent: unknown } | undefined> => {
    prepared ??= load().then((undici) => {
      if (!undici) return undefined
      try {
        return { undici, agent: new undici.ProxyAgent({ uri: proxy.url }) }
      } catch {
        return undefined
      }
    })
    return prepared
  }
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let hostname = ''
    try {
      hostname = new URL(url).hostname
    } catch {
      return fallback(input, init)
    }
    if (matchesBypass(hostname, proxy.bypass)) return fallback(input, init)
    const route = await prepare()
    if (!route) return fallback(input, init)
    return route.undici.fetch(url, { ...(init as Record<string, unknown> | undefined), dispatcher: route.agent })
  }
}
