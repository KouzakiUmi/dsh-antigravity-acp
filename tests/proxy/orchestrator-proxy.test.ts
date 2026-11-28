import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Llm, {
  BlockAssembler,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AdapterRequestOptions } from '../../src/adapter/request-options.js'
import { AntigravityProxyAdapter, PROXY_PROVIDER_ID } from '../../src/proxy/adapter.js'
import { resolveProxyOrchestrator } from '../../src/proxy/model-catalog.js'
import { ORCHESTRATOR_MODEL_ID, ORCHESTRATOR_MODEL_NAME, normalizeOrchestratorSettings } from '../../src/orchestrator/index.js'
import type { AntigravityHostConfig } from '../../src/settings.js'
import { getPublicModelDefinitions } from '@cortexkit/antigravity-auth-core'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const sse = (events: unknown[]) =>
  new Response(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''))

const textEvent = (
  text: string,
  finishReason?: string,
  usageMetadata?: Record<string, number>,
) => ({
  response: {
    candidates: [{ content: { parts: [{ text }] }, finishReason }],
    ...(usageMetadata === undefined ? {} : { usageMetadata }),
  },
})

const toolCallEvent = (
  id: string,
  name: string,
  args: Record<string, unknown>,
  usageMetadata?: Record<string, number>,
) => ({
  response: {
    candidates: [{ content: { parts: [{ functionCall: { id, name, args } }] }, finishReason: 'STOP' }],
    ...(usageMetadata === undefined ? {} : { usageMetadata }),
  },
})

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const fullCatalogResponse = () => Response.json({
  models: {
    'claude-opus-5-5-low': { supportsImages: true, maxTokens: 1000000, maxOutputTokens: 128000 },
    'claude-opus-5-5-medium': { supportsImages: true, maxTokens: 1000000, maxOutputTokens: 128000 },
    'claude-opus-5-5-high': { supportsImages: true, maxTokens: 1000000, maxOutputTokens: 128000 },
    'gemini-4-argon-high': { supportsImages: true, maxTokens: 1048576, maxOutputTokens: 65536 },
    'gemini-4-hydrogen-medium': { supportsImages: true, maxTokens: 524288, maxOutputTokens: 32768 },
    'gemini-4-hydrogen-high': { supportsImages: true, maxTokens: 524288, maxOutputTokens: 32768 },
  },
})

it('代理编排从目录到 planner 期间切换账户时不派发生成', async () => {
  let account = 'old'
  const credential = vi.fn(async () => ({ accessToken: account, source: 'login' as const, updatedAt: 'x' }))
  const request = vi.fn(async ({ url }: { url: string }) => {
    if (!url.includes('fetchAvailableModels')) return sse([textEvent('unexpected generation', 'STOP')])
    account = 'new'
    return fullCatalogResponse()
  })
  const adapter = new AntigravityProxyAdapter({ credential: { credential }, transport: { request } })
  await expect(collect(adapter.stream({
    provider: PROXY_PROVIDER_ID, model: ORCHESTRATOR_MODEL_ID,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'synthetic task' }], source: { kind: 'user' } })],
  }))).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(request).toHaveBeenCalledTimes(1)
})

