/**
 * 代理模式的线身份（wire identity）：agy CLI 通信头与固定端点。
 *
 * 伪装口径与 dsh-tool-antigravity 0.5.2 一致，全部取自
 * `@cortexkit/antigravity-auth-core` 3.0.14 的审计实现：
 * - `User-Agent`：`antigravity/cli/<version> (aidev_client; os_type=…; arch=…; cl=…; auth_method=consumer)`；
 * - 头序列：Host → User-Agent → (Transfer-Encoding|Content-Length) → Authorization → Content-Type → Accept-Encoding；
 * - `:streamGenerateContent` 一律 chunked 分帧，其余 Content-Length。
 *
 * 与参考实现的两点差异（本 bundle 的边界）：
 * 1. **不携带 DSH 归属头**。`attributionHeaders()` 的 User-Agent 与 agy 伪装互斥
 *    （同一个头只能有一个值），而本路由的伪装是用户显式开启的代理模式功能；
 *    参考实现把归属塞进第二个私有头，本 bundle 不引入额外头，避免偏离 agy 线形态。
 * 2. 端点白名单只允许 Cloud Code Assist 的生成、目录、项目与额度方法及 Google OAuth token 端点，
 *    其余 URL 一律拒绝，调用方无法注入任意头或任意目的地。
 */
import { Buffer } from 'node:buffer'
import { buildAgyCliHeaderPairs, buildAntigravityHarnessUserAgent } from '@cortexkit/antigravity-auth-core'

export const AGY_PROXY_USER_AGENT = buildAntigravityHarnessUserAgent()

/** 代理模式允许直连的上游端点（origin + pathname 精确匹配）。 */
export const PROXY_WIRE_ORIGINS = Object.freeze([
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
  'https://oauth2.googleapis.com',
])
export const PROXY_WIRE_PATHS = Object.freeze([
  '/v1internal:streamGenerateContent',
  '/v1internal:generateContent',
  '/v1internal:fetchAvailableModels',
  '/v1internal:loadCodeAssist',
  '/v1internal:retrieveUserQuotaSummary',
  '/token',
])

export type WireHeaderPair = readonly [name: string, value: string]

export class WireIdentityError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'WireIdentityError'
    this.code = code
  }
}

export interface ProxyWireRequest {
  /** 只接受裸 access token 或完整 `Bearer …` 值；不会进入任何错误消息。 */
  readonly authorization?: string
  readonly body: string | Uint8Array
  /** OAuth token 端点用表单编码；缺省 JSON。 */
  readonly contentType?: string
}

/** 校验端点在白名单内；query 只允许 `?alt=sse`。 */
export function assertProxyEndpoint(url: string): URL {
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new WireIdentityError('WIRE_ENDPOINT_INVALID', '代理模式请求端点无效') }
  if (parsed.protocol !== 'https:' || !PROXY_WIRE_ORIGINS.includes(parsed.origin) || !PROXY_WIRE_PATHS.includes(parsed.pathname)) {
    throw new WireIdentityError('WIRE_ENDPOINT_INVALID', '代理模式请求端点不在白名单内')
  }
  if (parsed.username || parsed.password || (parsed.origin === 'https://oauth2.googleapis.com') !== (parsed.pathname === '/token')) {
    throw new WireIdentityError('WIRE_ENDPOINT_INVALID', '代理模式请求端点身份或路径无效')
  }
  if (parsed.search.length > 0 && parsed.search !== '?alt=sse') {
    throw new WireIdentityError('WIRE_ENDPOINT_INVALID', '代理模式请求端点查询串不受支持')
  }
  if (parsed.hash.length > 0) throw new WireIdentityError('WIRE_ENDPOINT_INVALID', '代理模式请求端点不允许 fragment')
  return parsed
}

function assertSafeHeaderValue(name: string, value: string): void {
  if (value.length === 0 || value.length > 4096) throw new WireIdentityError('WIRE_HEADER_UNSAFE', `${name} 超出安全长度`)
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index)
    if (codePoint < 0x20 || codePoint === 0x7f) throw new WireIdentityError('WIRE_HEADER_UNSAFE', `${name} 含非法字符`)
  }
}

function normalizeAuthorization(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const bearer = value.startsWith('Bearer ') ? value : `Bearer ${value}`
  if (!/^Bearer\s+\S+$/u.test(bearer)) throw new WireIdentityError('WIRE_AUTH_INVALID', '代理模式授权值无效')
  assertSafeHeaderValue('Authorization', bearer)
  return bearer
}

/**
 * 生成 agy CLI 形态的请求头序列（固定顺序，调用方不能增删改）。
 * 返回值冻结；`User-Agent` 恒为 {@link AGY_PROXY_USER_AGENT}。
 */
export function buildProxyHeaderPairs(url: string, request: ProxyWireRequest): readonly WireHeaderPair[] {
  const parsed = assertProxyEndpoint(url)
  if (typeof request.body !== 'string' && !(request.body instanceof Uint8Array)) {
    throw new WireIdentityError('WIRE_BODY_INVALID', '代理模式请求体必须是有界字节')
  }
  const authorization = normalizeAuthorization(request.authorization)
  const basePairs = buildAgyCliHeaderPairs(url, {
    method: 'POST',
    body: request.body as RequestInit['body'],
    headers: {
      'User-Agent': AGY_PROXY_USER_AGENT,
      ...(authorization === undefined ? {} : { Authorization: authorization }),
      'Content-Type': request.contentType ?? 'application/json',
      'Accept-Encoding': 'gzip',
    },
  })
  void parsed
  return Object.freeze(basePairs.map((pair) => Object.freeze([pair[0], pair[1]] as const)))
}

/** 把固定头序列序列化成字面 HTTP/1.1 请求字节（chunked 或 Content-Length）。 */
export function serializeProxyRequest(url: string, request: ProxyWireRequest): Uint8Array {
  const parsed = assertProxyEndpoint(url)
  const pairs = buildProxyHeaderPairs(url, request)
  const body = Buffer.from(typeof request.body === 'string' ? request.body : Buffer.from(request.body))
  const lines = pairs.map(([name, value]) => `${name}: ${value}`).join('\r\n')
  const head = Buffer.from(`POST ${parsed.pathname}${parsed.search} HTTP/1.1\r\n${lines}\r\n\r\n`)
  if (!pairs.some(([name]) => name === 'Transfer-Encoding')) {
    return body.byteLength === 0 ? head : Buffer.concat([head, body])
  }
  if (body.byteLength === 0) return Buffer.concat([head, Buffer.from('0\r\n\r\n')])
  return Buffer.concat([
    head,
    Buffer.from(`${body.byteLength.toString(16)}\r\n`),
    body,
    Buffer.from('\r\n0\r\n\r\n'),
  ])
}
