/**
 * 代理模式的有界 HTTP/1.1 传输：字面分帧 + TLS 直连 / HTTP CONNECT 代理。
 *
 * 为什么不用 fetch：agy 线形态要求**固定头顺序**与 `:streamGenerateContent`
 * 的 chunked 分帧（见 wire-identity.ts），通用 fetch 实现会重排头并自行决定
 * 分帧，伪装即失效。这里按参考实现（dsh-tool-antigravity raw-http）的口径
 * 自己写字面请求字节并解析响应头 / chunked / gzip。
 *
 * 边界：
 * - 只支持直连与 http(s) 代理的 CONNECT；SOCKS 代理在代理模式下明确报错
 *   （官方 ACP 进程仍支持 SOCKS，两条链路各自说明）；
 * - 响应头、响应体、单帧都有字节与时间上限，超限即失败，不保留无界缓冲；
 * - 所有错误经 {@link ProxyTransportError}，不携带凭据与 URL userinfo。
 */
import { Buffer } from 'node:buffer'
import * as net from 'node:net'
import { PassThrough, Readable, Transform } from 'node:stream'
import type { Duplex } from 'node:stream'
import * as tls from 'node:tls'
import { createGunzip } from 'node:zlib'
import { serializeProxyRequest } from './wire-identity.js'
import type { ResolvedProxy } from '../runtime/proxy-env.js'
import { matchesBypass } from '../runtime/proxied-fetch.js'

export const PROXY_RESPONSE_HEADER_TIMEOUT_MS = 180_000
export const PROXY_IDLE_TIMEOUT_MS = 240_000
export const PROXY_TOTAL_TIMEOUT_MS = 600_000
export const PROXY_RESPONSE_BYTES = 8 * 1024 * 1024
export const PROXY_REQUEST_BYTES = 16 * 1024 * 1024
export const PROXY_FRAME_BYTES = 2 * 1024 * 1024
const MAX_RESPONSE_HEAD_BYTES = 64 * 1024
const DEFAULT_HTTPS_PORT = 443
const DEFAULT_PROXY_PORT = 8080

export type ProxyTransportErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'offline'
  | 'request-too-large'
  | 'response-too-large'
  | 'frame-too-large'
  | 'invalid-response'
  | 'protocol-drift'
  | 'authentication'
  | 'forbidden'
  | 'rate-limited'
  | 'upstream'
  | 'proxy-unsupported'

export class ProxyTransportError extends Error {
  readonly code: ProxyTransportErrorCode
  readonly status?: number
  readonly accepted: boolean
  constructor(code: ProxyTransportErrorCode, message: string, extra: { status?: number; accepted?: boolean; cause?: unknown } = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
    this.name = 'ProxyTransportError'
    this.code = code
    this.status = extra.status
    this.accepted = extra.accepted === true
  }
}

export interface ProxyTransportRequest {
  readonly url: string
  /** 裸 access token；传输层补 `Bearer ` 前缀。 */
  readonly accessToken?: string
  readonly body: string | Uint8Array
  readonly contentType?: string
  readonly signal?: AbortSignal
  readonly responseHeaderTimeoutMs?: number
}

export interface ProxyTransportOptions {
  /** 出网代理解析（与官方进程同一套设置）；返回 undefined 表示直连。 */
  resolveProxy?: () => ResolvedProxy | undefined
  responseHeaderTimeoutMs?: number
  maxRequestBytes?: number
}

export interface ProxyTransport {
  request(input: ProxyTransportRequest): Promise<Response>
}

