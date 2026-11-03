/**
 * 代理模式的 OAuth 登录流：PKCE + loopback 回调 + token 换发。
 *
 * 口径与 dsh-tool-antigravity 0.5.2 的 oauth-flow 一致：
 * - 授权端点 `https://accounts.google.com/o/oauth2/v2/auth`，S256 挑战；
 * - 回调固定 `http://localhost:51121/oauth-callback`（官方 OAuth client 登记的 redirect），
 *   监听只绑 127.0.0.1；
 * - client 元数据取自 `@cortexkit/antigravity-auth-core` 常量（官方安装型客户端的公开标识）。
 *
 * 与参考实现的差异：换发与 token 交换走本插件的**代理感知 fetch**
 * （`runtime/proxied-fetch` 的 live fetch），而不是 core 的裸 socket 传输——
 * 代理模式必须尊重设置页的 proxyUrl，否则「开了代理却登录不了」无法自洽。
 *
 * 一次性流程：start() 生成一代 flow；回调校验 state 后交换 token 并 commit；
 * 过期 / 取消 / dispose 都会关闭监听并作废在途 flow。
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
} from '@cortexkit/antigravity-auth-core'
import type { ProxyCredential } from './account-store.js'
import { readProxyText } from './transport.js'

export const PROXY_OAUTH_CALLBACK_PORT = 51121
export const PROXY_OAUTH_CALLBACK_PATH = '/oauth-callback'
const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const PROXY_OAUTH_TTL_MS = 5 * 60 * 1000
const MAX_CALLBACK_VALUE_LENGTH = 4096
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024
export const PROXY_ACCOUNT_REQUEST_TIMEOUT_MS = 15_000

export type ProxyOAuthPhase = 'idle' | 'pending' | 'finishing' | 'success' | 'cancelled' | 'expired' | 'failed' | 'port-conflict'

export type ProxyOAuthErrorCode =
  | 'cancelled'
  | 'expired'
  | 'port-conflict'
  | 'state-mismatch'
  | 'missing-code'
  | 'oauth-error'
  | 'token-exchange-failed'
  | 'project-detection-failed'
  | 'credential-save-failed'
  | 'invalid-callback-url'
  | 'internal'

export class ProxyOAuthError extends Error {
  readonly code: ProxyOAuthErrorCode
  constructor(code: ProxyOAuthErrorCode, message: string) {
    super(message)
    this.name = 'ProxyOAuthError'
    this.code = code
  }
}

export interface ProxyOAuthStatus {
  phase: ProxyOAuthPhase
  authorizationUrl?: string
  expiresAt?: string
  errorCode?: ProxyOAuthErrorCode
  /** 仅由本地受控错误生成，不包含上游响应或凭据。 */
  errorMessage?: string
}

export interface ProxyOAuthToken {
  accessToken: string
  refreshToken: string
  expiresAt: number
  email?: string
}

export interface ProxyOAuthFlowOptions {
  fetchImpl?: typeof fetch
  ttlMs?: number
  now?: () => number
  randomBytesImpl?: (size: number) => Uint8Array
  listenerFactory?: ProxyLoopbackListenerFactory
  exchangeCode?: (input: { code: string; verifier: string; signal: AbortSignal }) => Promise<ProxyOAuthToken>
  /** 登录成功后的落盘回调（写 ProxyAccountStore）。 */
  commit?: (token: ProxyOAuthToken, signal: AbortSignal) => Promise<ProxyCredential>
}

export interface ProxyLoopbackCallbackRequest {
  method: string
  host?: string
  url: string
}
export interface ProxyLoopbackCallbackResponse {
  status: number
  headers: Readonly<Record<string, string>>
  body: string
}
export type ProxyLoopbackHandler = (request: ProxyLoopbackCallbackRequest) => Promise<ProxyLoopbackCallbackResponse>
export interface ProxyLoopbackListener { close(): Promise<void> | void; port?: number }
export interface ProxyLoopbackListenerFactory { listen(handler: ProxyLoopbackHandler): Promise<ProxyLoopbackListener> }

