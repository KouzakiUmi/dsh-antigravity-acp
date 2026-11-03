import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createAssistantMessage, createToolResultMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { AntigravityProxyAdapter, PROXY_PROVIDER_ID } from '../src/proxy/adapter.js'
import { ProxyTransportError } from '../src/proxy/transport.js'
import { buildProxyGeneratePayload, createProxySessionStore } from '../src/proxy/payload.js'
import type { AntigravityHostConfig } from '../src/settings.js'
import type { ProxyAttachmentReader } from '../src/proxy/image.js'

const model = 'antigravity-gemini-3.8-flash'
const options: GenerateOptions = { provider: PROXY_PROVIDER_ID, model, messages: [] }
const event = (parts: unknown[], finishReason?: string) => ({ response: { candidates: [{ content: { parts }, finishReason }] } })
function adapter(events: unknown[]) {
  return new AntigravityProxyAdapter({
    credential: { credential: async () => ({ accessToken: 'synthetic', source: 'login', updatedAt: 'x' }) },
    transport: { request: async () => new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join('')) },
  })
}
async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('代理模式流式工具与签名', () => {
  it('设置页强制刷新绕过代理目录缓存，发现失败向设置页报告', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ models: { 'gemini-3.8-flash': {} } })))
    const instance = new AntigravityProxyAdapter({
      credential: { credential: async () => ({ accessToken: 'synthetic', source: 'login', updatedAt: 'x' }) },
      transport: { request },
    })
    expect((await instance.discoverModels()).some(row => row.id === model)).toBe(true)
    await instance.discoverModels()
    expect(request).toHaveBeenCalledTimes(1)
    await instance.discoverModels(true)
    expect(request).toHaveBeenCalledTimes(2)
    request.mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    await expect(instance.discoverModels(true)).rejects.toMatchObject({ code: 'UPSTREAM' })
  })
  it.each([false, true])('省略 id 的并行调用保持独立，跨 SSE 帧=%s', async (separateFrames) => {
    const parts = ['Paris', 'London'].map(city => ({ functionCall: { name: 'weather', args: { city } } }))
    const events = separateFrames ? parts.map(part => event([part], 'STOP')) : [event(parts, 'STOP')]
    const chunks = await collect(adapter(events).stream(options))
    const calls = chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block] : [])
    expect(calls.map(call => JSON.parse(call.arguments))).toEqual([{ city: 'Paris' }, { city: 'London' }])
    expect(new Set(calls.map(call => call.id)).size).toBe(2)
  })

  it('不同 id 的完整调用和同 id 的字符串参数分片都可组装', async () => {
    const chunks = await collect(adapter([
      event([{ functionCall: { id: 'one', name: 'weather', args: '{"city":' } }]),
      event([{ functionCall: { id: 'one', args: '"Paris"}' } }]),
      event([{ functionCall: { id: 'two', name: 'weather', args: { city: 'London' } } }], 'STOP'),
    ]).stream(options))
    const calls = chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block] : [])
    expect(calls.map(call => [call.id, JSON.parse(call.arguments)])).toEqual([
      ['one', { city: 'Paris' }], ['two', { city: 'London' }],
    ])
  })

  it('省略 args 的零参数并行调用独立，跨轮自动 id 不重用', async () => {
    const instance = adapter([event([{ functionCall: { name: 'ping' } }, { functionCall: { name: 'pong' } }], 'STOP')])
    const ids: string[] = []
    for (let round = 0; round < 2; round++) {
      const chunks = await collect(instance.stream(options))
      const calls = chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block] : [])
      expect(calls.map(call => [call.name, JSON.parse(call.arguments)])).toEqual([['ping', {}], ['pong', {}]])
      ids.push(...calls.map(call => call.id))
    }
    expect(new Set(ids).size).toBe(4)
  })

  it.each(['reasoning', 'text'] as const)('%s 块的后到签名进入历史回放元数据', async (kind) => {
    const thought = kind === 'reasoning'
    const chunks = await collect(adapter([
      event([{ text: 'first', thought }]),
      event([{ text: '', thought, thoughtSignature: 'late-signature' }], 'STOP'),
    ]).stream(options))
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish?.replayState?.blocks).toEqual([{ kind, signature: 'late-signature' }])
  })

  it('工具 STOP 结束为 tool-calls，真实宿主结果可回填续轮', async () => {
    const chunks = await collect(adapter([event([
      { functionCall: { name: 'read', args: { path: 'a' } }, thoughtSignature: 'tool-signature' },
      { functionCall: { name: 'read', args: { path: 'b' } } },
    ], 'STOP')]).stream(options))
    const calls = chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block] : [])
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish?.reason.kind).toBe('tool-calls')
    const assistant = createAssistantMessage({ content: calls, source: { provider: PROXY_PROVIDER_ID, model, replayState: finish?.replayState } })
    const results = calls.map((call, index) => createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: index === 0 ? 'found' : 'missing' }], isError: index === 1 }))
    const payload = await buildProxyGeneratePayload({ ...options, messages: [assistant, ...results] }, {}, createProxySessionStore(), 1)
    expect(payload.request.contents).toEqual([
      { role: 'model', parts: [
        { functionCall: { name: 'read', args: { path: 'a' } }, thoughtSignature: 'tool-signature' },
        { functionCall: { name: 'read', args: { path: 'b' } }, thoughtSignature: 'skip_thought_signature_validator' },
      ] },
      { role: 'user', parts: [{ functionResponse: { name: 'read', response: { content: 'found' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read', response: { error: 'missing' } } }] },
    ])
  })

  it('无 thought 标记的后到 8KB 签名仍属于原 thinking 块', async () => {
    const signature = 's'.repeat(8192)
    const chunks = await collect(adapter([
      event([{ text: 'thinking', thought: true }]),
      event([{ thoughtSignature: signature }]),
      event([{ text: 'answer' }], 'STOP'),
    ]).stream({ ...options, model: 'antigravity-claude-sonnet-5-5' }))
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish?.replayState?.blocks).toEqual([{ kind: 'reasoning', signature }, { kind: 'text' }])
  })

  it.each([
    { status: 401, code: 'UNAUTHENTICATED' },
    { code: 401, status: 'UNAUTHENTICATED' },
    { code: 403, status: 'PERMISSION_DENIED' },
  ])('SSE 鉴权错误换发一次并重试：%j', async error => {
    const credential = vi.fn(async (_signal?: AbortSignal, _refresh?: { forceRefresh?: boolean }) => ({ accessToken: 'synthetic', source: 'login' as const, updatedAt: 'x' }))
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(`data: ${JSON.stringify({ error })}\n\n`))
      .mockResolvedValueOnce(new Response(`data: ${JSON.stringify(event([{ text: 'ok' }], 'STOP'))}\n\n`))
    const instance = new AntigravityProxyAdapter({ credential: { credential }, transport: { request } })
    const chunks = await collect(instance.stream(options))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(request).toHaveBeenCalledTimes(2)
    expect(credential.mock.calls.map(call => call[1])).toEqual([undefined, { forceRefresh: true }])
  })

  it('已出文本后鉴权失败不重新派发生成', async () => {
    const request = vi.fn(async () => new Response([
      `data: ${JSON.stringify(event([{ text: 'partial' }]))}\n\n`,
      'data: {"error":{"code":401,"status":"UNAUTHENTICATED"}}\n\n',
    ].join('')))
    const instance = new AntigravityProxyAdapter({ credential: { credential: async () => ({ accessToken: 'synthetic', source: 'login', updatedAt: 'x' }) }, transport: { request } })
    await expect(collect(instance.stream(options))).rejects.toMatchObject({ code: 'AUTH' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('SSE 限流保留 HTTP 状态和 RATE_LIMIT 分类', async () => {
    const chunks = await collect(adapter([{ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }]).stream(options))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429 } } })
  })

  it('文本已到但缺少完成标记时不伪装成功；DONE 可终止保持打开的 SSE', async () => {
    await expect(collect(adapter([event([{ text: 'partial' }])]).stream(options))).rejects.toMatchObject({ code: 'TRANSPORT' })
    const cancel = vi.fn()
    const instance = new AntigravityProxyAdapter({
      credential: { credential: async () => ({ accessToken: 'synthetic', source: 'login', updatedAt: 'x' }) },
      transport: { request: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event([{ text: 'ok' }]))}\n\ndata: [DONE]\n\n`)) },
        cancel,
      })) },
    })
    expect((await collect(instance.stream(options))).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(cancel).toHaveBeenCalled()
  })

  it('HTTP 400 的 SSE 上下文错误进入压缩分类', async () => {
    const instance = new AntigravityProxyAdapter({
      credential: { credential: async () => ({ accessToken: 'synthetic', source: 'login', updatedAt: 'x' }) },
      transport: { request: async () => new Response('data: {"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"message":"too many tokens"}]}}\n\n', { status: 400 }) },
    })
    await expect(collect(instance.stream(options))).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
  })

  it('不可恢复的代理配置错误不做三轮网络重试', async () => {
    const request = vi.fn(async () => { throw new ProxyTransportError('proxy-unsupported', 'synthetic') })
    const instance = new AntigravityProxyAdapter({ credential: { credential: async () => ({ accessToken: 'synthetic', source: 'login', updatedAt: 'x' }) }, transport: { request } })
    await expect(collect(instance.stream(options))).rejects.toMatchObject({ code: 'AGY_INVALID_PROXY' })
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('代理凭据取消', () => {
  it('获取凭据时取消不被误报为 AUTH，也不等待不响应的后端', async () => {
    const controller = new AbortController()
    const credential = vi.fn(async () => new Promise<never>(() => {}))
    const request = vi.fn()
    const instance = new AntigravityProxyAdapter({ credential: { credential }, transport: { request } })
    const pending = collect(instance.stream({ ...options, signal: controller.signal }))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(request).not.toHaveBeenCalled()
  })
})

describe('代理模型设置与调用准备', () => {
  it('目录失败只保留同账户已观测结果，不回退未观测的审计快照', async () => {
    let account = 'a'
    const request = vi.fn(async () => new Response('unavailable', { status: 503 }))
    const instance = new AntigravityProxyAdapter({
      credential: { credential: async () => ({ accessToken: `synthetic-${account}`, email: `${account}@example.invalid`, source: 'login', updatedAt: 'x' }) },
      transport: { request },
    })
    await expect(instance.listModels(PROXY_PROVIDER_ID)).rejects.toMatchObject({ code: 'UPSTREAM' })
    request.mockResolvedValueOnce(new Response('{"models":{"gemini-3.8-flash-medium":{}}}'))
    expect(await instance.discoverModels(true)).toHaveLength(1)
    await expect(instance.discoverModels(true)).rejects.toMatchObject({ code: 'UPSTREAM' })
    expect((await instance.listModels(PROXY_PROVIDER_ID)).map(row => row.id)).toEqual([model])
    account = 'b'
    await expect(instance.listModels(PROXY_PROVIDER_ID)).rejects.toMatchObject({ code: 'UPSTREAM' })
  })

  it('注销后的在途旧目录不写回缓存，也不向调用方返回旧账户结果', async () => {
    let release: ((response: Response) => void) | undefined
    const request = vi.fn(() => new Promise<Response>(resolve => { release = resolve }))
    const instance = new AntigravityProxyAdapter({
      credential: { credential: async () => ({ accessToken: 'synthetic', source: 'login', updatedAt: 'x' }) },
      transport: { request },
    })
    const pending = instance.discoverModels()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    instance.invalidateModelCatalog()
    release!(new Response('{"models":{"gemini-3.8-flash-medium":{}}}'))
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    request.mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    await expect(instance.listModels(PROXY_PROVIDER_ID)).rejects.toMatchObject({ code: 'UPSTREAM' })
  })

  it('target 读取目标能力；未知映射保守声明文本并省略容量', async () => {
    let target = 'claude-opus-5-5-low'
    const instance = new AntigravityProxyAdapter({
      readSettings: () => ({ modelOverrides: { [model]: { target } } }),
      attachments: () => ({ readImage: vi.fn() }),
      credential: { credential: async () => ({ accessToken: 'synthetic', source: 'login', updatedAt: 'x' }) },
      transport: { request: vi.fn() },
    })
    expect(await instance.resolveModel(PROXY_PROVIDER_ID, model)).toMatchObject({ context: { contextWindow: 1000000 }, defaultMaxTokens: 128000, inputModalities: ['text', 'image'] })
    target = 'unknown-text-target'
    const unknown = await instance.resolveModel(PROXY_PROVIDER_ID, model)
    expect(unknown.inputModalities).toEqual(['text'])
    expect(unknown.context).toBeUndefined()
    expect(unknown.defaultMaxTokens).toBeUndefined()
    expect(unknown.reasoning).toBeUndefined()
    target = 'gemini-3.1-flash-image'
    await expect(instance.resolveModel(PROXY_PROVIDER_ID, model)).rejects.toMatchObject({ code: 'INVALID_MODEL' })
  })

  it('Gemini 3.5 默认档位与 core 默认 medium 保持一致', async () => {
    expect(await adapter([]).resolveModel(PROXY_PROVIDER_ID, 'antigravity-gemini-3.5-flash')).toMatchObject({ reasoning: { defaultEffort: 'medium' } })
  })
  it('隐藏仅影响选择目录，名称/默认档位仍可解析，显式档位优先且 target 最优先', async () => {
    let settings: Pick<AntigravityHostConfig, 'modelOverrides'> = { modelOverrides: { [model]: { enabled: false, name: 'My Flash', effort: 'high' } } }
    const bodies: Array<{ model: string }> = []
    const instance = new AntigravityProxyAdapter({
      readSettings: () => settings,
      credential: { credential: async () => ({ accessToken: 'synthetic', source: 'login', updatedAt: 'x' }) },
      transport: { request: async input => {
        if (input.url.includes('fetchAvailableModels')) return new Response('{"models":{"gemini-3.8-flash-medium":{}}}')
        bodies.push(JSON.parse(String(input.body)))
        return new Response(`data: ${JSON.stringify(event([{ text: 'ok' }], 'STOP'))}\n\n`)
      } },
    })
    expect(await instance.listModels(PROXY_PROVIDER_ID)).toEqual([])
    expect(await instance.discoverModels()).toContainEqual(expect.objectContaining({ id: model, name: 'My Flash' }))
    expect(await instance.resolveModel(PROXY_PROVIDER_ID, model)).toMatchObject({ name: 'My Flash', reasoning: { defaultEffort: 'high' }, inputModalities: ['text'] })
    await collect(instance.stream(options))
    await collect(instance.stream({ ...options, reasoningEffort: ReasoningEffortId('low') }))
    settings = { modelOverrides: { [model]: { target: 'claude-opus-5-5-low', effort: 'high' } } }
    await collect(instance.stream({ ...options, reasoningEffort: ReasoningEffortId('high') }))
    expect(bodies.map(body => body.model)).toEqual(['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'claude-opus-5-5-low'])
  })

  it('准备与派发复用同代设置/附件能力，下一次准备读取新设置', async () => {
    const image = { attachmentId: 'synthetic-image', mediaType: 'image/png', width: 4000, height: 4000, bytes: 3 } as ImageAttachmentRef
    let settings: Pick<AntigravityHostConfig, 'modelOverrides'> = { modelOverrides: { [model]: { effort: 'low', name: 'before' } } }
    const reader: ProxyAttachmentReader = { readImage: vi.fn(), readImageRequest: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' })) }
    let attachments: ProxyAttachmentReader | undefined = reader
    const bodies: Array<{ model: string }> = []
    const instance = new AntigravityProxyAdapter({
      readSettings: () => settings, attachments: () => attachments,
      credential: { credential: async () => ({ accessToken: 'synthetic', source: 'login', updatedAt: 'x' }) },
      transport: { request: async input => {
        bodies.push(JSON.parse(String(input.body)))
        return new Response(`data: ${JSON.stringify(event([{ text: 'ok' }], 'STOP'))}\n\n`)
      } },
    })
    const prepared = await instance.prepareCall(PROXY_PROVIDER_ID, model)
    settings = { modelOverrides: { [model]: { effort: 'high', name: 'after' } } }
    attachments = undefined
    expect(prepared.model).toMatchObject({ name: 'before', inputModalities: ['text', 'image'], reasoning: { defaultEffort: 'low' } })
    await collect(prepared.stream({ ...options, messages: [{ role: 'user', content: [{ type: 'image', attachment: image }] }] }))
    expect(bodies[0]?.model).toBe('gemini-3.8-flash-low')
    expect(reader.readImageRequest).toHaveBeenCalledWith(image, instance.imageRequestTarget(PROXY_PROVIDER_ID, model, image), undefined)
    expect(instance.imageRequestTarget(PROXY_PROVIDER_ID, model, image)).toMatchObject({ maxBytes: 1024 * 1024 })
    expect((await instance.prepareCall(PROXY_PROVIDER_ID, model)).model).toMatchObject({ name: 'after', inputModalities: ['text'], reasoning: { defaultEffort: 'high' } })
  })
})