export function createProxyTransport(options: ProxyTransportOptions = {}): ProxyTransport {
  const headerTimeout = boundedTimeout(options.responseHeaderTimeoutMs, PROXY_RESPONSE_HEADER_TIMEOUT_MS)
  const maxRequestBytes = boundedBytes(options.maxRequestBytes, PROXY_REQUEST_BYTES, PROXY_REQUEST_BYTES)
  return {
    request: async (input) => {
      if (input.signal?.aborted) throw cancelled(false)
      const bytes = Buffer.from(typeof input.body === 'string' ? input.body : Buffer.from(input.body))
      if (bytes.byteLength > maxRequestBytes) throw new ProxyTransportError('request-too-large', '代理模式请求超出字节上限', { accepted: false })
      const wire = serializeProxyRequest(input.url, {
        ...(input.accessToken === undefined ? {} : { authorization: `Bearer ${input.accessToken}` }),
        body: bytes,
        ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
      })
      const url = new URL(input.url)
      const timeout = boundedTimeout(input.responseHeaderTimeoutMs, headerTimeout)
      const socket = await connectTls(url, options.resolveProxy, timeout, input.signal)
      let accepted = false
      const abort = (): void => { socket.on('error', () => {}); socket.destroy() }
      try {
        if (isAborted(input.signal)) throw cancelled(false)
        input.signal?.addEventListener('abort', abort, { once: true })
        socket.write(wire)
        accepted = true
        const { head, leftover } = await waitForHead(socket, timeout, accepted, input.signal)
        const parsed = parseResponseHead(head)
        const body = buildResponseBody(socket, leftover, parsed, input.signal)
        return new Response(body, { status: parsed.status, statusText: parsed.statusText, headers: parsed.headers })
      } catch (error) {
        socket.destroy()
        if (error instanceof ProxyTransportError) throw error
        throw new ProxyTransportError('offline', '代理模式无法连通上游端点', { accepted, cause: error })
      } finally {
        input.signal?.removeEventListener('abort', abort)
      }
    },
  }
}

/** 把上游状态码折成传输错误；2xx 返回 undefined。 */
export function proxyStatusError(status: number): ProxyTransportError | undefined {
  if (status >= 200 && status < 300) return undefined
  if (status === 401) return new ProxyTransportError('authentication', '上游要求重新认证', { status })
  if (status === 403) return new ProxyTransportError('forbidden', '上游拒绝了该账户', { status })
  if (status === 429) return new ProxyTransportError('rate-limited', '上游限流', { status })
  if (status >= 500) return new ProxyTransportError('upstream', '上游不可用', { status })
  return new ProxyTransportError('protocol-drift', '上游返回了意外状态', { status })
}

export interface BoundedReadOptions {
  signal?: AbortSignal
  idleTimeoutMs?: number
  totalTimeoutMs?: number
  maxBytes?: number
  maxFrameBytes?: number
}

/** 有界读取响应体字节。 */
export async function readProxyBytes(response: Response, options: BoundedReadOptions = {}): Promise<Uint8Array> {
  const maxBytes = boundedBytes(options.maxBytes, PROXY_RESPONSE_BYTES, PROXY_RESPONSE_BYTES)
  if (response.body === null) {
    const data = new Uint8Array(await response.arrayBuffer().catch(() => { throw new ProxyTransportError('offline', '代理模式响应体不可读') }))
    if (data.byteLength > maxBytes) throw new ProxyTransportError('response-too-large', '代理模式响应超出字节上限')
    return data
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const startedAt = Date.now()
  try {
    for (;;) {
      const chunk = await readChunk(reader, options, startedAt)
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maxBytes) {
        await cancelReader(reader)
        throw new ProxyTransportError('response-too-large', '代理模式响应超出字节上限')
      }
      chunks.push(chunk.value)
    }
  } catch (error) {
    if (error instanceof ProxyTransportError) throw error
    if (isAborted(options.signal)) throw cancelled()
    throw new ProxyTransportError('offline', '代理模式响应体读取失败')
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return output
}

export async function readProxyText(response: Response, options: BoundedReadOptions = {}): Promise<string> {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await readProxyBytes(response, options))
  } catch (error) {
    if (error instanceof ProxyTransportError) throw error
    throw new ProxyTransportError('invalid-response', '代理模式响应不是合法 UTF-8')
  }
}

export interface ProxySseEvent { readonly data: string; readonly event?: string }