export interface ProxyOAuthFlow {
  start(): Promise<{ authorizationUrl: string; expiresAt: string }>
  status(): ProxyOAuthStatus
  completeCallbackUrl(callbackUrl: string): Promise<{ completed: boolean; errorCode?: ProxyOAuthErrorCode }>
  cancel(): Promise<ProxyOAuthStatus>
  dispose(): Promise<void>
}

interface PendingFlow {
  authorizationUrl: string
  expiresAt: number
  state: string
  verifier: string
  controller: AbortController
  timeout: ReturnType<typeof setTimeout>
  active: boolean
  listener?: ProxyLoopbackListener
}

const CALLBACK_HOSTS = Object.freeze([
  `localhost:${PROXY_OAUTH_CALLBACK_PORT}`,
  `127.0.0.1:${PROXY_OAUTH_CALLBACK_PORT}`,
  `[::1]:${PROXY_OAUTH_CALLBACK_PORT}`,
  'localhost',
  '127.0.0.1',
  '[::1]',
])

const RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Content-Type': 'text/html; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
})

export function createProxyOAuthFlow(options: ProxyOAuthFlowOptions = {}): ProxyOAuthFlow {
  const now = options.now ?? (() => Date.now())
  const random = options.randomBytesImpl ?? ((size: number) => randomBytes(size))
  const listenerFactory = options.listenerFactory ?? createProxyLoopbackListenerFactory()
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const exchange = options.exchangeCode ?? createTokenExchanger(fetchImpl, now)
  const ttlMs = options.ttlMs ?? PROXY_OAUTH_TTL_MS

  let pending: PendingFlow | undefined
  let status: ProxyOAuthStatus = { phase: 'idle' }
  let disposed = false
  let startGeneration = 0
  let listenerClosing: Promise<void> = Promise.resolve()

  const closeListener = (candidate: PendingFlow): Promise<void> => {
    const listener = candidate.listener
    candidate.listener = undefined
    if (listener === undefined) return listenerClosing
    listenerClosing = listenerClosing.then(
      () => Promise.resolve(listener.close()).catch(() => undefined),
      () => Promise.resolve(listener.close()).catch(() => undefined),
    )
    return listenerClosing
  }

  const cancelPending = async (candidate: PendingFlow, phase: 'cancelled' | 'expired'): Promise<void> => {
    if (!candidate.active && pending !== candidate) return
    candidate.active = false
    if (pending === candidate) pending = undefined
    clearTimeout(candidate.timeout)
    candidate.controller.abort(new ProxyOAuthError(phase, phase === 'expired' ? '代理模式登录已过期' : '代理模式登录已取消'))
    status = { phase, errorCode: phase }
    await closeListener(candidate)
  }

  return {
    start: async () => {
      if (disposed) throw new ProxyOAuthError('internal', '代理模式登录流已卸载')
      const generation = ++startGeneration
      if (pending) await cancelPending(pending, 'cancelled')
      if (disposed || generation !== startGeneration) throw new ProxyOAuthError('cancelled', '代理模式登录已取消')
      const verifier = Buffer.from(random(32)).toString('base64url')
      const state = Buffer.from(random(32)).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const url = new URL(AUTHORIZATION_ENDPOINT)
      url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('redirect_uri', ANTIGRAVITY_REDIRECT_URI)
      url.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '))
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('state', state)
      url.searchParams.set('access_type', 'offline')
      url.searchParams.set('prompt', 'consent')
      const candidate: PendingFlow = {
        authorizationUrl: url.toString(),
        expiresAt: now() + ttlMs,
        state,
        verifier,
        controller: new AbortController(),
        timeout: setTimeout(() => { void cancelPending(candidate, 'expired') }, ttlMs),
        active: true,
      }
      pending = candidate
      status = { phase: 'pending', authorizationUrl: candidate.authorizationUrl, expiresAt: new Date(candidate.expiresAt).toISOString() }
      try {
        await listenerClosing
        if (!candidate.active || pending !== candidate) throw new ProxyOAuthError('cancelled', '代理模式登录已取消')
        candidate.listener = await listenerFactory.listen((request) => handleCallback(request))
        if (!candidate.active || pending !== candidate) {
          await closeListener(candidate)
          throw new ProxyOAuthError('cancelled', '代理模式登录已取消')
        }
      } catch (error) {
        clearTimeout(candidate.timeout)
        const current = pending === candidate
        if (current) pending = undefined
        candidate.active = false
        const code = asListenerError(error).code
        if (current) status = { phase: code === 'port-conflict' ? 'port-conflict' : 'failed', errorCode: code }
        throw asListenerError(error)
      }
      return { authorizationUrl: candidate.authorizationUrl, expiresAt: new Date(candidate.expiresAt).toISOString() }
    },
    status: () => status,
    completeCallbackUrl: async (callbackUrl) => {
      if (typeof callbackUrl !== 'string' || callbackUrl.length === 0 || callbackUrl.length > MAX_CALLBACK_VALUE_LENGTH) {
        throw new ProxyOAuthError('invalid-callback-url', '回调 URL 无效')
      }
      let parsed: URL
      try { parsed = new URL(callbackUrl) } catch { throw new ProxyOAuthError('invalid-callback-url', '回调 URL 无效') }
      if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.hash) {
        throw new ProxyOAuthError('invalid-callback-url', '回调 URL 无效')
      }
      const result = await completeCallback({ method: 'GET', host: parsed.host, url: `${parsed.pathname}${parsed.search}` })
      return result
    },
    cancel: async () => {
      ++startGeneration
      if (pending) await cancelPending(pending, 'cancelled')
      return status
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      ++startGeneration
      if (pending) await cancelPending(pending, 'cancelled')
      await listenerClosing
    },
  }

  async function handleCallback(request: ProxyLoopbackCallbackRequest): Promise<ProxyLoopbackCallbackResponse> {
    try {
      const result = await completeCallback(request)
      if (result.completed) return callbackResponse(200, 'success')
      return callbackResponse(result.errorCode === 'cancelled' ? 409 : 400, result.errorCode ?? 'failed')
    } catch (error) {
      const safe = error instanceof ProxyOAuthError ? error : new ProxyOAuthError('internal', '回调处理失败')
      return callbackResponse(safe.code === 'port-conflict' ? 409 : 400, safe.code)
    }
  }

  async function completeCallback(request: ProxyLoopbackCallbackRequest): Promise<{ completed: boolean; errorCode?: ProxyOAuthErrorCode }> {
    if (disposed) throw new ProxyOAuthError('internal', '代理模式登录流已卸载')
    const candidate = pending
    if (!candidate || !candidate.active) throw new ProxyOAuthError('internal', '没有进行中的代理模式登录')
    if (request.method !== 'GET') throw new ProxyOAuthError('invalid-callback-url', '回调方法不受支持')
    if (typeof request.host !== 'string' || !CALLBACK_HOSTS.includes(request.host.toLowerCase())) {
      throw new ProxyOAuthError('invalid-callback-url', '回调主机不受支持')
    }
    let parsed: URL
    try { parsed = new URL(request.url, `http://${request.host}`) } catch { throw new ProxyOAuthError('invalid-callback-url', '回调路径无效') }
    if (parsed.pathname !== PROXY_OAUTH_CALLBACK_PATH || parsed.username || parsed.password || parsed.hash) {
      throw new ProxyOAuthError('invalid-callback-url', '回调路径不受支持')
    }
    const params = parsed.searchParams
    const state = params.get('state')
    const code = params.get('code')
    const oauthError = params.get('error')
    // state 不匹配不能消耗在途 flow：浏览器可能送来上一个标签页的旧回调。
    if (state !== candidate.state) {
      return { completed: false, errorCode: 'state-mismatch' }
    }
    candidate.active = false
    // 回调已消费，但 token 交换仍属于当前流程，取消/过期需要继续中止它。
    status = { phase: 'finishing', expiresAt: new Date(candidate.expiresAt).toISOString() }
    void closeListener(candidate)
    if (oauthError !== null) {
      pending = undefined
      clearTimeout(candidate.timeout)
      candidate.controller.abort(new ProxyOAuthError('oauth-error', '授权被拒绝'))
      status = { phase: 'failed', errorCode: 'oauth-error' }
      return { completed: false, errorCode: 'oauth-error' }
    }
    if (code === null || code.length === 0 || code.length > MAX_CALLBACK_VALUE_LENGTH) {
      pending = undefined
      clearTimeout(candidate.timeout)
      status = { phase: 'failed', errorCode: 'missing-code' }
      return { completed: false, errorCode: 'missing-code' }
    }
    try {
      const token = await withProxyAccountDeadline(signal => exchange({ code, verifier: candidate.verifier, signal }), candidate.controller.signal, ttlMs)
      if (candidate.controller.signal.aborted) throw new ProxyOAuthError('cancelled', '代理模式登录已取消')
      if (options.commit) await withProxyAccountDeadline(signal => options.commit!(token, signal), candidate.controller.signal, ttlMs)
      candidate.controller.signal.throwIfAborted()
      if (pending === candidate) status = { phase: 'success' }
      return { completed: true }
    } catch (error) {
      const reason: unknown = candidate.controller.signal.aborted ? candidate.controller.signal.reason : error
      const code2 = reason instanceof ProxyOAuthError ? reason.code : 'token-exchange-failed'
      if (pending === candidate) status = { phase: code2 === 'cancelled' ? 'cancelled' : code2 === 'expired' ? 'expired' : 'failed', errorCode: code2,
        ...(reason instanceof ProxyOAuthError ? { errorMessage: reason.message } : {}) }
      return { completed: false, errorCode: code2 }
    } finally {
      clearTimeout(candidate.timeout)
      if (pending === candidate) pending = undefined
    }
  }
}

