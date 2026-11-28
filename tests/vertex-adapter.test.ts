import { describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { BlockAssembler, createAssistantMessage, createToolResultMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AdapterRequestOptions } from '../src/adapter/request-options.js'
import type { ModelOverride } from '../src/settings.js'
import { VertexAdapter } from '../src/vertex/adapter.js'
import { listConfiguredVertexModels } from '../src/vertex/catalog.js'
import type { VertexSettingsBus } from '../src/vertex/settings-bus.js'

const provider = 'vertex-ai'
const wire = 'gemini-4-hydrogen'
const model = `${provider}-${wire}`
const prompt: AdapterRequestOptions = { provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
const event = (parts: unknown[], finishReason?: string) => ({ candidates: [{ content: { parts }, finishReason }] })
const sse = (...events: unknown[]) => new Response(events.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })

function fixture() {
  const state = { enabled: true, project: 'fixture-project', location: 'global', models: [wire], overrides: {} as Record<string, ModelOverride> }
  const settings: VertexSettingsBus = {
    enabled: () => state.enabled, project: () => state.project, location: () => state.location, models: () => state.models,
    modelSettings: () => ({ modelOverrides: state.overrides }), proxySettings: () => ({}), subscribe: () => () => {},
  }
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => sse(event([{ text: 'hello' }], 'STOP')))
  const token = vi.fn<(signal: AbortSignal) => Promise<string>>().mockResolvedValue('fixture-token')
  return { state, fetch, token, adapter: new VertexAdapter({ settings, fetch, token }) }
}

async function collect(stream: AsyncIterable<StreamChunk>) {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}