describe('代理模式 Orchestrator 目录合成', () => {
  it('planner 与 executor wire 都可见时出现合成条目，取最小容量与 executor 模态', async () => {
    const request = vi.fn(async () => fullCatalogResponse())
    const adapter = new AntigravityProxyAdapter({
      credential: { credential: async () => ({ accessToken: 'tok', source: 'login', updatedAt: 'x' }) },
      attachments: () => ({ readImage: vi.fn() }),
      transport: { request },
    })

    const listed = await adapter.listModels(PROXY_PROVIDER_ID)
    const entry = listed.find((row) => row.id === ORCHESTRATOR_MODEL_ID)
    expect(entry).toMatchObject({
      provider: PROXY_PROVIDER_ID,
      id: ORCHESTRATOR_MODEL_ID,
      name: ORCHESTRATOR_MODEL_NAME,
      inputModalities: ['text', 'image'],
      contextWindow: 524288,
      maxOutputTokens: 32768,
    })

    const discovered = await adapter.discoverModels()
    const discEntry = discovered.find((row) => row.id === ORCHESTRATOR_MODEL_ID)
    expect(discEntry).toMatchObject({
      id: ORCHESTRATOR_MODEL_ID,
      contextWindow: 524288,
      maxOutputTokens: 32768,
      inputModalities: ['text', 'image'],
    })

    const resolved = await adapter.resolveModel(PROXY_PROVIDER_ID, ORCHESTRATOR_MODEL_ID)
    expect(resolved).toMatchObject({
      id: ORCHESTRATOR_MODEL_ID,
      context: { contextWindow: 524288 },
      defaultMaxTokens: 32768,
      inputModalities: ['text', 'image'],
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'medium',
      },
    })
  })

  it('resolveModel 的 reasoning.defaultEffort 随配置的 plannerEffort 变化，缺少默认档时向可用档收敛', async () => {
    let plannerEffort: 'low' | 'medium' | 'high' = 'high'
    const adapter = new AntigravityProxyAdapter({
      readSettings: () => ({ orchestrator: { plannerModel: 'claude-opus-5-5', plannerEffort } }),
      credential: { credential: async () => ({ accessToken: 'tok', source: 'login', updatedAt: 'x' }) },
      transport: {
        request: async () => Response.json({
          models: {
            'claude-opus-5-5-low': { maxTokens: 1000000 },
            'claude-opus-5-5-high': { maxTokens: 1000000 },
            'gemini-4-hydrogen-medium': { maxTokens: 524288 },
          },
        }),
      },
    })
    const highResolved = await adapter.resolveModel(PROXY_PROVIDER_ID, ORCHESTRATOR_MODEL_ID)
    expect(highResolved.reasoning?.efforts.map((e) => String(e.id))).toEqual(['low', 'high'])
    expect(String(highResolved.reasoning?.defaultEffort)).toBe('high')

    plannerEffort = 'medium'
    const convergedResolved = await adapter.resolveModel(PROXY_PROVIDER_ID, ORCHESTRATOR_MODEL_ID)
    expect(String(convergedResolved.reasoning?.defaultEffort)).toBe('low')
  })

  it('resolveProxyOrchestrator 接收 planner/executor 独立 effort 参数并收敛到 live 目录', () => {
    const settings = normalizeOrchestratorSettings({ plannerModel: 'gemini-4-neon', plannerEffort: 'high', executorEffort: 'low' })
    const catalog = {
      models: new Map([
        ['antigravity-gemini-4-neon', {
          defaultWire: 'gemini-4-neon-medium',
          efforts: [],
          liveGemini: { name: 'Gemini 4 Neon', variants: new Map([['medium', 'gemini-4-neon-medium']]) },
        }],
        ['antigravity-gemini-4-hydrogen', {
          defaultWire: 'gemini-4-hydrogen-medium',
          efforts: [],
          liveGemini: { name: 'Gemini 4 Hydrogen', variants: new Map([['medium', 'gemini-4-hydrogen-medium'], ['high', 'gemini-4-hydrogen-high']]) },
        }],
      ]),
      wire: new Map([
        ['gemini-4-neon-medium', { contextWindow: 524288 }],
        ['gemini-4-hydrogen-medium', { contextWindow: 1048576 }],
        ['gemini-4-hydrogen-high', { contextWindow: 1048576 }],
      ]),
    }
    const resolved = resolveProxyOrchestrator(settings, catalog, getPublicModelDefinitions(), 'low', 'high')
    expect(resolved?.planner.wire).toBe('gemini-4-neon-medium')
    expect(resolved?.executor.wire).toBe('gemini-4-hydrogen-high')
  })

  it('缺少 planner 或 executor 任一依赖模型时不出现合成条目，选中报 INVALID_MODEL', async () => {
    const adapter = new AntigravityProxyAdapter({
      credential: { credential: async () => ({ accessToken: 'tok', source: 'login', updatedAt: 'x' }) },
      transport: {
        request: async () => Response.json({
          models: {
            'claude-opus-5-5-medium': { maxTokens: 1000000 },
            // 缺少 gemini-4-hydrogen-medium
          },
        }),
      },
    })

    const listed = await adapter.listModels(PROXY_PROVIDER_ID)
    expect(listed.map((row) => row.id)).toEqual(['antigravity-claude-opus-5-5'])
    await expect(adapter.resolveModel(PROXY_PROVIDER_ID, ORCHESTRATOR_MODEL_ID))
      .rejects.toMatchObject({ code: 'INVALID_MODEL', message: '编排模式的 planner/executor 模型不在当前目录' })
    await expect(collect(adapter.stream({
      provider: PROXY_PROVIDER_ID,
      model: ORCHESTRATOR_MODEL_ID,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    }))).rejects.toMatchObject({ code: 'INVALID_MODEL', message: '编排模式的 planner/executor 模型不在当前目录' })
  })

  it('enabled === false 时目录不出现，直接 stream 走 executor 常规路径', async () => {
    const bodies: Array<{ model: string; request: Record<string, unknown> }> = []
    const adapter = new AntigravityProxyAdapter({
      readSettings: () => ({ orchestrator: { enabled: false } }),
      credential: { credential: async () => ({ accessToken: 'tok', source: 'login', updatedAt: 'x' }) },
      transport: {
        request: async ({ url, body }) => {
          if (url.includes('fetchAvailableModels')) return fullCatalogResponse()
          bodies.push(JSON.parse(String(body)))
          return sse([textEvent('direct answer', 'STOP')])
        },
      },
    })

    const listed = await adapter.listModels(PROXY_PROVIDER_ID)
    expect(listed.some((row) => row.id === ORCHESTRATOR_MODEL_ID)).toBe(false)

    const chunks = await collect(adapter.stream({
      provider: PROXY_PROVIDER_ID,
      model: ORCHESTRATOR_MODEL_ID,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    }))
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.model).toBe('gemini-4-hydrogen-medium')
    expect(chunks.find((c) => c.type === 'finish')).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })
})

