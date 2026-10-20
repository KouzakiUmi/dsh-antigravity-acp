/**
 * Antigravity ACP adapter 的协议级测试：进程内假 ACP agent（tests/helpers/
 * fake-acp-agent.ts）+ 真实 loopback MCP 桥，全程不起官方二进制、不触碰
 * child_process。断言覆盖模型目录、StreamChunk 序列、reasoning、不支持项、
 * abort、工具 park/续轮、权限拒绝、原生活动拒绝与 prompt 重建。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  resolveRetryPolicy,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, SessionConfigOption } from '@agentclientprotocol/sdk'
import { AntigravityAcpAdapter, AGY_PROVIDER_ID, AGY_PLACEHOLDER_MODEL_ID, AGY_UNSUPPORTED_OPTION, AGY_ADAPTER_ERROR } from '../src/adapter/antigravity-adapter.js'
import type { AdapterLog } from '../src/adapter/antigravity-adapter.js'
import { NATIVE_REFUSAL_LIMIT } from '../src/adapter/prompt-turn.js'
import { AGY_TURN_ERROR } from '../src/adapter/prompt-turn.js'
import { AGY_BRIDGE_ERROR } from '../src/bridge/mcp-bridge.js'
import { AgentLink, AGY_LINK_ERROR } from '../src/protocol/agent-link.js'
import { AGY_CLIENT_CAPABILITIES } from '../src/index.js'
import { parsePromptTranscript } from '../src/adapter/prompt-transcript.js'
import { FakeAcpAgent, NO_REPLY } from './helpers/fake-acp-agent.js'

/** 假 agent 声明的会话配置：一个 boolean + 一个 model select。 */
const MODEL_CONFIG_OPTIONS: SessionConfigOption[] = [
  { id: 'thought', type: 'boolean', name: 'Deep Thinking', currentValue: false },
  {
    id: 'model',
    type: 'select',
    name: 'Model',
    category: 'model',
    currentValue: 'gemini-3-pro',
    options: [
      { value: 'gemini-3-pro', name: 'Gemini 3 Pro', description: '质量优先' },
      { value: 'gemini-3-flash', name: 'Gemini 3 Flash' },
    ],
  },
]

const SESSION_1 = 'acp-session-1'
const SESSION_2 = 'acp-session-2'

const TOOLS: ToolSchema[] = [
  {
    name: 'read_file',
    description: '读取宿主上的一个文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
]

interface McpRegistration {
  type: string
  url: string
  headers: Array<{ name: string; value: string }>
}

interface Harness {
  agent: FakeAcpAgent
  adapter: AntigravityAcpAdapter
  bridgeTeardown: () => Promise<void>
  recycles: () => number
}

const teardowns: Array<() => Promise<void>> = []

afterEach(async () => {
  while (teardowns.length > 0) await teardowns.pop()?.()
  vi.restoreAllMocks()
})

/**
 * 组装「假 agent + adapter」。initialize / authenticate / session/new /
 * session/set_config_option 由假 agent 自动应答，session/prompt 留给测试脚本。
 */
function createHarness(
  options: {
    parkSettleMs?: number
    log?: AdapterLog
    configOptions?: SessionConfigOption[] | null
    promptTimeoutMs?: number
    recycleFailure?: Error
    /** 只在第一次回收时失败：模拟「旧进程暂时没退干净，稍后退出」。 */
    recycleFailureOnce?: Error
    loadCachedCatalog?: () => Promise<{ id: string; name: string; description?: string }[] | undefined>
    saveCatalog?: (models: readonly { id: string; name: string; description?: string }[]) => Promise<void> | void
    loadCliCatalog?: () => Promise<readonly { id: string; name: string }[]>
  } = {},
): Harness {
  let agent = new FakeAcpAgent()
  let recycles = 0
  let recycleFailedOnce = false
  let configOptions: SessionConfigOption[] | null = options.configOptions === undefined ? MODEL_CONFIG_OPTIONS : options.configOptions
  let sessionSeq = 0

  const configureAgent = (): void => {
    agent.on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { embeddedContext: false, image: false, audio: false } },
    }))
    agent.on('authenticate', () => ({}))
    agent.on('session/new', () => ({
      sessionId: sessionSeq++ === 0 ? SESSION_1 : SESSION_2,
      configOptions,
    }))
    agent.on('session/set_config_option', (params) => {
      configOptions = (configOptions ?? []).map((option) =>
        option.id === params.configId && option.type === 'select'
          ? { ...option, currentValue: params.value as string }
          : option)
      return { configOptions }
    })
    agent.on('session/prompt', () => NO_REPLY)
  }
  configureAgent()

  let link: AgentLink | undefined
  let inflight: Promise<AgentLink> | undefined
  let bridgeTeardown: (() => Promise<void>) | undefined
  const adapter = new AntigravityAcpAdapter({
    getLink: async (handlers) => {
      if (link) return link
      // 与生产 ensureAcpRuntime 一样 single-flight，让并发测试覆盖 adapter 而非假连接抢锁。
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
      if (options.recycleFailure) throw options.recycleFailure
      if (options.recycleFailureOnce && !recycleFailedOnce) {
        recycleFailedOnce = true
        throw options.recycleFailureOnce
      }
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
    parkSettleMs: options.parkSettleMs ?? 15,
    log: options.log,
    promptTimeoutMs: options.promptTimeoutMs,
    loadCachedCatalog: options.loadCachedCatalog,
    saveCatalog: options.saveCatalog,
    loadCliCatalog: options.loadCliCatalog,
  })
  teardowns.push(async () => {
    await bridgeTeardown?.()
    await link?.close()
  })
  return {
    get agent() { return agent },
    recycles: () => recycles,
    adapter,
    bridgeTeardown: async () => {
      await bridgeTeardown?.()
    },
  }
}

function baseOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: AGY_PROVIDER_ID,
    model: 'gemini-3-pro',
    messages: [createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } })],
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** 等待假 agent 收到某方法的第 count 个请求。 */
async function waitForRequest(agent: FakeAcpAgent, method: string, count = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(agent.requestsFor(method).length).toBeGreaterThanOrEqual(count)
  })
}

/** 取 MCP tool 结果的文本（callTool 的返回类型是联合体，测试里按需窄化）。 */
function toolResultText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content
  return content?.[0]?.text ?? ''
}

/** 取 tool-call block-end chunk 里的调用 id。 */
function toolCallIdOf(chunk: StreamChunk | undefined): string {
  if (!chunk || chunk.type !== 'block-end' || chunk.block.type !== 'tool-call') {
    throw new Error(`该 chunk 不是 tool-call block-end：${JSON.stringify(chunk)}`)
  }
  return chunk.block.id
}

/** 构造「用户 → assistant(tool-call) → tool(result)」交替的完整历史。 */
function toolHistory(entries: ReadonlyArray<{ callId: string; path: string; result: string }>): RequestMessage[] {
  return [
    createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }),
    ...entries.flatMap((entry): RequestMessage[] => [
      createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId(entry.callId), name: 'read_file', arguments: JSON.stringify({ path: entry.path }) }],
        source: { provider: AGY_PROVIDER_ID, model: 'gemini-3-pro' },
      }),
      createToolResultMessage({ callId: ToolCallId(entry.callId), content: [{ type: 'text', text: entry.result }], isError: false }),
    ]),
  ]
}

