import { getPublicModelDefinitions } from '@cortexkit/antigravity-auth-core'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import type { AdapterRequestOptions } from '../../src/adapter/request-options.js'
import { normalizeModelSettings } from '../../src/adapter/model-settings.js'
import { normalizeOrchestratorSettings, ORCHESTRATOR_MODEL_ID } from '../../src/orchestrator/index.js'
import { AntigravityProxyAdapter, PROXY_PROVIDER_ID } from '../../src/proxy/adapter.js'
import { parseLiveProxyCatalog, resolveProxyOrchestrator, synthesizeProxyOrchestratorModel } from '../../src/proxy/model-catalog.js'

const definitions = getPublicModelDefinitions()
const settings = normalizeOrchestratorSettings(undefined)
const hydrogen = 'antigravity-gemini-4-hydrogen'
const opus = 'antigravity-claude-opus-5-5'
const sonnetWire = 'claude-sonnet-5-5-medium'
const argonWire = 'gemini-4-argon-high'
const accountModels = {
  'claude-opus-5-5-medium': { supportsImages: true, maxTokens: 12000, maxOutputTokens: 1200 },
  'gemini-4-hydrogen-medium': { supportsImages: true, maxTokens: 8000, maxOutputTokens: 800 },
  [sonnetWire]: { supportsImages: false, maxTokens: 4000, maxOutputTokens: 400 },
  [argonWire]: { supportsImages: true, maxTokens: 10000, maxOutputTokens: 1000 },
}

describe('代理编排的映射目标目录解析', () => {
  it('双端点使用实际映射目标，并取两端较小的容量与 executor 模态', () => {
    const catalog = parseLiveProxyCatalog({ models: accountModels }, definitions)
    const modelSettings = normalizeModelSettings({
      [opus]: { target: argonWire },
      [hydrogen]: { target: sonnetWire },
      'antigravity-claude-sonnet-5-5': { target: 'claude-sonnet-5-5-high' },
    })
    const resolved = resolveProxyOrchestrator(settings, catalog, definitions, 'low', 'high', modelSettings)
    expect(resolved).toMatchObject({
      planner: { wire: argonWire, effort: 'high', availableEfforts: [], contextWindow: 10000 },
      executor: { wire: sonnetWire, effort: 'medium', availableEfforts: [], contextWindow: 4000, supportsImages: false },
      contextWindow: 4000, maxOutputTokens: 400,
    })
    expect(synthesizeProxyOrchestratorModel({ settings, catalog, definitions, modelSettings, attachmentsAvailable: true }))
      .toMatchObject({ contextWindow: 4000, maxOutputTokens: 400, inputModalities: ['text'] })
  })

  it('映射目标缺少元数据时，只使用目标自己的已知能力', () => {
    const target = 'synthetic-chat-wire'
    const catalog = parseLiveProxyCatalog({ models: { ...accountModels, [target]: {} } }, definitions)
    const modelSettings = normalizeModelSettings({ [opus]: { target } })
    const resolved = resolveProxyOrchestrator(settings, catalog, definitions, undefined, undefined, modelSettings)
    expect(resolved?.planner).toMatchObject({ wire: target, availableEfforts: [], supportsImages: false })
    expect(resolved?.planner.effort).toBeUndefined()
    expect(resolved?.contextWindow).toBeUndefined()
    expect(resolved?.maxOutputTokens).toBeUndefined()
  })

  it('使用目标的审计回退，而非无图片且容量不同的源模型', () => {
    const catalog = parseLiveProxyCatalog({ models: {
      ...accountModels,
      'gemini-4-hydrogen-medium': { supportsImages: false, maxTokens: 8000, maxOutputTokens: 800 },
      [sonnetWire]: {},
    } }, definitions)
    const modelSettings = normalizeModelSettings({ [hydrogen]: { target: sonnetWire } })
    const resolved = resolveProxyOrchestrator(settings, catalog, definitions, undefined, undefined, modelSettings)
    expect(resolved?.executor).toMatchObject({ wire: sonnetWire, supportsImages: true,
      contextWindow: expect.any(Number), maxOutputTokens: expect.any(Number) })
    expect(resolved?.executor.contextWindow).not.toBe(8000)
    expect(resolved?.executor.maxOutputTokens).not.toBe(800)
    expect(synthesizeProxyOrchestratorModel({ settings, catalog, definitions, modelSettings, attachmentsAvailable: true, resolved }))
      .toMatchObject({ inputModalities: ['text', 'image'] })
    expect(synthesizeProxyOrchestratorModel({ settings, catalog, definitions, modelSettings, attachmentsAvailable: false, resolved }))
      .toMatchObject({ inputModalities: ['text'] })
  })

  it('任一可选的 live planner 档位容量未知时，不声明相应的共同容量', () => {
    const catalog = parseLiveProxyCatalog({ models: {
      ...accountModels,
      'gemini-4-neon-medium': { maxTokens: 10000, maxOutputTokens: 1000 },
      'gemini-4-neon-high': { maxOutputTokens: 300 },
    } }, definitions)
    const resolved = resolveProxyOrchestrator(normalizeOrchestratorSettings({ plannerModel: 'gemini-4-neon' }), catalog, definitions)
    expect(resolved?.planner).toMatchObject({ availableEfforts: ['medium', 'high'], contextWindow: 10000 })
    expect(resolved?.contextWindow).toBeUndefined()
    expect(resolved?.maxOutputTokens).toBe(300)
  })

  it.each([
    ['未观测', 'claude-sonnet-5-5-high', accountModels],
    ['已停用', sonnetWire, { ...accountModels, [sonnetWire]: { disabled: true } }],
    ['非文本', 'gemini-3.1-flash-image', { ...accountModels, 'gemini-3.1-flash-image': {} }],
    ['格式无效', 'broken\u0000wire', accountModels],
  ])('映射目标%s时不合成目录，也不回退到 Hydrogen', (_case, target, models) => {
    const catalog = parseLiveProxyCatalog({ models }, definitions)
    const modelSettings = normalizeModelSettings({ [hydrogen]: { target } })
    expect(() => resolveProxyOrchestrator(settings, catalog, definitions, undefined, undefined, modelSettings))
      .toThrow(expect.objectContaining({ code: 'INVALID_MODEL', message: expect.stringContaining('映射') }))
    expect(synthesizeProxyOrchestratorModel({ settings, catalog, definitions, modelSettings, attachmentsAvailable: true }))
      .toBeUndefined()
  })
})