/** Google token 交换；响应只在 Host 内存解析，错误消息不含凭据。 */
export function createTokenExchanger(fetchImpl: typeof fetch, now: () => number = () => Date.now()) {
  return async ({ code, verifier, signal }: { code: string; verifier: string; signal: AbortSignal }): Promise<ProxyOAuthToken> => {
    return withProxyAccountDeadline(async boundedSignal => {
    const response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: ANTIGRAVITY_REDIRECT_URI,
      }),
      signal: boundedSignal,
    })
    if (!response.ok) {
      try { await response.body?.cancel() } catch { /* best effort */ }
      throw new ProxyOAuthError('token-exchange-failed', `授权码交换失败（HTTP ${response.status}）`)
    }
    const payload = await readJsonBounded(response, boundedSignal)
    if (!isRecord(payload) || typeof payload.access_token !== 'string' || payload.access_token.length === 0
      || typeof payload.refresh_token !== 'string' || payload.refresh_token.length === 0) {
      throw new ProxyOAuthError('token-exchange-failed', 'token 响应缺少必需字段')
    }
    const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0 ? payload.expires_in : 3600
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: now() + expiresIn * 1000,
      ...emailFromTokenResponse(payload),
    }
    }, signal)
  }
}

/** 用 refresh_token 换发 access token（代理感知 fetch）。 */
export async function refreshProxyAccessToken(
  refreshToken: string,
  fetchImpl: typeof fetch,
  now: () => number = () => Date.now(),
  signal?: AbortSignal,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  return withProxyAccountDeadline(async boundedSignal => {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    signal: boundedSignal,
  })
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* best effort */ }
    throw new ProxyOAuthError('token-exchange-failed', `换发 access token 失败（HTTP ${response.status}）`)
  }
  const payload = await readJsonBounded(response, boundedSignal)
  if (!isRecord(payload) || typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new ProxyOAuthError('token-exchange-failed', '换发响应缺少 access_token')
  }
  const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0 ? payload.expires_in : 3600
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0 ? payload.refresh_token : refreshToken,
    expiresAt: now() + expiresIn * 1000,
  }
  }, signal)
}

