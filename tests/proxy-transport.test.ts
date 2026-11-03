import { createServer } from 'node:net'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { Duplex } from 'node:stream'
import * as tls from 'node:tls'
import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { createProxyTransport, iterateProxySse, readProxyText } from '../src/proxy/transport.js'
import { resolveHttpsProxy } from '../src/runtime/proxy-env.js'

vi.mock('node:tls', async original => {
  const actual = await original<typeof import('node:tls')>()
  return { ...actual, connect: vi.fn(actual.connect) }
})

const url = 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'

/** A local in-memory TLS peer; no certificates, credentials, or remote I/O. */
function syntheticPeer(onRequest: (socket: Duplex) => void): Duplex {
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, done) { done(); queueMicrotask(() => onRequest(socket)) },
  })
  vi.mocked(tls.connect).mockImplementationOnce(() => {
    queueMicrotask(() => socket.emit('secureConnect'))
    return socket as tls.TLSSocket
  })
  return socket
}

async function sseData(response: Response, maxFrameBytes?: number): Promise<string[]> {
  const data: string[] = []
  for await (const event of iterateProxySse(response, { idleTimeoutMs: 1000, maxFrameBytes })) data.push(event.data)
  return data
}

describe('代理模式的 HTTP 与 HTTPS 代理连接', () => {
  it('插件地址留空时，原生 TLS 请求实际向环境代理发送 CONNECT', async () => {
    const controller = new AbortController()
    let packet = ''
    const server = createServer(socket => {
      socket.on('error', () => {})
      socket.once('data', bytes => { packet = bytes.toString('ascii'); controller.abort(); socket.destroy() })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const port = (server.address() as AddressInfo).port
      const transport = createProxyTransport({ resolveProxy: () => resolveHttpsProxy({ url: '' }, { HTTPS_PROXY: `http://127.0.0.1:${port}` }) })
      await expect(transport.request({ url, body: '{}', signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
      expect(packet).toMatch(/^CONNECT daily-cloudcode-pa\.googleapis\.com:443 HTTP\/1\.1/)
      expect(packet).not.toContain('Authorization')
    } finally {
      controller.abort()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  it('目标命中排除列表时不连接出网代理', async () => {
    syntheticPeer(peer => { peer.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}')); peer.push(null) })
    const response = await createProxyTransport({ resolveProxy: () => ({ url: 'http://unreachable.invalid:7890', bypass: '*.googleapis.com' }) }).request({ url, body: '{}' })
    expect(await readProxyText(response)).toBe('{}')
  })
  it.each(['http', 'https'])('%s 代理先使用对应的握手协议', async protocol => {
    const controller = new AbortController()
    let firstPacket = Buffer.alloc(0)
    const server = createServer(socket => {
      socket.on('error', () => {})
      socket.once('data', bytes => {
        firstPacket = bytes
        controller.abort()
        socket.destroy()
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const port = (server.address() as AddressInfo).port
      const transport = createProxyTransport({ resolveProxy: () => ({ url: `${protocol}://127.0.0.1:${port}`, bypass: '' }) })
      await expect(transport.request({
        url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
        accessToken: 'synthetic', body: '{}', signal: controller.signal,
      })).rejects.toMatchObject({ code: 'cancelled' })
      if (protocol === 'https') {
        expect(firstPacket[0]).toBe(0x16) // TLS ClientHello
        expect(firstPacket[1]).toBe(0x03)
      } else expect(firstPacket.toString('ascii')).toMatch(/^CONNECT daily-cloudcode-pa\.googleapis\.com:443 HTTP\/1\.1/)
    } finally {
      controller.abort()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('代理模式完整 HTTP 响应', () => {
  it('响应头前正常 EOF 立即报 offline，不等待头超时', async () => {
    syntheticPeer(socket => socket.push(null))
    await expect(createProxyTransport({ responseHeaderTimeoutMs: 1000 }).request({ url, accessToken: 'synthetic', body: '{}' })).rejects.toMatchObject({ code: 'offline', accepted: true })
  })

  it('chunked + gzip 支持拆包、扩展与合法 trailer', async () => {
    const encoded = gzipSync(Buffer.from('data: {"text":"你好"}\n\ndata: [DONE]\n\n'))
    const body = Buffer.concat([Buffer.from(`${encoded.length.toString(16)};synthetic=yes\r\n`), encoded, Buffer.from('\r\n0\r\nX-Synthetic: ok\r\n\r\n')])
    const socket = syntheticPeer(peer => {
      peer.push(Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Encoding: gzip\r\n\r\n'))
      for (let index = 0; index < body.length; index += 3) peer.push(body.subarray(index, index + 3))
    })
    const response = await createProxyTransport().request({ url, accessToken: 'synthetic', body: '{}' })
    expect(await sseData(response)).toEqual(['{"text":"你好"}', '[DONE]'])
    expect(socket.destroyed).toBe(true)
  })

  it('未结束的大 HTTP chunk 也会增量输出 SSE', async () => {
    const socket = syntheticPeer(peer => {
      peer.push(Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n100000\r\ndata: {"text":"early"}\n\n'))
    })
    const response = await createProxyTransport().request({ url, body: '{}' })
    const events = iterateProxySse(response, { idleTimeoutMs: 100 })
    expect(await events.next()).toMatchObject({ value: { data: '{"text":"early"}' }, done: false })
    await events.return(undefined)
    expect(socket.destroyed).toBe(true)
  })

  it('超大且未结束的 HTTP chunk 受响应字节预算约束', async () => {
    syntheticPeer(peer => {
      peer.push(Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\na00000\r\n'))
      peer.push(Buffer.alloc(9 * 1024 * 1024))
    })
    const response = await createProxyTransport().request({ url, body: '{}' })
    await expect(readProxyText(response, { idleTimeoutMs: 1000 })).rejects.toMatchObject({ code: 'response-too-large' })
  })

  it('Content-Length 截断与 chunked 截断都报告 offline', async () => {
    for (const raw of [
      'HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\nshort',
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8\r\nshort',
    ]) {
      syntheticPeer(peer => { peer.push(Buffer.from(raw)); peer.push(null) })
      const response = await createProxyTransport().request({ url, body: '{}' })
      await expect(readProxyText(response, { idleTimeoutMs: 1000 })).rejects.toMatchObject({ code: 'offline' })
    }
  })

  it('响应体取消即时关闭底层连接', async () => {
    const controller = new AbortController()
    const socket = syntheticPeer(peer => peer.push(Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n')))
    const response = await createProxyTransport().request({ url, body: '{}', signal: controller.signal })
    const reading = readProxyText(response, { signal: controller.signal, idleTimeoutMs: 1000 })
    controller.abort()
    await expect(reading).rejects.toMatchObject({ code: 'cancelled' })
    expect(socket.destroyed).toBe(true)
  })

  it('SSE 接受 CR 换行及分片 UTF-8，未换行的超长帧也及时失败', async () => {
    const data = new TextEncoder().encode('data: 你好\r\rdata: [DONE]\r\r')
    const response = new Response(new ReadableStream({ start(controller) {
      for (let index = 0; index < data.length; index++) controller.enqueue(data.subarray(index, index + 1))
      controller.close()
    } }))
    expect(await sseData(response)).toEqual(['你好', '[DONE]'])
    await expect(sseData(new Response('data: ' + 'x'.repeat(100)), 16)).rejects.toMatchObject({ code: 'frame-too-large' })
  })
})