/** 取出最近一次 session/new 向 agent 注册的 loopback MCP server。 */
function registeredMcpServer(harness: Harness): McpRegistration {
  const params = harness.agent.requestsFor('session/new').at(-1)?.params
  const servers = (params?.mcpServers ?? []) as McpRegistration[]
  const server = servers.find((entry) => entry.type === 'http')
  if (!server) throw new Error('本轮 session/new 未注册 http 型 MCP server')
  return server
}

/** 假 agent 侧：以 ACP 注册的 url + header 连上本插件的 MCP 桥。 */
async function connectAgentMcpClient(harness: Harness): Promise<Client> {
  const server = registeredMcpServer(harness)
  const client = new Client({ name: 'fake-antigravity-agent', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])) },
  }))
  teardowns.push(async () => {
    // 桥可能已先关闭（某些用例刻意如此），此时客户端 close 会以
    // "Connection closed" 失败——收尾不应反向让用例失败。
    await client.close().catch(() => undefined)
  })
  return client
}

describe('模型目录来自 ACP 会话配置', () => {
  it('session/new 的 model select 配置项被映射为 LlmModelInfo 目录', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming

    expect(harness.adapter.catalogObserved).toBe(true)
    // 占位项始终排在首位且保留：用户多半在登录前就选了 server-default，
    // 真实目录出现后把它挤掉会造成「当前模型不在列表里」的语义断裂。
    expect(await harness.adapter.listModels(AGY_PROVIDER_ID)).toEqual([
      {
        provider: AGY_PROVIDER_ID,
        id: AGY_PLACEHOLDER_MODEL_ID,
        name: 'Antigravity 默认（首次对话登录）',
        description: '使用官方 ACP 会话的默认模型；第一次发消息时会下载/登录',
        inputModalities: ['text'],
      },
      { provider: AGY_PROVIDER_ID, id: 'gemini-3-pro', name: 'Gemini 3 Pro', description: '质量优先', inputModalities: ['text'] },
      { provider: AGY_PROVIDER_ID, id: 'gemini-3-flash', name: 'Gemini 3 Flash', inputModalities: ['text'] },
    ])
  })

  it('listModels 不为列目录启动运行时（未观测时广告占位模型，且零 ACP 交互）', async () => {
    const harness = createHarness()
    expect(await harness.adapter.listModels(AGY_PROVIDER_ID)).toEqual([
      {
        provider: AGY_PROVIDER_ID,
        id: AGY_PLACEHOLDER_MODEL_ID,
        name: 'Antigravity 默认（首次对话登录）',
        description: '使用官方 ACP 会话的默认模型；第一次发消息时会下载/登录',
        inputModalities: ['text'],
      },
    ])
    expect(harness.agent.requests).toHaveLength(0)
  })

  it('未观测到真实目录时用磁盘缓存兜住模型选择器，且仍零 ACP 交互', async () => {
    const reads: number[] = []
    const harness = createHarness({
      loadCachedCatalog: async () => {
        reads.push(1)
        return [{ id: 'gemini-3-flash-cached', name: 'Gemini 3 Flash (缓存)', description: '上次会话观测到' }]
      },
    })
    const models = await harness.adapter.listModels(AGY_PROVIDER_ID)
    expect(models[0]?.id).toBe(AGY_PLACEHOLDER_MODEL_ID)
    expect(models[1]).toEqual({
      provider: AGY_PROVIDER_ID,
      id: 'gemini-3-flash-cached',
      name: 'Gemini 3 Flash (缓存)',
      description: '上次会话观测到',
      inputModalities: ['text'],
    })
    // 缓存是纯本地读取，绝不因此启动运行时。
    expect(harness.agent.requests).toHaveLength(0)
    // 只读一次，后续列目录不再碰文件系统。
    await harness.adapter.listModels(AGY_PROVIDER_ID)
    expect(reads).toHaveLength(1)
  })

  it('缓存读取抛错时静默降级为只留占位模型', async () => {
    const harness = createHarness({
      loadCachedCatalog: async () => {
        throw new Error('cache unreadable')
      },
    })
    const models = await harness.adapter.listModels(AGY_PROVIDER_ID)
    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe(AGY_PLACEHOLDER_MODEL_ID)
  })

  it('观测到真实目录后写入缓存，且写入失败不影响本轮', async () => {
    const saved: { id: string; name: string; description?: string }[][] = []
    const harness = createHarness({
      saveCatalog: (models) => {
        saved.push([...models])
        return Promise.reject(new Error('disk full'))
      },
    })
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming

    expect(saved).toHaveLength(1)
    expect(saved[0]?.map((entry) => entry.id)).toEqual(['gemini-3-pro', 'gemini-3-flash'])
    expect(JSON.stringify(saved[0])).not.toMatch(/token|secret|oauth/i)
  })

  it('未观测到 model 选择器时不写缓存', () => {
    const saved: unknown[] = []
    const harness = createHarness({
      saveCatalog: (models) => {
        saved.push(models)
      },
    })
    // 只有 boolean 配置项 → findModelSelector 返回 undefined，不产生可缓存目录。
    harness.adapter.observeSessionConfigOptions([
      { id: 'thought', type: 'boolean', name: 'Deep Thinking', currentValue: false },
    ])
    expect(saved).toHaveLength(0)
  })

  it('providerRetryPolicy 不声明任何可重试失败码（整步重放会重复 spawn/OAuth/工具调用）', () => {
    const harness = createHarness()
    // 刻意 undefined：宿主默认词表不含任何 AGY_*，语义与显式空集一致，但更诚实。
    expect(harness.adapter.providerRetryPolicy(AGY_PROVIDER_ID)).toBeUndefined()
  })

  it('我们抛出的失败码与宿主默认重试词表无交集（「返回 undefined 就不重试」的前提）', () => {
    // 宿主在 providerRetryPolicy() ?? resolveRetryPolicy(undefined) 处装上的默认政策。
    const defaults = resolveRetryPolicy(undefined, 'test.defaults')
    const hostCodes = defaults.mode === 'normal' ? [...defaults.retryableCodes] : []
    const agyCodes = [
      ...Object.values(AGY_LINK_ERROR),
      ...Object.values(AGY_ADAPTER_ERROR),
      ...Object.values(AGY_TURN_ERROR),
      ...Object.values(AGY_BRIDGE_ERROR),
      'AGY_INVALID_PROXY',
    ]
    for (const code of agyCodes) {
      expect(code.startsWith('AGY_')).toBe(true)
      expect(hostCodes).not.toContain(code)
    }
  })

  it('占位 id 与官方目录同名时去重，选择器不出现重复条目', async () => {
    const harness = createHarness({
      configOptions: [
        {
          id: 'model',
          type: 'select',
          name: 'Model',
          category: 'model',
          currentValue: AGY_PLACEHOLDER_MODEL_ID,
          options: [{ value: AGY_PLACEHOLDER_MODEL_ID, name: 'Server Default' }, { value: 'gemini-3-flash', name: 'Gemini 3 Flash' }],
        },
      ],
    })
    harness.adapter.observeSessionConfigOptions([
      {
        id: 'model',
        type: 'select',
        name: 'Model',
        category: 'model',
        currentValue: AGY_PLACEHOLDER_MODEL_ID,
        options: [{ value: AGY_PLACEHOLDER_MODEL_ID, name: 'Server Default' }, { value: 'gemini-3-flash', name: 'Gemini 3 Flash' }],
      },
    ])
    const models = await harness.adapter.listModels(AGY_PROVIDER_ID)
    const ids = models.map((model) => model.id)
    expect(ids).toEqual([AGY_PLACEHOLDER_MODEL_ID, 'gemini-3-flash'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('占位模型不调用 session/set_config_option，沿用会话默认', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions({ model: AGY_PLACEHOLDER_MODEL_ID })))
    await waitForRequest(harness.agent, 'session/prompt')
    expect(harness.agent.requestsFor('session/set_config_option')).toHaveLength(0)
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming
  })

  it('非默认模型经 session/set_config_option 写入会话', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions({ model: 'gemini-3-flash' })))
    await waitForRequest(harness.agent, 'session/set_config_option')
    expect(harness.agent.requestsFor('session/set_config_option')[0]?.params).toMatchObject({
      sessionId: SESSION_1,
      configId: 'model',
      value: 'gemini-3-flash',
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming
  })

  it('config_option_update 也刷新模型目录', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.notify('session/update', {
      sessionId: SESSION_1,
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          { id: 'model', type: 'select', name: 'Model', category: 'model', currentValue: 'gemini-3-flash', options: [{ value: 'gemini-3-flash', name: 'Gemini 3 Flash' }] },
        ],
      },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming
    expect(await harness.adapter.listModels(AGY_PROVIDER_ID)).toEqual([
      {
        provider: AGY_PROVIDER_ID,
        id: AGY_PLACEHOLDER_MODEL_ID,
        name: 'Antigravity 默认（首次对话登录）',
        description: '使用官方 ACP 会话的默认模型；第一次发消息时会下载/登录',
        inputModalities: ['text'],
      },
      { provider: AGY_PROVIDER_ID, id: 'gemini-3-flash', name: 'Gemini 3 Flash', inputModalities: ['text'] },
    ])
  })

  it('会话未声明 model 配置项时报 AGY_NO_MODEL_SELECTOR', async () => {
    const harness = createHarness({ configOptions: [{ id: 'thought', type: 'boolean', name: 'Deep Thinking', currentValue: false }] })
    await expect(collect(harness.adapter.stream(baseOptions()))).rejects.toMatchObject({
      code: AGY_ADAPTER_ERROR.NO_MODEL_SELECTOR,
    })
  })

  it('resolveModel 对目录外 id 仍然接受（目录成员资格是建议性的）', async () => {
    const harness = createHarness()
    const resolved = await harness.adapter.resolveModel(AGY_PROVIDER_ID, '未登记的模型')
    expect(resolved).toMatchObject({ id: '未登记的模型', name: '未登记的模型', inputModalities: ['text'] })
  })

  it('listModels 折叠成家族（Opus 5.5 / Sonnet 5.5 / Argon），不把思考强度放进模型', async () => {
    const harness = createHarness({
      loadCachedCatalog: async () => [{ id: 'gemini-3-flash', name: 'Gemini 3 Flash' }],
      loadCliCatalog: async () => [
        { id: 'gemini-3-flash', name: '重复条目以目录为准' },
        { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
        { id: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
        { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
        { id: 'claude-sonnet-5-5-low', name: 'Claude Sonnet 5.5 (Low)' },
        { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
      ],
    })
    const models = await harness.adapter.listModels(AGY_PROVIDER_ID)
    const ids = models.map((model) => model.id)
    expect(ids[0]).toBe(AGY_PLACEHOLDER_MODEL_ID)
    expect(ids).toContain('claude-opus-5-5')
    expect(ids).toContain('gemini-4-argon')
    expect(ids).toContain('claude-sonnet-5-5')
    // 选择器里不出现档位化 id，也不出现临近下架的 gpt-oss-120b。
    expect(ids.some((id) => /-(low|medium|high)$/.test(id))).toBe(false)
    expect(ids.some((id) => id.includes('gpt-oss'))).toBe(false)
    // 同 id 时保留目录侧的名称。
    expect(models.find((model) => model.id === 'gemini-3-flash')?.name).toBe('Gemini 3 Flash')
    expect(models.find((model) => model.id === 'claude-opus-5-5')?.name).toBe('Claude Opus 5.5')
  })

  it('CLI 清单取数失败时目录主体不受影响', async () => {
    const harness = createHarness({
      loadCachedCatalog: async () => [{ id: 'gemini-3-pro', name: 'Gemini 3 Pro' }],
      loadCliCatalog: async () => {
        throw new Error('cli 不可用')
      },
    })
    const models = await harness.adapter.listModels(AGY_PROVIDER_ID)
    expect(models.map((model) => model.id)).toEqual([AGY_PLACEHOLDER_MODEL_ID, 'gemini-3-pro'])
  })

  it('resolveModel 声明思考强度菜单（低/中/高），默认档位 medium', async () => {
    const harness = createHarness()
    const resolved = await harness.adapter.resolveModel(AGY_PROVIDER_ID, 'claude-opus-5-5')
    expect(resolved.reasoning?.efforts.map((effort) => String(effort.id))).toEqual(['low', 'medium', 'high'])
    expect(String(resolved.reasoning?.defaultEffort)).toBe('medium')
    expect(resolved.reasoning?.efforts.map((effort) => effort.name)).toEqual(['低', '中', '高'])
  })

  it('思考强度路由：选 high 就落到 claude-opus-5-5-high', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions({ model: 'claude-opus-5-5', reasoningEffort: 'high' as never })))
    await waitForRequest(harness.agent, 'session/set_config_option')
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming
    const requested = harness.agent.requests
      .filter((request) => request.method === 'session/set_config_option')
      .map((request) => (request.params as { value: string }).value)
    expect(requested).toContain('claude-opus-5-5-high')
  })

  it('思考强度路由：未选强度且家族档位已知时走默认档位 medium', async () => {
    const harness = createHarness({
      loadCliCatalog: async () => [
        { id: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
        { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
        { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
      ],
    })
    const streaming = collect(harness.adapter.stream(baseOptions({ model: 'gemini-4-argon' })))
    await waitForRequest(harness.agent, 'session/set_config_option')
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming
    const requested = harness.agent.requests
      .filter((request) => request.method === 'session/set_config_option')
      .map((request) => (request.params as { value: string }).value)
    expect(requested).toContain('gemini-4-argon-medium')
  })

  it('配置显式钉住档位且未选强度时，尊重钉住的档位', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions({ model: 'gemini-3.8-flash-high' })))
    await waitForRequest(harness.agent, 'session/set_config_option')
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming
    const requested = harness.agent.requests
      .filter((request) => request.method === 'session/set_config_option')
      .map((request) => (request.params as { value: string }).value)
    expect(requested).toContain('gemini-3.8-flash-high')
  })
})