/** 解析 SSE（兼容无 SSE 帧的纯 JSON 响应）；帧与总量有界。 */
export async function* iterateProxySse(response: Response, options: BoundedReadOptions = {}): AsyncGenerator<ProxySseEvent> {
  const maxBytes = boundedBytes(options.maxBytes, PROXY_RESPONSE_BYTES, PROXY_RESPONSE_BYTES)
  const maxFrameBytes = boundedBytes(options.maxFrameBytes, PROXY_FRAME_BYTES, PROXY_FRAME_BYTES)
  if (response.body === null) {
    const text = await readProxyText(response, options)
    if (text.trim().length > 0) yield { data: text.trim() }
    return
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let eventName: string | undefined
  let dataLines: string[] = []
  let bytes = 0
  let frameBytes = 0
  let sawSseFrame = false
  let plainText = ''
  const startedAt = Date.now()
  const flush = (): ProxySseEvent | undefined => {
    if (dataLines.length === 0) { eventName = undefined; frameBytes = 0; return undefined }
    const data = dataLines.join('\n')
    const event = eventName
    dataLines = []
    eventName = undefined
    frameBytes = 0
    sawSseFrame = true
    plainText = ''
    return event === undefined ? { data } : { data, event }
  }
  try {
    for (;;) {
      const chunk = await readChunk(reader, options, startedAt)
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new ProxyTransportError('response-too-large', '代理模式响应超出字节上限')
      let decoded: string
      try { decoded = decoder.decode(chunk.value, { stream: true }) } catch { throw new ProxyTransportError('invalid-response', '代理模式响应不是合法 UTF-8') }
      if (!sawSseFrame) plainText += decoded
      buffer += decoded
      for (;;) {
        const newline = buffer.search(/[\r\n]/u)
        if (newline < 0) break
        if (buffer[newline] === '\r' && newline === buffer.length - 1) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + (buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1))
        if (utf8Bytes(line) > maxFrameBytes) throw new ProxyTransportError('frame-too-large', '代理模式响应帧超出上限')
        if (line.length === 0) {
          const event = flush()
          if (event !== undefined) yield event
          continue
        }
        if (line.startsWith(':')) continue
        frameBytes += utf8Bytes(line) + 1
        if (frameBytes > maxFrameBytes) throw new ProxyTransportError('frame-too-large', '代理模式响应帧超出上限')
        if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim() || undefined
        else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).replace(/^ /u, ''))
      }
      if (frameBytes + utf8Bytes(buffer) > maxFrameBytes) throw new ProxyTransportError('frame-too-large', '代理模式响应帧超出上限')
    }
    let tail: string
    try { tail = decoder.decode() } catch { throw new ProxyTransportError('invalid-response', '代理模式响应不是合法 UTF-8') }
    if (!sawSseFrame) plainText += tail
    buffer += tail
    if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1)
    if (buffer.length > 0) {
      frameBytes += utf8Bytes(buffer)
      if (frameBytes > maxFrameBytes) throw new ProxyTransportError('frame-too-large', '代理模式响应帧超出上限')
      if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /u, ''))
    }
    const event = flush()
    if (event !== undefined) yield event
    if (!sawSseFrame && plainText.trim().length > 0) yield { data: plainText.trim() }
  } catch (error) {
    if (error instanceof ProxyTransportError) throw error
    if (isAborted(options.signal)) throw cancelled()
    throw new ProxyTransportError('offline', '代理模式响应流读取失败')
  } finally {
    await cancelReader(reader)
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------- internals

async function connectTls(url: URL, resolveProxy: ProxyTransportOptions['resolveProxy'], timeoutMs: number, signal: AbortSignal | undefined): Promise<tls.TLSSocket> {
  const proxy = resolveProxy?.()
  if (proxy === undefined || matchesBypass(url.hostname, proxy.bypass)) {
    const socket = tls.connect({ host: url.hostname, port: Number(url.port || DEFAULT_HTTPS_PORT), servername: url.hostname })
    configureSocket(socket)
    await waitForConnect(socket, 'secureConnect', timeoutMs, signal)
    return socket
  }
  const proxyUrl = new URL(proxy.url)
  if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
    throw new ProxyTransportError('proxy-unsupported', `代理模式暂不支持 ${proxyUrl.protocol.replace(':', '')} 代理（官方 ACP 链路仍可用）；请改用 http 代理或关闭代理`, { accepted: false })
  }
  const proxyAuthorization = proxyAuthorizationHeader(proxyUrl)
  const secureProxy = proxyUrl.protocol === 'https:'
  const proxyAddress = { host: proxyUrl.hostname, port: Number(proxyUrl.port || (secureProxy ? DEFAULT_HTTPS_PORT : DEFAULT_PROXY_PORT)) }
  const proxySocket = secureProxy
    ? tls.connect({ ...proxyAddress, servername: net.isIP(proxyUrl.hostname) ? undefined : proxyUrl.hostname })
    : net.connect(proxyAddress)
  configureSocket(proxySocket)
  await waitForConnect(proxySocket, secureProxy ? 'secureConnect' : 'connect', timeoutMs, signal)
  const targetPort = Number(url.port || DEFAULT_HTTPS_PORT)
  proxySocket.write(
    `CONNECT ${url.hostname}:${targetPort} HTTP/1.1\r\n`
    + `Host: ${url.hostname}:${targetPort}\r\n`
    + proxyAuthorization
    + '\r\n',
  )
  const { head, leftover } = await waitForHead(proxySocket, timeoutMs, false, signal)
  if (!/^HTTP\/1\.[01]\s+2\d\d(?:\s|$)/u.test(head.split('\r\n', 1)[0] ?? '')) {
    proxySocket.destroy()
    throw new ProxyTransportError('offline', 'HTTP 代理拒绝了代理模式的 CONNECT 请求', { accepted: false })
  }
  if (leftover.byteLength > 0) proxySocket.unshift(leftover)
  proxySocket.resume()
  const socket = tls.connect({ socket: proxySocket, servername: url.hostname })
  configureSocket(socket)
  await waitForConnect(socket, 'secureConnect', timeoutMs, signal)
  return socket
}

