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
import type { ContentBlock, RequestPermissionRequest, SessionConfigOption } from '@agentclientprotocol/sdk'
import { AntigravityAcpAdapter, AGY_PROVIDER_ID, AGY_PLACEHOLDER_MODEL_ID, AGY_ADAPTER_ERROR } from '../src/adapter/antigravity-adapter.js'
import type { ModelOverride } from '../src/settings.js'
import type { AdapterLog, AntigravityAcpAdapterOptions } from '../src/adapter/antigravity-adapter.js'
import type { ImageReader } from '../src/adapter/image-content.js'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionMapStore } from '../src/runtime/session-map.js'
import type { SessionMapEntry } from '../src/runtime/session-map.js'
import { outputHash, prefixHash, routeFingerprint } from '../src/adapter/session-reuse.js'
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
  currentAgent: () => FakeAcpAgent
  bridgeTeardown: () => Promise<void>
  recycles: () => number
  recycleAttempts: () => number
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
    modelOverrides?: Record<string, ModelOverride>
    readSettings?: AntigravityAcpAdapterOptions['readSettings']
    log?: AdapterLog
    configOptions?: SessionConfigOption[] | null
    promptTimeoutMs?: number
    recycleFailure?: Error
    /** 只在第一次回收时失败：模拟「旧进程暂时没退干净，稍后退出」。 */
    recycleFailureOnce?: Error
    holdRecycle?: Promise<void>
    holdRecycleAttempts?: number[]
    onRecycleAttempt?: (count: number) => void
    loadCachedCatalog?: () => Promise<{ id: string; name: string; description?: string }[] | undefined>
    saveCatalog?: (models: readonly { id: string; name: string; description?: string }[]) => Promise<void> | void
    loadCliCatalog?: () => Promise<readonly { id: string; name: string }[]>
    readImage?: ImageReader
    canReadImages?: () => boolean
    imageCapability?: boolean
    onGetLink?: (purpose?: 'warmup') => void
    /** ACP 会话复用开关（默认沿用 adapter 默认值 true）。 */
    reuseSessions?: boolean
    resumeSessions?: boolean
    sessionStore?: SessionMapStore
    loadSessionMap?: () => Promise<Record<string, SessionMapEntry>>
    saveSessionMap?: (entries: Record<string, SessionMapEntry>) => Promise<void> | void
    /** 假 agent 是否声明 loadSession 能力。 */
    loadSessionCapability?: boolean
    keepProcessAfterCancel?: boolean
    cancelGraceMs?: number
    idleRecycleMs?: number
  } = {},
): Harness {
  let agent = new FakeAcpAgent()
  let recycles = 0
  let recycleFailedOnce = false
  let recycleAttempts = 0
  let configOptions: SessionConfigOption[] | null = options.configOptions === undefined ? MODEL_CONFIG_OPTIONS : options.configOptions
  let sessionSeq = 0

  const configureAgent = (): void => {
    agent.on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { embeddedContext: false, image: options.imageCapability === true, audio: false },
        mcpCapabilities: { http: true },
        loadSession: options.loadSessionCapability === true,
      },
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
    agent.on('session/load', () => ({ configOptions }))
    agent.on('session/close', () => ({}))
  }
  configureAgent()

  let link: AgentLink | undefined
  let inflight: Promise<AgentLink> | undefined
  let bridgeTeardown: (() => Promise<void>) | undefined
  const adapter = new AntigravityAcpAdapter({
    modelOverrides: options.modelOverrides,
    readSettings: options.readSettings,
    getLink: async (handlers, _signal, purpose) => {
      options.onGetLink?.(purpose)
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
      recycleAttempts += 1
      options.onRecycleAttempt?.(recycleAttempts)
      if (options.holdRecycleAttempts?.includes(recycleAttempts)) await options.holdRecycle
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
    readImage: options.readImage,
    canReadImages: options.canReadImages,
    reuseSessions: options.reuseSessions,
    resumeSessions: options.resumeSessions,
    sessionStore: options.sessionStore,
    keepProcessAfterCancel: options.keepProcessAfterCancel,
    cancelGraceMs: options.cancelGraceMs,
    idleRecycleMs: options.idleRecycleMs,
    loadSessionMap: options.loadSessionMap,
    saveSessionMap: options.saveSessionMap,
  })
  teardowns.push(async () => {
    await bridgeTeardown?.()
    await link?.close()
  })
  return {
    get agent() { return agent },
    recycles: () => recycles,
    recycleAttempts: () => recycleAttempts,
    currentAgent: () => agent,
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

/** Preserve the actual emitted assistant blocks; a continuation cannot rewrite their arguments or text. */
function emittedAssistant(chunks: readonly StreamChunk[]): RequestMessage {
  return createAssistantMessage({
    content: chunks.flatMap((chunk) => chunk.type === 'block-end' ? [chunk.block] : []),
    source: { provider: AGY_PROVIDER_ID, model: 'gemini-3-pro' },
  })
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
  it('即时配置的开关与显示名更新直接反映在目录，不需要重建 adapter', async () => {
    let modelOverrides: Record<string, ModelOverride> = { 'gemini-test': { enabled: false } }
    const harness = createHarness({
      readSettings: () => ({ modelOverrides }),
      loadCliCatalog: async () => [{ id: 'gemini-test', name: 'Gemini' }, { id: 'claude-test', name: 'Claude' }],
    })
    expect((await harness.adapter.listModels(AGY_PROVIDER_ID)).map(model => model.id)).toEqual(['claude-test'])
    modelOverrides = { 'gemini-test': { name: '改名后' } }
    const models = await harness.adapter.listModels(AGY_PROVIDER_ID)
    expect(models.map(model => model.id)).toEqual(['gemini-test', 'claude-test'])
    expect(models[0]?.name).toBe('改名后')
    modelOverrides = {}
    expect((await harness.adapter.listModels(AGY_PROVIDER_ID)).map(model => model.name)).toEqual(['Gemini', 'Claude'])
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(0)
  })

  it('显式发现模型通过无工具 session/new，首次无 CLI 也能取得目录且不发 prompt', async () => {
    const harness = createHarness()
    expect(await harness.adapter.listModels(AGY_PROVIDER_ID)).toEqual([])
    const models = await harness.adapter.discoverModels()
    expect(models.length).toBeGreaterThan(0)
    expect(harness.agent.requestsFor('session/new')[0]?.params).toMatchObject({
      mcpServers: [], _meta: { antigravity: { enabledTools: [], eagerMcpServers: [] } },
    })
    expect(harness.agent.requestsFor('session/prompt')).toEqual([])
    expect(harness.adapter.busy).toBe(false)
  })

  it.each([true, false])('发现目录 interactive=%s 原样决定是否允许交互认证', async (interactive) => {
    const onGetLink = vi.fn()
    const harness = createHarness({ onGetLink })
    if (interactive) await harness.adapter.discoverModels()
    else await harness.adapter.discoverModels(undefined, false)
    expect(onGetLink).toHaveBeenCalledWith(interactive ? undefined : 'warmup')
    expect(harness.agent.requestsFor('session/prompt')).toEqual([])
  })

  it('发现目录期间取消会回收连接并释放调度位', async () => {
    const harness = createHarness()
    harness.agent.on('session/new', () => NO_REPLY)
    const controller = new AbortController()
    const pending = harness.adapter.discoverModels(controller.signal)
    await waitForRequest(harness.agent, 'session/new')
    controller.abort()
    await expect(pending).rejects.toBeDefined()
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    expect(harness.adapter.busy).toBe(false)
  })

  it('准备首次图像请求前协商能力，实际发送原生图像并可广播元数据', async () => {
    const data = Uint8Array.from([137, 80, 78, 71])
    const ref = { attachmentId: 'sha256:test', mediaType: 'image/png', bytes: data.length, width: 1, height: 1 } as ImageAttachmentRef
    const readImage = vi.fn(async () => ({ ref, data }))
    const harness = createHarness({ readImage, imageCapability: true })
    expect((await harness.adapter.resolveModel(AGY_PROVIDER_ID, 'gemini-3-pro')).inputModalities).toBeUndefined()
    expect(harness.agent.requests).toEqual([])
    const prepared = await harness.adapter.prepareCall(AGY_PROVIDER_ID, 'gemini-3-pro')
    expect(prepared.model.inputModalities).toEqual(['text', 'image'])
    expect(harness.agent.requestsFor('session/new')).toEqual([])
    const result = collect(prepared.stream(baseOptions({ messages: [createUserMessage({ content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } })] })))
    await waitForRequest(harness.agent, 'session/prompt')
    expect(harness.agent.requestsFor('session/prompt')[0]?.params.prompt).toContainEqual({ type: 'image', mimeType: 'image/png', data: Buffer.from(data).toString('base64') })
    await replyWithText(harness, '已读图')
    await result
    const follower = createHarness({ readImage })
    follower.adapter.importMetadata(harness.adapter.exportMetadata())
    expect((await follower.adapter.resolveModel(AGY_PROVIDER_ID, 'gemini-3-pro')).inputModalities).toEqual(['text', 'image'])
    expect(follower.agent.requests).toEqual([])
  })

  it('工具图像结果在原 prompt 中以 MCP image 回填', async () => {
    const data = Uint8Array.from([137, 80, 78, 71])
    const ref = { attachmentId: 'sha256:tool', mediaType: 'image/png', bytes: data.length, width: 1, height: 1 } as ImageAttachmentRef
    const harness = createHarness({ readImage: async () => ({ ref, data }), imageCapability: true })
    const first = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')
    const client = await connectAgentMcpClient(harness)
    const pending = client.callTool({ name: 'read_file', arguments: { path: 'image.png' } })
    const chunks = await first
    const callId = toolCallIdOf(chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call'))
    const next = collect(harness.adapter.stream(baseOptions({ tools: TOOLS, messages: [
      ...baseOptions().messages, emittedAssistant(chunks),
      createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'image', attachment: ref }], isError: false }),
    ] })))
    expect(await pending).toMatchObject({ content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from(data).toString('base64') }], isError: false })
    await replyWithText(harness, '截图已读')
    await next
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(1)
  })

  it('未协商图像能力时直接请求不会把图片 JSON 冒充图像发送', async () => {
    const ref = { attachmentId: 'sha256:test', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } as ImageAttachmentRef
    const harness = createHarness({ readImage: async () => ({ ref, data: Uint8Array.of(1) }) })
    await expect(collect(harness.adapter.stream(baseOptions({ messages: [createUserMessage({ content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } })] })))).rejects.toMatchObject({ code: 'AGY_IMAGE_UNAVAILABLE' })
    expect(harness.agent.requestsFor('session/prompt')).toEqual([])
  })

  it('尚未支持的非文本模型输出明确失败，不把base64作为回复文字显示', async () => {
    const harness = createHarness()
    const pending = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.notify('session/update', {
      sessionId: SESSION_1,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'PRIVATE_IMAGE_BYTES', mimeType: 'image/png' } },
    })
    const result = await pending
    expect(result.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'AGY_UNSUPPORTED_CONTENT' } } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_IMAGE_BYTES')
  })
  it('预热保留同一连接与事件 handlers；聊天复用它且预热不发 prompt', async () => {
    const harness = createHarness()
    await harness.adapter.warmup()
    const agent = harness.agent
    expect(agent.requestsFor('initialize')).toHaveLength(1)
    expect(agent.requestsFor('session/new')).toHaveLength(0)
    expect(agent.requestsFor('session/prompt')).toHaveLength(0)
    const first = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(agent, 'session/prompt')
    await replyWithText(harness, '预热后回复')
    expect(visibleText(await first)).toBe('预热后回复')
    expect(agent.requestsFor('initialize')).toHaveLength(1)
    expect(harness.recycles()).toBe(0)
  })
  it('用户停用的模型不列入选择器，也不新增自造条目', async () => {
    const harness = createHarness({
      modelOverrides: { 'gemini-test': { enabled: false } },
      loadCliCatalog: async () => [{ id: 'gemini-test', name: 'Gemini' }, { id: 'claude-test', name: 'Claude' }],
    })
    expect((await harness.adapter.listModels(AGY_PROVIDER_ID)).map((row) => row.id)).toEqual(['claude-test'])
    expect(harness.agent.requests).toHaveLength(0)
  })

  it('目录外的映射目标不作为模型新增，目录条目保持官方清单', async () => {
    const harness = createHarness({
      modelOverrides: { 'claude-test': { target: 'claude-test-high' } },
      loadCliCatalog: async () => [{ id: 'gemini-test', name: 'Gemini' }, { id: 'claude-test', name: 'Claude' }],
    })
    expect((await harness.adapter.listModels(AGY_PROVIDER_ID)).map((row) => row.id)).toEqual(['gemini-test', 'claude-test'])
  })

  it('显示名覆盖同时作用于目录与会话解析', async () => {
    const harness = createHarness({
      modelOverrides: { 'gemini-test': { name: '自定义名称' } },
      loadCliCatalog: async () => [{ id: 'gemini-test', name: 'Gemini' }],
    })
    expect((await harness.adapter.listModels(AGY_PROVIDER_ID))[0]?.name).toBe('自定义名称')
    expect((await harness.adapter.resolveModel(AGY_PROVIDER_ID, 'gemini-test')).name).toBe('自定义名称')
  })

  it('设置的默认档位成为该模型的 reasoning 缺省档位，未声明的档位退回官方默认', async () => {
    const harness = createHarness({
      modelOverrides: { 'claude-test': { effort: 'high' }, 'gemini-test': { effort: 'low' } },
      loadCliCatalog: async () => [
        { id: 'claude-test-low', name: 'Claude (Low)' },
        { id: 'claude-test-high', name: 'Claude (High)' },
        { id: 'gemini-test-medium', name: 'Gemini (Medium)' },
      ],
    })
    const reasoning = (await harness.adapter.resolveModel(AGY_PROVIDER_ID, 'claude-test')).reasoning
    expect(reasoning?.defaultEffort?.toString()).toBe('high')
    // 官方只声明 medium 时，用户配置的 low 不能指向不存在的选项。
    expect((await harness.adapter.resolveModel(AGY_PROVIDER_ID, 'gemini-test')).reasoning?.defaultEffort?.toString()).toBe('medium')
  })

  it('session/new 的 model select 配置项被映射为 LlmModelInfo 目录', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming

    expect(harness.adapter.catalogObserved).toBe(true)
    // 只展示真实目录；旧 server-default 会话仍可路由，但不再广告首次登录占位项。
    expect(await harness.adapter.listModels(AGY_PROVIDER_ID)).toEqual([
      { provider: AGY_PROVIDER_ID, id: 'gemini-3-pro', name: 'Gemini 3 Pro', description: '质量优先', inputModalities: ['text'] },
      { provider: AGY_PROVIDER_ID, id: 'gemini-3-flash', name: 'Gemini 3 Flash', inputModalities: ['text'] },
    ])
  })

  it('listModels 不为列目录启动运行时（未观测时为空，且零 ACP 交互）', async () => {
    const harness = createHarness()
    expect(await harness.adapter.listModels(AGY_PROVIDER_ID)).toEqual([
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
    expect(models).toHaveLength(1)
    expect(models[0]).toEqual({
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

  it('缓存读取抛错时返回空目录，不编造占位模型', async () => {
    const harness = createHarness({
      loadCachedCatalog: async () => {
        throw new Error('cache unreadable')
      },
    })
    const models = await harness.adapter.listModels(AGY_PROVIDER_ID)
    expect(models).toHaveLength(0)
  })

  it.each([false, true])('观测目录后缓存写入失败不影响本轮（同步抛错=%s）', async (synchronous) => {
    const saved: { id: string; name: string; description?: string }[][] = []
    const harness = createHarness({
      saveCatalog: (models) => {
        saved.push([...models])
        if (synchronous) throw new Error('disk full')
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
    expect(ids).toEqual(['gemini-3-flash'])
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

  it('选模 RPC 成功但未回传配置时继续对话并保留目录', async () => {
    const harness = createHarness()
    harness.agent.on('session/set_config_option', () => NO_REPLY)
    const streaming = collect(harness.adapter.stream(baseOptions({ model: 'gemini-3-flash' })))
    await waitForRequest(harness.agent, 'session/set_config_option')
    const before = await harness.adapter.listModels(AGY_PROVIDER_ID)
    expect(before.length).toBeGreaterThan(0)
    await harness.agent.reply('session/set_config_option', {})
    await waitForRequest(harness.agent, 'session/prompt')
    expect(await harness.adapter.listModels(AGY_PROVIDER_ID)).toEqual(before)
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming
  })

  it('选模 RPC 成功且服务端返回归一化 ID 时继续对话', async () => {
    const harness = createHarness()
    harness.agent.on('session/set_config_option', () => ({ configOptions: [{
      id: 'model', type: 'select', name: 'Model', category: 'model',
      currentValue: 'gemini-3-flash-medium',
      options: [{ value: 'gemini-3-flash-medium', name: 'Gemini Flash Medium' }],
    }] }))
    const streaming = collect(harness.adapter.stream(baseOptions({ model: 'gemini-3-flash' })))
    await waitForRequest(harness.agent, 'session/prompt')
    expect(harness.agent.requestsFor('session/set_config_option')[0]?.params.value).toBe('gemini-3-flash')
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
    expect(ids).not.toContain(AGY_PLACEHOLDER_MODEL_ID)
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
    expect(models.map((model) => model.id)).toEqual(['gemini-3-pro'])
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

  it('映射到官方 ID 时原样写入，优先于家族 + 档位路由', async () => {
    const harness = createHarness({
      modelOverrides: { 'gemini-4-argon': { target: 'gemini-4-argon-preview-x' } },
      loadCliCatalog: async () => [
        { id: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
        { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
      ],
    })
    const streaming = collect(harness.adapter.stream(baseOptions({ model: 'gemini-4-argon', reasoningEffort: 'high' as never })))
    await waitForRequest(harness.agent, 'session/set_config_option')
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming
    const requested = harness.agent.requests
      .filter((request) => request.method === 'session/set_config_option')
      .map((request) => (request.params as { value: string }).value)
    // 映射目标优先：显式选了 high 也不改写用户明确配置的目标。
    expect(requested).toEqual(['gemini-4-argon-preview-x'])
  })

  it('默认思考档位设置决定未选强度时的路由结果', async () => {
    const harness = createHarness({
      modelOverrides: { 'gemini-4-argon': { effort: 'high' } },
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
    expect(requested).toEqual(['gemini-4-argon-high'])
  })

  it('设置里映射的占位路由按映射写入，未映射时沿用会话默认', async () => {
    // 会话当前 value 是 gemini-3-pro；映射到别的 ID 才会产生一次 RPC。
    const mapped = createHarness({
      modelOverrides: { [AGY_PLACEHOLDER_MODEL_ID]: { target: 'gemini-3-flash' } },
    })
    const streaming = collect(mapped.adapter.stream(baseOptions({ model: AGY_PLACEHOLDER_MODEL_ID })))
    await waitForRequest(mapped.agent, 'session/set_config_option')
    expect(mapped.agent.requestsFor('session/set_config_option')[0]?.params).toMatchObject({ value: 'gemini-3-flash' })
    await mapped.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await streaming
    const unmapped = createHarness()
    const second = collect(unmapped.adapter.stream(baseOptions({ model: AGY_PLACEHOLDER_MODEL_ID })))
    await waitForRequest(unmapped.agent, 'session/prompt')
    expect(unmapped.agent.requestsFor('session/set_config_option')).toHaveLength(0)
    await unmapped.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await second
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
    it(`${label} 被忽略（只记警告），请求照常完成`, async () => {
      const log = { info: vi.fn(), warn: vi.fn() }
      const harness = createHarness({ log })
      const streaming = collect(harness.adapter.stream(baseOptions(patch)))
      await waitForRequest(harness.agent, 'session/prompt')
      await replyWithText(harness, '照常完成')
      expect(visibleText(await streaming)).toBe('照常完成')
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(label))
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

describe('模型元数据一致性', () => {
  it('仅导入目录、尚未列目录时也能解析家族名称与真实档位', async () => {
    const loadCliCatalog = async () => [
      { id: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
      { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
    ]
    const source = createHarness({ loadCliCatalog, configOptions: [
      { id: 'model', type: 'select', name: 'Model', category: 'model', currentValue: 'claude-opus-5-5-high', options: [
        { value: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
        { value: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
      ] },
    ] })
    await source.adapter.discoverModels()
    const target = createHarness()
    target.adapter.importMetadata(source.adapter.exportMetadata())
    const resolved = await target.adapter.resolveModel(AGY_PROVIDER_ID, 'claude-opus-5-5')
    expect(resolved.name).toBe('Claude Opus 5.5')
    expect(resolved.reasoning?.efforts.map(entry => entry.id.toString())).toEqual(['low', 'high'])
    expect(resolved.reasoning?.defaultEffort?.toString()).not.toBe('medium')
    // CLI-only 的家族兜底不能覆盖另一个 worker 的完整 ACP 档位观测。
    const observed = createHarness()
    await observed.adapter.discoverModels()
    const original = observed.adapter.exportMetadata()
    observed.adapter.importMetadata({ ...source.adapter.exportMetadata(), catalogSource: 'fallback' })
    expect(observed.adapter.exportMetadata().catalog).toEqual(original.catalog)
  })

  it('磁盘 ACP 原始档位优先于其它 worker 的 CLI 家族兜底', async () => {
    const loadCachedCatalog = async () => [
      { id: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
      { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
    ]
    const fallback = createHarness({ loadCliCatalog: async () => [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    ] })
    await fallback.adapter.listModels(AGY_PROVIDER_ID)
    const target = createHarness({ loadCachedCatalog })
    target.adapter.importMetadata(fallback.adapter.exportMetadata())
    const resolved = await target.adapter.resolveModel(AGY_PROVIDER_ID, 'claude-opus-5-5')
    expect(resolved.reasoning?.efforts.map(entry => entry.id.toString())).toEqual(['low', 'high'])
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
    // 普通聊天不自动补试回收；上一次错误若已发生就原样交给调用方。
    await vi.waitFor(() => expect(harness.recycleAttempts()).toBe(1))
    await expect(collect(harness.adapter.stream(baseOptions()))).rejects.toBe(failure)
    // 屏障必须可重试：回收成功后，下一轮应能正常对话，而不是永远重放同一个失败。
    const third = collect(harness.adapter.stream(baseOptions()))
    await vi.waitFor(() => expect(harness.currentAgent().requestsFor('session/prompt').length).toBe(1))
    await replyWithText(harness, '恢复后的回复')
    expect((await third).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    expect(harness.recycles()).toBe(1)
  })

  it('显式预热可从一次性旧回收故障中恢复，不跳过退出确认', async () => {
    let releaseRecycle!: () => void
    const holdRecycle = new Promise<void>((resolve) => { releaseRecycle = resolve })
    let failedRecycle!: () => void
    const failed = new Promise<void>((resolve) => { failedRecycle = resolve })
    const harness = createHarness({
      recycleFailureOnce: new Error('无法确认旧进程已退出'), holdRecycle, holdRecycleAttempts: [2],
      onRecycleAttempt: (count) => { if (count === 2) failedRecycle() },
    })
    const controller = new AbortController()
    const first = collect(harness.adapter.stream(baseOptions({ signal: controller.signal })))
    const previousAgent = harness.agent
    await waitForRequest(previousAgent, 'session/prompt')
    controller.abort()
    await first
    await vi.waitFor(() => expect(harness.recycleAttempts()).toBe(1))
    const warmup = harness.adapter.warmup()
    await failed
    expect(harness.recycleAttempts()).toBe(2)
    releaseRecycle()
    await warmup
    // 第一次回收失败已发生，本次在同一预热操作内重试并成功恢复。
    expect(harness.recycleAttempts()).toBe(2)
    expect(harness.recycles()).toBe(1)
    expect(previousAgent.requestsFor('session/prompt')).toHaveLength(1)
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(0)
    const next = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '预热恢复后的回复')
    expect(visibleText(await next)).toBe('预热恢复后的回复')
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
  it('工具 ID 仍匹配但系统提示改变时取消旧 prompt 并按新上下文重建', async () => {
    const harness = createHarness()
    const first = collect(harness.adapter.stream(baseOptions({ tools: TOOLS, system: 'old system' })))
    await waitForRequest(harness.agent, 'session/prompt')
    const client = await connectAgentMcpClient(harness)
    const pending = client.callTool({ name: 'read_file', arguments: { path: 'a.txt' } })
    const chunks = await first
    const callId = toolCallIdOf(chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call'))
    const next = collect(harness.adapter.stream(baseOptions({ tools: TOOLS, system: 'new system', messages: [
      ...baseOptions().messages, emittedAssistant(chunks),
      createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: 'already executed' }], isError: false }),
    ] })))
    expect((await pending).isError).toBe(true)
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    await waitForRequest(harness.agent, 'session/prompt')
    const transcript = parsePromptTranscript(harness.agent.requestsFor('session/prompt')[0]!.params.prompt as ContentBlock[])
    expect(transcript.system).toBe('new system')
    expect(transcript.entries.at(-1)).toMatchObject({ role: 'tool', toolCallId: callId, content: [{ type: 'text', text: 'already executed' }] })
    await replyWithText(harness, '使用新上下文继续')
    expect(visibleText(await next)).toBe('使用新上下文继续')
  })

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
      messages: [
        ...toolHistory([{ callId: firstId, path: 'first.txt', result: 'first' }]),
        emittedAssistant(secondChunks),
        createToolResultMessage({ callId: ToolCallId(lateId), content: [{ type: 'text', text: 'late' }], isError: false }),
      ],
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
    // 卸载已明确终止生产者，迟到的 end_turn 不能把取消冒充成功。
    expect((await streaming).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure: { code: AGY_TURN_ERROR.ABORTED } } })

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
  it('权限诊断不放行未知工具、外部服务器、原生名称或外来会话', async () => {
    const warn = vi.fn()
    const harness = createHarness({ log: { info: vi.fn(), warn } })
    const streaming = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')
    const calls = [
      { sessionId: SESSION_1, name: 'call_mcp_tool', kind: 'other', server: 'dsh-tools', tool: 'unknown' },
      { sessionId: SESSION_1, name: 'run_command', kind: 'execute', server: 'dsh-tools', tool: 'read_file' },
      { sessionId: 'SECRET_FOREIGN_SESSION', name: 'call_mcp_tool', kind: 'other', server: 'dsh-tools', tool: 'read_file' },
      { sessionId: SESSION_1, name: undefined, kind: 'other', server: 'external', tool: 'read_file' },
    ]
    for (const call of calls) {
      const response = await harness.agent.callClient('session/request_permission', {
        sessionId: call.sessionId,
        toolCall: {
          toolCallId: 'SECRET_ID', name: call.name, kind: call.kind,
          _meta: { is_mcp_tool_call: true, mcp: { server: call.server, tool: call.tool } },
          title: 'SECRET_TITLE',
          rawInput: { ServerName: 'dsh-tools', ToolName: 'read_file', Arguments: { path: 'SECRET_PATH', token: 'SECRET_TOKEN' } },
        },
        options: [
          { optionId: 'yes', name: '允许一次', kind: 'allow_once' },
          { optionId: 'no', name: '拒绝一次', kind: 'reject_once' },
        ],
      })
      expect(response).toMatchObject({ result: { outcome: call.sessionId === SESSION_1
        ? { outcome: 'selected', optionId: 'no' }
        : { outcome: 'cancelled' } } })
    }
    const diagnosticLines = warn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('权限请求结构'))
    expect(diagnosticLines).toHaveLength(4)
    expect(diagnosticLines[0]).toContain('"programmaticName":"mcp-wrapper"')
    expect(diagnosticLines[0]).toContain('"toolAdvertised":false')
    expect(diagnosticLines[1]).toContain('"programmaticName":"other"')
    expect(diagnosticLines[2]).toContain('"sessionMatches":false')
    expect(diagnosticLines[3]).toContain('"mcpMeta":{"marked":true,"serverMatches":false,"toolAdvertised":true}')
    expect(warn.mock.calls.some(([message]) => String(message).includes('来源=ACP插件，尚未转交DSH工具审批'))).toBe(true)
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

  it('反复索要原生能力仍逐次拒绝，但不因累计次数终止对话或回收进程', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await harness.agent.callClient('fs/read_text_file', { sessionId: SESSION_1, path: `/tmp/${attempt}` })
      expect(response).toMatchObject({ error: { code: -32601 } })
      const denied = await harness.agent.callClient('session/request_permission', {
        sessionId: SESSION_1, toolCall: { toolCallId: `native-${attempt}`, name: 'run_command', kind: 'execute' },
        options: [{ optionId: 'no', name: 'Deny', kind: 'reject_once' }],
      })
      expect(denied).toMatchObject({ result: { outcome: { optionId: 'no' } } })
    }
    await replyWithText(harness, '拒绝后继续回复')
    expect((await streaming).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    expect(harness.recycles()).toBe(0)
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
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
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

describe('ACP 私有 MCP 权限与原 prompt 续轮', () => {
  function permission(sessionId = SESSION_1, id = 'official-call-1', args = { path: 'a.txt' }): RequestPermissionRequest {
    return {
      sessionId,
      toolCall: {
        toolCallId: id, kind: 'other',
        _meta: { is_mcp_tool_call: true, mcp: { server: 'dsh-tools', tool: 'read_file' } },
        rawInput: { arguments: args, ...args },
      },
      options: [
        { optionId: 'always', name: 'Always', kind: 'allow_always' },
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Deny', kind: 'reject_once' },
      ],
    }
  }

  it.each([false, true])('DSH 结果 isError=%s 经 MCP 回原 prompt；无进程重启或历史重放', async (isError) => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')
    expect(harness.agent.requestsFor('session/new')[0]!.params._meta).toEqual({
      antigravity: { enabledTools: [], eagerMcpServers: ['dsh-tools'] },
    })
    const approval: RequestPermissionRequest = permission()
    approval.toolCall.kind = 'read'
    delete approval.toolCall.rawInput
    const response = await harness.agent.callClient('session/request_permission', approval)
    expect(response).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'yes' } } })
    // 展示分类或提示参数缺失不拦桥；权限应答本身不合成调用，只有实际 tools/call 才交给 DSH。
    expect(harness.adapter.bridge.pendingCallIds()).toEqual([])
    const client = await connectAgentMcpClient(harness)
    const pending = client.callTool({ name: 'read_file', arguments: { path: 'a.txt' } })
    const chunks = await streaming
    const callId = toolCallIdOf(chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call'))
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'tool-calls' } })
    const text = isError ? 'DSH denied this operation' : 'file contents'
    const messages = toolHistory([{ callId, path: 'a.txt', result: text }])
    messages[messages.length - 1] = createToolResultMessage({
      callId: ToolCallId(callId), content: [{ type: 'text', text }], isError,
    })
    const next = collect(harness.adapter.stream(baseOptions({ tools: TOOLS, messages })))
    expect(await pending).toMatchObject({ isError, content: [{ type: 'text', text }] })
    await replyWithText(harness, '继续回答')
    expect(visibleText(await next)).toBe('继续回答')
    expect(harness.recycles()).toBe(0)
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(1)
  })

  it('同批并行权限与 MCP 调用全部交给 DSH；第二批仍复用原 prompt', async () => {
    const harness = createHarness({ parkSettleMs: 30 })
    const options = baseOptions({ tools: TOOLS })
    const first = collect(harness.adapter.stream(options))
    await waitForRequest(harness.agent, 'session/prompt')
    const client = await connectAgentMcpClient(harness)
    const responses = await Promise.all(['a', 'b', 'c'].map((path, index) =>
      harness.agent.callClient('session/request_permission', permission(SESSION_1, `parallel-${index}`, { path }))))
    for (const response of responses) expect(response).toMatchObject({ result: { outcome: { optionId: 'yes' } } })
    const pending = ['a', 'b', 'c'].map((path) => client.callTool({ name: 'read_file', arguments: { path } }))
    const calls = (await first).filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(calls).toHaveLength(3)
    const entries = calls.map((call, index) => ({ callId: toolCallIdOf(call), path: ['a', 'b', 'c'][index]!, result: `result-${index}` }))
    const messages = [
      ...baseOptions().messages,
      createAssistantMessage({
        content: calls.map((call) => {
          if (call.type !== 'block-end' || call.block.type !== 'tool-call') throw new Error('Expected tool call')
          return call.block
        }),
        source: { provider: AGY_PROVIDER_ID, model: 'gemini-3-pro' },
      }),
      // DSH 并行完成顺序与发起顺序相反时仍应在同 prompt 内回喂。
      ...[...entries].reverse().map(({ callId, result }) => createToolResultMessage({
        callId: ToolCallId(callId), content: [{ type: 'text', text: result }], isError: false,
      })),
    ]
    const second = collect(harness.adapter.stream(baseOptions({ tools: TOOLS, messages })))
    expect((await Promise.all(pending)).map(toolResultText)).toEqual(['result-0', 'result-1', 'result-2'])
    await harness.agent.callClient('session/request_permission', permission(SESSION_1, 'next-batch'))
    const nextPending = client.callTool({ name: 'read_file', arguments: { path: 'a.txt' } })
    const nextCalls = (await second).filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(nextCalls).toHaveLength(1)
    const third = collect(harness.adapter.stream(baseOptions({ tools: TOOLS, messages: [
      ...messages, emittedAssistant(nextCalls),
      createToolResultMessage({ callId: ToolCallId(toolCallIdOf(nextCalls[0])), content: [{ type: 'text', text: 'last' }], isError: false }),
    ] })))
    expect(toolResultText(await nextPending)).toBe('last')
    await replyWithText(harness, '全部完成')
    expect(visibleText(await third)).toBe('全部完成')
    expect(harness.recycles()).toBe(0)
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(1)
  })

  it('缺参在桥内立即返回签名；修正后同 prompt 继续，DSH 不收到无效调用', async () => {
    const warn = vi.fn()
    const harness = createHarness({ log: { info: vi.fn(), warn } })
    const tools: ToolSchema[] = [{ ...TOOLS[0]!, parameters: {
      type: 'object', properties: { path: { type: 'string' }, description: { type: 'string' } }, required: ['path', 'description'],
    } }]
    const first = collect(harness.adapter.stream(baseOptions({ tools })))
    await waitForRequest(harness.agent, 'session/prompt')
    const prompt = harness.agent.requestsFor('session/prompt')[0]!.params.prompt as ContentBlock[]
    expect(prompt.some((block) => block.type === 'text' && block.text.includes('read_file(path: string, description: string)'))).toBe(true)
    await harness.agent.callClient('session/request_permission', permission())
    const client = await connectAgentMcpClient(harness)
    const bad = await client.callTool({ name: 'read_file', arguments: { path: 'SECRET_VALUE.txt' } })
    expect(bad.isError).toBe(true)
    expect(toolResultText(bad)).toContain('description')
    expect(harness.adapter.bridge.pendingCallIds()).toEqual([])
    expect(warn.mock.calls.map(([text]) => String(text)).join(' ')).toContain('缺少必填=[description]')
    expect(warn.mock.calls.map(([text]) => String(text)).join(' ')).not.toContain('SECRET_VALUE')
    await harness.agent.callClient('session/request_permission', permission(SESSION_1, 'corrected'))
    const pending = client.callTool({ name: 'read_file', arguments: { path: 'a.txt', description: 'Read file' } })
    const calls = (await first).filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(calls).toHaveLength(1)
    const next = collect(harness.adapter.stream(baseOptions({ tools, messages: [
      ...baseOptions().messages, emittedAssistant(calls),
      createToolResultMessage({ callId: ToolCallId(toolCallIdOf(calls[0])), content: [{ type: 'text', text: 'ok' }], isError: false }),
    ] })))
    await pending
    await replyWithText(harness, '参数已修正')
    await next
    expect(harness.recycles()).toBe(0)
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(1)
  })

  it('常见参数别名在入桥后修正并记录键名', async () => {
    const info = vi.fn()
    const harness = createHarness({ log: { info, warn: vi.fn() } })
    const first = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')
    const response = await harness.agent.callClient('session/request_permission', {
      ...permission(), toolCall: {
        toolCallId: 'eager-tool', kind: 'other', title: 'Run read_file?',
        rawInput: { AbsolutePath: 'SECRET_VALUE.txt' },
      },
    })
    expect(response).toMatchObject({ result: { outcome: { optionId: 'yes' } } })
    const client = await connectAgentMcpClient(harness)
    const pending = client.callTool({ name: 'read_file', arguments: { AbsolutePath: 'SECRET_VALUE.txt' } })
    void pending.catch(() => undefined)
    const chunks = await first
    expect(chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call'))
      .toMatchObject({ block: { arguments: '{"path":"SECRET_VALUE.txt"}' } })
    const logs = info.mock.calls.map(([text]) => String(text)).join(' ')
    expect(logs).toContain('AbsolutePath->path')
    expect(logs).not.toContain('SECRET_VALUE')
  })

  it('旧会话、伪装原生请求、无 allow_once 选项不放行，也不合成 DSH 调用', async () => {
    const harness = createHarness()
    const first = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')
    const foreign = await harness.agent.callClient('session/request_permission', permission('foreign'))
    expect(foreign).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    const native = permission()
    const rejected = await harness.agent.callClient('session/request_permission', {
      ...native, toolCall: { ...native.toolCall, name: 'run_command', kind: 'execute' },
    })
    expect(rejected).toMatchObject({ result: { outcome: { optionId: 'no' } } })
    const noOnce = permission()
    noOnce.options = noOnce.options.filter((option) => option.kind === 'allow_always')
    expect(await harness.agent.callClient('session/request_permission', noOnce))
      .toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    await replyWithText(harness, '继续')
    expect((await first).some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toBe(false)
    expect(harness.recycles()).toBe(0)
  })

  it('重复权限 id 不产生第二次授权，正常工具调用仍可继续', async () => {
    const harness = createHarness()
    const first = collect(harness.adapter.stream(baseOptions({ tools: TOOLS })))
    await waitForRequest(harness.agent, 'session/prompt')
    const responses = await Promise.all([1, 2].map(() => harness.agent.callClient('session/request_permission', permission())))
    expect(responses[0]).toMatchObject({ result: { outcome: { optionId: 'yes' } } })
    expect(responses[1]).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    await replyWithText(harness, '继续')
    await first
    expect(harness.recycles()).toBe(0)
  })

  it('DSH 执行阶段取消仍释放所有权，后台请求不会永久等待', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    const first = collect(harness.adapter.stream(baseOptions({ tools: TOOLS, signal: controller.signal })))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.callClient('session/request_permission', permission())
    const client = await connectAgentMcpClient(harness)
    const pending = client.callTool({ name: 'read_file', arguments: { path: 'a.txt' } })
    void pending.catch(() => undefined)
    await first
    controller.abort()
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    const next = collect(harness.adapter.stream(baseOptions({ purpose: 'session-title' })))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '标题')
    expect(visibleText(await next)).toBe('标题')
  })
})

describe('审查回归：取消、身份、目录和历史', () => {
  it('消费者未收到 finish 就 return 时回收旧回合，下一轮可运行', async () => {
    const harness = createHarness()
    const iterator = harness.adapter.stream(baseOptions())[Symbol.asyncIterator]()
    const first = iterator.next()
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.notify('session/update', {
      sessionId: SESSION_1,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } },
    })
    await first
    await iterator.return?.()
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    const next = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '恢复成功')
    expect(visibleText(await next)).toBe('恢复成功')
  })

  it('session/new 等待期间取消会立即结束且不发送 prompt', async () => {
    const harness = createHarness()
    harness.agent.on('session/new', () => NO_REPLY)
    const controller = new AbortController()
    const streaming = collect(harness.adapter.stream(baseOptions({ signal: controller.signal })))
    const rejected = expect(streaming).rejects.toMatchObject({ code: AGY_TURN_ERROR.ABORTED })
    await waitForRequest(harness.agent, 'session/new')
    controller.abort()
    await rejected
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(0)
  })

  it('启动工厂未完成时取消不等待它，迟到连接回收且不创建会话', async () => {
    let release!: (link: AgentLink) => void
    let teardown!: () => Promise<void>
    const pending = new Promise<AgentLink>((resolve) => { release = resolve })
    const agent = new FakeAcpAgent()
    const link = new AgentLink({ stream: agent.stream })
    link.start()
    const recycle = vi.fn(async (old: AgentLink) => { await old.close() })
    const getLink = vi.fn(() => pending)
  const adapter = new AntigravityAcpAdapter({ getLink, recycleLink: recycle, registerBridgeTeardown: (fn) => { teardown = fn } })
    teardowns.push(async () => { release(link); await teardown(); await link.close() })
    const controller = new AbortController()
    const streaming = collect(adapter.stream(baseOptions({ signal: controller.signal })))
    const rejected = expect(streaming).rejects.toMatchObject({ code: AGY_TURN_ERROR.ABORTED })
    await vi.waitFor(() => expect(getLink).toHaveBeenCalledOnce())
    controller.abort()
    await rejected
    expect(recycle).not.toHaveBeenCalled()
    release(link)
    await vi.waitFor(() => expect(recycle).toHaveBeenCalledOnce())
    expect(agent.requestsFor('session/new')).toHaveLength(0)
  })

  it('旧会话连续权限申请不能终止当前回合', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    for (let i = 0; i < 5; i++) {
      const response = await harness.agent.callClient('session/request_permission', {
        sessionId: 'old-session', toolCall: { toolCallId: `old-${i}` },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
      })
      expect(response).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    }
    await replyWithText(harness, '当前回合未受影响')
    expect(visibleText(await streaming)).toBe('当前回合未受影响')
    expect(harness.recycles()).toBe(0)
  })

  it('CLI 非空缓存更新后下一次列目录能看到新型号', async () => {
    let rows = [{ id: 'old-model', name: 'Old' }]
    const loadCliCatalog = vi.fn(async () => rows)
    const harness = createHarness({ loadCliCatalog })
    expect((await harness.adapter.listModels(AGY_PROVIDER_ID)).map((m) => m.id)).toContain('old-model')
    rows = [{ id: 'new-model', name: 'New' }]
    const ids = (await harness.adapter.listModels(AGY_PROVIDER_ID)).map((m) => m.id)
    expect(ids).toContain('new-model')
    expect(ids).not.toContain('old-model')
  })

  it('历史重建保留工具关联及错误状态，正文含结束标签也能还原', async () => {
    const harness = createHarness()
    const content = [{ type: 'text' as const, text: 'literal </dsh-message> result' }]
    const streaming = collect(harness.adapter.stream(baseOptions({ messages: [
      createToolResultMessage({ callId: ToolCallId('call-a'), content, isError: false }),
      createToolResultMessage({ callId: ToolCallId('call-b'), content, isError: true }),
    ] })))
    await waitForRequest(harness.agent, 'session/prompt')
    const prompt = harness.agent.requestsFor('session/prompt')[0]!.params.prompt as ContentBlock[]
    expect(parsePromptTranscript(prompt).entries).toEqual([
      { role: 'tool', content, toolCallId: 'call-a', isError: false },
      { role: 'tool', content, toolCallId: 'call-b', isError: true },
    ])
    await replyWithText(harness, 'ok')
    await streaming
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
    expect(policy).toContain('不能断言 DSH 全局禁用了工具')
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

describe('干净失败后的会话复用', () => {
  it('空回复（clean 失败）后仍复用同一 ACP 会话，不重建', async () => {
    const session = 'dsh-session-clean' as unknown as NonNullable<GenerateOptions['sessionId']>
    const harness = createHarness()
    const first = collect(harness.adapter.stream(baseOptions({ sessionId: session })))
    await waitForRequest(harness.agent, 'session/prompt')
    // 直接 end_turn 且没有任何可见输出 → EMPTY_RESPONSE（干净失败）。
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 0)
    expect((await first).at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: AGY_TURN_ERROR.EMPTY_RESPONSE } },
    })

    const second = collect(harness.adapter.stream(baseOptions({ sessionId: session, messages: [
      ...baseOptions().messages,
      createUserMessage({ content: [{ type: 'text', text: '再试一次' }], source: { kind: 'user' } }),
    ] })))
    await waitForRequest(harness.agent, 'session/prompt', 2)
    await replyWithText(harness, '恢复', 1)
    expect(visibleText(await second)).toBe('恢复')
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
  })
})

describe('取消后保留进程（可选）', () => {
  it('取消确认后保留进程，空闲超过上限再回收', async () => {
    const harness = createHarness({ keepProcessAfterCancel: true, cancelGraceMs: 1_000, idleRecycleMs: 80 })
    const controller = new AbortController()
    const streaming = collect(harness.adapter.stream(baseOptions({ signal: controller.signal })))
    await waitForRequest(harness.agent, 'session/prompt')
    controller.abort()
    await streaming
    // agent 确认取消（应答 cancelled）→ 草稿不回收。
    await harness.agent.reply('session/prompt', { stopReason: 'cancelled' })
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    expect(harness.recycles()).toBe(0)
    // 之后超过空闲上限才回收。
    await vi.waitFor(() => expect(harness.recycles()).toBe(1), { timeout: 1_000 })
  })

  it('宽限内没有确认取消时按原策略立即回收', async () => {
    const harness = createHarness({ keepProcessAfterCancel: true, cancelGraceMs: 50, idleRecycleMs: 60_000 })
    const controller = new AbortController()
    const streaming = collect(harness.adapter.stream(baseOptions({ signal: controller.signal })))
    await waitForRequest(harness.agent, 'session/prompt')
    controller.abort()
    await streaming
    await vi.waitFor(() => expect(harness.recycles()).toBe(1), { timeout: 1_000 })
  })

  it('默认关闭时取消立即回收', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    const streaming = collect(harness.adapter.stream(baseOptions({ signal: controller.signal })))
    await waitForRequest(harness.agent, 'session/prompt')
    controller.abort()
    await streaming
    await vi.waitFor(() => expect(harness.recycles()).toBe(1), { timeout: 1_000 })
  })
})

describe('取消排空与统一空闲租约回归', () => {
  it('取消未确认时新轮等待；确认后复用进程而不并发运行旧 prompt', async () => {
    const harness = createHarness({ keepProcessAfterCancel: true, cancelGraceMs: 1_000, idleRecycleMs: 0 })
    const controller = new AbortController()
    const first = collect(harness.adapter.stream(baseOptions({ signal: controller.signal })))
    await waitForRequest(harness.agent, 'session/prompt'); controller.abort(); await first
    const next = collect(harness.adapter.stream(baseOptions()))
    await new Promise<void>(resolve => setTimeout(resolve, 30))
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(1)
    await harness.agent.reply('session/prompt', { stopReason: 'cancelled' })
    await waitForRequest(harness.agent, 'session/prompt', 2)
    expect(harness.recycles()).toBe(0)
    await replyWithText(harness, '新轮', 1); await next
  })

  it('本地超时不是停止确认，取消保留也必须回收', async () => {
    const harness = createHarness({ keepProcessAfterCancel: true, cancelGraceMs: 1_000, idleRecycleMs: 0, promptTimeoutMs: 150 })
    const controller = new AbortController()
    const original = harness.agent
    const streaming = collect(harness.adapter.stream(baseOptions({ signal: controller.signal })))
    await waitForRequest(original, 'session/prompt'); controller.abort(); await streaming
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    expect(original.unanswered.has(original.requestsFor('session/prompt')[0]!.id)).toBe(true)
  })

  it('取消宽限为零表示不等待立即回收，不保留未确认连接', async () => {
    const harness = createHarness({ keepProcessAfterCancel: true, cancelGraceMs: 0 })
    const controller = new AbortController()
    const streaming = collect(harness.adapter.stream(baseOptions({ signal: controller.signal })))
    await waitForRequest(harness.agent, 'session/prompt'); controller.abort(); await streaming
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
  })

  it('正常聊天完成也启动空闲计时，0 可禁用', async () => {
    for (const idleRecycleMs of [50, 0]) {
      const harness = createHarness({ idleRecycleMs })
      const streaming = collect(harness.adapter.stream(baseOptions()))
      await waitForRequest(harness.agent, 'session/prompt'); await replyWithText(harness, 'done'); await streaming
      if (idleRecycleMs > 0) await vi.waitFor(() => expect(harness.recycles()).toBe(1))
      else { await new Promise<void>(resolve => setTimeout(resolve, 80)); expect(harness.recycles()).toBe(0) }
    }
  })

  it('目录发现期间撤销旧 idle 定时器，结束后重新计时并关闭发现会话', async () => {
    const harness = createHarness({ idleRecycleMs: 120 })
    await harness.adapter.warmup()
    harness.agent.on('session/new', () => NO_REPLY)
    const discovery = harness.adapter.discoverModels()
    await waitForRequest(harness.agent, 'session/new')
    await new Promise<void>(resolve => setTimeout(resolve, 180))
    expect(harness.recycles()).toBe(0)
    await harness.agent.reply('session/new', { sessionId: SESSION_1, configOptions: MODEL_CONFIG_OPTIONS })
    await discovery
    await waitForRequest(harness.agent, 'session/close')
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
  })

  for (const purpose of ['session-title', 'compaction'] as const) {
    it(`${purpose} 正常结束关闭一次性会话，finish 即 return 也不泄漏`, async () => {
      const harness = createHarness()
      const streaming = (async () => {
        for await (const chunk of harness.adapter.stream(baseOptions({ purpose }))) if (chunk.type === 'finish') break
      })()
      await waitForRequest(harness.agent, 'session/prompt'); await replyWithText(harness, 'done'); await streaming
      await waitForRequest(harness.agent, 'session/close')
      expect(harness.agent.requestsFor('session/close')[0]!.params.sessionId).toBe(SESSION_1)
    })
  }

  it('卸载正在运行的回合时立即封口，不遗留取消宽限定时器', async () => {
    const harness = createHarness({ keepProcessAfterCancel: true, cancelGraceMs: 50, idleRecycleMs: 50 })
    const running = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.bridgeTeardown()
    expect((await running).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    await new Promise<void>(resolve => setTimeout(resolve, 100))
    expect(harness.recycles()).toBe(0)
    expect(harness.adapter.busy).toBe(false)
  })

  it('等待工具审批的 parked prompt 不是 idle', async () => {
    const harness = createHarness({ idleRecycleMs: 50 })
    const controller = new AbortController()
    const streaming = collect(harness.adapter.stream(baseOptions({ tools: TOOLS, signal: controller.signal })))
    await waitForRequest(harness.agent, 'session/prompt')
    const client = await connectAgentMcpClient(harness)
    const result = client.callTool({ name: 'read_file', arguments: { path: '/example' } })
    expect((await streaming).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    await new Promise<void>(resolve => setTimeout(resolve, 100)); expect(harness.recycles()).toBe(0)
    controller.abort(); await result
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
  })
})

describe('ACP 会话复用与跨进程恢复', () => {
  // dsh-llm 只导出 branded 类型、不导出 SessionId 构造函数：测试里直接断言。
  const DSH_SESSION = 'dsh-session-reuse' as unknown as NonNullable<GenerateOptions['sessionId']>

  function secondRoundMessages(): RequestMessage[] {
    return [
      ...baseOptions().messages,
      createAssistantMessage({
        content: [{ type: 'text', text: '第一轮回答' }],
        source: { provider: AGY_PROVIDER_ID, model: 'gemini-3-pro' },
      }),
      createUserMessage({ content: [{ type: 'text', text: '第二个问题' }], source: { kind: 'user' } }),
    ]
  }

  function promptTexts(harness: Harness, index: number): string {
    const prompt = harness.agent.requestsFor('session/prompt')[index]!.params.prompt as ContentBlock[]
    return prompt.filter((block): block is { type: 'text'; text: string } => block.type === 'text').map((block) => block.text).join('\n')
  }

  it('同一 DSH 对话的第二轮复用 ACP 会话，只发送新增消息', async () => {
    const harness = createHarness()
    const first = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION })))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '第一轮回答')
    await first
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)

    const second = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages() })))
    await waitForRequest(harness.agent, 'session/prompt', 2)
    const texts = promptTexts(harness, 1)
    // 增量：不再重复 system/工具策略/历史说明，也不重放第一轮的消息。
    expect(texts).not.toContain('<dsh-tool-policy>')
    expect(texts).not.toContain('<dsh-conversation-history>')
    expect(texts).not.toContain('你好')
    // agent 自己产生的上一轮回答已经在它的会话里，增量不再重发。
    expect(texts).not.toContain('第一轮回答')
    expect(texts).toContain('第二个问题')
    await replyWithText(harness, '第二轮回答', 1)
    expect(visibleText(await second)).toBe('第二轮回答')
    // 全程只有一个 ACP 会话。
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
  })

  it('同一对话换模型时重建，不复用旧会话', async () => {
    const harness = createHarness()
    const first = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION })))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '第一轮回答')
    await first
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)

    const second = collect(harness.adapter.stream(baseOptions({
      sessionId: DSH_SESSION, model: 'gemini-3-flash', messages: secondRoundMessages(),
    })))
    await waitForRequest(harness.agent, 'session/new', 2)
    await replyWithText(harness, '重建回答', 1)
    expect(visibleText(await second)).toBe('重建回答')
    // 重建走全量重放：prompt 里仍有工具策略与完整历史。
    const rebuilt = promptTexts(harness, 1)
    expect(rebuilt).toContain('<dsh-tool-policy>')
    expect(rebuilt).toContain('你好')
  })

  it('历史被压缩或改写后重建', async () => {
    const harness = createHarness()
    const first = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION })))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '第一轮回答')
    await first

    const rewritten: RequestMessage[] = [
      createUserMessage({ content: [{ type: 'text', text: '这是压缩后的摘要' }], source: { kind: 'user' } }),
      createUserMessage({ content: [{ type: 'text', text: '继续问' }], source: { kind: 'user' } }),
    ]
    const second = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: rewritten })))
    await waitForRequest(harness.agent, 'session/new', 2)
    await replyWithText(harness, '重建回答', 1)
    expect(visibleText(await second)).toBe('重建回答')
  })

  it('标题等一次性请求不参与会话复用', async () => {
    const harness = createHarness()
    const title = { provider: AGY_PROVIDER_ID, model: 'gemini-3-pro', purpose: 'session-title' as const }
    const first = collect(harness.adapter.stream(baseOptions({ ...title, sessionId: DSH_SESSION })))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '标题')
    await first

    const second = collect(harness.adapter.stream(baseOptions({
      ...title, sessionId: DSH_SESSION, messages: secondRoundMessages(),
    })))
    await waitForRequest(harness.agent, 'session/prompt', 2)
    await replyWithText(harness, '标题二', 1)
    await second
    // 每次都是独立 ACP 会话。
    expect(harness.agent.requestsFor('session/new')).toHaveLength(2)
  })

  it('运行中修改复用设置不打断当前回合，下一轮采用新值', async () => {
    let reuseSessions = true
    const harness = createHarness({ readSettings: () => ({ reuseSessions }) })
    const first = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION })))
    await waitForRequest(harness.agent, 'session/prompt')
    reuseSessions = false
    // Background catalog reads must not replace the current turn's captured settings.
    await harness.adapter.listModels(AGY_PROVIDER_ID)
    await replyWithText(harness, '第一轮回答')
    expect(visibleText(await first)).toBe('第一轮回答')
    expect(harness.recycles()).toBe(0)
    const second = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages() })))
    await waitForRequest(harness.agent, 'session/prompt', 2)
    expect(harness.agent.requestsFor('session/new')).toHaveLength(2)
    expect(promptTexts(harness, 1)).toContain('你好')
    await replyWithText(harness, '第二轮回答', 1)
    expect(visibleText(await second)).toBe('第二轮回答')
  })

  it('关闭复用开关时回到每轮新会话', async () => {
    const harness = createHarness({ reuseSessions: false })
    const first = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION })))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '第一轮回答')
    await first

    const second = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages() })))
    await waitForRequest(harness.agent, 'session/prompt', 2)
    await replyWithText(harness, '第二轮回答', 1)
    await second
    expect(harness.agent.requestsFor('session/new')).toHaveLength(2)
  })

  it('resume 开启时用 session/load 恢复会话，并只发送增量', async () => {
    const map: Record<string, SessionMapEntry> = {}
    const shared = {
      loadSessionMap: async () => ({ ...map }),
      saveSessionMap: (entries: Record<string, SessionMapEntry>) => {
        for (const key of Object.keys(map)) delete map[key]
        Object.assign(map, entries)
      },
    }
    const firstHarness = createHarness({ resumeSessions: true, loadSessionCapability: true, ...shared })
    const first = collect(firstHarness.adapter.stream(baseOptions({ sessionId: DSH_SESSION })))
    await waitForRequest(firstHarness.agent, 'session/prompt')
    await replyWithText(firstHarness, '第一轮回答')
    await first
    await vi.waitFor(() => expect(Object.keys(map)).toContain(`${DSH_SESSION}::chat`))
    await firstHarness.bridgeTeardown()

    const harness = createHarness({ resumeSessions: true, loadSessionCapability: true, ...shared })
    const resumed = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages() })))
    await waitForRequest(harness.agent, 'session/load')
    await waitForRequest(harness.agent, 'session/prompt')
    expect(harness.agent.requestsFor('session/new')).toHaveLength(0)
    const texts = promptTexts(harness, 0)
    expect(texts).not.toContain('你好')
    expect(texts).toContain('第二个问题')
    await replyWithText(harness, '恢复后回答')
    expect(visibleText(await resumed)).toBe('恢复后回答')
  })

  it('usage 按协议原样上报，不做累计换算（官方 1.4.0 实测不返回）', async () => {
    const harness = createHarness()
    const first = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION })))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.notify('session/update', {
      sessionId: SESSION_1,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第一轮回答' } },
    })
    await harness.agent.reply('session/prompt', {
      stopReason: 'end_turn',
      usage: { totalTokens: 110, inputTokens: 100, outputTokens: 10 },
    }, 0)
    const firstChunks = await first
    expect(firstChunks.find((chunk) => chunk.type === 'usage')).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    })

    const second = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages() })))
    await waitForRequest(harness.agent, 'session/prompt', 2)
    await harness.agent.notify('session/update', {
      sessionId: SESSION_1,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第二轮回答' } },
    })
    await harness.agent.reply('session/prompt', {
      stopReason: 'end_turn',
      usage: { totalTokens: 175, inputTokens: 150, outputTokens: 25 },
    }, 1)
    const secondChunks = await second
    // 协议把 PromptResponse.usage 标为「本轮用量」：原样上报，不擅自从累计值求差。
    expect(secondChunks.find((chunk) => chunk.type === 'usage')).toMatchObject({
      usage: { inputTokens: 150, outputTokens: 25, totalTokens: 175 },
    })
  })

  it('增量轮保留首次出现的快照与 notice，并把最新用户消息放到最后', async () => {
    const harness = createHarness()
    const first = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION })))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, '第一轮回答')
    await first

    const injected = (text: string, kind: string, form?: string): RequestMessage => ({
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind, ...(form === undefined ? {} : { form }) },
    } as unknown as RequestMessage)

    const second = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: [
      ...baseOptions().messages,
      createAssistantMessage({ content: [{ type: 'text', text: '第一轮回答' }], source: { provider: AGY_PROVIDER_ID, model: 'gemini-3-pro' } }),
      injected('时间快照', 'time-context', 'snapshot'),
      createUserMessage({ content: [{ type: 'text', text: '新的问题' }], source: { kind: 'user' } }),
      injected('目标更新', 'goal', 'notice'),
    ] })))
    await waitForRequest(harness.agent, 'session/prompt', 2)
    const texts = promptTexts(harness, 1)
    expect(texts).toContain('时间快照')
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
    expect(texts).toContain('目标更新')
    expect(texts).toContain('新的问题')
    await replyWithText(harness, 'ok', 1)
    await second
  })

  for (const stopReason of ['end_turn', 'max_tokens', 'refusal'] as const) {
    it(`收到 ${stopReason} 的 finish 立即 return，第三轮不重复第二轮输入`, async () => {
      const harness = createHarness()
      const history = [...baseOptions().messages]
      const readUntilFinish = async (messages: RequestMessage[]) => {
        const chunks: StreamChunk[] = []
        for await (const chunk of harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages }))) {
          chunks.push(chunk)
          if (chunk.type === 'finish') break
        }
        return chunks
      }
      for (let index = 0; index < 2; index++) {
        const running = readUntilFinish([...history])
        await waitForRequest(harness.agent, 'session/prompt', index + 1)
        const sessionId = harness.agent.requestsFor('session/prompt')[index]!.params.sessionId
        await harness.agent.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `A${index}` } } })
        await harness.agent.reply('session/prompt', { stopReason }, index)
        const chunks = await running
        history.push(emittedAssistant(chunks), createUserMessage({ content: [{ type: 'text', text: `Q${index + 2}` }], source: { kind: 'user' } }))
      }
      const third = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: history })))
      await waitForRequest(harness.agent, 'session/prompt', 3)
      expect(promptTexts(harness, 2)).not.toContain('Q2')
      expect(promptTexts(harness, 2)).toContain('Q3')
      expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
      await replyWithText(harness, 'A3', 2); await third
    })
  }

  for (const external of [false, true]) {
    it(`${external ? '其他 provider 的额外回答' : '改写上轮回答'}触发完整重建`, async () => {
      const harness = createHarness()
      const first = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION })))
      await waitForRequest(harness.agent, 'session/prompt'); await replyWithText(harness, '第一轮回答'); await first
      const messages = secondRoundMessages()
      if (external) messages.splice(2, 0,
        createUserMessage({ content: [{ type: 'text', text: '外部问题' }], source: { kind: 'user' } }),
        createAssistantMessage({ content: [{ type: 'text', text: '外部回答' }], source: { provider: 'other', model: 'other' } }))
      else messages[1] = createAssistantMessage({ content: [{ type: 'text', text: '编辑后的回答' }], source: { provider: AGY_PROVIDER_ID, model: 'gemini-3-pro' } })
      const next = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages })))
      await waitForRequest(harness.agent, 'session/prompt', 2)
      expect(harness.agent.requestsFor('session/new')).toHaveLength(2)
      expect(promptTexts(harness, 1)).toContain(external ? '外部回答' : '编辑后的回答')
      await replyWithText(harness, '重建', 1); await next
    })
  }

  function savedEntry(options = baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages() })): SessionMapEntry {
    return { sessionId: 'saved-acp', cwd: process.cwd(), sentCount: 1, sentHash: prefixHash(options.messages, 1), outputHash: outputHash([{ type: 'text', text: '第一轮回答' }]), route: routeFingerprint(options), updatedAt: Date.now() }
  }

  for (const restored of [false, true]) {
    it(`${restored ? '磁盘恢复' : '内存复用'}没有可发送增量时完整重建，不发空 prompt`, async () => {
      const harness = createHarness(restored ? {
        resumeSessions: true, loadSessionCapability: true,
        loadSessionMap: async () => ({ [`${DSH_SESSION}::chat`]: savedEntry() }), saveSessionMap: () => undefined,
      } : {})
      if (!restored) {
        const first = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION })))
        await waitForRequest(harness.agent, 'session/prompt'); await replyWithText(harness, '第一轮回答'); await first
      }
      const index = restored ? 0 : 1
      const running = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages().slice(0, -1) })))
      await waitForRequest(harness.agent, 'session/prompt', index + 1)
      expect(harness.agent.requestsFor('session/new')).toHaveLength(index + 1)
      expect(harness.agent.requestsFor('session/load')).toHaveLength(0)
      expect(promptTexts(harness, index)).toContain('<dsh-conversation-history>')
      expect(promptTexts(harness, index)).toContain('你好')
      await replyWithText(harness, '重建', index); await running
    })
  }

  it('有效映射下 load RPC 拒绝：先回收连接，再完整重建', async () => {
    const harness = createHarness({ resumeSessions: true, loadSessionCapability: true,
      loadSessionMap: async () => ({ [`${DSH_SESSION}::chat`]: savedEntry() }), saveSessionMap: () => undefined })
    const original = harness.agent
    original.on('session/load', () => { throw new Error('session removed') })
    const running = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages() })))
    await waitForRequest(original, 'session/load')
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    await waitForRequest(harness.agent, 'session/prompt')
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
    expect(promptTexts(harness, 0)).toContain('第一轮回答')
    await replyWithText(harness, 'fallback'); await running
  })

  it('load 回放被丢弃，恢复配置漂移时校正实际模型', async () => {
    const harness = createHarness({ resumeSessions: true, loadSessionCapability: true,
      loadSessionMap: async () => ({ [`${DSH_SESSION}::chat`]: savedEntry() }), saveSessionMap: () => undefined })
    harness.agent.on('session/load', async () => {
      await harness.agent.notify('session/update', { sessionId: 'saved-acp', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '这是旧回放' } } })
      return { configOptions: MODEL_CONFIG_OPTIONS.map(option => option.id === 'model' && option.type === 'select' ? { ...option, currentValue: 'gemini-3-flash' } : option) }
    })
    const running = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages() })))
    await waitForRequest(harness.agent, 'session/prompt')
    expect(harness.agent.requestsFor('session/set_config_option')[0]?.params.value).toBe('gemini-3-pro')
    await replyWithText(harness, '新回答')
    expect(visibleText(await running)).toBe('新回答')
    expect(harness.agent.requestsFor('session/new')).toHaveLength(0)
  })

  it('恢复后选模 RPC 被 agent 拒绝时回收重建', async () => {
    const harness = createHarness({ resumeSessions: true, loadSessionCapability: true,
      loadSessionMap: async () => ({ [`${DSH_SESSION}::chat`]: savedEntry() }), saveSessionMap: () => undefined })
    const original = harness.agent
    const drifted = MODEL_CONFIG_OPTIONS.map(option => option.id === 'model' && option.type === 'select' ? { ...option, currentValue: 'gemini-3-flash' } : option)
    original.on('session/load', () => ({ configOptions: drifted }))
    original.on('session/set_config_option', () => { throw new Error('model selection rejected') })
    const running = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages() })))
    await waitForRequest(original, 'session/set_config_option')
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    await waitForRequest(harness.agent, 'session/prompt')
    expect(original.requestsFor('session/prompt')).toHaveLength(0)
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
    await replyWithText(harness, 'correct model'); await running
  })

  it('恢复会话的工具仍通过新 token 的真实 MCP 桥 park 与回填', async () => {
    const request = baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages(), tools: TOOLS })
    const harness = createHarness({ resumeSessions: true, loadSessionCapability: true,
      loadSessionMap: async () => ({ [`${DSH_SESSION}::chat`]: savedEntry(request) }), saveSessionMap: () => undefined })
    const running = collect(harness.adapter.stream(request))
    await waitForRequest(harness.agent, 'session/prompt')
    const servers = harness.agent.requestsFor('session/load')[0]!.params.mcpServers as McpRegistration[]
    const registration = servers[0]!
    const client = new Client({ name: 'load-regression', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(registration.url), { requestInit: { headers: Object.fromEntries(registration.headers.map(header => [header.name, header.value])) } }))
    teardowns.push(() => client.close().catch(() => undefined))
    const result = client.callTool({ name: 'read_file', arguments: { path: '/example' } })
    const chunks = await running
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')!
    const continuation = collect(harness.adapter.stream({ ...request, messages: [...request.messages, emittedAssistant(chunks), createToolResultMessage({ callId: ToolCallId(toolCallIdOf(call)), content: [{ type: 'text', text: 'tool payload' }], isError: false })] }))
    expect(toolResultText(await result)).toBe('tool payload')
    await replyWithText(harness, 'done'); expect(visibleText(await continuation)).toBe('done')
  })

  it('worker 接管同一 DSH 对话时新建 ACP 会话，旧 worker 写其他键不回退游标', async () => {
    let disk: Record<string, SessionMapEntry> = {}
    const sessionStore = new SessionMapStore({ load: async () => ({}), save: rows => { disk = rows } })
    const firstHarness = createHarness({ resumeSessions: true, loadSessionCapability: true, sessionStore })
    const first = collect(firstHarness.adapter.stream(baseOptions({ sessionId: DSH_SESSION })))
    await waitForRequest(firstHarness.agent, 'session/prompt'); await replyWithText(firstHarness, '第一轮回答'); await first
    const nextHarness = createHarness({ resumeSessions: true, loadSessionCapability: true, sessionStore })
    const next = collect(nextHarness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages() })))
    await waitForRequest(nextHarness.agent, 'session/prompt')
    expect(nextHarness.agent.requestsFor('session/load')).toHaveLength(0)
    await replyWithText(nextHarness, 'second'); await next
    const other = collect(firstHarness.adapter.stream(baseOptions({ sessionId: 'other-chat' as typeof DSH_SESSION })))
    await waitForRequest(firstHarness.agent, 'session/prompt', 2); await replyWithText(firstHarness, 'other', 1); await other
    await sessionStore.flush()
    expect(disk[`${DSH_SESSION}::chat`]?.sentCount).toBe(3)
  })

  it('同一键接回旧 worker 时先验证旧所有权，不能复活被接管的内存会话', async () => {
    const sessionStore = new SessionMapStore({ load: async () => ({}), save: () => undefined })
    const a = createHarness({ resumeSessions: true, sessionStore }), b = createHarness({ resumeSessions: true, sessionStore })
    const first = collect(a.adapter.stream(baseOptions({ sessionId: DSH_SESSION })))
    await waitForRequest(a.agent, 'session/prompt'); await replyWithText(a, '第一轮回答'); await first
    const moved = collect(b.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages() })))
    await waitForRequest(b.agent, 'session/prompt'); await replyWithText(b, '第二轮回答'); await moved
    // 回到旧 worker 并重试/回退到 Q2；即便文本仍匹配旧输出，旧记录也已失去所有权。
    const returned = collect(a.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages() })))
    await waitForRequest(a.agent, 'session/prompt', 2)
    expect(a.agent.requestsFor('session/new')).toHaveLength(2)
    await replyWithText(a, '重建回答', 1); await returned
  })

  it('load 超时回收后重建，不复用仍可能发送回放的旧连接', async () => {
    const harness = createHarness({ resumeSessions: true, loadSessionCapability: true, promptTimeoutMs: 300,
      loadSessionMap: async () => ({ [`${DSH_SESSION}::chat`]: savedEntry() }), saveSessionMap: () => undefined })
    const original = harness.agent
    original.on('session/load', () => NO_REPLY)
    const running = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages() })))
    await waitForRequest(original, 'session/load')
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, 'timeout fallback'); await running
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
  })

  it('load 期间取消会回收连接，不再发送 prompt', async () => {
    const harness = createHarness({ resumeSessions: true, loadSessionCapability: true,
      loadSessionMap: async () => ({ [`${DSH_SESSION}::chat`]: savedEntry() }), saveSessionMap: () => undefined })
    const controller = new AbortController(), original = harness.agent
    original.on('session/load', () => NO_REPLY)
    const running = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages(), signal: controller.signal })))
      .then(() => 'success', () => 'cancelled')
    await waitForRequest(original, 'session/load'); controller.abort()
    expect(await running).toBe('cancelled')
    expect(harness.recycles()).toBe(1)
    expect(original.requestsFor('session/prompt')).toHaveLength(0)
    expect(harness.agent.requestsFor('session/prompt')).toHaveLength(0)
  })

  it('正常空闲回收保留有效映射，下轮在新连接 load 而不全量重放', async () => {
    const map: Record<string, SessionMapEntry> = {}
    const harness = createHarness({ resumeSessions: true, loadSessionCapability: true, idleRecycleMs: 80,
      loadSessionMap: async () => ({ ...map }), saveSessionMap: rows => { for (const key of Object.keys(map)) delete map[key]; Object.assign(map, rows) } })
    const first = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION })))
    await waitForRequest(harness.agent, 'session/prompt'); await replyWithText(harness, '第一轮回答'); await first
    await vi.waitFor(() => expect(harness.recycles()).toBe(1))
    expect(map[`${DSH_SESSION}::chat`]).toBeDefined()
    const next = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION, messages: secondRoundMessages() })))
    await waitForRequest(harness.agent, 'session/prompt')
    expect(harness.agent.requestsFor('session/load')).toHaveLength(1)
    expect(harness.agent.requestsFor('session/new')).toHaveLength(0)
    await replyWithText(harness, 'resumed'); await next
  })

  it('tool-calls 与续轮 finish 即 return 仍提交游标，下个用户轮复用且不重发工具轨迹', async () => {
    const harness = createHarness()
    const request = baseOptions({ sessionId: DSH_SESSION, tools: TOOLS })
    const untilFinish = async (options: GenerateOptions) => {
      const chunks: StreamChunk[] = []
      for await (const chunk of harness.adapter.stream(options)) { chunks.push(chunk); if (chunk.type === 'finish') break }
      return chunks
    }
    const first = untilFinish(request)
    await waitForRequest(harness.agent, 'session/prompt')
    const client = await connectAgentMcpClient(harness)
    const result = client.callTool({ name: 'read_file', arguments: { path: '/example' } })
    const firstChunks = await first
    const call = firstChunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')!
    const messages = [...request.messages, emittedAssistant(firstChunks), createToolResultMessage({ callId: ToolCallId(toolCallIdOf(call)), content: [{ type: 'text', text: 'tool data' }], isError: false })]
    const continuation = untilFinish({ ...request, messages })
    await result; await replyWithText(harness, '最终回答'); const finalChunks = await continuation
    const next = collect(harness.adapter.stream({ ...request, messages: [...messages, emittedAssistant(finalChunks), createUserMessage({ content: [{ type: 'text', text: '下一问' }], source: { kind: 'user' } })] }))
    await waitForRequest(harness.agent, 'session/prompt', 2)
    expect(harness.agent.requestsFor('session/new')).toHaveLength(1)
    expect(promptTexts(harness, 1)).not.toContain('tool data')
    expect(promptTexts(harness, 1)).not.toContain('最终回答')
    await replyWithText(harness, 'next', 1); await next
  })

  it('后续会话省略模型配置时保留已知目录与选择器', async () => {
    const harness = createHarness({ reuseSessions: false })
    let calls = 0
    harness.agent.on('session/new', () => ({
      sessionId: `partial-${++calls}`,
      configOptions: calls === 1 ? MODEL_CONFIG_OPTIONS : null,
    }))
    const first = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await replyWithText(harness, 'first')
    await first
    expect((await harness.adapter.listModels(AGY_PROVIDER_ID)).length).toBeGreaterThan(0)
    const second = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt', 2)
    await replyWithText(harness, 'second', 1)
    expect(visibleText(await second)).toBe('second')
    expect((await harness.adapter.listModels(AGY_PROVIDER_ID)).map(model => model.id)).toContain('gemini-3-pro')
  })

  it('内存会话表有界，超过 64 个会话关闭最旧会话', async () => {
    const harness = createHarness()
    let sequence = 0
    harness.agent.on('session/new', () => ({ sessionId: `unique-${++sequence}`, configOptions: MODEL_CONFIG_OPTIONS }))
    for (let index = 0; index < 65; index++) {
      const running = collect(harness.adapter.stream(baseOptions({ sessionId: `chat-${index}` as typeof DSH_SESSION })))
      await waitForRequest(harness.agent, 'session/prompt', index + 1); await replyWithText(harness, 'A', index); await running
    }
    await waitForRequest(harness.agent, 'session/close')
    expect(harness.agent.requestsFor('session/close')).toHaveLength(1)
    expect(harness.agent.requestsFor('session/close')[0]!.params.sessionId).toBe('unique-1')
  })

  it('本地无效映射在 load 之前被丢弃并重建', async () => {
    const harness = createHarness({
      resumeSessions: true,
      loadSessionCapability: true,
      loadSessionMap: async () => ({
        [`${DSH_SESSION}::chat`]: {
          sessionId: 'gone-session',
          cwd: process.cwd(),
          sentCount: 1,
          sentHash: 'bogus',
          outputHash: outputHash([]),
          route: 'bogus',
          updatedAt: Date.now(),
        },
      }),
      saveSessionMap: () => undefined,
    })
    const streaming = collect(harness.adapter.stream(baseOptions({ sessionId: DSH_SESSION })))
    await waitForRequest(harness.agent, 'session/new')
    await replyWithText(harness, '重建回答')
    expect(visibleText(await streaming)).toBe('重建回答')
  })
})