describe('StreamChunk 序列映射', () => {
  it('agent_message_chunk → text block，stop 后 usage + finish stop，且 finish 是最后一个 chunk', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    for (const [messageId, text] of [['m1', '世界'], ['m1', '，你好'], ['m2', '！']] as const) {
      await harness.agent.notify('session/update', {
        sessionId: SESSION_1,
        update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } },
      })
    }
    await harness.agent.reply('session/prompt', {
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17, thoughtTokens: 2 },
    })

    const chunks = await streaming
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '世界' },
      { type: 'text-delta', index: 0, text: '，你好' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '世界，你好' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '！' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '！' } },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17, reasoningTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(chunks.at(-1)?.type).toBe('finish')
  })

  it('agent_thought_chunk → reasoning block，与后续 text block 各自独立编号', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.notify('session/update', {
      sessionId: SESSION_1,
      update: { sessionUpdate: 'agent_thought_chunk', messageId: 't1', content: { type: 'text', text: '先想' } },
    })
    await harness.agent.notify('session/update', {
      sessionId: SESSION_1,
      update: { sessionUpdate: 'agent_thought_chunk', messageId: 't1', content: { type: 'text', text: '一下' } },
    })
    await harness.agent.notify('session/update', {
      sessionId: SESSION_1,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: '答案' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })

    expect(await streaming).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '先想' },
      { type: 'reasoning-delta', index: 0, text: '一下' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先想一下' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '答案' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '答案' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('max_tokens stopReason 映射为 max-tokens finish', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.reply('session/prompt', { stopReason: 'max_tokens' })
    expect((await streaming).at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('refusal stopReason 映射为 error finish', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.reply('session/prompt', { stopReason: 'refusal' })
    expect((await streaming).at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: AGY_TURN_ERROR.REFUSED } },
    })
  })

  it('refusal 是已应答的干净失败：不回收链接，下一轮直接复用同一连接', async () => {
    const harness = createHarness()
    const first = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.reply('session/prompt', { stopReason: 'refusal' })
    expect((await first).at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: AGY_TURN_ERROR.REFUSED } },
    })

    // 第二轮：同一 agent（未发生回收换新）、同一链路上正常对话。
    const second = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt', 2)
    await harness.agent.notify('session/update', {
      sessionId: SESSION_2,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '恢复后的回复' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 1)
    expect((await second).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    // 留出时间让（不该发生的）回收落地，再确认没有为此重新 spawn 链路。
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.recycles()).toBe(0)
  })

  it('忽略进度类 session/update（plan / usage_update）而不误当内容', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.notify('session/update', {
      sessionId: SESSION_1,
      update: { sessionUpdate: 'plan', entries: [{ content: '规划', priority: 'high', status: 'pending' }] },
    })
    await harness.agent.notify('session/update', {
      sessionId: SESSION_1,
      update: { sessionUpdate: 'usage_update', used: 10, size: 1_000_000 },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    expect(await streaming).toEqual([{
      type: 'finish', reason: { kind: 'error', failure: {
        code: AGY_TURN_ERROR.EMPTY_RESPONSE,
        message: expect.any(String),
      } },
    }])
  })

  it('usage_update.size 记为实测上下文容量，出现在 resolveModel().context', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.notify('session/update', {
      sessionId: SESSION_1,
      update: { sessionUpdate: 'usage_update', used: 10, size: 1_048_576 },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming
    const resolved = await harness.adapter.resolveModel(AGY_PROVIDER_ID, 'gemini-3-pro')
    expect(resolved.context).toEqual({ contextWindow: 1_048_576 })
  })

  it('未实测容量的模型不声明 context（官方目录不报告，绝不填猜测值）', async () => {
    const harness = createHarness()
    const resolved = await harness.adapter.resolveModel(AGY_PROVIDER_ID, 'gemini-3-pro')
    expect(resolved.context).toBeUndefined()
  })

  it('家族折叠下实测容量按家族 id 落盘，且 resolveModel 用家族显示名', async () => {
    // 目录条目是官方档位 id，而 DSH 路由键是折叠后的家族 id：两者不同名。
    const tiered: SessionConfigOption[] = [{
      id: 'model',
      type: 'select',
      name: 'Model',
      category: 'model',
      currentValue: 'claude-opus-5-5-medium',
      options: [
        { value: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
        { value: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' },
        { value: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
      ],
    }]
    const saved: Array<Array<{ id: string; contextWindow?: number }>> = []
    const harness = createHarness({
      configOptions: tiered,
      saveCatalog: (models) => {
        saved.push(models.map((model) => ({ ...model })))
      },
    })
    const streaming = collect(harness.adapter.stream(baseOptions({ model: 'claude-opus-5-5' })))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.notify('session/update', {
      sessionId: SESSION_1,
      update: { sessionUpdate: 'usage_update', used: 10, size: 1_000_000 },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming

    // 修复前：key 是家族 id，落盘却按档位 id 查 → 缓存里永远没有 contextWindow。
    const last = saved.at(-1) ?? []
    expect(last.map((row) => row.contextWindow)).toEqual([1_000_000, 1_000_000, 1_000_000])

    const resolved = await harness.adapter.resolveModel(AGY_PROVIDER_ID, 'claude-opus-5-5')
    expect(resolved).toMatchObject({
      name: 'Claude Opus 5.5',
      context: { contextWindow: 1_000_000 },
    })
  })
})

describe('不支持的请求项', () => {
  const cases: Array<[string, Partial<GenerateOptions>]> = [
    ['temperature', { temperature: 0.5 }],
    ['stop', { stop: ['END'] }],
  ]
  for (const [label, patch] of cases) {
    it(`${label} 抛 UNSUPPORTED_OPTION 且不发起任何 ACP 交互`, async () => {
      const harness = createHarness()
      await expect(collect(harness.adapter.stream(baseOptions(patch)))).rejects.toMatchObject({
        code: AGY_UNSUPPORTED_OPTION,
      })
      expect(harness.agent.requests).toHaveLength(0)
    })
  }

  it('maxTokens 被静默忽略而不是整单拒绝（会话标题等宿主流程固定携带它）', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions({ maxTokens: 256 })))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '参数已接受')
    const chunks = await streaming
    expect(visibleText(chunks)).toBe('参数已接受')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reasoningEffort 是路由键而不是不支持项（菜单选强度 → 路由到档位模型）', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions({ reasoningEffort: 'low' as never })))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '参数已接受')
    const chunks = await streaming
    expect(visibleText(chunks)).toBe('参数已接受')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})

describe('abort 语义', () => {
  it('回收失败时禁止新回合，不绕过回收屏障继续使用旧进程', async () => {
    const failure = new Error('无法确认旧进程已退出')
    const harness = createHarness({ recycleFailure: failure })
    const controller = new AbortController()
    const first = collect(harness.adapter.stream(baseOptions({ signal: controller.signal })))
    await waitForRequest(harness.agent, 'session/prompt')
    controller.abort()
    await first
    await expect(collect(harness.adapter.stream(baseOptions()))).rejects.toBe(failure)
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
  })

  it('回收暂时失败后屏障可重试：旧进程退出后下一轮自动恢复，不永久卡死', async () => {
    const failure = new Error('无法确认旧进程已退出')
    const harness = createHarness({ recycleFailureOnce: failure })
    const controller = new AbortController()
    const first = collect(harness.adapter.stream(baseOptions({ signal: controller.signal })))
    await waitForRequest(harness.agent, 'session/prompt')
    controller.abort()
    await first
    // 第一次回收失败：这一轮被屏障挡住（既有语义）。
    await expect(collect(harness.adapter.stream(baseOptions()))).rejects.toBe(failure)
    // 屏障必须可重试：再次回收成功后，下一轮应能正常对话，而不是永远重放同一个失败。
    const third = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '恢复后的回复')
    expect((await third).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    expect(harness.recycles()).toBe(1)
  })

  it('prompt 超时后回收连接，下一次对话不再卡在 AGY_BUSY', async () => {
    const harness = createHarness({ promptTimeoutMs: 150 })
    const first = await collect(harness.adapter.stream(baseOptions()))
    expect(first.at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: AGY_LINK_ERROR.REQUEST_TIMEOUT } } })
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    const second = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '恢复后的回复')
    expect((await second).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('对端不支持取消时仍回收连接，下一次对话可用', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    const first = collect(harness.adapter.stream(baseOptions({ signal: controller.signal })))
    const oldAgent = harness.agent
    await waitForRequest(oldAgent, 'session/prompt')
    controller.abort('用户停止')
    expect((await first).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    expect(oldAgent.notificationsFor('session/cancel')).toHaveLength(1)
    const second = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '恢复后的回复')
    expect((await second).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('等待工具结果期间取消仍生效，pending 清空且可以再次对话', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    const first = collect(harness.adapter.stream(baseOptions({ tools: TOOLS, signal: controller.signal })))
    const oldAgent = harness.agent
    await waitForRequest(oldAgent, 'session/prompt')
    const client = await connectAgentMcpClient(harness)
    const result = client.callTool({ name: 'read_file', arguments: { path: 'parked.txt' } })
    void result.catch(() => undefined)
    expect((await first).at(-1)).toMatchObject({ reason: { kind: 'tool-calls' } })
    controller.abort('等待工具时取消')
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    expect(harness.adapter.bridge.pendingCallIds()).toEqual([])
    expect(oldAgent.notificationsFor('session/cancel')).toHaveLength(1)
    expect((await result).isError).toBe(true)
    const second = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '恢复后的回复')
    expect((await second).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('signal abort 后发出 session/cancel 并以 finish aborted 收尾', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    const streaming = collect(harness.adapter.stream(baseOptions({ signal: controller.signal })))
    await waitForRequest(harness.agent, 'session/prompt')
    controller.abort(new Error('用户取消'))
    await harness.agent.reply('session/prompt', { stopReason: 'cancelled' })

    expect(await streaming).toEqual([
      {
        type: 'finish',
        reason: { kind: 'aborted', failure: { code: AGY_TURN_ERROR.ABORTED, message: expect.stringContaining('用户取消') } },
      },
    ])
    await vi.waitFor(() => expect(harness.agent.notificationsFor('session/cancel')).toHaveLength(1))
    expect(harness.agent.notificationsFor('session/cancel')[0]?.params).toEqual({ sessionId: SESSION_1 })
  })

  it('已 abort 的 signal 立即以 aborted finish 结束，不发 prompt', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    controller.abort(new Error('pre-abort'))
    const chunks = await collect(harness.adapter.stream(baseOptions({ signal: controller.signal })))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(0)
  })
})

describe('MCP 工具桥：park 与续轮', () => {
  it('tools/call park → tool-call block → finish tool-calls → 续轮回喂 → 同一 prompt 内续流 → finish stop', async () => {
    const harness = createHarness({ parkSettleMs: 60 })
    let mcpResultText: string | undefined
    const mcpCalls: Array<{ name: string; args: unknown }> = []

    // 假 agent 在收到 prompt 后连上本轮注册的 MCP server，列出工具并发一个
    // tools/call；ACP prompt 保持未应答（agent 挂起等待工具输出）。
    harness.agent.on('session/prompt', async () => {
      const client = await connectAgentMcpClient(harness)
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual(['read_file'])
      mcpCalls.push({ name: 'read_file', args: { path: 'a.txt' } })
      const call = client.callTool({ name: 'read_file', arguments: { path: 'a.txt' } })
      void call.then((result) => {
        mcpResultText = (result.content as Array<{ text: string }>)[0]?.text
      })
      await vi.waitFor(() => {
        expect(mcpResultText).toBe('文件内容：hello')
      })
      await harness.agent.notify('session/update', {
        sessionId: SESSION_1,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: '文件已读完' } },
      })
      await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
      return NO_REPLY
    })

    const firstRound = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')
    const firstChunks = await firstRound

    expect(firstChunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: expect.any(String), name: 'read_file', arguments: '{"path":"a.txt"}' },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    const callId = (firstChunks[1] as { block: { id: string } }).block.id

    const continuation = collect(harness.adapter.stream(baseOptions({
      tools: TOOLS,
      messages: [
        createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }),
        createAssistantMessage({
          content: [{ type: 'tool-call', id: ToolCallId(callId), name: 'read_file', arguments: '{"path":"a.txt"}' }],
          source: { provider: AGY_PROVIDER_ID, model: 'gemini-3-pro' },
        }),
        createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: '文件内容：hello' }], isError: false }),
      ],
    })))

    expect(await continuation).toEqual([
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '文件已读完' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '文件已读完' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    // 续轮沿用同一个 ACP session 与同一次 prompt，不重建会话。
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(1)
    expect(mcpCalls).toEqual([{ name: 'read_file', args: { path: 'a.txt' } }])
  })

  it('回喂后 agent 在同一 prompt 内再次 callTool → 续轮订阅仍在，第二批照样 park 并以 finish(tool-calls) 结束', async () => {
    const harness = createHarness({ parkSettleMs: 60, promptTimeoutMs: 10_000 })
    const mcpResults: string[] = []

    harness.agent.on('session/prompt', async () => {
      const client = await connectAgentMcpClient(harness)
      // 第一批：park → 等 DSH 回喂 → resolve。
      const first = await client.callTool({ name: 'read_file', arguments: { path: 'a.txt' } })
      mcpResults.push(toolResultText(first))
      // **同一个 ACP prompt 内**的第二批：续轮若没有（重新）订阅桥的 onParked，
      // 这次 tools/call 不会有人接管，本回合只能等到 prompt 超时。
      const second = await client.callTool({ name: 'read_file', arguments: { path: 'b.txt' } })
      mcpResults.push(toolResultText(second))
      await harness.agent.notify('session/update', {
        sessionId: SESSION_1,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: '两个文件都读完了' } },
      })
      await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
      return NO_REPLY
    })

    // 第 1 轮：agent park 第一批 tools/call。
    const firstRound = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')
    const firstChunks = await firstRound
    expect(firstChunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: expect.any(String), name: 'read_file', arguments: '{"path":"a.txt"}' },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    const firstCallId = toolCallIdOf(firstChunks[1])

    // 第 2 轮：回喂第一个结果 → agent 在同一 prompt 内发出第二批调用。
    const history: Array<{ callId: string; path: string; result: string }> = [
      { callId: firstCallId, path: 'a.txt', result: '文件内容：a' },
    ]
    const secondRound = collect(harness.adapter.stream(baseOptions({ tools: TOOLS, messages: toolHistory(history) })))
    const secondChunks = await secondRound
    expect(secondChunks).toEqual([
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: expect.any(String), name: 'read_file', arguments: '{"path":"b.txt"}' },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    const secondCallId = toolCallIdOf(secondChunks[1])
    expect(secondCallId).not.toBe(firstCallId)

    // 第 3 轮：再次回喂 → 同一 prompt 内续流到 finish stop，不重建会话。
    history.push({ callId: secondCallId, path: 'b.txt', result: '文件内容：b' })
    const thirdRound = collect(harness.adapter.stream(baseOptions({ tools: TOOLS, messages: toolHistory(history) })))
    expect(await thirdRound).toEqual([
      { type: 'block-start', index: 2, blockType: 'text' },
      { type: 'text-delta', index: 2, text: '两个文件都读完了' },
      { type: 'block-end', index: 2, block: { type: 'text', text: '两个文件都读完了' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])

    // 两次回喂都真的到达了 agent 侧（第二批没有挂起）。
    expect(mcpResults).toEqual(['文件内容：a', '文件内容：b'])
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(1)
    expect(harness.adapter.bridge.pendingCallIds()).toEqual([])
  })

  it('首批封口后才到达的并发调用留给续轮，不丢失也不重建会话', async () => {
    const harness = createHarness({ parkSettleMs: 15 })
    const firstRound = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')
    const client = await connectAgentMcpClient(harness)
    const firstResult = client.callTool({ name: 'read_file', arguments: { path: 'first.txt' } })
    void firstResult.catch(() => undefined)
    const firstChunks = await firstRound
    const firstId = toolCallIdOf(firstChunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call'))
    // 此时首轮已返回 finish，文本与第二个并发请求才到达。
    await harness.agent.notify('session/update', {
      sessionId: SESSION_1,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '迟到的进度' } },
    })
    const lateResult = client.callTool({ name: 'read_file', arguments: { path: 'late.txt' } })
    void lateResult.catch(() => undefined)
    await vi.waitFor(() => expect(harness.adapter.bridge.pendingCallIds()).toHaveLength(2))
    const secondChunks = await collect(harness.adapter.stream(baseOptions({
      tools: TOOLS,
      messages: toolHistory([{ callId: firstId, path: 'first.txt', result: 'first' }]),
    })))
    expect(secondChunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: '迟到的进度' }))
    const lateBlock = secondChunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    const lateId = toolCallIdOf(lateBlock)
    expect(lateBlock).toMatchObject({ block: { arguments: '{"path":"late.txt"}' } })
    expect(secondChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(toolResultText(await firstResult)).toBe('first')
    const thirdRound = collect(harness.adapter.stream(baseOptions({
      tools: TOOLS,
      messages: toolHistory([
        { callId: firstId, path: 'first.txt', result: 'first' },
        { callId: lateId, path: 'late.txt', result: 'late' },
      ]),
    })))
    expect(toolResultText(await lateResult)).toBe('late')
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    expect((await thirdRound).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
  })

  it('同一轮内并发 park 的多个调用一起进入同一个 tool-calls 轮次', async () => {
    const harness = createHarness({ parkSettleMs: 150 })
    harness.agent.on('session/prompt', async () => {
      const client = await connectAgentMcpClient(harness)
      const first = client.callTool({ name: 'read_file', arguments: { path: 'x.txt' } })
      const second = client.callTool({ name: 'read_file', arguments: { path: 'y.txt' } })
      void first.catch(() => undefined)
      void second.catch(() => undefined)
      await vi.waitFor(() => {
        expect(harness.adapter.bridge.pendingCallIds()).toHaveLength(2)
      })
      await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
      return NO_REPLY
    })

    const chunks = await collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    const toolCallBlocks = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(toolCallBlocks).toHaveLength(2)
    expect(toolCallBlocks.map((chunk) => (chunk as { block: { arguments: string } }).block.arguments).sort())
      .toEqual(['{"path":"x.txt"}', '{"path":"y.txt"}'])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('MCP server 只监听 127.0.0.1，且缺少随机 token 时拒绝一切请求', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')

    const server = registeredMcpServer(harness)
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(server.headers).toEqual([{ name: 'authorization', value: `Bearer ${harness.adapter.bridge.token}` }])

    const unauthorized = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(unauthorized.status).toBe(401)

    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming
  })

  it('resetPending 以错误结果作废未回喂的 park', async () => {
    const harness = createHarness({ parkSettleMs: 5_000 })
    const streaming = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')
    const client = await connectAgentMcpClient(harness)
    const settled = client.callTool({ name: 'read_file', arguments: { path: 'b.txt' } })
    await vi.waitFor(() => expect(harness.adapter.bridge.pendingCallIds()).toHaveLength(1))

    harness.adapter.bridge.resetPending('本轮作废')
    const result = await settled
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('本轮作废')
    expect(harness.adapter.bridge.pendingCallIds()).toEqual([])

    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    expect((await streaming).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('桥关闭会清空 pending 并停止监听', async () => {
    const harness = createHarness({ parkSettleMs: 5_000 })
    const streaming = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')
    const server = registeredMcpServer(harness)
    const client = await connectAgentMcpClient(harness)
    // close 会立刻断开 HTTP 连接，客户端这次调用未必拿得到响应体；
    // 作废语义（错误结果内容）由上面的 resetPending 用例断言，这里只断言
    // 「pending 被结算 + 监听停止」这两个可确定观察到的副作用。
    const settled = client.callTool({ name: 'read_file', arguments: { path: 'b.txt' } })
    void settled.catch(() => undefined)
    await vi.waitFor(() => expect(harness.adapter.bridge.pendingCallIds()).toHaveLength(1))

    await harness.bridgeTeardown()
    expect(harness.adapter.bridge.pendingCallIds()).toEqual([])
    expect(harness.adapter.bridge.acpRegistration()).toEqual([])

    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    // park 已结算，本轮不再携带待续工具调用。
    expect((await streaming).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })

    // 关闭后端口不再接受请求。
    await expect(fetch(server.url, { method: 'POST', body: '{}' })).rejects.toThrow()
  })

  it('回喂未被 park 的调用被桥拒绝', async () => {
    const harness = createHarness()
    await expect(harness.adapter.bridge.deliverResults([{ callId: '不存在', text: 'x', isError: false }]))
      .rejects.toThrow(AGY_BRIDGE_ERROR.UNKNOWN_TOOL)
  })
})

describe('权限与原生活动策略', () => {
  it('补充权限诊断不放行看似桥接的请求、伪装的原生请求或外来会话', async () => {
    const warn = vi.fn()
    const harness = createHarness({ log: { info: vi.fn(), warn } })
    const streaming = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')
    const calls = [
      { sessionId: SESSION_1, name: 'call_mcp_tool', kind: 'other' },
      { sessionId: SESSION_1, name: 'run_command', kind: 'execute' },
      { sessionId: 'SECRET_FOREIGN_SESSION', name: 'call_mcp_tool', kind: 'other' },
    ]
    for (const call of calls) {
      const response = await harness.agent.callClient('session/request_permission', {
        sessionId: call.sessionId,
        toolCall: {
          toolCallId: 'SECRET_ID', name: call.name, kind: call.kind,
          title: 'SECRET_TITLE',
          rawInput: { ServerName: 'dsh-tools', ToolName: 'read_file', Arguments: { path: 'SECRET_PATH', token: 'SECRET_TOKEN' } },
        },
        options: [
          { optionId: 'yes', name: '允许一次', kind: 'allow_once' },
          { optionId: 'no', name: '拒绝一次', kind: 'reject_once' },
        ],
      })
      expect(response).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'no' } } })
    }
    const diagnosticLines = warn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('权限请求结构'))
    expect(diagnosticLines).toHaveLength(3)
    expect(diagnosticLines[0]).toContain('"programmaticName":"mcp-wrapper"')
    expect(diagnosticLines[0]).toContain('"toolAdvertised":true')
    expect(diagnosticLines[1]).toContain('"programmaticName":"other"')
    expect(diagnosticLines[2]).toContain('"sessionMatches":false')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_')
    await replyWithText(harness, '拒绝规则未改变')
    expect(visibleText(await streaming)).toBe('拒绝规则未改变')
    expect(harness.adapter.bridge.pendingCallIds()).toEqual([])
  })

  it('session/request_permission 仍拒绝，首轮拒绝不终止回合', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    const response = await harness.agent.callClient('session/request_permission', {
      sessionId: SESSION_1,
      toolCall: { toolCallId: 'tc-1', title: '写入文件' },
      options: [
        { optionId: 'yes', name: '允许一次', kind: 'allow_once' },
        { optionId: 'no', name: '拒绝一次', kind: 'reject_once' },
      ],
    })
    // 仍然一律拒绝（不授予任何本地能力）。
    expect(response).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'no' } } })
    // 但回合继续：模型照常收尾，不产生 error finish。
    await replyWithText(harness, '拒绝原生能力后仍可回复')
    const last = (await streaming).at(-1) as { type: string; reason?: { kind?: string } }
    expect(last.type).toBe('finish')
    expect(last.reason?.kind).not.toBe('error')
  })

  it('未预期的原生请求（fs/write_text_file）回 method-not-found，首次不终止回合', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    const response = await harness.agent.callClient('fs/write_text_file', {
      sessionId: SESSION_1,
      path: '/etc/passwd',
      content: 'x',
    })
    // AgentLink 仍按既有语义回 method-not-found（能力没有开放）。
    expect(response).toMatchObject({ error: { code: -32601 } })
    await replyWithText(harness, '拒绝原生能力后仍可回复')
    const last = (await streaming).at(-1) as { type: string; reason?: { kind?: string } }
    expect(last.type).toBe('finish')
    expect(last.reason?.kind).not.toBe('error')
  })

  it('同一回合反复索要原生能力超过上限时按 fail-closed 终止回合', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    // 上限 3：连续 4 次「拒绝但继续」之后才终止。
    for (let attempt = 1; attempt <= NATIVE_REFUSAL_LIMIT + 1; attempt += 1) {
      await harness.agent.callClient('fs/read_text_file', { sessionId: SESSION_1, path: `/tmp/${attempt}` })
    }
    const last = (await streaming).at(-1) as { type: string; reason?: { kind?: string; failure?: { code?: string } } }
    expect(last).toMatchObject({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { code: AGY_TURN_ERROR.NATIVE_ACTIVITY_REFUSED, message: expect.stringContaining('fs/read_text_file') },
      },
    })
    // 对端不答 cancelled 也必须回收，不能把后续对话永久卡在 AGY_BUSY。
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    const next = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '新回合回复')
    expect((await next).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('initialize 上报全关闭的 client 能力（fs / terminal / elicitation）', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'initialize')
    expect(harness.agent.requestsFor('initialize')[0]?.params).toMatchObject({
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming
    expect(AGY_CLIENT_CAPABILITIES.elicitation).toBeUndefined()
  })
})

