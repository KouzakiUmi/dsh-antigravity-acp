import { createServer } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { createLiveProxiedFetch, createProxiedFetch, PROXY_CLOSE_TIMEOUT_MS } from '../src/runtime/proxied-fetch.js'
import type { UndiciLike } from '../src/runtime/proxied-fetch.js'

describe('explicit proxy safety', () => {
  it('保存后的代理切换和清空用于后续请求，不中断旧响应且卸载全部释放', async () => {
    let proxy: { url: string; bypass: string } | undefined = { url: 'http://localhost:7890', bypass: '' }
    const agents: Array<{ uri: string; destroy: ReturnType<typeof vi.fn> }> = []
    const fallback = vi.fn(async () => new Response('host route'))
    const request = createLiveProxiedFetch(() => proxy, {
      fallback,
      loadUndici: async () => ({
        ProxyAgent: class {
          uri: string
          destroy = vi.fn(async () => {})
          constructor(options: { uri: string }) { this.uri = options.uri; agents.push(this) }
        },
        fetch: async () => new Response('proxy route'),
      }),
    })
    const first = await request('https://example.invalid/')
    proxy = { url: 'http://localhost:7891', bypass: '' }
    await request('https://example.invalid/')
    expect(agents.map(agent => agent.uri)).toEqual(['http://localhost:7890/', 'http://localhost:7891/'])
    expect(agents.every(agent => agent.destroy.mock.calls.length === 0)).toBe(true)
    expect(await first.text()).toBe('proxy route')
    proxy = undefined
    expect(await (await request('https://example.invalid/')).text()).toBe('host route')
    expect(fallback).toHaveBeenCalledTimes(1)
    await Promise.all([request.close(), request.close()])
    expect(agents.every(agent => agent.destroy.mock.calls.length === 1)).toBe(true)
    await expect(request('https://example.invalid/')).rejects.toThrow('已关闭')
  })

  it('never falls back when the configured proxy rejects a request', async () => {
    let fallbackCalls = 0
    const request = createProxiedFetch({ url: 'http://localhost:7890', bypass: '' }, {
      fallback: async () => { fallbackCalls += 1; return new Response('wrong route') },
      loadUndici: async () => ({ ProxyAgent: class {}, fetch: async () => { throw new Error('proxy refused') } }),
    })
    await expect(request('https://example.invalid/')).rejects.toThrow('proxy refused')
    expect(fallbackCalls).toBe(0)
  })

  it('rejects instead of throwing synchronously when the saved proxy becomes invalid', async () => {
    // readProxy 按最新设置解析；用户把地址改坏后，下一次取数必须拿到 rejected
    // promise（fetch 契约），否则调用方的 .catch()/.then(onError) 收不到它。
    const invalid = (): never => { throw new Error('代理地址无法解析') }
    const request = createLiveProxiedFetch(invalid, { fallback: async () => new Response('host route') })
    let thrown: unknown
    let pending: Promise<Response> | undefined
    try {
      pending = request('https://example.invalid/')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeUndefined()
    await expect(pending).rejects.toThrow('代理地址无法解析')
    await request.close()
  })

  it('closes a lazily created dispatcher exactly once', async () => {
    let closeCount = 0
    const request = createProxiedFetch({ url: 'http://localhost:7890', bypass: '' }, {
      loadUndici: async () => ({ ProxyAgent: class { async close() { closeCount += 1 } }, fetch: async () => new Response('ok') }),
    })
    await request('https://example.invalid/')
    await Promise.all([request.close(), request.close()])
    expect(closeCount).toBe(1)
    await expect(request('https://example.invalid/')).rejects.toThrow(/已关闭/)
  })

  it('prefers immediate destruction over draining an unread response body', async () => {
    let destroyed = 0
    const request = createProxiedFetch({ url: 'http://localhost:7890', bypass: '' }, {
      loadUndici: async () => ({
        ProxyAgent: class {
          async destroy() { destroyed += 1 }
          close(): Promise<void> { return new Promise(() => undefined) }
        },
        fetch: async () => new Response('unread error body', { status: 503 }),
      }),
    })
    await request('https://example.invalid/')
    await request.close()
    expect(destroyed).toBe(1)
  })

  it('bounds cleanup even when a dispatcher never confirms destruction', async () => {
    vi.useFakeTimers()
    try {
      const request = createProxiedFetch({ url: 'http://localhost:7890', bypass: '' }, {
        loadUndici: async () => ({ ProxyAgent: class { destroy(): Promise<void> { return new Promise(() => undefined) } }, fetch: async () => new Response('ok') }),
      })
      await request('https://example.invalid/')
      const closed = expect(request.close()).rejects.toThrow(/回收超时/)
      await vi.advanceTimersByTimeAsync(PROXY_CLOSE_TIMEOUT_MS)
      await closed
    } finally { vi.useRealTimers() }
  })

  it('decodes proxy authentication without exposing credentials in the HTTP URI', async () => {
    const captured: Array<ConstructorParameters<UndiciLike['ProxyAgent']>[0]> = []
    const loadUndici = async (): Promise<UndiciLike> => ({
      ProxyAgent: class { constructor(options: ConstructorParameters<UndiciLike['ProxyAgent']>[0]) { captured.push(options) } },
      fetch: async () => new Response('ok'),
    })
    const http = createProxiedFetch({ url: 'http://alice:p%40ss@localhost:7890', bypass: '' }, { loadUndici })
    await http('https://example.invalid/')
    expect(captured[0]).toEqual({ uri: 'http://localhost:7890/', token: `Basic ${Buffer.from('alice:p@ss').toString('base64')}` })
    const socks = createProxiedFetch({ url: 'socks5h://alice:p%40ss@localhost:1080', bypass: '' }, { loadUndici })
    await socks('https://example.invalid/')
    expect(captured[1]).toMatchObject({ uri: 'socks5://alice:p%40ss@localhost:1080', username: 'alice', password: 'p@ss' })
  })

  it('real undici SOCKS5H sends the destination hostname to the local proxy', async () => {
    const sockets = new Set<Socket>()
    let destination: string | undefined
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => undefined)
      let stage = 0
      let buffered = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buffered = Buffer.concat([buffered, chunk])
        if (stage === 0 && buffered.length >= 2 + buffered[1]!) {
          buffered = buffered.subarray(2 + buffered[1]!)
          stage = 1
          socket.write(Buffer.from([5, 0]))
        }
        if (stage === 1 && buffered.length >= 5 && buffered[3] === 3 && buffered.length >= 7 + buffered[4]!) {
          destination = buffered.subarray(5, 5 + buffered[4]!).toString()
          buffered = buffered.subarray(7 + buffered[4]!)
          stage = 2
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]))
        }
        if (stage === 2 && buffered.includes('\r\n\r\n')) {
          stage = 3
          socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const request = createProxiedFetch({ url: `socks5h://127.0.0.1:${(server.address() as AddressInfo).port}`, bypass: '' })
    try {
      const response = await request('http://proxy-only.invalid/', { signal: AbortSignal.timeout(3000) })
      expect(await response.text()).toBe('ok')
      expect(destination).toBe('proxy-only.invalid')
    } finally {
      for (const socket of sockets) socket.destroy()
      await request.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
