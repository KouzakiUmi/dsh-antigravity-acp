import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import Llm, {
  BlockAssembler,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, SessionConfigOption } from '@agentclientprotocol/sdk'
import { AntigravityAcpAdapter, AGY_ADAPTER_ERROR, AGY_PROVIDER_ID } from '../../src/adapter/antigravity-adapter.js'
import type { AntigravityAcpAdapterOptions } from '../../src/adapter/antigravity-adapter.js'
import type { AdapterRequestOptions } from '../../src/adapter/request-options.js'
import { parsePromptTranscript } from '../../src/adapter/prompt-transcript.js'
import { ORCHESTRATOR_MODEL_ID, ORCHESTRATOR_MODEL_NAME } from '../../src/orchestrator/index.js'
import { AgentLink } from '../../src/protocol/agent-link.js'
import { AGY_CLIENT_CAPABILITIES } from '../../src/index.js'
import { FakeAcpAgent, NO_REPLY } from '../helpers/fake-acp-agent.js'

const ORCH_CONFIG_OPTIONS: SessionConfigOption[] = [
  {
    id: 'model',
    type: 'select',
    name: 'Model',
    category: 'model',
    currentValue: 'gemini-4-argon-medium',
    options: [
      { value: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
      { value: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' },
      { value: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
      { value: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
      { value: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
      { value: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
      { value: 'gemini-4-hydrogen-low', name: 'Gemini 4 Hydrogen (Low)' },
      { value: 'gemini-4-hydrogen-medium', name: 'Gemini 4 Hydrogen (Medium)' },
      { value: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
    ],
  },
  {
    id: 'mode',
    type: 'select',
    name: 'Mode',
    category: 'mode',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'accept-edits', name: 'Accept Edits' },
      { value: 'auto', name: 'Auto' },
      { value: 'plan', name: 'Plan' },
    ],
  },
]

const TOOLS: ToolSchema[] = [
  {
    name: 'read_file',
    description: '读取文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
]

const teardowns: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.useRealTimers()
  while (teardowns.length > 0) await teardowns.pop()?.()
  vi.restoreAllMocks()
})

interface McpRegistration {
  type: string
  url: string
  headers: Array<{ name: string; value: string }>
}

function createHarness(options: {
  configOptions?: SessionConfigOption[] | null
  readSettings?: AntigravityAcpAdapterOptions['readSettings']
  loadCliCatalog?: AntigravityAcpAdapterOptions['loadCliCatalog']
  log?: AntigravityAcpAdapterOptions['log']
  keepProcessAfterCancel?: boolean
  cancelGraceMs?: number
  parkSettleMs?: number
  cwd?: string
} = {}) {
  let agent = new FakeAcpAgent()
  let link: AgentLink | undefined
  let inflight: Promise<AgentLink> | undefined
  let bridgeTeardown: (() => Promise<void>) | undefined
  let recycles = 0
  let sessionSeq = 0
  const sessionConfigs = new Map<string, SessionConfigOption[]>()

  const baseConfigOptions = (): SessionConfigOption[] =>
    structuredClone(options.configOptions ?? ORCH_CONFIG_OPTIONS)

  const configureAgent = (): void => {
    agent.on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { embeddedContext: false, image: false, audio: false },
        mcpCapabilities: { http: true },
      },
    }))
    agent.on('authenticate', () => ({}))
    agent.on('session/new', () => {
      sessionSeq += 1
      const sessionId = `acp-session-${sessionSeq}`
      const opts = options.configOptions === null ? [] : baseConfigOptions()
      sessionConfigs.set(sessionId, opts)
      return {
        sessionId,
        configOptions: options.configOptions === null ? null : opts,
      }
    })
    agent.on('session/set_config_option', (params) => {
      const sid = String(params.sessionId ?? '')
      const current = sessionConfigs.get(sid) ?? baseConfigOptions()
      const updated = current.map((opt) =>
        opt.id === params.configId && opt.type === 'select'
          ? { ...opt, currentValue: params.value as string }
          : opt,
      )
      sessionConfigs.set(sid, updated)
      return { configOptions: updated }
    })
    agent.on('session/prompt', () => NO_REPLY)
    agent.on('session/close', () => ({}))
  }
  configureAgent()

  const adapter = new AntigravityAcpAdapter({
    readSettings: options.readSettings,
    loadCliCatalog: options.loadCliCatalog,
    log: options.log,
    keepProcessAfterCancel: options.keepProcessAfterCancel,
    cancelGraceMs: options.cancelGraceMs ?? 50,
    parkSettleMs: options.parkSettleMs ?? 15,
    cwd: options.cwd,
    getLink: async (handlers) => {
      if (link) return link
      inflight ??= (async () => {
        const created = new AgentLink({ stream: agent.stream, handlers, requestTimeoutMs: 5_000 })
        created.start()
        await created.initialize({ clientCapabilities: AGY_CLIENT_CAPABILITIES })
        await created.authenticate()
        link = created
        return created
      })()
      return inflight
    },
    recycleLink: async (old) => {
      await old.close()
      if (link === old) {
        recycles += 1
        link = undefined
        inflight = undefined
        agent = new FakeAcpAgent()
        configureAgent()
      }
    },
    registerBridgeTeardown: (fn) => {
      bridgeTeardown = fn
    },
  })

  teardowns.push(async () => {
    await bridgeTeardown?.()
    await link?.close()
  })

  return {
    adapter,
    get agent() { return agent },
    recycles: () => recycles,
    sessionConfigs,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function waitForRequest(agent: FakeAcpAgent, method: string, count = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(agent.requestsFor(method).length).toBeGreaterThanOrEqual(count)
  })
}