async function replyWithText(harness: Harness, text: string, index = 0): Promise<void> {
  const request = harness.agent.requestsFor('session/prompt')[index]
  if (!request) throw new Error('假 agent 尚未收到待回复的 prompt')
  await harness.agent.notify('session/update', {
    sessionId: request.params.sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  })
  await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, index)
}

function visibleText(chunks: readonly StreamChunk[]): string {
  return chunks.flatMap((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text' ? [chunk.block.text] : []).join('')
}

describe('主对话与辅助请求隔离', () => {
  for (const titleFirst of [false, true]) {
    it(`首次握手期间同时启动主对话和标题（${titleFirst ? '标题先到' : '主对话先到'}），不覆盖回合`, async () => {
      const harness = createHarness()
      harness.agent.on('session/new', () => NO_REPLY)
      const first = collect(harness.adapter.stream(baseOptions(titleFirst ? { purpose: 'session-title' } : { tools: TOOLS })))
      const second = collect(harness.adapter.stream(baseOptions(titleFirst ? { tools: TOOLS } : { purpose: 'session-title' })))
      void first.catch(() => undefined)
      void second.catch(() => undefined)
      await waitForRequest(harness.agent, 'session/new')
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
      await harness.agent.reply('session/new', { sessionId: SESSION_1, configOptions: MODEL_CONFIG_OPTIONS })
      await waitForRequest(harness.agent, 'session/prompt')
      await replyWithText(harness, titleFirst ? '标题文本' : '主对话文本')
      expect(visibleText(await first)).toBe(titleFirst ? '标题文本' : '主对话文本')
      await waitForRequest(harness.agent, 'session/new', 2)
      await harness.agent.reply('session/new', { sessionId: SESSION_2, configOptions: MODEL_CONFIG_OPTIONS }, 1)
      await waitForRequest(harness.agent, 'session/prompt', 2)
      await replyWithText(harness, titleFirst ? '主对话文本' : '标题文本', 1)
      expect(visibleText(await second)).toBe(titleFirst ? '主对话文本' : '标题文本')
    })
  }

  it('首轮建会话或选模型失败后释放调度位，后面的请求仍可执行', async () => {
    const harness = createHarness({ configOptions: null })
    const failed = collect(harness.adapter.stream(baseOptions()))
    const queued = collect(harness.adapter.stream(baseOptions({ model: AGY_PLACEHOLDER_MODEL_ID, purpose: 'session-title' })))
    await expect(failed).rejects.toMatchObject({ code: AGY_ADAPTER_ERROR.NO_MODEL_SELECTOR })
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '后续请求正常')
    expect(visibleText(await queued)).toBe('后续请求正常')
  })

  it('标题请求不能打断等待工具回喂的主回合，主续轮优先继续', async () => {
    const harness = createHarness()
    const first = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')
    const client = await connectAgentMcpClient(harness)
    const result = client.callTool({ name: 'read_file', arguments: { path: 'a.txt' } })
    void result.catch(() => undefined)
    const chunks = await first
    const id = toolCallIdOf(chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call'))
    const title = collect(harness.adapter.stream(baseOptions({ purpose: 'session-title' })))
    void title.catch(() => undefined)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
    const continuation = collect(harness.adapter.stream(baseOptions({
      tools: TOOLS, messages: toolHistory([{ callId: id, path: 'a.txt', result: '文件内容' }]),
    })))
    expect((await result).isError).not.toBe(true)
    await replyWithText(harness, '主对话最终回复')
    expect(visibleText(await continuation)).toBe('主对话最终回复')
    await waitForRequest(harness.agent, 'session/prompt', 2)
    await replyWithText(harness, '独立标题', 1)
    expect(visibleText(await title)).toBe('独立标题')
    expect(harness.recycles()).toBe(0)
  })

  it('同会话同步压缩不死等其自己的 park，主请求随后用完整历史重建', async () => {
    const harness = createHarness()
    const first = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')
    const client = await connectAgentMcpClient(harness)
    const result = client.callTool({ name: 'read_file', arguments: { path: 'a.txt' } })
    void result.catch(() => undefined)
    const chunks = await first
    const id = toolCallIdOf(chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call'))
    const compact = collect(harness.adapter.stream(baseOptions({ purpose: 'compaction' })))
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    expect((await result).isError).toBe(true)
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '压缩摘要')
    expect(visibleText(await compact)).toBe('压缩摘要')
    const main = collect(harness.adapter.stream(baseOptions({
      tools: TOOLS, messages: toolHistory([{ callId: id, path: 'a.txt', result: '已执行的结果' }]),
    })))
    await waitForRequest(harness.agent, 'session/prompt', 2)
    await replyWithText(harness, '重建后继续回答', 1)
    expect(visibleText(await main)).toBe('重建后继续回答')
  })

  it('卸载 adapter 会释放排队等待者，不让其永久挂起', async () => {
    const harness = createHarness()
    const main = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    const title = collect(harness.adapter.stream(baseOptions({ purpose: 'session-title' })))
    void title.catch(() => undefined)
    await harness.bridgeTeardown()
    await expect(title).rejects.toMatchObject({ code: 'AGY_LINK_CLOSED' })
    await replyWithText(harness, '收尾')
    await main
  })

  it('排队中的标题被取消时只移除等待者，不取消主对话', async () => {
    const harness = createHarness()
    const main = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    const controller = new AbortController()
    const title = collect(harness.adapter.stream(baseOptions({ purpose: 'session-title', signal: controller.signal })))
    controller.abort('标题超时')
    await expect(title).rejects.toMatchObject({ code: AGY_TURN_ERROR.ABORTED })
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
    expect(harness.agent.notificationsFor('session/cancel')).toEqual([])
    await replyWithText(harness, '主对话仍正常')
    expect(visibleText(await main)).toBe('主对话仍正常')
    expect(harness.recycles()).toBe(0)
  })

  it('只有思考或空白文本而没有最终回复也不算成功', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.notify('session/update', {
      sessionId: SESSION_1,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '内部推理' } },
    })
    await harness.agent.notify('session/update', {
      sessionId: SESSION_1,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '  \n' } },
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    expect((await streaming).at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: AGY_TURN_ERROR.EMPTY_RESPONSE } } })
  })

  it('官方回合结束却没有任何内容时明确报错，不显示空白成功', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    expect((await streaming).at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'AGY_EMPTY_RESPONSE' } } })
  })
})

