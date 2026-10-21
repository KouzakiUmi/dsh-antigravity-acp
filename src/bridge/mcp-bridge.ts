/**
 * 私有 loopback MCP 桥（原创实现）。
 *
 * 目的：工具留在 DSH 侧执行。ACP agent 不直接拥有 DSH 的工具，而是看到一台
 * 进程内的 MCP server（`@modelcontextprotocol/sdk` 的 Streamable HTTP），
 * 该 server 只监听 127.0.0.1、端口随机、每次启动随机 token，通过
 * `session/new` 的 `mcpServers: [{ type: "http", url, headers }]` 注册给
 * agent（ACP v1 1.4.0 的 `McpServerHttp` 形状，见 SDK types.gen.d.ts）。
 * 不起任何子进程（不使用 child_process）。
 *
 * **park 机制**：`tools/call` 到达时不立即返回。桥把它登记为 pending
 * （`BridgeParkedCall`），交给 adapter 吐 DSH `tool-call` block，本轮 stream
 * 以 `finish{kind:'tool-calls'}` 结束；下一轮 DSH `stream` 带着 tool result
 * 回来时 `deliverResults` 才 resolve 对应的 MCP 响应，agent 在**同一个 ACP
 * prompt** 内继续产出。
 *
 * **多会话**：每个 MCP 会话（= 每条 ACP `session/new` 注册的连接）拥有独立的
 * Streamable HTTP transport 与 McpServer 实例，按 `mcp-session-id` 分发请求
 * （见 BridgeChannel 注释）；工具集合与 park 表仍是全桥共享的一份。
 *
 * 测试友好性：`attach(transport)` 接受任意 MCP Transport，因此测试用 SDK 自带
 * 的 `InMemoryTransport.createLinkedPair()` 在进程内直连，不占端口。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** 本模块原创错误码（AGY_BRIDGE_*）。 */
export const AGY_BRIDGE_ERROR = {
  /** 桥尚未 start/attach 就被要求提供 MCP 注册信息。 */
  NOT_LISTENING: 'AGY_BRIDGE_NOT_LISTENING',
  /** HTTP 请求缺少或不匹配本桥的随机 token。 */
  UNAUTHORIZED: 'AGY_BRIDGE_UNAUTHORIZED',
  /** tools/call 指向桥当前未发布的工具。 */
  UNKNOWN_TOOL: 'AGY_BRIDGE_UNKNOWN_TOOL',
  /** 桥已关闭后再交付 tool result。 */
  CLOSED: 'AGY_BRIDGE_CLOSED',
  /** 请求携带的 mcp-session-id 不属于本桥的任何现存会话。 */
  UNKNOWN_SESSION: 'AGY_BRIDGE_UNKNOWN_SESSION',
  /** 桥已绑定一条 transport 后再次 attach。 */
  ALREADY_ATTACHED: 'AGY_BRIDGE_ALREADY_ATTACHED',
} as const

/** 桥为 agent 暴露的 MCP server 名称（ACP 侧注册名）。 */
export const BRIDGE_MCP_SERVER_NAME = 'dsh-tools'
/** 注册时使用的鉴权请求头名；值为 `Bearer <token>`。 */
export const BRIDGE_AUTH_HEADER = 'authorization'
/** MCP Streamable HTTP 规范的会话头名（客户端 initialize 之后必须回带）。 */
export const BRIDGE_SESSION_HEADER = 'mcp-session-id'

/** 一次被 park 的 `tools/call`。 */
export interface BridgeParkedCall {
  /** MCP 层生成的请求 id；DSH 侧以它作为 tool-call id 回喂。 */
  callId: string
  /** MCP 工具名。 */
  name: string
  /** 原始参数对象的 JSON 文本（DSH tool-call block 需要 raw JSON string）。 */
  arguments: string
}

/** 一次回喂给被 park 调用的结果。 */
export interface BridgeToolResult {
  /** 与 `BridgeParkedCall.callId` 对应。 */
  callId: string
  /** 结果文本（MCP text content）。 */
  text: string
  /** 工具是否失败（映射到 MCP `isError`，且让 agent 自行决定重试/放弃）。 */
  isError: boolean
}

interface PendingEntry {
  call: BridgeParkedCall
  settle: (result: CallToolResult) => void
}

/**
 * 一条 MCP 通道 = 一个 transport + 绑定其上的 McpServer 实例。
 *
 * 为什么必须一对一并按会话隔离：SDK 1.32.1 的 `Protocol.connect()` 在已持有
 * transport 时直接抛 "Already connected to a transport"，而 Streamable HTTP 的
 * 有状态 transport 对同一实例的第二次 initialize 回 400
 * "Invalid Request: Server already initialized"。每个 ACP `session/new` 都会让
 * agent 新建一条 MCP 连接，因此单一 transport/server 会让第二个会话直接失败。
 * 无状态模式（sessionIdGenerator: undefined）被 SDK 明确禁止跨请求复用，
 * 所以这里选择「每次 initialize 新建 transport + 新建 server」，用
 * mcp-session-id → 通道路由后续请求。
 */