function configureSocket(socket: Duplex): void {
  const plain = socket as net.Socket
  if (typeof plain.setNoDelay === 'function') plain.setNoDelay(true)
  if (typeof plain.setKeepAlive === 'function') plain.setKeepAlive(true, 15_000)
}

async function waitForConnect(socket: Duplex, event: 'connect' | 'secureConnect', timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener(event, onConnect)
      socket.removeListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
      action()
    }
    const onConnect = (): void => finish(resolve)
    const onError = (error: unknown): void => finish(() => reject(new ProxyTransportError('offline', '代理模式无法连通上游端点', { accepted: false, cause: error })))
    const onAbort = (): void => finish(() => { socket.destroy(); reject(cancelled(false)) })
    const timer = setTimeout(() => finish(() => {
      socket.destroy()
      reject(new ProxyTransportError('timeout', '代理模式连接上游超时', { accepted: false }))
    }), timeoutMs)
    socket.once(event, onConnect)
    socket.once('error', onError)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function waitForHead(socket: Duplex, timeoutMs: number, accepted: boolean, signal?: AbortSignal): Promise<{ head: string; leftover: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('end', onEnd)
      socket.removeListener('close', onEnd)
      signal?.removeEventListener('abort', onAbort)
      action()
    }
    const onError = (error: unknown): void => finish(() => reject(
      error instanceof ProxyTransportError
        ? error
        : new ProxyTransportError('offline', '上游在响应头之前关闭了连接', { accepted, cause: error }),
    ))
    const onAbort = (): void => finish(() => { socket.destroy(); reject(cancelled(accepted)) })
    const onEnd = (): void => finish(() => reject(new ProxyTransportError('offline', '上游在响应头之前关闭了连接', { accepted })))
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const marker = buffer.indexOf('\r\n\r\n')
      if (marker < 0) {
        if (buffer.byteLength > MAX_RESPONSE_HEAD_BYTES) finish(() => reject(new ProxyTransportError('protocol-drift', '上游响应头超出上限', { accepted })))
        return
      }
      if (marker > MAX_RESPONSE_HEAD_BYTES) {
        finish(() => reject(new ProxyTransportError('protocol-drift', '上游响应头超出上限', { accepted })))
        return
      }
      socket.pause()
      const head = buffer.subarray(0, marker).toString('latin1')
      const leftover = buffer.subarray(marker + 4)
      finish(() => resolve({ head, leftover }))
    }
    const timer = setTimeout(() => finish(() => {
      socket.destroy()
      reject(new ProxyTransportError('timeout', '代理模式等待响应头超时', { accepted }))
    }), timeoutMs)
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('end', onEnd)
    socket.once('close', onEnd)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