describe('prompt 重建与并发防御', () => {
  it('完整 messages + system 被重建进同一条 ACP prompt，且可逆还原', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions({
      system: '你是守规矩的助手',
      messages: [
        createSystemMessage('系统提示词正文'),
        createUserMessage({ content: [{ type: 'text', text: '第一个问题' }], source: { kind: 'user' } }),
        createAssistantMessage({
          content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '第一个回答' }],
          source: { provider: AGY_PROVIDER_ID, model: 'gemini-3-pro' },
        }),
        createUserMessage({ content: [{ type: 'text', text: '第二个问题' }], source: { kind: 'user' } }),
      ],
    })))
    await waitForRequest(harness.agent, 'session/prompt')

    const prompt = harness.agent.requestsFor('session/prompt')[0]?.params.prompt as ContentBlock[]
    const parsed = parsePromptTranscript(prompt)
    expect(parsed.system).toBe('你是守规矩的助手')
    expect(parsed.entries.map((entry) => entry.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(parsed.entries[2]?.content).toEqual([
      { type: 'reasoning', text: '思考' },
      { type: 'text', text: '第一个回答' },
    ])

    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming
  })

  it('prompt 附带工具策略说明：原生 fs/terminal 不可用、请用随会话工具', async () => {
    // 参考 @estebanforge/pi-antigravity-bridge 的 tool-priority note：只拒绝原生能力
    // 而不告知，偏好原生工具的型号会反复索要（表现为「选具体型号没反应」）。
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    const prompt = harness.agent.requestsFor('session/prompt')[0]?.params.prompt as ContentBlock[]
    const texts = prompt.filter((block): block is { type: 'text'; text: string } => block.type === 'text').map((block) => block.text)
    const policy = texts.find((text) => text.startsWith('<dsh-tool-policy>'))
    expect(policy, 'prompt 里必须带工具策略块').toBeDefined()
    expect(policy).toContain('run_command')
    expect(policy).toContain('不可用')
    // 策略块不参与消息逆解析：system 与消息序列不受影响。
    const parsed = parsePromptTranscript(prompt)
    expect(parsed.entries.map((entry) => entry.role)).toEqual(['user'])
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming
  })

  it('不建会话存储：adapter 状态里只有内存态回合与 bridge pending', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming
    // 会话身份完全来自 ACP 侧；adapter 关闭后无任何残留（下面 teardown 后
    // bridge 的 pending 为空即证）。
    expect(harness.adapter.bridge.pendingCallIds()).toEqual([])
  })

  it('上一轮仍在进行时的新轮等待前轮结束，不抢占也不丢回复', async () => {
    const harness = createHarness()
    const first = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    const second = collect(harness.adapter.stream(baseOptions()))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(1)
    await replyWithText(harness, '第一轮')
    expect(visibleText(await first)).toBe('第一轮')
    await waitForRequest(harness.agent, 'session/prompt', 2)
    await replyWithText(harness, '第二轮', 1)
    expect(visibleText(await second)).toBe('第二轮')
  })

  it('续轮工具结果与 park 表不匹配时放弃旧回合并重建新 session', async () => {
    const harness = createHarness({ parkSettleMs: 2_000 })
    const streaming = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')
    const client = await connectAgentMcpClient(harness)
    const call = client.callTool({ name: 'read_file', arguments: { path: 'c.txt' } })
    void call.catch(() => undefined)
    await vi.waitFor(() => expect(harness.adapter.bridge.pendingCallIds()).toHaveLength(1))
    expect((await streaming).at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })

    const second = collect(harness.adapter.stream(baseOptions({
      tools: TOOLS,
      messages: [createToolResultMessage({ callId: ToolCallId('不对应的-id'), content: [{ type: 'text', text: 'x' }], isError: false })],
    })))
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    await waitForRequest(harness.agent, 'session/new')
    // 旧 park 被作废：桥不再等待回喂。
    expect(harness.adapter.bridge.pendingCallIds()).toEqual([])
    await replyWithText(harness, '重建后的回复')
    expect((await second).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})