describe('代理模式 Orchestrator 两阶段执行、预算、降级与取消', () => {
  it('planner → executor 两阶段：planner 无工具无图片、system 稳定注入、usage 合并、工具正常后不重复规划', async () => {
    const generateBodies: Array<{ model: string; requestId: string; request: Record<string, unknown> }> = []
    let turn = 0
    const adapter = new AntigravityProxyAdapter({
      readSettings: () => ({ orchestrator: { showPlan: false, maxPlansPerTurn: 2 } }),
      credential: { credential: async () => ({ accessToken: 'tok', source: 'login', updatedAt: 'x' }) },
      transport: {
        request: async ({ url, body }) => {
          if (url.includes('fetchAvailableModels')) return fullCatalogResponse()
          const parsed = JSON.parse(String(body)) as { model: string; requestId: string; request: Record<string, unknown> }
          generateBodies.push(parsed)
          turn += 1
          if (turn === 1) {
            return sse([
              textEvent('<plan>{"goal":"查看文件","steps":[{"id":"p1","title":"读取 a.ts","verification":"拿到内容"}],"handback":["文件不存在"]}</plan>', 'STOP', {
                promptTokenCount: 100,
                candidatesTokenCount: 40,
                totalTokenCount: 140,
              }),
            ])
          }
          if (turn === 2) {
            return sse([
              toolCallEvent('c1', 'read_file', { path: 'a.ts' }, {
                promptTokenCount: 200,
                candidatesTokenCount: 30,
                thoughtsTokenCount: 10,
                totalTokenCount: 240,
              }),
            ])
          }
          return sse([
            textEvent('已完成读取', 'STOP', {
              promptTokenCount: 250,
              candidatesTokenCount: 20,
              totalTokenCount: 270,
            }),
          ])
        },
      },
    })

    const userMsg = createUserMessage({ content: [{ type: 'text', text: '读一下 a.ts' }], source: { kind: 'user' } })
    const tools = [{
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }]
    const baseOptions: AdapterRequestOptions = {
      provider: PROXY_PROVIDER_ID,
      model: ORCHESTRATOR_MODEL_ID,
      sessionId: 'sess-1' as never,
      system: 'Base prompt',
      tools,
      messages: [userMsg],
    }

    // 第 1 步：触发 planner + executor
    const chunks1 = await collect(adapter.stream(baseOptions))
    expect(generateBodies).toHaveLength(2)

    const plannerBody = generateBodies[0]!
    const execBody1 = generateBodies[1]!
    expect(plannerBody.model).toBe('claude-opus-5-5-medium')
    expect(plannerBody.request.tools).toBeUndefined()
    expect(plannerBody.requestId).not.toBe(execBody1.requestId)
    expect(JSON.stringify(plannerBody.request.systemInstruction)).toContain('planning phase of an orchestrator')

    expect(execBody1.model).toBe('gemini-4-hydrogen-medium')
    expect(execBody1.request.tools).toBeDefined()
    const sys1 = JSON.stringify(execBody1.request.systemInstruction)
    expect(sys1).toContain('[Orchestrator Plan rev=1]')
    expect(sys1).toContain('读取 a.ts')

    // showPlan=false 时只见 executor block（index=0）及合并后的 usage
    const usage1 = chunks1.find((c) => c.type === 'usage')
    expect(usage1).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 300,
        outputTokens: 70,
        reasoningTokens: 10,
        totalTokens: 380,
      },
    })
    const toolBlock = chunks1.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(toolBlock).toBeDefined()
    const finish1 = chunks1.find((c) => c.type === 'finish')

    // 第 2 步：工具成功返回，不应触发 planner，且 executor system 逐字节相同
    const assistantMsg = createAssistantMessage({
      content: [toolBlock!.type === 'block-end' ? toolBlock!.block : { type: 'text', text: '' }],
      source: { provider: PROXY_PROVIDER_ID, model: 'antigravity-gemini-4-hydrogen', replayState: finish1?.replayState },
    })
    const toolOkMsg = createToolResultMessage({
      callId: ToolCallId('c1'),
      content: [{ type: 'text', text: 'export const x = 1' }],
      isError: false,
    })
    const chunks2 = await collect(adapter.stream({
      ...baseOptions,
      messages: [userMsg, assistantMsg, toolOkMsg],
    }))
    expect(generateBodies).toHaveLength(3)
    const execBody2 = generateBodies[2]!
    expect(execBody2.request.systemInstruction).toEqual(execBody1.request.systemInstruction)
    expect(chunks2.find((c) => c.type === 'block-end')?.type).toBe('block-end')
  })

  it('showPlan=true 时展示计划文本块并顺延 executor 块索引；LlmRuntime 装配一致', async () => {
    let call = 0
    const adapter = new AntigravityProxyAdapter({
      readSettings: () => ({ orchestrator: { showPlan: true } }),
      credential: { credential: async () => ({ accessToken: 'tok', source: 'login', updatedAt: 'x' }) },
      transport: {
        request: async ({ url }) => {
          if (url.includes('fetchAvailableModels')) return fullCatalogResponse()
          call += 1
          if (call === 1) {
            return sse([textEvent('<plan>{"goal":"回答问题","steps":[{"id":"p1","title":"直接回答"}]}</plan>', 'STOP')])
          }
          return sse([textEvent('最终答案', 'STOP')])
        },
      },
    })

    const ctx = new Context()
    const fiber = ctx.plugin(Llm)
    try {
      await fiber.inertia
      ctx.llm.registerAdapter([PROXY_PROVIDER_ID], adapter)
      const assembler = new BlockAssembler()
      const chunks = await collect(ctx.llm.stream({
        provider: PROXY_PROVIDER_ID,
        model: ORCHESTRATOR_MODEL_ID,
        sessionId: 'sess-show' as never,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      }))
      for (const chunk of chunks) assembler.push(chunk)
      expect(assembler.blocks()).toEqual([
        { type: 'text', text: expect.stringContaining('[Orchestrator Plan rev=1]') },
        { type: 'text', text: '最终答案' },
      ])
    } finally {
      await fiber.dispose()
    }
  })

  it('planner 显式请求档位优先于配置，非法 executorModel 回落默认 hydrogen', async () => {
    const modelsSent: string[] = []
    const adapter = new AntigravityProxyAdapter({
      readSettings: () => ({
        orchestrator: {
          plannerModel: 'claude-opus-5-5',
          plannerEffort: 'low',
          executorEffort: 'high',
          executorModel: 'legacy-executor' as never,
        },
      }),
      credential: { credential: async () => ({ accessToken: 'tok', source: 'login', updatedAt: 'x' }) },
      transport: {
        request: async ({ url, body }) => {
          if (url.includes('fetchAvailableModels')) return fullCatalogResponse()
          const parsed = JSON.parse(String(body)) as { model: string }
          modelsSent.push(parsed.model)
          if (parsed.model.startsWith('claude-opus-5-5')) {
            return sse([textEvent('<plan>{"goal":"g","steps":[{"id":"p1","title":"s"}]}</plan>', 'STOP')])
          }
          return sse([textEvent('done', 'STOP')])
        },
      },
    })

    await collect(adapter.stream({
      provider: PROXY_PROVIDER_ID,
      model: ORCHESTRATOR_MODEL_ID,
      reasoningEffort: ReasoningEffortId('high'),
      sessionId: 'sess-override' as never,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })],
    }))
    expect(modelsSent).toEqual(['claude-opus-5-5-high', 'gemini-4-hydrogen-high'])
  })

  it('executorModel 配置为 claude-sonnet-5-5 时两阶段都走 Claude 家族，档位显式编码在 wire 后缀', async () => {
    const sonnetCatalog = () => Response.json({
      models: {
        'claude-opus-5-5-low': { supportsImages: true, maxTokens: 1000000, maxOutputTokens: 128000 },
        'claude-opus-5-5-medium': { supportsImages: true, maxTokens: 1000000, maxOutputTokens: 128000 },
        'claude-opus-5-5-high': { supportsImages: true, maxTokens: 1000000, maxOutputTokens: 128000 },
        'claude-sonnet-5-5-low': { supportsImages: true, maxTokens: 1000000, maxOutputTokens: 128000 },
        'claude-sonnet-5-5-medium': { supportsImages: true, maxTokens: 1000000, maxOutputTokens: 128000 },
        'claude-sonnet-5-5-high': { supportsImages: true, maxTokens: 1000000, maxOutputTokens: 128000 },
      },
    })
    const modelsSent: string[] = []
    const adapter = new AntigravityProxyAdapter({
      readSettings: () => ({
        orchestrator: {
          plannerModel: 'claude-opus-5-5',
          executorModel: 'claude-sonnet-5-5',
          executorEffort: 'high',
        },
      }),
      credential: { credential: async () => ({ accessToken: 'tok', source: 'login', updatedAt: 'x' }) },
      transport: {
        request: async ({ url, body }) => {
          if (url.includes('fetchAvailableModels')) return sonnetCatalog()
          const parsed = JSON.parse(String(body)) as { model: string }
          modelsSent.push(parsed.model)
          if (parsed.model.startsWith('claude-opus-5-5')) {
            return sse([textEvent('<plan>{"goal":"g","steps":[{"id":"p1","title":"s"}]}</plan>', 'STOP')])
          }
          return sse([textEvent('done', 'STOP')])
        },
      },
    })

    const listed = await adapter.listModels(PROXY_PROVIDER_ID)
    expect(listed.some((row) => row.id === ORCHESTRATOR_MODEL_ID)).toBe(true)
    await collect(adapter.stream({
      provider: PROXY_PROVIDER_ID,
      model: ORCHESTRATOR_MODEL_ID,
      sessionId: 'sess-sonnet' as never,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })],
    }))
    expect(modelsSent).toEqual(['claude-opus-5-5-medium', 'claude-sonnet-5-5-high'])
  })

  it('工具失败触发重规划并受 maxPlansPerTurn 预算限制；planner 失败降级执行', async () => {
    const warn = vi.fn()
    let settings: Pick<AntigravityHostConfig, 'orchestrator'> = {
      orchestrator: { maxPlansPerTurn: 2 },
    }
    const modelsSent: string[] = []
    let mode: 'ok' | 'fail-planner' = 'ok'
    let planNum = 0

    const adapter = new AntigravityProxyAdapter({
      readSettings: () => settings,
      log: { info: vi.fn(), warn },
      credential: { credential: async () => ({ accessToken: 'tok', source: 'login', updatedAt: 'x' }) },
      transport: {
        request: async ({ url, body }) => {
          if (url.includes('fetchAvailableModels')) return fullCatalogResponse()
          const parsed = JSON.parse(String(body)) as { model: string }
          modelsSent.push(parsed.model)
          if (parsed.model === 'claude-opus-5-5-medium') {
            if (mode === 'fail-planner') return new Response('bad', { status: 500 })
            planNum += 1
            return sse([textEvent(`<plan>{"goal":"g${planNum}","steps":[{"id":"p1","title":"step-${planNum}"}]}</plan>`, 'STOP')])
          }
          return sse([textEvent(`exec-${modelsSent.length}`, 'STOP')])
        },
      },
    })

    const u1 = createUserMessage({ content: [{ type: 'text', text: 'goal 1' }], source: { kind: 'user' } })
    const a1 = createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('t1'), name: 'bash', arguments: '{}' }],
      source: { provider: PROXY_PROVIDER_ID, model: 'antigravity-gemini-4-hydrogen' },
    })
    const err1 = createToolResultMessage({ callId: ToolCallId('t1'), content: [{ type: 'text', text: 'failed 1' }], isError: true })
    const a2 = createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('t2'), name: 'bash', arguments: '{}' }],
      source: { provider: PROXY_PROVIDER_ID, model: 'antigravity-gemini-4-hydrogen' },
    })
    const err2 = createToolResultMessage({ callId: ToolCallId('t2'), content: [{ type: 'text', text: 'failed 2' }], isError: true })

    // 第 1 次（no-plan）：planner + executor
    await collect(adapter.stream({ provider: PROXY_PROVIDER_ID, model: ORCHESTRATOR_MODEL_ID, sessionId: 's-budget' as never, messages: [u1] }))
    expect(modelsSent).toEqual(['claude-opus-5-5-medium', 'gemini-4-hydrogen-medium'])

    // 第 2 次（tool-error）：planner(rev=2) + executor
    await collect(adapter.stream({ provider: PROXY_PROVIDER_ID, model: ORCHESTRATOR_MODEL_ID, sessionId: 's-budget' as never, messages: [u1, a1, err1] }))
    expect(modelsSent).toEqual([
      'claude-opus-5-5-medium', 'gemini-4-hydrogen-medium',
      'claude-opus-5-5-medium', 'gemini-4-hydrogen-medium',
    ])

    // 第 3 次（达到 maxPlansPerTurn=2 预算）：即使 tool-error 也不再触发 planner
    await collect(adapter.stream({ provider: PROXY_PROVIDER_ID, model: ORCHESTRATOR_MODEL_ID, sessionId: 's-budget' as never, messages: [u1, a1, err1, a2, err2] }))
    expect(modelsSent).toEqual([
      'claude-opus-5-5-medium', 'gemini-4-hydrogen-medium',
      'claude-opus-5-5-medium', 'gemini-4-hydrogen-medium',
      'gemini-4-hydrogen-medium',
    ])

    // 新会话遇到 planner 失败 → warn 后直接执行 executor
    mode = 'fail-planner'
    const chunksFail = await collect(adapter.stream({ provider: PROXY_PROVIDER_ID, model: ORCHESTRATOR_MODEL_ID, sessionId: 's-fail' as never, messages: [u1] }))
    expect(warn).toHaveBeenCalled()
    expect(chunksFail.find((c) => c.type === 'finish')).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(modelsSent.slice(-2)).toEqual(['claude-opus-5-5-medium', 'gemini-4-hydrogen-medium'])
  })

  it('options.signal 在 planner 阶段中止时返回 aborted finish 且不 emit usage', async () => {
    const controller = new AbortController()
    const request = vi.fn(async ({ url }: { url: string }) => {
      if (url.includes('fetchAvailableModels')) return fullCatalogResponse()
      controller.abort()
      return sse([textEvent('ignored', 'STOP', { promptTokenCount: 10, candidatesTokenCount: 5 })])
    })
    const adapter = new AntigravityProxyAdapter({
      credential: { credential: async () => ({ accessToken: 'tok', source: 'login', updatedAt: 'x' }) },
      transport: { request },
    })

    const chunks = await collect(adapter.stream({
      provider: PROXY_PROVIDER_ID,
      model: ORCHESTRATOR_MODEL_ID,
      signal: controller.signal,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })],
    }))
    expect(chunks.some((c) => c.type === 'usage')).toBe(false)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
  })
})