interface ParsedResponseHead {
  status: number
  statusText: string
  headers: Headers
  chunked: boolean
  gzip: boolean
  contentLength?: number
}

function parseResponseHead(value: string): ParsedResponseHead {
  const lines = value.split('\r\n')
  const statusLine = lines.shift() ?? ''
  const match = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+([^\r\n]*))?$/u.exec(statusLine)
  if (match === null) throw new ProxyTransportError('protocol-drift', '上游响应状态行格式错误')
  const status = Number(match[1])
  if (status < 200 || status > 599 || hasInvalidHeaderValue(match[2] ?? '')) throw new ProxyTransportError('protocol-drift', '上游响应状态不受支持')
  const headers = new Headers()
  let chunked = false
  let gzip = false
  let contentLength: number | undefined
  for (const line of lines) {
    if (line.length === 0 || /^[ \t]/u.test(line)) throw new ProxyTransportError('protocol-drift', '上游响应头格式错误')
    const separator = line.indexOf(':')
    if (separator <= 0) throw new ProxyTransportError('protocol-drift', '上游响应头格式错误')
    const name = line.slice(0, separator)
    const raw = line.slice(separator + 1).trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || hasInvalidHeaderValue(raw)) throw new ProxyTransportError('protocol-drift', '上游响应头格式错误')
    const lowerName = name.toLowerCase()
    const lowerValue = raw.toLowerCase()
    if (lowerName === 'transfer-encoding') {
      if (chunked || lowerValue !== 'chunked') throw new ProxyTransportError('protocol-drift', '上游响应分帧不受支持')
      chunked = true
      continue
    }
    if (lowerName === 'content-encoding') {
      if (gzip || lowerValue !== 'gzip') throw new ProxyTransportError('protocol-drift', '上游响应编码不受支持')
      gzip = true
      continue
    }
    if (lowerName === 'content-length') {
      if (contentLength !== undefined || !/^\d+$/u.test(raw)) throw new ProxyTransportError('protocol-drift', '上游响应长度歧义')
      const parsed = Number(raw)
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ProxyTransportError('protocol-drift', '上游响应长度格式错误')
      contentLength = parsed
      continue
    }
    headers.append(name, raw)
  }
  if (chunked && contentLength !== undefined) throw new ProxyTransportError('protocol-drift', '上游响应分帧歧义')
  if (!gzip && contentLength !== undefined) headers.set('content-length', String(contentLength))
  return { status, statusText: match[2] ?? '', headers, chunked, gzip, ...(contentLength === undefined ? {} : { contentLength }) }
}

function buildResponseBody(socket: Duplex, leftover: Buffer, head: ParsedResponseHead, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  const source = new PassThrough()
  let current: Readable = pipeStage(source, new ResponseByteLimit())
  if (head.chunked) current = pipeStage(current, new ChunkedDecoder())
  else if (head.contentLength !== undefined) current = pipeStage(current, new ContentLengthDecoder(head.contentLength))
  if (head.gzip) {
    current = pipeStage(current, createGunzip())
    current = pipeStage(current, new PassThrough(), (error) => {
      const zlibCode = (error as { code?: string }).code
      return zlibCode === 'Z_BUF_ERROR'
        ? new ProxyTransportError('offline', '上游 gzip 响应提前结束')
        : new ProxyTransportError('protocol-drift', '上游 gzip 响应格式错误')
    })
  }
  const abort = (): void => { source.destroy(cancelled()); socket.on('error', () => {}); socket.destroy() }
  const cleanup = (): void => { signal?.removeEventListener('abort', abort); socket.unpipe(source); source.destroy(); socket.destroy() }
  socket.once('error', (error) => source.destroy(
    error instanceof ProxyTransportError ? error : new ProxyTransportError('offline', '上游响应流中断'),
  ))
  if (leftover.byteLength > 0) source.write(leftover)
  socket.pipe(source)
  socket.resume()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  current.once('end', cleanup)
  current.once('error', cleanup)
  current.once('close', cleanup)
  return toWebBody(current, cleanup)
}