interface BridgeChannel {
  server: McpServer
  transport: Transport
}

/** HTTP 会话通道：transport 是 Streamable HTTP 实现，需要按请求分发。 */
interface HttpChannel extends BridgeChannel {
  transport: StreamableHTTPServerTransport
}

export interface McpToolBridgeOptions {
  /** 固定监听端口；缺省为 0（由内核随机分配）。 */
  port?: number
  /** 固定 token（仅测试用）；缺省随机 32 字节 hex。 */
  token?: string
}

/**
 * 进程内 MCP 工具桥。一个 adapter 实例持有一个桥，跨 ACP 回合与 ACP 会话复用；
 * 每回合通过 `publishTools` 更新工具列表、`resetPending` 清空未回喂的 park。
 * 工具集合按**请求时**读取，因此所有 MCP 会话看到同一份当前工具。
 */
export class McpToolBridge {
  #token: string
  #generation = 0
  readonly #requestedPort: number
  readonly #pending = new Map<string, PendingEntry>()
  readonly #listeners = new Set<(call: BridgeParkedCall) => void>()
  /** HTTP 模式下按 mcp-session-id 索引的会话通道（每个 MCP/ACP 会话一条）。 */
  readonly #sessions = new Map<string, HttpChannel>()
  /** attach() 注入的非 HTTP 通道（测试用 in-memory pair）。 */
  #attached: BridgeChannel | undefined
  #tools: readonly ToolSchema[] = []
  #http: Server | undefined
  #bound = false
  #closed = false
  #address: string | undefined
  #callSeq = 0
  /** HTTP 监听器的最近一次运行期错误（诊断用；listen 阶段的错误走 spawn 的 reject）。 */
  #httpError: Error | undefined

  constructor(options: McpToolBridgeOptions = {}) {
    this.#token = options.token ?? randomBytes(32).toString('hex')
    this.#requestedPort = options.port ?? 0
  }

  /** 本桥的随机访问 token（注册进 ACP mcpServers 的 header 值即 `Bearer ${token}`）。 */
  get token(): string {
    return this.#token
  }

  /** 桥的实际 MCP 端点；未 listen 时为 undefined。 */
  get url(): string | undefined {
    return this.#address
  }

  /** 是否已向 MCP Transport 绑定（listen 或 attach 完成）。 */
  get listening(): boolean {
    return this.#bound
  }

  /** HTTP 监听器的最近一次运行期错误；健康时为 undefined。 */
  get lastHttpError(): Error | undefined {
    return this.#httpError
  }

  /** 订阅 park 事件；返回退订函数。 */
  onParked(listener: (call: BridgeParkedCall) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** 发布本回合 DSH 交给 agent 的工具（tools/list 的数据源）。 */
  publishTools(tools: readonly ToolSchema[]): void {
    this.#tools = [...tools]
  }

  /** 新 ACP 回合取得独立授权代次，旧连接不能把调用投递到新回合。 */
  beginRound(tools: readonly ToolSchema[]): void {
    this.invalidateRound('已切换 ACP 回合')
    this.publishTools(tools)
    // 上一回合的 MCP 会话通道已无用（新回合会新建 ACP 会话与连接），在这里
    // 收掉以免按回合累积。**不能**放进 invalidateRound：回合失败/取消时
    // resetPending 刚把错误结果结算给 agent，立即关闭 transport 会截断那个响应，
    // MCP 客户端会一直等它。
    this.#closeSessionChannels()
  }

  /** 撤销本回合目录、凭证和所有未完成调用；server 本身仍可用于下个回合。 */
  invalidateRound(reason: string): void {
    this.#generation += 1
    this.#token = randomBytes(32).toString('hex')
    this.#tools = []
    this.resetPending(reason)
  }

  /** 关闭已握手完成（已登记 mcp-session-id）的全部 MCP 会话通道。 */
  #closeSessionChannels(): void {
    for (const [sessionId, channel] of this.#sessions) {
      this.#sessions.delete(sessionId)
      void channel.transport.close().catch(() => undefined)
      void channel.server.close().catch(() => undefined)
    }
  }

  /** 当前发布的工具名集合。 */
  toolNames(): readonly string[] {
    return this.#tools.map((tool) => tool.name)
  }

