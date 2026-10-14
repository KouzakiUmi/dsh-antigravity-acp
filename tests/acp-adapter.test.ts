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
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, SessionConfigOption } from '@agentclientprotocol/sdk'
import { AntigravityAcpAdapter, AGY_PROVIDER_ID, AGY_UNSUPPORTED_OPTION, AGY_ADAPTER_ERROR } from '../src/adapter/antigravity-adapter.js'
import { AGY_TURN_ERROR } from '../src/adapter/prompt-turn.js'
import { AGY_BRIDGE_ERROR } from '../src/bridge/mcp-bridge.js'
import { AgentLink } from '../src/protocol/agent-link.js'
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
function createHarness(options: { parkSettleMs?: number; configOptions?: SessionConfigOption[] | null; promptTimeoutMs?: number } = {}): Harness {
  const agent = new FakeAcpAgent()
  let configOptions: SessionConfigOption[] | null = options.configOptions === undefined ? MODEL_CONFIG_OPTIONS : options.configOptions
  let sessionSeq = 0

  agent.on('initialize', () => ({
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { embeddedContext: false, image: false, audio: false } },
  }))
  agent.on('authenticate', () => ({}))
  agent.on('session/new', () => ({
    sessionId: sessionSeq === 0 ? SESSION_1 : SESSION_2,
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

  let link: AgentLink | undefined
  let bridgeTeardown: (() => Promise<void>) | undefined
  const adapter = new AntigravityAcpAdapter({
    getLink: async (handlers) => {
      if (link) return link
      const created = new AgentLink({ stream: agent.stream, handlers, requestTimeoutMs: 5_000 })
      created.start()
      await created.initialize({ clientCapabilities: AGY_CLIENT_CAPABILITIES })
      await created.authenticate()
      link = created
      return created
    },
    registerBridgeTeardown: (fn) => {
      bridgeTeardown = fn
    },
    parkSettleMs: options.parkSettleMs ?? 15,
    promptTimeoutMs: options.promptTimeoutMs,
  })
  teardowns.push(async () => {
    await bridgeTeardown?.()
    await link?.close()
  })
  return {
    agent,
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
    expect(await harness.adapter.listModels(AGY_PROVIDER_ID)).toEqual([
      { provider: AGY_PROVIDER_ID, id: 'gemini-3-pro', name: 'Gemini 3 Pro', description: '质量优先', inputModalities: ['text'] },
      { provider: AGY_PROVIDER_ID, id: 'gemini-3-flash', name: 'Gemini 3 Flash', inputModalities: ['text'] },
    ])
  })

  it('listModels 不为列目录启动运行时（未观测时返回空目录，且零 ACP 交互）', async () => {
    const harness = createHarness()
    expect(await harness.adapter.listModels(AGY_PROVIDER_ID)).toEqual([])
    expect(harness.agent.requests).toHaveLength(0)
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
    expect(await streaming).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })
})

describe('不支持的请求项', () => {
  const cases: Array<[string, Partial<GenerateOptions>]> = [
    ['temperature', { temperature: 0.5 }],
    ['maxTokens', { maxTokens: 256 }],
    ['stop', { stop: ['END'] }],
    ['reasoningEffort', { reasoningEffort: 'high' as never }],
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

  it('缺省 reasoningEffort 不报错', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await expect(streaming).resolves.toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })
})

describe('abort 语义', () => {
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
  it('session/request_permission 一律拒绝并以 AGY_PERMISSION_DENIED 结束回合', async () => {
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
    expect(response).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'no' } } })
    await harness.agent.reply('session/prompt', { stopReason: 'cancelled' })

    expect(await streaming).toEqual([
      {
        type: 'finish',
        reason: { kind: 'error', failure: { code: AGY_TURN_ERROR.PERMISSION_DENIED, message: expect.stringContaining('tc-1') } },
      },
    ])
  })

  it('未预期的原生请求（fs/write_text_file）终止回合而非静默吞掉', async () => {
    const harness = createHarness()
    const streaming = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    const response = await harness.agent.callClient('fs/write_text_file', {
      sessionId: SESSION_1,
      path: '/etc/passwd',
      content: 'x',
    })
    // AgentLink 仍按既有语义回 method-not-found。
    expect(response).toMatchObject({ error: { code: -32601 } })
    await harness.agent.reply('session/prompt', { stopReason: 'cancelled' })
    expect((await streaming).at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: AGY_TURN_ERROR.NATIVE_ACTIVITY_REFUSED, message: expect.stringContaining('fs/write_text_file') } },
    })
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

  it('上一轮仍在进行时的新轮被拒为 AGY_BUSY', async () => {
    const harness = createHarness()
    const first = collect(harness.adapter.stream(baseOptions()))
    await waitForRequest(harness.agent, 'session/prompt')
    await expect(collect(harness.adapter.stream(baseOptions()))).rejects.toMatchObject({
      code: AGY_ADAPTER_ERROR.BUSY,
    })
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' })
    await first
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
    await waitForRequest(harness.agent, 'session/new', 2)
    // 旧 park 被作废：桥不再等待回喂。
    expect(harness.adapter.bridge.pendingCallIds()).toEqual([])
    await harness.agent.reply('session/prompt', { stopReason: 'end_turn' }, 1)
    expect((await second).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})