/** 只绑 127.0.0.1；生产使用官方登记端口，测试可用随机端口而保持原 Host 校验。 */
export function createProxyLoopbackListenerFactory(port = PROXY_OAUTH_CALLBACK_PORT): ProxyLoopbackListenerFactory {
  return {
    listen: (handler) => new Promise<ProxyLoopbackListener>((resolve, reject) => {
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        void (async () => {
          const host = typeof request.headers.host === 'string' ? request.headers.host : undefined
          const result = await handler({ method: request.method ?? '', ...(host === undefined ? {} : { host }), url: request.url ?? '' })
          response.writeHead(result.status, result.headers)
          response.end(result.body)
        })().catch(() => {
          if (!response.headersSent) response.writeHead(500, RESPONSE_HEADERS)
          response.end(callbackResponse(500, 'internal').body)
        })
      })
      let settled = false
      const onError = (error: unknown): void => { if (!settled) { settled = true; reject(error) } }
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        settled = true
        server.removeListener('error', onError)
        resolve({
          port: (server.address() as { port: number }).port,
          close: () => new Promise<void>((resolveClose, rejectClose) => {
            if (!server.listening) { resolveClose(); return }
            server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)))
          }),
        })
      })
    }),
  }
}

function emailFromTokenResponse(payload: Record<string, unknown>): { email?: string } {
  if (typeof payload.email === 'string' && payload.email.length > 0) return { email: payload.email }
  const idToken = payload.id_token
  if (typeof idToken !== 'string') return {}
  const segments = idToken.split('.')
  if (segments.length !== 3 || !segments[1] || segments[1].length > 16 * 1024) return {}
  try {
    const claims: unknown = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'))
    if (isRecord(claims) && typeof claims.email === 'string' && claims.email.length > 0) return { email: claims.email }
  } catch { /* 缺邮箱不影响登录 */ }
  return {}
}

