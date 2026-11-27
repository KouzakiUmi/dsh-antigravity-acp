import { describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { BlockAssembler, createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AdapterRequestOptions } from '../src/adapter/request-options.js'
import { AistudioAdapter } from '../src/aistudio/adapter.js'
import { AISTUDIO_PROVIDER_ID } from '../src/aistudio/endpoints.js'
import type { ModelOverride } from '../src/settings.js'

const model = 'aistudio-gemini-2.5-flash'
const options: AdapterRequestOptions = { provider: AISTUDIO_PROVIDER_ID, model, messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })] }
const event = (parts: unknown[], finishReason?: string) => ({ candidates: [{ content: { parts }, finishReason }] })
const sse = (events: unknown[], status = 200) => new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { status })
const defaultModels = [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] }]

function makeAdapter(opts: { events?: unknown[]; models?: unknown[]; key?: string; credentialReject?: Error; streamStatus?: number; streamBody?: string; readSettings?: () => { modelOverrides?: Record<string, ModelOverride> } } = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.includes(':streamGenerateContent')) {
      if (opts.streamBody !== undefined) return new Response(opts.streamBody, { status: opts.streamStatus ?? 200 })
      return sse(opts.events ?? [], opts.streamStatus ?? 200)
    }
    return new Response(JSON.stringify({ models: opts.models ?? defaultModels }))
  })
  const adapter = new AistudioAdapter({ credential: async () => { if (opts.credentialReject) throw opts.credentialReject; return opts.key ?? 'test-key' }, fetch, ...(opts.readSettings ? { readSettings: opts.readSettings } : {}) })
  return { adapter, fetch, calls }
}
async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('AI Studio 热切换', () => {
  it('外部轮换后已准备请求不会用新 key 发送', async () => {
    let key = 'fixture-original'
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ models: defaultModels }))
    const adapter = new AistudioAdapter({ credential: async () => key, fetch })
    const prepared = await adapter.prepareCall(AISTUDIO_PROVIDER_ID, model)
    key = 'fixture-replacement'
    expect(await collect(prepared.stream(options))).toMatchObject([{ type: 'finish', reason: { kind: 'aborted' } }])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('凭据刷新时终止旧目录分页且不访问下一页', async () => {
    let finish!: (response: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const adapter = new AistudioAdapter({ credential: async () => 'fixture-original', fetch })
    const directory = adapter.discoverModels(true)
    const expected = expect(directory).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    adapter.invalidateOperations()
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    finish(Response.json({ models: defaultModels, nextPageToken: 'fixture-next' }))
    await expected
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('模型映射不借用原模型容量', async () => {
    const { adapter } = makeAdapter({ readSettings: () => ({ modelOverrides: { [model]: { target: 'models/gemini-unlisted' } } }) })
    expect(await adapter.resolveModel(AISTUDIO_PROVIDER_ID, model)).not.toHaveProperty('context')
    expect((await adapter.discoverModels())[0]).not.toHaveProperty('maxOutputTokens')
  })
})

describe('AI Studio 流式生成', () => {
  it('标准 Gemini 直挂 candidates 解析为文本块并以 stop 结束', async () => {
    const { adapter } = makeAdapter({ events: [event([{ text: 'Hello' }]), event([{ text: ' world' }], 'STOP')] })
    const chunks = await collect(adapter.stream(options))
    expect(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')).toBe('Hello world')
    const finish = chunks.find(c => c.type === 'finish')
    expect(finish?.reason.kind).toBe('stop')
  })

  it('thought:true 部分渲染为 reasoning 块', async () => {
    const { adapter } = makeAdapter({ events: [event([{ text: 'pondering', thought: true }]), event([{ text: 'answer' }], 'STOP')] })
    const chunks = await collect(adapter.stream(options))
    expect(chunks.some(c => c.type === 'reasoning-delta' && c.text === 'pondering')).toBe(true)
    expect(chunks.some(c => c.type === 'block-start' && c.blockType === 'reasoning')).toBe(true)
  })

  it('工具调用组装并以 tool-calls 结束，签名进入 replay', async () => {
    const { adapter } = makeAdapter({ events: [event([{ functionCall: { name: 'weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-1' }], 'STOP')] })
    const chunks = await collect(adapter.stream(options))
    const calls = chunks.flatMap(c => c.type === 'block-end' && c.block.type === 'tool-call' ? [c.block] : [])
    expect(calls.map(c => [c.name, JSON.parse(c.arguments)])).toEqual([['weather', { city: 'Paris' }]])
    const finish = chunks.find(c => c.type === 'finish')
    expect(finish?.reason.kind).toBe('tool-calls')
    expect(finish?.replayState?.blocks).toEqual([{ kind: 'tool-call', signature: 'sig-1' }])
  })

  it('多轮：上一轮 thoughtSignature 经 replay 回填进下一轮请求体', async () => {
    const { adapter, calls } = makeAdapter({ events: [event([{ functionCall: { name: 'weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-xyz' }], 'STOP')] })
    const first = await collect(adapter.stream(options))
    const call = first.flatMap(c => c.type === 'block-end' && c.block.type === 'tool-call' ? [c.block] : [])[0]!
    const finish = first.find(c => c.type === 'finish')
    const assistant = createAssistantMessage({ content: [call], source: { provider: AISTUDIO_PROVIDER_ID, model, replayState: finish?.replayState } })
    const result = createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'sunny' }], isError: false })
    await collect(adapter.stream({ ...options, messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), assistant, result] }))
    const body = JSON.parse(String(calls.at(-1)?.init?.body)) as { contents: { parts: { functionCall?: unknown; thoughtSignature?: string }[] }[] }
    const modelParts = body.contents.find(c => c.parts.some(p => p.functionCall !== undefined))
    expect(modelParts?.parts[0]).toMatchObject({ functionCall: { name: 'weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-xyz' })
  })

  it('多轮真实形态：tool-call 伴随 text 块时按全部块忠实重建，签名仍附到 functionCall', async () => {
    // 真实 key 集成探针核实：思考模型工具轮发出 functionCall + 伴随 text 部分，replay 记多块。
    // 助手内容须用流发出的全部块（与 replay 同源同序）重建，kinds 对齐才能取回签名；
    // 只取 tool-call 单块会令 compatibleAistudioReplayState 因长度不匹配拒绝、上游报 400 缺签名。
    const { adapter, calls } = makeAdapter({ events: [event([{ functionCall: { name: 'weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-real' }, { text: 'let me check' }], 'STOP')] })
    const first = await collect(adapter.stream(options))
    const blocks = first.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
    const finish = first.find(chunk => chunk.type === 'finish')
    expect(blocks.length).toBeGreaterThan(1)
    expect(finish?.replayState?.blocks?.[0]).toEqual({ kind: 'tool-call', signature: 'sig-real' })
    const assistant = createAssistantMessage({ content: blocks, source: { provider: AISTUDIO_PROVIDER_ID, model, replayState: finish?.replayState } })
    const call = blocks.find(block => block.type === 'tool-call')!
    const result = createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'sunny' }], isError: false })
    await collect(adapter.stream({ ...options, messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), assistant, result] }))
    const body = JSON.parse(String(calls.at(-1)?.init?.body)) as { contents: { parts: { functionCall?: unknown; thoughtSignature?: string }[] }[] }
    const modelParts = body.contents.find(content => content.parts.some(part => part.functionCall !== undefined))
    expect(modelParts?.parts[0]).toMatchObject({ functionCall: { name: 'weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-real' })
  })

  it('全链路经真实宿主 BlockAssembler：块与 replay 对齐、下轮 functionCall 签名附上', async () => {
    // 弥合集成探针手动重建与宿主实际组装的缺口：把真实 adapter 流喂进宿主 BlockAssembler，
    // 用其 blocks()/replayState 重建助手消息再续轮。宿主正常路径保留全部块（含空 text），
    // replay 信封按块数量对齐保留；max-tokens 时块与 replay 同步裁剪。锁定全链路签名不丢。
    const { adapter, calls } = makeAdapter({ events: [event([{ functionCall: { id: 'fixture-wire', name: 'weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-host' }, { text: '' }], 'STOP')] })
    const assembler = new BlockAssembler()
    for await (const chunk of adapter.stream(options)) assembler.push(chunk)
    const hostBlocks = assembler.blocks()
    const hostReplay = assembler.replayState
    expect(hostReplay).toBeDefined()
    expect(hostReplay?.blocks?.length).toBe(hostBlocks.length)
    expect(hostBlocks.some(block => block.type === 'tool-call')).toBe(true)
    const assistant = createAssistantMessage({ content: hostBlocks, source: { provider: AISTUDIO_PROVIDER_ID, model, replayState: hostReplay } })
    const call = hostBlocks.find(block => block.type === 'tool-call')!
    const result = createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'sunny' }], isError: false })
    await collect(adapter.stream({ ...options, messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), assistant, result] }))
    const body = JSON.parse(String(calls.at(-1)?.init?.body)) as { contents: { parts: { functionCall?: unknown; thoughtSignature?: string }[] }[] }
    const modelParts = body.contents.find(content => content.parts.some(part => part.functionCall !== undefined))
    expect(modelParts?.parts[0]).toMatchObject({ functionCall: { id: 'fixture-wire', name: 'weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-host' })
    expect(body.contents.at(-1)).toMatchObject({ parts: [{ functionResponse: { id: 'fixture-wire', name: 'weather' } }] })
  })

  it('usageMetadata 产出 usage 块', async () => {
    const { adapter } = makeAdapter({ events: [{ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }] })
    const chunks = await collect(adapter.stream(options))
    const usage = chunks.find(c => c.type === 'usage')
    expect(usage?.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })

  it('请求经 x-goog-api-key 头鉴权，URL 不含 key', async () => {
    const { adapter, calls } = makeAdapter({ events: [event([{ text: 'x' }], 'STOP')] })
    await collect(adapter.stream(options))
    const call = calls[0]!
    expect(call.url).not.toContain('key=')
    expect((call.init?.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key')
  })

  it('真实上游帧形态（CRLF 分隔 + modelVersion/responseId 额外字段 + thoughtSignature）正确解析', async () => {
    // 真实 key 探针核实：gemini-3.8-flash 的 SSE 用 \r\n\r\n 分隔，帧顶层含 modelVersion/responseId
    // 额外字段（解析器忽略），思考与工具部分携带 thoughtSignature。锁定该真实形态防回归。
    const frames = [
      { candidates: [{ content: { parts: [{ text: '思考中', thought: true, thoughtSignature: 'sig-real' }], role: 'model' }, index: 0 }], usageMetadata: { promptTokenCount: 7, totalTokenCount: 12 }, modelVersion: 'gemini-3.8-flash', responseId: 'r-1' },
      { candidates: [{ content: { parts: [{ functionCall: { name: 'weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-real' }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8, totalTokenCount: 24 }, modelVersion: 'gemini-3.8-flash', responseId: 'r-1' },
    ]
    const streamBody = frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('')
    const { adapter } = makeAdapter({ streamBody })
    const chunks = await collect(adapter.stream(options))
    expect(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === '思考中')).toBe(true)
    const calls = chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block] : [])
    expect(calls.map(call => [call.name, JSON.parse(call.arguments)])).toEqual([['weather', { city: 'Paris' }]])
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish?.reason.kind).toBe('tool-calls')
    expect(finish?.replayState?.blocks).toContainEqual({ kind: 'tool-call', signature: 'sig-real' })
    expect(chunks.find(chunk => chunk.type === 'usage')?.usage).toMatchObject({ inputTokens: 7, outputTokens: 8 })
  })
})

describe('AI Studio 错误映射', () => {
  it('HTTP 401 → AUTH', async () => {
    const { adapter } = makeAdapter({ streamStatus: 401, streamBody: JSON.stringify({ error: { message: 'bad key' } }) })
    await expect(collect(adapter.stream(options))).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('HTTP 429 → RATE_LIMIT，不透出未经许可的任意错误文本', async () => {
    const { adapter } = makeAdapter({ streamStatus: 429, streamBody: JSON.stringify({ error: { message: 'quota exhausted, retry in 30s' } }) })
    await expect(collect(adapter.stream(options))).rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })

  it('HTTP 400 上下文超限 → CONTEXT_WINDOW_EXCEEDED', async () => {
    const { adapter } = makeAdapter({ streamStatus: 400, streamBody: JSON.stringify({ error: { message: 'The input token count exceeds the context window' } }) })
    await expect(collect(adapter.stream(options))).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
  })

  it('流内 error 事件 → finish error（不抛）', async () => {
    const { adapter } = makeAdapter({ events: [{ error: { code: 'RESOURCE_EXHAUSTED', message: 'slow down' } }] })
    const chunks = await collect(adapter.stream(options))
    const finish = chunks.find(c => c.type === 'finish')
    expect(finish?.reason.kind).toBe('error')
    expect(finish?.reason.kind === 'error' && finish.reason.failure.code).toBe('RATE_LIMIT')
  })

  it('缺 key → AUTH，不发送请求', async () => {
    const { adapter, fetch } = makeAdapter({ key: '' })
    await expect(collect(adapter.stream(options))).rejects.toMatchObject({ code: 'AUTH' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('凭据接缝解析拒绝 → 可读 LlmError，不泄漏原始 rejection、不发送请求', async () => {
    const { adapter, fetch } = makeAdapter({ credentialReject: new Error('凭据存储 IO 故障') })
    await expect(collect(adapter.stream(options))).rejects.toMatchObject({ code: 'TRANSPORT', message: 'AI Studio 凭据读取失败' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('空响应（无块）→ EMPTY_RESPONSE', async () => {
    const { adapter } = makeAdapter({ events: [event([], 'STOP')] })
    const chunks = await collect(adapter.stream(options))
    const finish = chunks.find(c => c.type === 'finish')
    expect(finish?.reason.kind === 'error' && finish.reason.failure.code).toBe('EMPTY_RESPONSE')
  })
})

describe('AI Studio 模型目录', () => {
  it('listModels 发现并应用显示名覆盖与停用过滤', async () => {
    const { adapter } = makeAdapter({
      models: [...defaultModels, { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] }],
      readSettings: () => ({ modelOverrides: { 'aistudio-gemini-2.5-flash': { enabled: true, name: '我的 Flash' }, 'aistudio-gemini-2.5-pro': { enabled: false } } }),
    })
    const models = await adapter.listModels(AISTUDIO_PROVIDER_ID)
    expect(models.map(m => m.id)).toEqual(['aistudio-gemini-2.5-flash'])
    expect(models[0]!.name).toBe('我的 Flash')
  })

  it('目录缓存 TTL 内复用，force 绕过', async () => {
    const { adapter, fetch } = makeAdapter()
    await adapter.discoverModels()
    await adapter.discoverModels()
    expect(fetch).toHaveBeenCalledTimes(1)
    await adapter.discoverModels(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('刷新失败保留已观测目录', async () => {
    const { adapter, fetch } = makeAdapter()
    await adapter.discoverModels()
    fetch.mockResolvedValueOnce(new Response('down', { status: 503 }))
    // 用 discoverModels 断言缓存保留（不受默认启用过滤影响）。
    const models = await adapter.discoverModels()
    expect(models.some(m => m.id === model)).toBe(true)
  })

  it('默认仅 4 系进选择器；非 4 系默认隐藏、显式启用后出现、仅改显示名不启用', async () => {
    const catalog = [
      { name: 'models/gemini-4-argon', displayName: 'Gemini 4 Argon', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
    ]
    const bare = makeAdapter({ models: catalog })
    expect((await bare.adapter.listModels(AISTUDIO_PROVIDER_ID)).map(m => m.id)).toEqual(['aistudio-gemini-4-argon'])
    const enabled = makeAdapter({ models: catalog, readSettings: () => ({ modelOverrides: { 'aistudio-gemini-2.5-flash': { enabled: true } } }) })
    expect((await enabled.adapter.listModels(AISTUDIO_PROVIDER_ID)).map(m => m.id).sort()).toEqual(['aistudio-gemini-2.5-flash', 'aistudio-gemini-4-argon'])
    const nameOnly = makeAdapter({ models: catalog, readSettings: () => ({ modelOverrides: { 'aistudio-gemini-2.5-flash': { name: '改名' } } }) })
    expect((await nameOnly.adapter.listModels(AISTUDIO_PROVIDER_ID)).map(m => m.id)).toEqual(['aistudio-gemini-4-argon'])
  })

  it('resolveModel 返回容量与文本模态', async () => {
    const { adapter } = makeAdapter()
    const resolved = await adapter.resolveModel(AISTUDIO_PROVIDER_ID, model)
    expect(resolved).toMatchObject({ provider: AISTUDIO_PROVIDER_ID, id: model, inputModalities: ['text'], context: { contextWindow: 1048576 }, defaultMaxTokens: 65536 })
  })

  it('modelOverrides.target 改写线模型', async () => {
    const { adapter, calls } = makeAdapter({ events: [event([{ text: 'x' }], 'STOP')], readSettings: () => ({ modelOverrides: { [model]: { target: 'gemini-2.5-flash-002' } } }) })
    await collect(adapter.stream(options))
    expect(calls[0]!.url).toContain('gemini-2.5-flash-002:streamGenerateContent')
  })

  it('prepareCall 解析模型并经返回的 stream 闭包派发（target 映射生效）', async () => {
    const { adapter, calls } = makeAdapter({ events: [event([{ text: 'x' }], 'STOP')], readSettings: () => ({ modelOverrides: { [model]: { target: 'gemini-2.5-flash-002' } } }) })
    const prepared = await adapter.prepareCall(AISTUDIO_PROVIDER_ID, model)
    expect(prepared.model).toMatchObject({ provider: AISTUDIO_PROVIDER_ID, id: model, inputModalities: ['text'] })
    const chunks = await collect(prepared.stream(options))
    expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true)
    // prepareCall 先发现目录（calls[0] = /models），生成请求随后；定位生成帧核实 target 映射。
    const generation = calls.find(call => call.url.includes(':streamGenerateContent'))
    expect(generation?.url).toContain('gemini-2.5-flash-002:streamGenerateContent')
  })

  it('目录外模型 resolveModel 报 INVALID_MODEL', async () => {
    const { adapter } = makeAdapter()
    await expect(adapter.resolveModel(AISTUDIO_PROVIDER_ID, 'aistudio-ghost')).rejects.toMatchObject({ code: 'INVALID_MODEL' })
  })
})