const requestOptions: AdapterRequestOptions = {
  provider: PROXY_PROVIDER_ID,
  model: ORCHESTRATOR_MODEL_ID,
  messages: [{ role: 'user', content: [{ type: 'text', text: '完成合成任务' }] }],
}

const imageRef = { attachmentId: 'synthetic-image', width: 1, height: 1, bytes: 3, mediaType: 'image/png' } as ImageAttachmentRef

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function fixture(modelOverrides: Record<string, { target: string }>, models: Record<string, unknown> = accountModels) {
  const generatedWires: string[] = []
  const transport = { request: vi.fn(async ({ url, body }: { url: string; body: string | Uint8Array }) => {
    if (url.includes('fetchAvailableModels')) return Response.json({ models })
    generatedWires.push((JSON.parse(String(body)) as { model: string }).model)
    const text = generatedWires.length === 1
      ? '<plan>{"goal":"完成合成任务","steps":[{"id":"p1","title":"检查夹具","verification":"读到预期字段"}],"handback":[]}</plan>'
      : '已执行合成任务'
    return new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] } })}\n\n`)
  }) }
  const readImage = vi.fn()
  const adapter = new AntigravityProxyAdapter({
    readSettings: () => ({ modelOverrides }),
    attachments: () => ({ readImage }),
    credential: { credential: async () => ({ accessToken: 'synthetic', source: 'login', updatedAt: 'x' }) },
    transport,
  })
  return { adapter, generatedWires, readImage }
}

describe('代理编排目录、预检与真实派发参数一致', () => {
  it('Hydrogen → Sonnet 后，列表与准备使用 4000，实际派发给同一 Sonnet wire', async () => {
    const { adapter, generatedWires } = fixture({ [hydrogen]: { target: sonnetWire }, [opus]: { target: argonWire } })
    const entry = { id: ORCHESTRATOR_MODEL_ID, contextWindow: 4000, maxOutputTokens: 400, inputModalities: ['text'] }
    for (const rows of [await adapter.listModels(PROXY_PROVIDER_ID), await adapter.discoverModels()]) {
      expect(rows.find(row => row.id === ORCHESTRATOR_MODEL_ID)).toMatchObject(entry)
    }
    const prepared = await adapter.prepareCall(PROXY_PROVIDER_ID, ORCHESTRATOR_MODEL_ID)
    expect(prepared.model).toMatchObject({ context: { contextWindow: 4000 }, defaultMaxTokens: 400, inputModalities: ['text'] })
    expect(prepared.model.reasoning).toBeUndefined()
    const chunks = await collect(prepared.stream(requestOptions))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(generatedWires).toEqual([argonWire, sonnetWire])
  })

  it('目录为所有可选 planner 档保留共同容量；切档派发到新档的实际 wire', async () => {
    const selectedPlannerWire = 'claude-opus-5-5-high'
    const { adapter, generatedWires } = fixture({}, {
      ...accountModels,
      [selectedPlannerWire]: { supportsImages: true, maxTokens: 3000, maxOutputTokens: 300 },
      'gemini-4-hydrogen-high': { supportsImages: false, maxTokens: 2000, maxOutputTokens: 200 },
    })
    const rows = await adapter.listModels(PROXY_PROVIDER_ID)
    expect(rows.find(row => row.id === ORCHESTRATOR_MODEL_ID)).toMatchObject({ contextWindow: 3000, maxOutputTokens: 300 })
    const prepared = await adapter.prepareCall(PROXY_PROVIDER_ID, ORCHESTRATOR_MODEL_ID)
    expect(prepared.model).toMatchObject({ context: { contextWindow: 3000 }, defaultMaxTokens: 300,
      reasoning: { defaultEffort: 'medium' } })
    const chunks = await collect(prepared.stream({ ...requestOptions, reasoningEffort: ReasoningEffortId('high') }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(generatedWires).toEqual([selectedPlannerWire, 'gemini-4-hydrogen-medium'])
  })

  it('映射目标不接受图片时，在 planner 派发或读取附件之前显式失败', async () => {
    const { adapter, generatedWires, readImage } = fixture({ [hydrogen]: { target: sonnetWire } })
    await expect(collect(adapter.stream({
      ...requestOptions,
      messages: [{ role: 'user', content: [{ type: 'image', attachment: imageRef }] }],
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_MODALITY' })
    expect(generatedWires).toEqual([])
    expect(readImage).not.toHaveBeenCalled()
  })

  it('planner 目标已固定时，拒绝不兼容的显式档位而非忽略请求', async () => {
    const { adapter, generatedWires } = fixture({ [opus]: { target: argonWire } })
    const prepared = await adapter.prepareCall(PROXY_PROVIDER_ID, ORCHESTRATOR_MODEL_ID)
    await expect(collect(prepared.stream({ ...requestOptions, reasoningEffort: ReasoningEffortId('low') })))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    expect(generatedWires).toEqual([])
  })

  it('无效映射只从选择器隐藏合成项，准备和直接流均报错且不派发', async () => {
    const { adapter, generatedWires } = fixture({ [hydrogen]: { target: 'claude-sonnet-5-5-high' } })
    const listed = await adapter.listModels(PROXY_PROVIDER_ID)
    expect(listed.some(row => row.id === ORCHESTRATOR_MODEL_ID)).toBe(false)
    expect(listed.some(row => row.id === opus)).toBe(true)
    await expect(adapter.prepareCall(PROXY_PROVIDER_ID, ORCHESTRATOR_MODEL_ID)).rejects.toMatchObject({ code: 'INVALID_MODEL' })
    await expect(collect(adapter.stream(requestOptions))).rejects.toMatchObject({ code: 'INVALID_MODEL' })
    expect(generatedWires).toEqual([])
  })

  it.each(['session-title', 'compaction'] as const)('%s 跳过 planner，但使用同一已验证 executor 目标', async (purpose) => {
    const { adapter, generatedWires } = fixture({ [hydrogen]: { target: sonnetWire } })
    const prepared = await adapter.prepareCall(PROXY_PROVIDER_ID, ORCHESTRATOR_MODEL_ID)
    expect(prepared.model.context?.contextWindow).toBe(4000)
    const chunks = await collect(prepared.stream({ ...requestOptions, purpose }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(generatedWires).toEqual([sonnetWire])
  })

  it('辅助用途不能绕过未观测目标校验', async () => {
    const { adapter, generatedWires } = fixture({ [hydrogen]: { target: 'claude-sonnet-5-5-high' } })
    await expect(collect(adapter.stream({ ...requestOptions, purpose: 'compaction' })))
      .rejects.toMatchObject({ code: 'INVALID_MODEL' })
    expect(generatedWires).toEqual([])
  })
})
