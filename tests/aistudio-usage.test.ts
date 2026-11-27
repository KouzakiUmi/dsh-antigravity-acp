import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AistudioAdapter } from '../src/aistudio/adapter.js'
import { AISTUDIO_MINUTE_CAP, AISTUDIO_MODEL_CAP, AistudioUsageStore } from '../src/aistudio/usage.js'
import type { AdapterRequestOptions } from '../src/adapter/request-options.js'

const model = 'aistudio-gemini-4-flash'
const wire = 'gemini-4-flash'
const options: AdapterRequestOptions = { provider: 'aistudio', model, messages: [createUserMessage({ content: [{ type: 'text', text: 'synthetic' }], source: { kind: 'user' } })] }
const snapshot = (usageMetadata: Record<string, number>) => ({ usageMetadata })
const stop = { candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }
const sse = (...frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join(''))
const collect = async (adapter: AistudioAdapter, input = options) => { for await (const _ of adapter.stream(input)) { /* consume */ } }
const limited = (message: string) => ({ code: 429, status: 'RESOURCE_EXHAUSTED', message, details: [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: message, quotaDimensions: { secret: message } }] },
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1.250s' },
] })

afterEach(() => vi.useRealTimers())

describe('AI Studio 的生成尝试、上游输入 token 和 429', () => {
  it('只计实际派发；按真实线模型投影；取最后一次已报告值而非累加帧', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [] })))
      .mockResolvedValueOnce(sse(snapshot({ promptTokenCount: 9 }), snapshot({ promptTokenCount: 12, cachedContentTokenCount: 4 }), stop, snapshot({ candidatesTokenCount: 5 })))
      .mockResolvedValueOnce(sse(stop, snapshot({ promptTokenCount: 0 })))
      .mockResolvedValueOnce(sse(stop, snapshot({ candidatesTokenCount: 2 })))
      .mockRejectedValueOnce(new Error('network failure'))
    const adapter = new AistudioAdapter({ credential: async () => 'mock-A', fetch, readSettings: () => ({ modelOverrides: { [model]: { target: 'gemini-4-flash-alias' } } }) })
    await adapter.discoverModels()
    const cancel = new AbortController()
    cancel.abort()
    await collect(adapter, { ...options, signal: cancel.signal })
    await expect(collect(adapter, { ...options, maxTokens: -1 })).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await adapter.readUsage()).toMatchObject({ today: { requests: 0, inputTokens: null, reportedRequests: 0 } })
    await collect(adapter)
    await collect(adapter, { ...options, model: 'aistudio-gemini-4-pro' })
    await collect(adapter, { ...options, model: 'aistudio-gemini-4-ultra' })
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'TRANSPORT' })
    expect(await adapter.readUsage()).toMatchObject({
      minute: { requests: 4, inputTokens: 12, reportedRequests: 2 },
      today: { requests: 4, inputTokens: 12, reportedRequests: 2 },
      models: expect.arrayContaining([
        expect.objectContaining({ model: 'gemini-4-flash-alias', today: { requests: 2, inputTokens: 12, reportedRequests: 1 } }),
        expect.objectContaining({ model: 'gemini-4-pro', today: { requests: 1, inputTokens: 0, reportedRequests: 1 } }),
        expect.objectContaining({ model: 'gemini-4-ultra', today: { requests: 1, inputTokens: null, reportedRequests: 0 } }),
      ]),
    })
  })

  it('HTTP 和 SSE 429 保留时间与结构化提示，错误不回显认证文本', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const secret = 'long-synthetic-credential'
    const credentialError = `private ${secret} x-goog-api-key: OTHER-SECRET`
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: limited(credentialError) }), { status: 429, headers: { 'Retry-After': '3' } }))
      .mockResolvedValueOnce(sse(snapshot({ promptTokenCount: 8 }), { error: limited(credentialError) }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: credentialError } }), { status: 403 }))
    const adapter = new AistudioAdapter({ credential: async () => secret, fetch })
    vi.setSystemTime(new Date('2026-11-27T12:00:00Z'))
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'RATE_LIMIT', message: 'AI Studio 上游错误（429）' })
    expect(await adapter.readUsage()).toMatchObject({ last429: { at: '2026-11-27T12:00:00.000Z', source: 'http', model: wire, retryAfterMs: 3000, quotaFailure: true } })
    vi.setSystemTime(new Date('2026-11-27T12:00:01Z'))
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    expect(JSON.stringify(chunks)).not.toContain(secret)
    expect(JSON.stringify(chunks)).not.toContain('OTHER-SECRET')
    const usage = await adapter.readUsage()
    expect(usage).toMatchObject({
      last429: { at: '2026-11-27T12:00:01.000Z', source: 'sse', model: wire, retryAfterMs: 1250, quotaFailure: true },
      today: { requests: 2, inputTokens: 8, reportedRequests: 1 },
    })
    expect(JSON.stringify(usage)).not.toContain(secret)
    await expect(collect(adapter)).rejects.toMatchObject({ message: 'AI Studio 上游错误（403）：private *** x-goog-api-key: ***' })
  })

  it('同引用实际值更换、清空和回切时，旧在途 429/token 不污染新一代', async () => {
    let key: string | undefined = 'mock-A'
    let deliver!: (response: Response) => void
    let started!: () => void
    const pending = new Promise<Response>(resolve => { deliver = resolve })
    const present = new Promise<void>(resolve => { started = resolve })
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(() => { started(); return pending })
      .mockResolvedValueOnce(sse(stop, snapshot({ promptTokenCount: 3 })))
    const adapter = new AistudioAdapter({ credential: async () => key, fetch })
    const prior = collect(adapter)
    await present
    expect(await adapter.readUsage()).toMatchObject({ today: { requests: 1 } })
    key = 'mock-B'
    expect(await adapter.readUsage()).toMatchObject({ today: { requests: 0 } })
    await collect(adapter)
    key = undefined
    expect(await adapter.readUsage()).toEqual({ status: 'unconfigured' })
    key = 'mock-A'
    expect(await adapter.readUsage()).toMatchObject({ today: { requests: 0 } })
    deliver(sse(snapshot({ promptTokenCount: 600 }), { error: limited('old') }))
    await prior
    const result = await adapter.readUsage()
    expect(result).toMatchObject({ today: { requests: 0, inputTokens: null, reportedRequests: 0 } })
    expect(result).not.toHaveProperty('last429')
  })

  it('代理本地准备失败不计，旧凭据冷准备后阻止调 HTTP 客户端', async () => {
    let notifyWaiting!: () => void
    let unblock!: () => void
    const waiting = new Promise<void>(resolve => { notifyWaiting = resolve })
    const ready = new Promise<void>(resolve => { unblock = resolve })
    const fetch = vi.fn<typeof globalThis.fetch>()
    let key = 'mock-A'
    const adapter = new AistudioAdapter({ credential: async () => key, fetch,
      dispatch: vi.fn<NonNullable<ConstructorParameters<typeof AistudioAdapter>[0]['dispatch']>>()
        .mockRejectedValueOnce(new Error('local init failed'))
        .mockImplementationOnce(async (input, init, onDispatch) => { notifyWaiting(); await ready; onDispatch(); return fetch(input, init) }),
    })
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'TRANSPORT' })
    expect(await adapter.readUsage()).toMatchObject({ today: { requests: 0 } })
    const prior = collect(adapter)
    await waiting
    key = 'mock-B'
    expect(await adapter.readUsage()).toMatchObject({ today: { requests: 0 } })
    unblock()
    await prior
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('AI Studio 本地统计窗口与上限', () => {
  it('按 Pacific 夏令时午夜分日，滚动一分钟保留前一日刚发出的请求', () => {
    let now = Date.parse('2026-07-01T06:59:55Z')
    const store = new AistudioUsageStore(() => now)
    const digest = store.fingerprint('mock')
    store.activate(digest)
    const attempt = store.start(digest, wire)!
    expect(store.snapshot().pacificDay).toBe('2026-06-30')
    now += 5000
    store.reportInput(attempt, 0)
    expect(store.snapshot()).toMatchObject({ pacificDay: '2026-07-01', minute: { requests: 1, inputTokens: 0 }, today: { requests: 0, inputTokens: null } })
    now += 55000
    expect(store.snapshot()).toMatchObject({ minute: { requests: 0, inputTokens: null }, models: [] })
  })

  it('高流量裁剪 minute 并保留 day 统计，模型超限归并，过期旧 request 不复活', () => {
    let now = Date.parse('2026-11-27T12:00:00Z')
    const store = new AistudioUsageStore(() => now)
    const digest = store.fingerprint('mock')
    store.activate(digest)
    const first = store.start(digest, wire)!
    for (let i = 0; i < AISTUDIO_MINUTE_CAP; i++) store.start(digest, `model-${i}`)
    store.reportInput(first, 17)
    const overflow = store.snapshot()
    expect(overflow).toMatchObject({ minuteTruncated: true, today: { requests: AISTUDIO_MINUTE_CAP + 1, inputTokens: 17 }, minute: { requests: AISTUDIO_MINUTE_CAP, inputTokens: null } })
    expect(overflow.models.length).toBeLessThanOrEqual(AISTUDIO_MODEL_CAP + 1)
    expect(overflow.models.some(row => row.model === null)).toBe(true)
    now += 48 * 60 * 60 * 1000
    store.activate(digest)
    store.record429(first, 'http', {})
    expect(store.snapshot()).toMatchObject({ minuteTruncated: false, today: { requests: 0 }, models: [] })
    expect(store.snapshot()).not.toHaveProperty('last429')
  })
})