function toWebBody(stream: Readable, cancel: () => void): ReadableStream<Uint8Array> {
  const iterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => {
      const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>
      return {
        next: () => iterator.next(),
        return: async () => {
          cancel()
          stream.destroy()
          return iterator.return === undefined ? { done: true, value: undefined } : await iterator.return()
        },
      }
    },
  }
  return (ReadableStream as typeof ReadableStream & { from<T>(source: AsyncIterable<T> | Iterable<T>): ReadableStream<T> }).from(iterable)
}

function pipeStage(source: Readable, target: Transform, mapError: (error: Error) => Error = (error) => error): Readable {
  source.once('error', (error) => target.destroy(mapError(error)))
  return source.pipe(target)
}

class ResponseByteLimit extends Transform {
  private total = 0
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.total += chunk.byteLength
    if (this.total > PROXY_RESPONSE_BYTES) { callback(new ProxyTransportError('response-too-large', '代理模式响应超出字节上限')); return }
    this.push(chunk)
    callback()
  }
}

class ContentLengthDecoder extends Transform {
  private remaining: number
  constructor(contentLength: number) {
    super()
    this.remaining = contentLength
    if (contentLength === 0) this.push(null)
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error: Error | null, ) => void): void {
    if (this.remaining <= 0 || chunk.byteLength > this.remaining) {
      callback(new ProxyTransportError('protocol-drift', '上游响应超出声明长度'))
      return
    }
    this.remaining -= chunk.byteLength
    this.push(chunk)
    if (this.remaining === 0) this.push(null)
    callback(null)
  }
  override _flush(callback: (error: Error | null) => void): void {
    callback(this.remaining === 0 ? null : new ProxyTransportError('offline', '上游响应在声明长度前结束'))
  }
}

class ChunkedDecoder extends Transform {
  private buffer = Buffer.alloc(0)
  private finished = false
  private remaining: number | undefined
  private needsTerminator = false
  private readingTrailers = false
  private trailerBytes = 0
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.finished && chunk.byteLength > 0) {
      callback(new ProxyTransportError('protocol-drift', '上游 chunked 响应含尾随字节'))
      return
    }
    this.buffer = Buffer.concat([this.buffer, chunk])
    try {
      this.flushChunks()
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new ProxyTransportError('protocol-drift', '上游 chunked 响应格式错误'))
    }
  }
  override _flush(callback: (error?: Error | null) => void): void {
    try {
      this.flushChunks()
      callback(this.finished ? null : new ProxyTransportError('offline', '上游 chunked 响应提前结束'))
    } catch (error) {
      callback(error instanceof Error ? error : new ProxyTransportError('protocol-drift', '上游 chunked 响应格式错误'))
    }
  }
  private flushChunks(): void {
    while (!this.finished) {
      if (this.readingTrailers) {
        const end = this.buffer.indexOf('\r\n')
        if (end < 0) {
          if (this.trailerBytes + this.buffer.byteLength > MAX_RESPONSE_HEAD_BYTES) throw new ProxyTransportError('protocol-drift', '上游 trailer 超出上限')
          return
        }
        this.trailerBytes += end + 2
        if (this.trailerBytes > MAX_RESPONSE_HEAD_BYTES) throw new ProxyTransportError('protocol-drift', '上游 trailer 超出上限')
        const line = this.buffer.subarray(0, end).toString('latin1')
        this.buffer = this.buffer.subarray(end + 2)
        if (line.length === 0) {
          if (this.buffer.byteLength > 0) throw new ProxyTransportError('protocol-drift', '上游 chunked 响应含尾随字节')
          this.finished = true
          this.push(null)
          return
        }
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t\x20-\x7E\x80-\xFF]*$/u.test(line)) throw new ProxyTransportError('protocol-drift', '上游 trailer 格式错误')
        continue
      }
      if (this.needsTerminator) {
        if (this.buffer.byteLength < 2) return
        if (this.buffer[0] !== 0x0d || this.buffer[1] !== 0x0a) throw new ProxyTransportError('protocol-drift', '上游 chunk 结束符格式错误')
        this.buffer = this.buffer.subarray(2)
        this.needsTerminator = false
      }
      if (this.remaining !== undefined) {
        const length = Math.min(this.remaining, this.buffer.byteLength)
        if (length === 0) return
        this.push(this.buffer.subarray(0, length))
        this.buffer = this.buffer.subarray(length)
        this.remaining -= length
        if (this.remaining > 0) return
        this.remaining = undefined
        this.needsTerminator = true
        continue
      }
      const lineEnd = this.buffer.indexOf('\r\n')
      if (lineEnd < 0) {
        if (this.buffer.byteLength > MAX_RESPONSE_HEAD_BYTES) throw new ProxyTransportError('protocol-drift', '上游 chunk 尺寸行超出上限')
        return
      }
      if (lineEnd > MAX_RESPONSE_HEAD_BYTES) throw new ProxyTransportError('protocol-drift', '上游 chunk 尺寸行超出上限')
      const sizeText = this.buffer.subarray(0, lineEnd).toString('latin1').split(';', 1)[0]?.trim() ?? ''
      if (!/^[0-9A-Fa-f]+$/u.test(sizeText)) throw new ProxyTransportError('protocol-drift', '上游 chunk 尺寸格式错误')
      const size = Number.parseInt(sizeText, 16)
      if (!Number.isSafeInteger(size) || size < 0) throw new ProxyTransportError('protocol-drift', '上游 chunk 尺寸格式错误')
      this.buffer = this.buffer.subarray(lineEnd + 2)
      if (size === 0) {
        this.readingTrailers = true
        continue
      }
      this.remaining = size
    }
  }
}