describe('Vertex AI standard Gemini stream', () => {
  it('posts to the exact global and regional endpoints with bearer auth and emits usage', async () => {
    const { adapter, state, fetch } = fixture()
    fetch.mockImplementationOnce(async () => sse(event([{ text: 'Hel' }]), {
      ...event([{ text: 'lo' }], 'STOP'), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }))
    const chunks = await collect(adapter.stream(prompt))
    expect(chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : []).join('')).toBe('Hello')
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'usage', usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5 }) }))
    const path = `/v1/projects/${state.project}/locations/`
    const modelPath = `/publishers/google/models/${wire}:streamGenerateContent?alt=sse`
    expect(fetch.mock.calls[0]?.[0]).toBe(`https://aiplatform.googleapis.com${path}global${modelPath}`)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer fixture-token' } })
    state.location = 'us-central1'
    await collect(adapter.stream(prompt))
    expect(fetch.mock.calls[1]?.[0]).toBe(`https://us-central1-aiplatform.googleapis.com${path}us-central1${modelPath}`)
    state.location = 'eu'
    await collect(adapter.stream(prompt))
    expect(fetch.mock.calls[2]?.[0]).toBe(`https://aiplatform.eu.rep.googleapis.com${path}eu${modelPath}`)
    state.location = 'us'
    await collect(adapter.stream(prompt))
    expect(fetch.mock.calls[3]?.[0]).toBe(`https://aiplatform.us.rep.googleapis.com${path}us${modelPath}`)
  })

  it('replays real signatures and upstream IDs through host assembly, but isolates project, region and provider', async () => {
    const { adapter, state, fetch } = fixture()
    fetch.mockImplementationOnce(async () => sse(event([
      { text: 'thinking', thought: true, thoughtSignature: 'signed-reasoning' },
      { functionCall: { id: 'upstream-1', name: 'weather', args: { city: 'Paris' } }, thoughtSignature: 'signed-call' },
      { functionCall: { name: 'weather', args: { city: 'Rome' } } },
    ], 'STOP')))
    const assembler = new BlockAssembler()
    const initial = await collect(adapter.stream(prompt))
    initial.forEach(chunk => assembler.push(chunk))
    expect(initial.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    const content = assembler.blocks()
    const results = content.flatMap(block => block.type === 'tool-call' ? [createToolResultMessage({ callId: block.id, isError: false, content: [{ type: 'text', text: 'sunny' }] })] : [])
    expect(results).toHaveLength(2)
    const send = async (sourceProvider = provider) => {
      const assistant = createAssistantMessage({ content, source: { provider: sourceProvider, model, replayState: assembler.replayState } })
      await collect(adapter.stream({ ...prompt, messages: [...prompt.messages, assistant, ...results] }))
      return JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body)) as { contents: unknown[] }
    }
    expect((await send()).contents.slice(1)).toEqual([
      { role: 'model', parts: [
        { text: 'thinking', thought: true, thoughtSignature: 'signed-reasoning' },
        { functionCall: { name: 'weather', id: 'upstream-1', args: { city: 'Paris' } }, thoughtSignature: 'signed-call' },
        { functionCall: { name: 'weather', args: { city: 'Rome' } } },
      ] },
      { role: 'user', parts: [
        { functionResponse: { name: 'weather', id: 'upstream-1', response: { content: 'sunny' } } },
        { functionResponse: { name: 'weather', response: { content: 'sunny' } } },
      ] },
    ])
    expect(JSON.stringify(await send('aistudio'))).not.toMatch(/signed-|upstream-1/)
    state.project = 'another-project'
    expect(JSON.stringify(await send())).not.toMatch(/signed-|upstream-1/)
    state.project = 'fixture-project'; state.location = 'europe-west1'
    expect(JSON.stringify(await send())).not.toMatch(/signed-|upstream-1/)
    state.location = 'global'; state.overrides = { [model]: { target: 'gemini-4-neon' } }
    expect(JSON.stringify(await send())).not.toMatch(/signed-|upstream-1/)
  })

  it('invalidates captured scope even after change-back and prevents stale ADC dispatch', async () => {
    const { adapter, state, fetch, token } = fixture()
    const prepared = await adapter.prepareCall(provider, model)
    state.location = 'us-central1'; adapter.syncScope()
    state.location = 'global'; adapter.syncScope()
    expect(await collect(prepared.stream(prompt))).toEqual([expect.objectContaining({ reason: expect.objectContaining({ kind: 'aborted' }) })])
    expect(token).not.toHaveBeenCalled()
    token.mockImplementationOnce(async () => { state.project = 'changed-project'; adapter.syncScope(); return 'fixture-token' })
    expect(await collect(adapter.stream(prompt))).toEqual([expect.objectContaining({ reason: expect.objectContaining({ kind: 'aborted' }) })])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not read a late response after a scope transition', async () => {
    const { adapter, state, fetch } = fixture()
    const cancel = vi.fn()
    fetch.mockImplementationOnce(async () => {
      state.project = 'changed-project'; adapter.syncScope()
      return new Response(new ReadableStream({ cancel }))
    })
    expect(await collect(adapter.stream(prompt))).toMatchObject([{ type: 'finish', reason: { kind: 'aborted' } }])
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([[401, 'AUTH'], [403, 'FORBIDDEN'], [404, 'INVALID_MODEL'], [429, 'RATE_LIMIT'], [503, 'UPSTREAM']])('maps HTTP %i to %s and never retries/falls back', async (status, code) => {
    const { adapter, fetch } = fixture()
    fetch.mockResolvedValueOnce(new Response('fixture-token must not surface', { status }))
    const error = collect(adapter.stream(prompt))
    await expect(error).rejects.toMatchObject({ code, failure: { status } })
    await expect(error).rejects.toThrow(/^(?!.*fixture-token).*Vertex AI/su)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('models are explicit and offline; hidden rows still resolve and unknown sizes remain absent', async () => {
    const { adapter, state, token, fetch } = fixture()
    state.models = [wire, 'invalid/image', ' gemini-x-preview ', 'gemini-4-image', wire]
    state.overrides = { [model]: { enabled: false, name: 'Fixture' } }
    expect(listConfiguredVertexModels(state.models, state.overrides)).toMatchObject([
      { id: model, name: 'Fixture', enabled: false, upstreamId: wire, contextWindow: 1_048_576, maxOutputTokens: 65_536 },
      { id: 'vertex-ai-gemini-x-preview', enabled: false },
    ])
    expect(await adapter.listModels(provider)).toEqual([])
    state.overrides['vertex-ai-gemini-x-preview'] = { enabled: true }
    expect(await adapter.listModels(provider)).toEqual([expect.not.objectContaining({ contextWindow: expect.anything() })])
    expect(await adapter.resolveModel(provider, model)).toMatchObject({ name: 'Fixture', context: { contextWindow: 1_048_576 } })
    state.overrides = { [model]: { target: 'gemini-4-live', enabled: true } }
    expect(await adapter.listModels(provider)).toEqual([])
    await expect(adapter.resolveModel(provider, model)).rejects.toMatchObject({ code: 'INVALID_MODEL' })
    await expect(collect(adapter.stream(prompt))).rejects.toMatchObject({ code: 'INVALID_MODEL' })
    await expect(adapter.resolveModel(provider, 'vertex-ai-gemini-4-image')).rejects.toMatchObject({ code: 'INVALID_MODEL' })
    expect(token).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })

  it('advertises audited Gemini 4 defaults and sends standard Vertex generation controls', async () => {
    const { adapter, state, fetch } = fixture()
    state.overrides = { [model]: { temperature: 0.7 } }
    const [row] = await adapter.listModels(provider)
    expect(row).toMatchObject({ inputModalities: ['text'], contextWindowSource: 'audited', maxOutputTokens: 65_536,
      compat: { protocol: 'google-generate-content', inputModalities: ['text'], reasoningEfforts: ['low', 'medium', 'high'],
        upstreamReasoningEffort: 'high', temperature: false, maxStopSequences: 5, protocolMaxOutputTokens: 65_536 } })
    expect(row).not.toHaveProperty('controls')
    const prepared = await adapter.prepareCall(provider, model)
    expect(prepared.model).toMatchObject({ context: { contextWindow: 1_048_576 }, defaultMaxTokens: 65_536,
      reasoning: { defaultEffort: 'high' } })
    await collect(prepared.stream(prompt))
    expect(sentConfig(fetch)).toEqual({ maxOutputTokens: 65_536, thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } })
  })

  it('prepares the mapped wire and snapshots its defaults instead of re-reading settings during dispatch', async () => {
    const { adapter, state, fetch } = fixture()
    state.overrides = { [model]: { target: 'gemini-4-argon', contextWindow: 12_000, maxTokens: 2048, stop: ['END'] } }
    expect(listConfiguredVertexModels(state.models, state.overrides)[0]).toMatchObject({ upstreamId: 'gemini-4-argon',
      contextWindow: 1_048_576, contextWindowSource: 'audited', maxOutputTokens: 65_536, defaultMaxTokens: 2048,
      compat: { protocolMaxOutputTokens: 65_536, upstreamContextWindow: 1_048_576, upstreamReasoningEffort: 'medium' } })
    const prepared = await adapter.prepareCall(provider, model)
    expect(prepared.model).toMatchObject({ context: { contextWindow: 12_000 }, defaultMaxTokens: 2048,
      reasoning: { defaultEffort: 'medium' } })
    state.overrides = { [model]: { target: 'gemini-x-preview' } }
    await collect(prepared.stream(prompt))
    expect(String(fetch.mock.lastCall?.[0])).toContain('/models/gemini-4-argon:streamGenerateContent')
    expect(sentConfig(fetch)).toEqual({ maxOutputTokens: 2048, stopSequences: ['END'],
      thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: true } })
    const unknown = await adapter.resolveModel(provider, model)
    expect(unknown.context).toBeUndefined()
    expect(unknown.defaultMaxTokens).toBeUndefined()
    expect(unknown.reasoning).toBeUndefined()
    const unknownRow = listConfiguredVertexModels(state.models, state.overrides)[0]
    expect(unknownRow?.compat).not.toHaveProperty('upstreamContextWindow')
    expect(unknownRow?.compat).not.toHaveProperty('protocolMaxOutputTokens')
  })

  it('applies explicit compatible controls and rejects unsupported effort before obtaining ADC', async () => {
    const { adapter, state, fetch, token } = fixture()
    state.overrides = { [model]: { target: 'gemini-4-neon', reasoningEffort: 'medium', maxTokens: 1200, stop: ['END'] } }
    const prepared = await adapter.prepareCall(provider, model)
    expect(prepared.model.reasoning?.defaultEffort).toBe('medium')
    await expect(collect(prepared.stream({ ...prompt, reasoningEffort: ReasoningEffortId('xhigh') })))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    expect(token).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    await collect(prepared.stream({ ...prompt, reasoningEffort: ReasoningEffortId('low'), maxTokens: 2000, stop: [] }))
    expect(sentConfig(fetch)).toEqual({ maxOutputTokens: 2000, thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: true } })
  })

  it('preserves Flash-Lite audited capacity when mapped and does not send guessed thinking levels', async () => {
    const { adapter, state, fetch } = fixture()
    state.overrides = { [model]: { target: 'gemini-3.5-flash-lite' } }
    const prepared = await adapter.prepareCall(provider, model)
    expect(prepared.model).toMatchObject({ context: { contextWindow: 1_048_576 }, defaultMaxTokens: 65_536 })
    expect(prepared.model.reasoning).toBeUndefined()
    await collect(prepared.stream(prompt))
    expect(String(fetch.mock.lastCall?.[0])).toContain('/models/gemini-3.5-flash-lite:streamGenerateContent')
    expect(sentConfig(fetch)).toEqual({ maxOutputTokens: 65_536 })
  })

  it('rejects images and out-of-range generation options before obtaining ADC', async () => {
    const { adapter, fetch, token } = fixture()
    const prepared = await adapter.prepareCall(provider, model)
    const attachment = { attachmentId: 'fixture-image', width: 1, height: 1, mediaType: 'image/png', bytes: 3 } as ImageAttachmentRef
    await expect(collect(prepared.stream({ ...prompt, messages: [{ role: 'user', content: [{ type: 'image', attachment }] }] })))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_MODALITY' })
    await expect(collect(prepared.stream({ ...prompt, maxTokens: 65_537 }))).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    expect(token).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
})

function sentConfig(fetch: ReturnType<typeof fixture>['fetch']): unknown {
  const body = JSON.parse(String(fetch.mock.lastCall?.[1]?.body)) as { generationConfig?: unknown }
  return body.generationConfig
}