async function connectAgentMcpClient(harness: ReturnType<typeof createHarness>, sessionNewIndex: number): Promise<Client> {
  const params = harness.agent.requestsFor('session/new')[sessionNewIndex]?.params
  const servers = (params?.mcpServers ?? []) as McpRegistration[]
  const server = servers.find((entry) => entry.type === 'http')
  if (!server) throw new Error(`session/new[${sessionNewIndex}] 未注册 http 型 MCP server`)
  const client = new Client({ name: 'fake-antigravity-agent', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])) },
  }))
  teardowns.push(async () => {
    await client.close().catch(() => undefined)
  })
  return client
}

function baseOptions(overrides: Partial<AdapterRequestOptions> = {}): AdapterRequestOptions {
  return {
    provider: AGY_PROVIDER_ID,
    model: ORCHESTRATOR_MODEL_ID,
    sessionId: 'dsh-session-1' as never,
    messages: [createUserMessage({ content: [{ type: 'text', text: '读取 a.ts' }], source: { kind: 'user' } })],
    ...overrides,
  }
}

describe('ACP 编排目录合成与配置校验', () => {
  it('仅当 planner 与 executor 家族都在 configOptions.model 中出现时才合成条目，缺席时选中报错', async () => {
    const partialHarness = createHarness({
      configOptions: [
        {
          id: 'model',
          type: 'select',
          name: 'Model',
          category: 'model',
          currentValue: 'claude-opus-5-5-medium',
          options: [{ value: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' }],
        },
      ],
      // 即使 CLI 清单有 hydrogen，configOptions.model 没有也不得合成
      loadCliCatalog: async () => [{ id: 'gemini-4-hydrogen-medium', name: 'Gemini 4 Hydrogen (Medium)' }],
    })
    await partialHarness.adapter.discoverModels()
    const partialModels = await partialHarness.adapter.listModels(AGY_PROVIDER_ID)
    expect(partialModels.some((m) => m.id === ORCHESTRATOR_MODEL_ID)).toBe(false)
    await expect(partialHarness.adapter.resolveModel(AGY_PROVIDER_ID, ORCHESTRATOR_MODEL_ID))
      .rejects.toMatchObject({ code: AGY_ADAPTER_ERROR.INVALID_ORCHESTRATOR_MODEL })

    let plannerEffort: 'low' | 'medium' | 'high' = 'medium'
    const fullHarness = createHarness({
      readSettings: () => ({ orchestrator: { plannerEffort } }),
    })
    await fullHarness.adapter.discoverModels()
    const fullModels = await fullHarness.adapter.listModels(AGY_PROVIDER_ID)
    expect(fullModels.find((m) => m.id === ORCHESTRATOR_MODEL_ID)).toMatchObject({
      provider: AGY_PROVIDER_ID,
      id: ORCHESTRATOR_MODEL_ID,
      name: ORCHESTRATOR_MODEL_NAME,
    })
    const resolved = await fullHarness.adapter.resolveModel(AGY_PROVIDER_ID, ORCHESTRATOR_MODEL_ID)
    expect(resolved.reasoning?.efforts.map((e) => String(e.id))).toEqual(['low', 'medium', 'high'])
    expect(resolved.reasoning?.efforts.map((e) => e.name)).toEqual(['Low', 'Medium', 'High'])
    expect(String(resolved.reasoning?.defaultEffort)).toBe('medium')

    plannerEffort = 'high'
    const highResolved = await fullHarness.adapter.resolveModel(AGY_PROVIDER_ID, ORCHESTRATOR_MODEL_ID)
    expect(String(highResolved.reasoning?.defaultEffort)).toBe('high')
  })

  it('家族目录 + thought_level 下切到 executor 必须写带档位后缀的 model 并按 thought_level 收敛；非法 executorModel 回落 hydrogen', async () => {
    const barePlusThought: SessionConfigOption[] = [
      {
        id: 'model',
        type: 'select',
        name: 'Model',
        category: 'model',
        currentValue: 'claude-opus-5-5',
        options: [
          { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
          { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
        ],
      },
      {
        id: 'thought_level',
        type: 'select',
        name: 'Thought Level',
        category: 'thought_level',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        id: 'mode',
        type: 'select',
        name: 'Mode',
        category: 'mode',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'plan', name: 'Plan' },
        ],
      },
    ]
    const harness = createHarness({
      configOptions: barePlusThought,
      readSettings: () => ({
        orchestrator: {
          plannerModel: 'claude-opus-5-5',
          plannerEffort: 'low',
          executorEffort: 'medium',
          executorModel: 'ignored-legacy-model',
        } as never,
      }),
    })
    await harness.adapter.discoverModels()
    const streaming = collect(harness.adapter.stream(baseOptions()))

    // planner prompt
    await waitForRequest(harness.agent, 'session/prompt', 1)
    const plannerSid = String(harness.agent.requestsFor('session/prompt')[0]!.params.sessionId)
    await harness.agent.notify('session/update', {
      sessionId: plannerSid,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'p1', content: { type: 'text', text: '<plan>{"goal":"g","steps":[{"id":"p1","title":"s"}]}</plan>' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 0)

    // executor prompt
    await waitForRequest(harness.agent, 'session/prompt', 2)
    const chatSid = String(harness.agent.requestsFor('session/prompt')[1]!.params.sessionId)
    const execModelWrites = harness.agent.requests
      .filter((r) => r.method === 'session/set_config_option' && r.params.sessionId === chatSid && r.params.configId === 'model')
      .map((r) => r.params.value)
    expect(execModelWrites).toEqual(['gemini-4-hydrogen-medium'])

    await harness.agent.notify('session/update', {
      sessionId: chatSid,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'e1', content: { type: 'text', text: 'ok' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 1)
    const chunks = await streaming
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('executorModel 配置为 claude-sonnet-5-5 时，合成条目出现且 executor 会话写入 Sonnet 家族带档位 model', async () => {
    const sonnetOptions: SessionConfigOption[] = [
      {
        id: 'model',
        type: 'select',
        name: 'Model',
        category: 'model',
        currentValue: 'claude-opus-5-5',
        options: [
          { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
          { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
        ],
      },
      {
        id: 'thought_level',
        type: 'select',
        name: 'Thought Level',
        category: 'thought_level',
        currentValue: 'medium',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        id: 'mode',
        type: 'select',
        name: 'Mode',
        category: 'mode',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'plan', name: 'Plan' },
        ],
      },
    ]
    const harness = createHarness({
      configOptions: sonnetOptions,
      readSettings: () => ({
        orchestrator: {
          plannerModel: 'claude-opus-5-5',
          executorModel: 'claude-sonnet-5-5',
          executorEffort: 'medium',
        },
      }),
    })
    await harness.adapter.discoverModels()
    expect((await harness.adapter.listModels(AGY_PROVIDER_ID)).some((m) => m.id === ORCHESTRATOR_MODEL_ID)).toBe(true)

    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt', 1)
    const plannerSid = String(harness.agent.requestsFor('session/prompt')[0]!.params.sessionId)
    await harness.agent.notify('session/update', {
      sessionId: plannerSid,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'p1', content: { type: 'text', text: '<plan>{"goal":"g","steps":[{"id":"p1","title":"s"}]}</plan>' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 0)

    await waitForRequest(harness.agent, 'session/prompt', 2)
    const chatSid = String(harness.agent.requestsFor('session/prompt')[1]!.params.sessionId)
    const execModelWrites = harness.agent.requests
      .filter((r) => r.method === 'session/set_config_option' && r.params.sessionId === chatSid && r.params.configId === 'model')
      .map((r) => r.params.value)
    expect(execModelWrites).toEqual(['claude-sonnet-5-5-medium'])

    await harness.agent.notify('session/update', {
      sessionId: chatSid,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'e1', content: { type: 'text', text: 'ok' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 1)
    const chunks = await streaming
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('orchestrator.enabled === false 时不合成目录条目，stream 直接按 executor 常规执行', async () => {
    const harness = createHarness({
      readSettings: () => ({ orchestrator: { enabled: false } }),
    })
    await harness.adapter.discoverModels()
    expect((await harness.adapter.listModels(AGY_PROVIDER_ID)).some((m) => m.id === ORCHESTRATOR_MODEL_ID)).toBe(false)

    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    const promptReq = harness.agent.requestsFor('session/prompt')[0]!
    await harness.agent.notify('session/update', {
      sessionId: promptReq.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: '直接执行完成' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    const chunks = await streaming
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(1)
    expect(harness.agent.requestsFor('session/set_config_option').map((r) => r.params.value)).toEqual(['gemini-4-hydrogen-medium'])
  })
})

describe('ACP 编排 planner 会话顺序、隔离、取消、超时与 usage 合并', () => {
  it('planner 按 new → set model → set mode(plan) → prompt 顺序，mcpServers 为空，忽略辅助通知，合并两阶段 usage 且排除 usage_update', async () => {
    const harness = createHarness({
      cwd: 'D:\\repo\\demo',
      readSettings: () => ({ orchestrator: { showPlan: true } }),
    })

    const ctx = new Context()
    const fiber = ctx.plugin(Llm)
    try {
      await fiber.inertia
      ctx.llm.registerAdapter([AGY_PROVIDER_ID], harness.adapter)
      await harness.adapter.discoverModels()

      const streaming = collect(ctx.llm.stream({
        provider: AGY_PROVIDER_ID,
        model: ORCHESTRATOR_MODEL_ID,
        sessionId: 'dsh-chat-1' as never,
        messages: [createUserMessage({ content: [{ type: 'text', text: '重构模块' }], source: { kind: 'user' } })],
      }))

      // discoverModels 用了 session/new[0]，planner 会建 session/new[1]
      await waitForRequest(harness.agent, 'session/prompt', 1)
      const plannerNew = harness.agent.requestsFor('session/new')[1]!
      expect(plannerNew.params).toMatchObject({
        cwd: 'D:\\repo\\demo',
        mcpServers: [],
        _meta: { antigravity: { enabledTools: [], eagerMcpServers: [] } },
      })

      const plannerSessionId = 'acp-session-2'
      const plannerPromptReq = harness.agent.requestsFor('session/prompt')[0]!
      expect(plannerPromptReq.params.sessionId).toBe(plannerSessionId)

      // 验证 planner 会话内部严格顺序：new → set model → set mode → prompt
      const plannerMethods = harness.agent.requests
        .filter((req) => req.params.sessionId === plannerSessionId || req === plannerNew)
        .map((req) => req.method === 'session/set_config_option' ? `${req.method}:${String(req.params.configId)}=${String(req.params.value)}` : req.method)
      expect(plannerMethods).toEqual([
        'session/new',
        'session/set_config_option:model=claude-opus-5-5-medium',
        'session/set_config_option:mode=plan',
        'session/prompt',
      ])

      // planner 会话期间发出多种辅助/未知通知与 usage_update，均不得报错或污染 chat/usage
      await harness.agent.notify('session/update', {
        sessionId: plannerSessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
      })
      await harness.agent.notify('session/update', {
        sessionId: plannerSessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
      })
      await harness.agent.notify('session/update', {
        sessionId: plannerSessionId,
        update: { sessionUpdate: 'session_info_update', title: 'planning' },
      })
      await harness.agent.notify('session/update', {
        sessionId: plannerSessionId,
        update: { sessionUpdate: 'usage_update', size: 999999, used: 12345 },
      })
      await harness.agent.notify('session/update', {
        sessionId: plannerSessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'p1',
          content: { type: 'text', text: '<plan>{"goal":"重构模块","steps":[{"id":"p1","title":"检查依赖","verification":"typecheck"}],"handback":["缺权限"]}</plan>' },
        },
      })
      await harness.agent.reply('session/prompt', {
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 40, totalTokens: 155, thoughtTokens: 15 },
      }, 0)

      // 等待 executor 的 session/prompt（第 2 个 prompt）
      await waitForRequest(harness.agent, 'session/prompt', 2)
      const chatSessionId = 'acp-session-3'
      const execPromptReq = harness.agent.requestsFor('session/prompt')[1]!
      expect(execPromptReq.params.sessionId).toBe(chatSessionId)
      const transcript = parsePromptTranscript(execPromptReq.params.prompt as ContentBlock[])
      expect(transcript.system).toContain('[Orchestrator Plan rev=1]')
      expect(transcript.system).toContain('检查依赖')

      // chat 会话从未被切成 plan mode
      const chatSetConfigs = harness.agent.requests
        .filter((req) => req.method === 'session/set_config_option' && req.params.sessionId === chatSessionId)
        .map((req) => `${String(req.params.configId)}=${String(req.params.value)}`)
      expect(chatSetConfigs).toEqual(['model=gemini-4-hydrogen-medium'])

      // chat 的 usage_update 只记录 contextWindow，不计费
      await harness.agent.notify('session/update', {
        sessionId: chatSessionId,
        update: { sessionUpdate: 'usage_update', size: 262144, used: 50000 },
      })
      await harness.agent.notify('session/update', {
        sessionId: chatSessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'e1', content: { type: 'text', text: '重构完成' } },
      })
      await harness.agent.reply('session/prompt', {
        stopReason: 'end_turn',
        usage: { inputTokens: 200, outputTokens: 60, totalTokens: 280, cachedReadTokens: 20 },
      }, 1)

      const chunks = await streaming
      const usageChunks = chunks.filter((c) => c.type === 'usage')
      expect(usageChunks).toHaveLength(1)
      expect(chunks.at(-2)).toEqual({
        type: 'usage',
        usage: {
          inputTokens: 300,
          outputTokens: 100,
          cacheReadTokens: 20,
          reasoningTokens: 15,
          totalTokens: 435,
        },
      })
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })

      const assembler = new BlockAssembler()
      for (const chunk of chunks) assembler.push(chunk)
      expect(assembler.blocks()).toEqual([
        { type: 'text', text: expect.stringContaining('[Orchestrator Plan rev=1]') },
        { type: 'text', text: '重构完成' },
      ])
    } finally {
      await fiber.dispose()
    }
  })

  it('取消只发给 planner 的 sessionId，不降级到 executor，且迟到通知不进入后续 chat 回合', async () => {
    const harness = createHarness({ keepProcessAfterCancel: true, cancelGraceMs: 500 })
    const controller = new AbortController()
    const streaming = collect(harness.adapter.stream(baseOptions({ signal: controller.signal })))

    await waitForRequest(harness.agent, 'session/prompt')
    const plannerPrompt = harness.agent.requestsFor('session/prompt')[0]!
    const plannerSessionId = String(plannerPrompt.params.sessionId)

    controller.abort()
    await vi.waitFor(() => expect(harness.agent.notificationsFor('session/cancel')).toHaveLength(1))
    expect(harness.agent.notificationsFor('session/cancel')[0]?.params).toEqual({ sessionId: plannerSessionId })

    // 迟到的 planner 文本与确认停止
    await harness.agent.notify('session/update', {
      sessionId: plannerSessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'late', content: { type: 'text', text: 'LATE_PLANNER_TEXT' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'cancelled' })

    const chunks = await streaming
    expect(chunks).toEqual([
      { type: 'finish', reason: { kind: 'aborted', failure: { code: expect.any(String), message: expect.stringContaining('取消') } } },
    ])
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(1)

    // 紧接着发起一个普通 chat 请求，验证迟到通知未污染它
    const chatStreaming = collect(harness.adapter.stream({
      provider: AGY_PROVIDER_ID,
      model: 'gemini-4-hydrogen',
      sessionId: 'dsh-chat-clean' as never,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    }))
    await waitForRequest(harness.agent, 'session/prompt', 2)
    const chatSessionId = String(harness.agent.requestsFor('session/prompt')[1]!.params.sessionId)
    expect(chatSessionId).not.toBe(plannerSessionId)
    // 再次从旧 planner sessionId 发迟到更新
    await harness.agent.notify('session/update', {
      sessionId: plannerSessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'late2', content: { type: 'text', text: 'SHOULD_BE_IGNORED' } },
    })
    await harness.agent.notify('session/update', {
      sessionId: chatSessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'c1', content: { type: 'text', text: 'clean reply' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 1)
    const chatChunks = await chatStreaming
    const text = chatChunks.flatMap((c) => c.type === 'text-delta' ? [c.text] : []).join('')
    expect(text).toBe('clean reply')
  })

  it('ACP planner 超时后 warn 并降级直接执行 executor（使用假定时器验证 120000ms 默认超时）', async () => {
    vi.useFakeTimers()
    const warn = vi.fn()
    const harness = createHarness({ log: { info: vi.fn(), warn } })

    const streaming = collect(harness.adapter.stream(baseOptions()))
    await vi.waitFor(() => expect(harness.agent.requestsFor('session/prompt')).toHaveLength(1))

    // 推进 119s 不应超时，推进超过 120s 触发 planner 超时并降级到 executor
    await vi.advanceTimersByTimeAsync(119_000)
    expect(warn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)

    await vi.waitFor(() => expect(harness.agent.requestsFor('session/prompt')).toHaveLength(1))
    // 超时回收旧 link 后，在新 link 上发起 executor prompt
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    await vi.waitFor(() => expect(harness.agent.requestsFor('session/prompt')).toHaveLength(1))

    const execSessionId = String(harness.agent.requestsFor('session/prompt')[0]!.params.sessionId)
    await harness.agent.notify('session/update', {
      sessionId: execSessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'e1', content: { type: 'text', text: '降级执行成功' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })

    const chunks = await streaming
    expect(warn).toHaveBeenCalled()
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const text = chunks.flatMap((c) => c.type === 'text-delta' ? [c.text] : []).join('')
    expect(text).toBe('降级执行成功')
  })
})

describe('ACP 编排三组续轮断言（正常 park / 规划失败 / 计划改变）', () => {
  it('正常 park：工具成功后不重新规划，沿用原 system 并在同一 ACP prompt 上经 MCP 回填一次', async () => {
    const harness = createHarness({ parkSettleMs: 30 })
    const u1 = createUserMessage({ content: [{ type: 'text', text: '读 a.ts' }], source: { kind: 'user' } })
    const opts1 = baseOptions({ tools: TOOLS, messages: [u1], system: 'BASE_SYS' })

    const first = collect(harness.adapter.stream(opts1))
    // 1. planner
    await waitForRequest(harness.agent, 'session/prompt', 1)
    await harness.agent.notify('session/update', {
      sessionId: String(harness.agent.requestsFor('session/prompt')[0]!.params.sessionId),
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'p1', content: { type: 'text', text: '<plan>{"goal":"读文件","steps":[{"id":"p1","title":"读取 a.ts"}]}</plan>' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 0)

    // 2. executor 发起 MCP tool call
    await waitForRequest(harness.agent, 'session/prompt', 2)
    const chatSessionId = String(harness.agent.requestsFor('session/prompt')[1]!.params.sessionId)
    const client = await connectAgentMcpClient(harness, 1)
    const toolCallPromise = client.callTool({ name: 'read_file', arguments: { path: 'a.ts' } })

    const chunks1 = await first
    const callEnd = chunks1.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(callEnd).toBeDefined()
    const callId = callEnd!.type === 'block-end' && callEnd!.block.type === 'tool-call' ? callEnd!.block.id : ''
    expect(chunks1.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })

    // 3. 工具成功返回 → 不触发 planner，原 prompt 回填一次
    const a1 = createAssistantMessage({
      content: [callEnd!.type === 'block-end' ? callEnd!.block : { type: 'text', text: '' }],
      source: { provider: AGY_PROVIDER_ID, model: ORCHESTRATOR_MODEL_ID },
    })
    const okTool = createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: 'FILE_OK' }], isError: false })
    const second = collect(harness.adapter.stream({ ...opts1, messages: [u1, a1, okTool] }))

    const mcpRes = await toolCallPromise
    expect((mcpRes.content as Array<{ text: string }>)[0]?.text).toBe('FILE_OK')
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(2)

    await harness.agent.notify('session/update', {
      sessionId: chatSessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'e2', content: { type: 'text', text: '文件内容已处理' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 1)

    const chunks2 = await second
    expect(chunks2.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(2)
  })

  it('规划失败降级：工具出错触发规划但 planner 返回无效文本，沿用原 system 并在原 prompt 回填一次', async () => {
    const warn = vi.fn()
    const harness = createHarness({ parkSettleMs: 30, log: { info: vi.fn(), warn } })
    const u1 = createUserMessage({ content: [{ type: 'text', text: '读 a.ts' }], source: { kind: 'user' } })
    const opts1 = baseOptions({ tools: TOOLS, messages: [u1], system: 'BASE_SYS' })

    const first = collect(harness.adapter.stream(opts1))
    await waitForRequest(harness.agent, 'session/prompt', 1)
    await harness.agent.notify('session/update', {
      sessionId: String(harness.agent.requestsFor('session/prompt')[0]!.params.sessionId),
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'p1', content: { type: 'text', text: '<plan>{"goal":"读文件","steps":[{"id":"p1","title":"读取 a.ts"}]}</plan>' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 0)

    await waitForRequest(harness.agent, 'session/prompt', 2)
    const chatSessionId = String(harness.agent.requestsFor('session/prompt')[1]!.params.sessionId)
    const client = await connectAgentMcpClient(harness, 1)
    const toolCallPromise = client.callTool({ name: 'read_file', arguments: { path: 'a.ts' } })

    const chunks1 = await first
    const callEnd = chunks1.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')!
    const callId = callEnd.type === 'block-end' && callEnd.block.type === 'tool-call' ? callEnd.block.id : ''

    // 工具报错触发重规划，但 planner 返回不可解析文本
    const a1 = createAssistantMessage({
      content: [callEnd.type === 'block-end' ? callEnd.block : { type: 'text', text: '' }],
      source: { provider: AGY_PROVIDER_ID, model: ORCHESTRATOR_MODEL_ID },
    })
    const errTool = createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: 'ENOENT' }], isError: true })
    const second = collect(harness.adapter.stream({ ...opts1, messages: [u1, a1, errTool] }))

    // planner 复用同一个 planner 会话发第 3 个 prompt
    await waitForRequest(harness.agent, 'session/prompt', 3)
    const plannerSid = String(harness.agent.requestsFor('session/prompt')[2]!.params.sessionId)
    await harness.agent.notify('session/update', {
      sessionId: plannerSid,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'p2', content: { type: 'text', text: 'invalid plan without tags' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 2)

    // 规划失败 → 沿用原 plan 与原 system → 原 chat prompt 通过 MCP 回填一次
    const mcpRes = await toolCallPromise
    expect(mcpRes.isError).toBe(true)
    expect((mcpRes.content as Array<{ text: string }>)[0]?.text).toBe('ENOENT')
    expect(warn).toHaveBeenCalled()
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(3)

    await harness.agent.notify('session/update', {
      sessionId: chatSessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'e2', content: { type: 'text', text: '降级继续完成' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 1)

    const chunks2 = await second
    expect(chunks2.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('计划改变：工具出错重规划出新计划时取消旧 prompt 并只新建一个含新计划与工具历史的 chat prompt', async () => {
    const harness = createHarness({ parkSettleMs: 30, keepProcessAfterCancel: true, cancelGraceMs: 500 })
    const u1 = createUserMessage({ content: [{ type: 'text', text: '读 a.ts' }], source: { kind: 'user' } })
    const opts1 = baseOptions({ tools: TOOLS, messages: [u1], system: 'BASE_SYS' })

    const first = collect(harness.adapter.stream(opts1))
    await waitForRequest(harness.agent, 'session/prompt', 1)
    await harness.agent.notify('session/update', {
      sessionId: String(harness.agent.requestsFor('session/prompt')[0]!.params.sessionId),
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'p1', content: { type: 'text', text: '<plan>{"goal":"读文件","steps":[{"id":"p1","title":"读取 a.ts"}]}</plan>' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 0)

    await waitForRequest(harness.agent, 'session/prompt', 2)
    const oldChatSessionId = String(harness.agent.requestsFor('session/prompt')[1]!.params.sessionId)
    const client = await connectAgentMcpClient(harness, 1)
    const oldToolCall = client.callTool({ name: 'read_file', arguments: { path: 'a.ts' } })

    const chunks1 = await first
    const callEnd = chunks1.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')!
    const callId = callEnd.type === 'block-end' && callEnd.block.type === 'tool-call' ? callEnd.block.id : ''

    const a1 = createAssistantMessage({
      content: [callEnd.type === 'block-end' ? callEnd.block : { type: 'text', text: '' }],
      source: { provider: AGY_PROVIDER_ID, model: ORCHESTRATOR_MODEL_ID },
    })
    const errTool = createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: 'ENOENT' }], isError: true })
    const second = collect(harness.adapter.stream({ ...opts1, messages: [u1, a1, errTool] }))

    // planner 产出新计划 (rev=2)
    await waitForRequest(harness.agent, 'session/prompt', 3)
    const plannerSid = String(harness.agent.requestsFor('session/prompt')[2]!.params.sessionId)
    await harness.agent.notify('session/update', {
      sessionId: plannerSid,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'p2', content: { type: 'text', text: '<plan>{"goal":"读文件","steps":[{"id":"p1","title":"改读 b.ts"}]}</plan>' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 2)

    // ContinuationState 检测到 system 改变 → 取消旧 chat prompt、旧工具调用报错退出（不回填真实结果）
    expect((await oldToolCall).isError).toBe(true)
    await vi.waitFor(() => {
      expect(harness.agent.notificationsFor('session/cancel').map((n) => n.params.sessionId)).toContain(oldChatSessionId)
    })
    // 确认旧 chat prompt 停止，以便继续复用链接建立新 chat 会话
    await harness.agent.reply('session/prompt', { stopReason: 'cancelled' }, 1)

    await waitForRequest(harness.agent, 'session/prompt', 4)
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(4)
    const newChatPrompt = harness.agent.requestsFor('session/prompt')[3]!
    const newChatSessionId = String(newChatPrompt.params.sessionId)
    expect(newChatSessionId).not.toBe(oldChatSessionId)

    const transcript = parsePromptTranscript(newChatPrompt.params.prompt as ContentBlock[])
    expect(transcript.system).toContain('[Orchestrator Plan rev=2]')
    expect(transcript.system).toContain('改读 b.ts')
    expect(transcript.entries.at(-1)).toMatchObject({
      role: 'tool',
      toolCallId: callId,
      isError: true,
      content: [{ type: 'text', text: 'ENOENT' }],
    })

    await harness.agent.notify('session/update', {
      sessionId: newChatSessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'e3', content: { type: 'text', text: '已改读 b.ts 完成' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 3)

    const chunks2 = await second
    expect(chunks2.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })
})