type ReadResult = { done: true; value?: undefined } | { done: false; value: Uint8Array }

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, options: BoundedReadOptions, startedAt: number): Promise<ReadResult> {
  if (isAborted(options.signal)) {
    await cancelReader(reader)
    throw cancelled()
  }
  const totalTimeout = boundedTimeout(options.totalTimeoutMs, PROXY_TOTAL_TIMEOUT_MS)
  const elapsed = Date.now() - startedAt
  if (elapsed >= totalTimeout) {
    await cancelReader(reader)
    throw new ProxyTransportError('timeout', '代理模式响应超出总时长上限')
  }
  const idleTimeout = boundedTimeout(options.idleTimeoutMs, PROXY_IDLE_TIMEOUT_MS)
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbort: (() => void) | undefined
  const abort = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(cancelled())
    removeAbort = () => options.signal?.removeEventListener('abort', onAbort)
    if (options.signal === undefined) return
    if (options.signal.aborted) onAbort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  })
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProxyTransportError('timeout', '代理模式响应流停滞')), idleTimeout)
  })
  let totalHandle: ReturnType<typeof setTimeout> | undefined
  const total = new Promise<never>((_, reject) => {
    totalHandle = setTimeout(() => reject(new ProxyTransportError('timeout', '代理模式响应超出总时长上限')), totalTimeout - elapsed)
  })
  try {
    return await Promise.race([reader.read(), abort, idle, total]) as ReadResult
  } catch (error) {
    await cancelReader(reader)
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (totalHandle !== undefined) clearTimeout(totalHandle)
    removeAbort?.()
  }
}

function proxyAuthorizationHeader(proxy: URL): string {
  if (proxy.username.length === 0) return ''
  let username: string
  let password: string
  try {
    username = decodeURIComponent(proxy.username)
    password = decodeURIComponent(proxy.password)
  } catch {
    throw new ProxyTransportError('offline', '代理凭据无效', { accepted: false })
  }
  if (username.length > 1024 || password.length > 1024 || username.includes(':') || hasInvalidHeaderValue(username) || hasInvalidHeaderValue(password)) {
    throw new ProxyTransportError('offline', '代理凭据无效', { accepted: false })
  }
  return `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}\r\n`
}

function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength }
function isAborted(signal: AbortSignal | undefined): boolean { return signal !== undefined && signal.aborted }
async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> { try { await reader.cancel() } catch { /* best effort */ } }
function cancelled(accepted = true): ProxyTransportError { return new ProxyTransportError('cancelled', '代理模式请求已取消', { accepted }) }
function boundedTimeout(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : Math.min(Math.floor(value), 10 * 60 * 1000)
}
function boundedBytes(value: number | undefined, fallback: number, cap: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : Math.min(Math.floor(value), cap)
}
function hasInvalidHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true
  }
  return false
}