async function readJsonBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  const text = await readProxyText(response, { signal, maxBytes: MAX_TOKEN_RESPONSE_BYTES,
    idleTimeoutMs: PROXY_ACCOUNT_REQUEST_TIMEOUT_MS, totalTimeoutMs: PROXY_ACCOUNT_REQUEST_TIMEOUT_MS })
  try { return JSON.parse(text) as unknown } catch { throw new ProxyOAuthError('token-exchange-failed', 'token 响应不是合法 JSON') }
}

/** 同时约束连接与响应读取；即使注入的 fetch 忽略 signal，调用方也会按时结束。 */
export async function withProxyAccountDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal,
  timeoutMs = PROXY_ACCOUNT_REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  const boundedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  boundedSignal.throwIfAborted()
  const timer = setTimeout(() => controller.abort(new ProxyOAuthError('token-exchange-failed', '代理账户请求超时')), timeoutMs)
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(boundedSignal.reason)
    boundedSignal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([operation(boundedSignal), cancelled]) } finally {
    clearTimeout(timer)
    if (onAbort) boundedSignal.removeEventListener('abort', onAbort)
  }
}

function callbackResponse(status: number, outcome: string): ProxyLoopbackCallbackResponse {
  const body = outcome === 'success'
    ? '<!doctype html><meta charset="utf-8"><title>授权完成</title><p>授权完成，可返回 DeepSeek Harness 继续使用代理模式。</p>'
    : '<!doctype html><meta charset="utf-8"><title>授权未完成</title><p>授权未完成，请返回 DeepSeek Harness 查看原因。</p>'
  return { status, headers: RESPONSE_HEADERS, body }
}

function asListenerError(error: unknown): ProxyOAuthError {
  if (error instanceof ProxyOAuthError) return error
  if (isRecord(error) && error.code === 'EADDRINUSE') return new ProxyOAuthError('port-conflict', `回调端口 ${PROXY_OAUTH_CALLBACK_PORT} 已被占用`)
  return new ProxyOAuthError('internal', '回调监听启动失败')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