  /** 当前目录的只读快照，供权限请求转交 DSH 时匹配工具 schema。 */
  toolSchemas(): readonly ToolSchema[] {
    return [...this.#tools]
  }

  /** ACP `session/new` 用的 mcpServers 条目；仅 127.0.0.1 loopback。 */
  acpRegistration(): AcpMcpServer[] {
    if (!this.#address) return []
    return [
      {
        type: 'http',
        name: BRIDGE_MCP_SERVER_NAME,
        url: this.#address,
        headers: [{ name: BRIDGE_AUTH_HEADER, value: `Bearer ${this.#token}` }],
      },
    ]
  }

  /** 尚未回喂的 park 调用 id（按 park 顺序）。 */
  pendingCallIds(): string[] {
    return [...this.#pending.keys()]
  }

  /** 某个 tool-call id 是否仍在等待回喂。 */
  hasPending(callId: string): boolean {
    return this.#pending.has(callId)
  }

  /**
   * 回喂 tool result：按 callId resolve 对应的 MCP tools/call 响应。
   * 未登记的 callId 抛错（调用方负责在投递前做匹配判断）。
   */
  async deliverResults(results: readonly BridgeToolResult[]): Promise<void> {
    if (this.#closed) throw new Error(`${AGY_BRIDGE_ERROR.CLOSED}: MCP 桥已关闭，无法回喂工具结果`)
    for (const result of results) {
      const entry = this.#pending.get(result.callId)
      if (!entry) throw new Error(`${AGY_BRIDGE_ERROR.UNKNOWN_TOOL}: 未登记的 park 调用 ${result.callId}`)
      this.#pending.delete(result.callId)
      entry.settle({
        content: [{ type: 'text', text: result.text }],
        isError: result.isError,
      })
    }
  }

  /**
   * 丢弃所有未回喂的 park：以错误结果 settle，使仍在等待的 MCP 客户端
   * 请求立即失败而不是永久挂起（agent 侧会看到工具调用失败）。
   */
  resetPending(reason: string): void {
    for (const [, entry] of this.#pending) {
      entry.settle({ content: [{ type: 'text', text: reason }], isError: true })
    }
    this.#pending.clear()
  }

  /** 绑定到任意 MCP Transport（测试用 in-memory pair；生产用 listen）。 */
  async attach(transport: Transport): Promise<void> {
    if (this.#attached) {
      throw new Error(`${AGY_BRIDGE_ERROR.ALREADY_ATTACHED}: 桥已绑定一条 MCP transport，请先 close() 再重新 attach`)
    }
    const server = this.#createServer()
    const channel: BridgeChannel = { server, transport }
    this.#attached = channel
    transport.onclose = () => {
      if (this.#attached === channel) this.#attached = undefined
      void server.close().catch(() => undefined)
    }
    await server.connect(transport)
    this.#bound = true
  }

  /** 在 127.0.0.1 上监听随机端口的 Streamable HTTP MCP server。 */
  async start(): Promise<void> {
    if (this.#bound) return
    // 有状态模式（SDK 语义）：每个 MCP 会话一条 transport，initialize 时签发
    // mcp-session-id 并由 #handleHttp 按该头名分发后续请求。SDK 的**无状态**
    // 模式禁止跨请求复用同一 transport（"Stateless transport cannot be reused
    // across requests"），因此不做无状态复用。
    const http = createServer((req: IncomingMessage, res: ServerResponse) => {
      // #createHttpChannel 等路径的异常不在 #handleHttp 的 try 内：这里兜住，否则
      // 它会变成 unhandledRejection 并终止整个宿主进程。
      this.#handleHttp(req, res).catch(() => {
        if (!res.headersSent) res.statusCode = 500
        if (!res.writableEnded) res.end()
      })
    })
    // 运行期错误必须有人接住：Node 的 http.Server 在没有 'error' 监听时会抛出
    // 未捕获异常，直接终止宿主进程。这里只记录，供诊断读取。
    http.on('error', (error: Error) => {
      this.#httpError = error
    })
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(this.#requestedPort, '127.0.0.1', () => {
        http.removeListener('error', reject)
        resolve()
      })
    })
    this.#http = http
    const address = http.address() as AddressInfo | null
    this.#address = `http://127.0.0.1:${address?.port ?? this.#requestedPort}/mcp`
    this.#bound = true
  }

  /** 关闭 HTTP 监听、拒绝所有未回喂 park、关闭全部会话通道。幂等。 */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.resetPending(`${AGY_BRIDGE_ERROR.CLOSED}: MCP 桥已关闭，未执行的工具调用作废`)
    const http = this.#http
    this.#http = undefined
    if (http) {
      // 必须先发起 close 再强制断开：MCP 客户端可能还挂着 GET SSE 长连接，
      // 只调 close() 会一直等到对端自己断开。
      await new Promise<void>((resolve) => {
        http.close(() => resolve())
        http.closeIdleConnections?.()
        http.closeAllConnections?.()
      })
    }
    // 所有会话通道（每个 MCP 会话一条）一并关闭，避免留下半开的 server。
    const channels: BridgeChannel[] = [...this.#sessions.values()]
    this.#sessions.clear()
    if (this.#attached) {
      channels.push(this.#attached)
      this.#attached = undefined
    }
    await Promise.all(channels.map((channel) => channel.transport.close().catch(() => undefined)))
    await Promise.all(channels.map((channel) => channel.server.close().catch(() => undefined)))
    this.#address = undefined
    this.#bound = false
  }

  async #handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 鉴权先于任何 MCP 处理：随机 token 是唯一凭证，且地址只对 loopback 开放。
    if (req.headers[BRIDGE_AUTH_HEADER] !== `Bearer ${this.#token}`) {
      res.statusCode = 401
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: AGY_BRIDGE_ERROR.UNAUTHORIZED }, id: null }))
      return
    }
    let channel: HttpChannel | undefined
    const sessionId = req.headers[BRIDGE_SESSION_HEADER]
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      channel = this.#sessions.get(sessionId)
      if (!channel) {
        // 会话可能属于上一个桥实例，或已被 DELETE/close 清理；按 SDK 语义回 404。
        res.statusCode = 404
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: `${AGY_BRIDGE_ERROR.UNKNOWN_SESSION}: 未知的 MCP 会话` },
          id: null,
        }))
        return
      }
    } else {
      // 无会话头 = 新客户端在做 initialize（其余无头请求由 transport 自己回 400）：
      // 为它开一条独立通道，使每个 ACP 会话的 MCP Client 都能连上桥。
      channel = await this.#createHttpChannel()
    }
    try {
      await channel.transport.handleRequest(req, res)
    } catch {
      // 传输层异常：已经写过响应头就交给它收尾，否则补一个 500。
      if (!res.headersSent) {
        res.statusCode = 500
        res.end()
      }
    } finally {
      // 无 session 头却没能完成 initialize 的请求（畸形 JSON、失败的握手）不会被
      // transport 登记进 #sessions；这里主动收掉，避免每次畸形请求都泄漏一条通道。
      // 已生成 sessionId 的会话保留，供后续请求按 mcp-session-id 分发。
      if (!channel.transport.sessionId) {
        await channel.transport.close().catch(() => undefined)
      }
    }
  }

  /** 新建一条在 127.0.0.1 上按会话隔离的 HTTP 通道（initialize 时登记会话 id）。 */
  async #createHttpChannel(): Promise<HttpChannel> {
    const server = this.#createServer()
    let channel: HttpChannel | undefined
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        if (channel) this.#sessions.set(sessionId, channel)
      },
    })
    channel = { server, transport }
    // Protocol.connect 会把已有的 onclose 链到自己的处理器上，因此必须在
    // connect 之前挂好清理：会话关闭时从路由表摘除并关掉它自己的 server。
    transport.onclose = () => {
      const closedId = transport.sessionId
      if (closedId && this.#sessions.get(closedId) === channel) this.#sessions.delete(closedId)
      void server.close().catch(() => undefined)
    }
    await server.connect(transport)
    return channel
  }

  /**
   * 建一个会话级的 MCP server。低层 handler 在**请求时**才读当前发布的工具
   * （工具集合每回合可变），因此刻意不走 McpServer.registerTool（它是
   * per-tool 静态注册、且同名会冲突）。
   */
  #createServer(): McpServer {
    const generation = this.#generation
    const server = new McpServer({ name: BRIDGE_MCP_SERVER_NAME, version: '0.1.0' }, { capabilities: { tools: {} } })
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: generation === this.#generation ? this.#mcpTools() : [] }))
    server.server.setRequestHandler(CallToolRequestSchema, (request) => this.#parkCall(request.params.name, request.params.arguments, generation))
    return server
  }

  #mcpTools(): Tool[] {
    return this.#tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as Tool['inputSchema'],
    }))
  }

  #parkCall(name: string, args: Record<string, unknown> | undefined, generation: number): Promise<CallToolResult> {
    // tools/list 不是授权凭证；每次调用都重新检查当前目录，拒绝撤销/未知工具。
    if (this.#closed || generation !== this.#generation || !this.#tools.some((tool) => tool.name === name)) {
      return Promise.resolve({
        content: [{ type: 'text', text: `${this.#closed ? AGY_BRIDGE_ERROR.CLOSED : AGY_BRIDGE_ERROR.UNKNOWN_TOOL}: ${name}` }],
        isError: true,
      })
    }
    const callId = `${BRIDGE_MCP_SERVER_NAME}-${++this.#callSeq}`
    const call: BridgeParkedCall = { callId, name, arguments: JSON.stringify(args ?? {}) }
    return new Promise<CallToolResult>((resolve) => {
      this.#pending.set(callId, { call, settle: resolve })
      for (const listener of this.#listeners) listener(call)
    })
  }
}
