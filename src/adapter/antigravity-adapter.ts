/**
 * Antigravity ACP 的 LlmAdapter 实现。
 *
 * 形态：官方 ACP server（Gemini 主模型）走 stdio，工具留在 DSH 侧，经插件
 * 进程内的私有 loopback MCP 桥暴露给 agent（见 ../bridge/mcp-bridge.ts）。
 *
 * 历史权威是 DSH：**本文件不建任何会话存储/数据库/文件**。每次 `stream` 都
 * 用完整的 `options.messages` + `options.system` 重建一条 ACP prompt
 * （见 prompt-transcript.ts）；唯一的跨回合内存态是「当前 ACP 回合」与
 * 「park 中的 MCP tools/call」，它们都随回合结束而释放。
 *
 * 不支持项一律抛 `LlmError(..., 'UNSUPPORTED_OPTION')`（dsh-llm 0.2.1 的
 * error.d.ts 未导出该码的官方常量，因此用字面量并在下方集中定义）。
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  RequestMessage,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AnyRequest, McpServer as AcpMcpServer, SessionConfigOption } from '@agentclientprotocol/sdk'
import type { AgentLink, AgentLinkHandlers } from '../protocol/agent-link.js'
import { McpToolBridge } from '../bridge/mcp-bridge.js'
import type { BridgeToolResult } from '../bridge/mcp-bridge.js'
import { findModelSelector, toModelCatalog } from './model-catalog.js'
import type { ModelSelector } from './model-catalog.js'
import { buildPromptContent, renderToolResultText } from './prompt-transcript.js'
import { PromptTurn } from './prompt-turn.js'

/** DSH 侧 provider 标识符；与 cordis.patch.yml 的 id 及文档保持一致。 */
export const AGY_PROVIDER_ID = 'antigravity-acp'

/**
 * 不支持项的机器错误码。dsh-llm 0.2.1-alpha.2 的 `error.d.ts` 未导出
 * `UNSUPPORTED_OPTION` 常量，故使用字面量并集中在此定义。
 */
export const AGY_UNSUPPORTED_OPTION = 'UNSUPPORTED_OPTION'

/** 本 adapter 的其余原创错误码（AGY_* 体系）。 */
export const AGY_ADAPTER_ERROR = {
  /** 同一时刻已有活跃回合，且当前请求不是它的续轮。 */
  BUSY: 'AGY_BUSY',
  /** 回合需要一个模型选择器，但 ACP 会话未声明任何 model 类 configOption。 */
  NO_MODEL_SELECTOR: 'AGY_NO_MODEL_SELECTOR',
} as const

/** MCP 桥与回合的可调参数（由 index.ts 从插件配置注入）。 */
export interface AntigravityAcpAdapterOptions {
  /**
   * 惰性启动工厂：返回完成 initialize + authenticate 的 AgentLink。传入的
   * handlers 必须在整个 adapter 生命周期内保持**同一对象**——index.ts 会把
   * 首个 handler 集合固化到被缓存的 AgentLink 上，后续回合只更换其内部状态。
   */
  getLink: (handlers: AgentLinkHandlers) => Promise<AgentLink>
  /** 登记桥的关闭钩子（index.ts 把它挂到 ActiveAcpRuntime.bridgeTeardown）。 */
  registerBridgeTeardown: (teardown: () => Promise<void>) => void
  /** session/prompt 等待上限（毫秒）。 */
  promptTimeoutMs?: number
  /** 并发 MCP park 的聚合窗口（毫秒）。 */
  parkSettleMs?: number
  /** session/new 使用的工作目录；缺省为进程 cwd。 */
  cwd?: string
}

const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_PARK_SETTLE_MS = 50

export class AntigravityAcpAdapter extends LlmAdapter {
  readonly #getLink: AntigravityAcpAdapterOptions['getLink']
  readonly #registerBridgeTeardown: AntigravityAcpAdapterOptions['registerBridgeTeardown']
  readonly #promptTimeoutMs: number
  readonly #parkSettleMs: number
  readonly #cwd: string
  readonly #bridge: McpToolBridge
  /** 身份稳定的 ACP 事件处理器：AgentLink 只在构造时取一次 handlers。 */
  readonly #handlers: AgentLinkHandlers
  #turn: PromptTurn | undefined
  /**
   * 当前 ACP 回合的 park 订阅。生命周期是**回合**而不是单次 `stream` 调用：
   * 首轮以 `finish(tool-calls)` 收尾时 ACP prompt 仍然活着（agent 挂起等回喂），
   * 此时退订会让回喂后 agent 发起的下一批 tools/call 无人接管、MCP 请求永久
   * 挂起（见 #subscribeTurn 的注释）。
   */
  #turnSubscription: { turn: PromptTurn; unsubscribe: () => void } | undefined
  #catalog: LlmModelInfo[] = []
  #modelSelector: ModelSelector | undefined
  /** 模型目录的观察来源，用于列表页在真实会话之前就能给出缓存目录。 */
  #catalogObserved = false

  constructor(options: AntigravityAcpAdapterOptions) {
    super()
    this.#getLink = options.getLink
    this.#registerBridgeTeardown = options.registerBridgeTeardown
    this.#promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
    this.#parkSettleMs = options.parkSettleMs ?? DEFAULT_PARK_SETTLE_MS
    this.#cwd = options.cwd ?? process.cwd()
    this.#bridge = new McpToolBridge()
    this.#registerBridgeTeardown(async () => {
      this.#releaseTurnSubscription()
      await this.#bridge.close()
    })
    this.#handlers = {
      onSessionUpdate: (notification) => this.#turn?.handleSessionUpdate(notification),
      onRequestPermission: (request) => this.#turn?.handleRequestPermission(request)
        ?? { outcome: { outcome: 'cancelled' } },
      onUnexpectedAgentRequest: (method, request) => this.#handleUnexpectedRequest(method, request),
    }
  }

  /** 私有 MCP 桥（诊断与测试可见；agent 侧只经 ACP mcpServers 访问它）。 */
  get bridge(): McpToolBridge {
    return this.#bridge
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Antigravity (ACP)' }
  }

  /**
   * 模型目录：只读**已观测**的 ACP 会话配置，绝不为了列目录而启动运行时。
   *
   * 依据已安装 SDK 1.4.0 的 d.ts：`InitializeResponse` 只有 protocolVersion /
   * agentCapabilities / authMethods / agentInfo，**没有 configOptions**；模型
   * 选择器出现在 `session/new` 响应、`session/set_config_option` 响应或
   * `session/update(config_option_update)` 里。也就是说，ACP v1 没有任何
   * 「无副作用即可读到模型目录」的方法；而启动运行时必然走
   * `authenticate`（官方进程会自行弹浏览器）。
   *
   * 因此本实现在无目录时返回空目录：真实目录会在第一次 `stream` 建立会话
   * 后由 `observeSessionConfigOptions` 写入缓存（GUI 侧的目录刷新会读到它）。
   */
  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return this.#catalog.map((model) => ({ ...model }))
  }

  /**
   * 精确模型解析。按 dsh-llm 的目录语义，目录成员资格是**建议性**的
   * （catalog membership remains advisory），因此这里不因未登记的 id 报错；
   * 真正的能力拒绝发生在 ACP 会话侧（模型不存在时 agent 自行报错）。
   */
  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const known = this.#catalog.find((entry) => entry.id === model)
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      inputModalities: ['text'],
      ...(known?.description === undefined ? {} : { description: known.description }),
    }
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const modelInfo = await this.resolveModel(provider, model, signal)
    return {
      model: modelInfo,
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /**
   * 一次模型调用的 chunk 流。
   *
   * 判定「续轮 vs 新轮」：messages 尾部的连续 tool 结果消息与当前回合 park
   * 的 MCP 调用**按顺序一一匹配**且该回合的 ACP prompt 尚未应答 → 续轮；
   * 否则按新轮重建（放弃旧回合、新建 ACP session、重放完整 messages）。
   * 并发防御：若上一轮仍**在产出中**（既非封口也非等待回喂），新轮直接抛
   * AGY_BUSY——DSH 语义本就是单路活跃 stream，静默抢占会让 pending 表错乱。
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 1) 不支持项先行拒绝：必须在任何 IO 之前失败。
    assertSupportedOptions(options)

    const tail = trailingToolResults(options.messages)
    let turn = this.#turn
    if (turn?.awaitingToolResults) {
      // 能续轮的前提有两个：ACP prompt 尚未应答（同一 prompt 内才能继续
      // 产出），且尾部 tool 结果与 park 表按顺序一一匹配。
      if (!turn.promptSettled && matchesParkedCalls(turn, tail, this.#bridge)) {
        yield* this.#runContinuation(turn, options, tail)
        return
      }
      // 不匹配（或 agent 已经收尾）→ 按 brief 的兜底规则放弃旧回合、回到
      // W4 的「重建新 prompt」路径；历史权威仍是 DSH 的完整 messages。
      this.#abandonTurn('续轮条件不满足（工具结果与 park 表不匹配，或 ACP prompt 已应答），按新轮重建')
      turn = undefined
    }
    if (turn && !this.#isTurnClosed(turn)) {
      throw new LlmError(
        'Antigravity ACP 同一时刻只允许一路活跃 stream：当前回合仍在进行中，本请求既不是其续轮，也无法安全抢占',
        AGY_ADAPTER_ERROR.BUSY,
      )
    }
    yield* this.#runNewRound(options)
  }

  async *#runNewRound(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const link = await this.#getLink(this.#handlers)
    const tools = options.tools ?? []
    this.#bridge.publishTools(tools)
    let mcpServers: AcpMcpServer[] = []
    if (tools.length > 0) {
      // 端口/token 随桥实例固定，跨回合复用同一台 server；register/teardown
      // 已在构造时挂到 ActiveAcpRuntime.bridgeTeardown。
      if (!this.#bridge.listening) await this.#bridge.start()
      mcpServers = this.#bridge.acpRegistration()
    } else {
      this.#bridge.resetPending('本轮未向 agent 暴露工具')
    }

    const session = await link.newSession({ cwd: this.#cwd, mcpServers })
    this.observeSessionConfigOptions(session.configOptions)
    await this.#applyModelSelection(link, session.sessionId, options.model)

    const turn = new PromptTurn(session.sessionId, {
      link,
      bridge: this.#bridge,
      promptTimeoutMs: this.#promptTimeoutMs,
      parkSettleMs: this.#parkSettleMs,
      onConfigOptions: (observed) => this.observeSessionConfigOptions(observed),
    })
    this.#turn = turn
    this.#subscribeTurn(turn)
    turn.startPrompt(buildPromptContent(options.system, options.messages), options.signal)
    try {
      yield* drainTurn(turn)
    } finally {
      // 只有该 ACP prompt **真正结束**（已应答且不再等待回喂）才退订；
      // finish(tool-calls) 之后 prompt 还活着，订阅必须留给续轮。
      this.#releaseTurnSubscriptionIfClosed(turn)
    }
  }

  async *#runContinuation(turn: PromptTurn, options: GenerateOptions, tail: readonly RequestMessage[]): AsyncGenerator<StreamChunk> {
    turn.resume(options.signal)
    // 续轮仍在同一个 ACP prompt 内：先确保 park 订阅在位——回喂之后 agent
    // 可能马上发起第二批 tools/call，若此处没有订阅，那些 MCP 请求会永久挂起。
    // 同回合重复调用是幂等的，不会叠加监听器。
    this.#subscribeTurn(turn)
    const results: BridgeToolResult[] = tail.map((message) => {
      if (message.role !== 'tool') throw new LlmError('续轮内部错误：非 tool 角色进入工具回喂', AGY_ADAPTER_ERROR.BUSY)
      return {
        callId: message.toolCallId,
        text: renderToolResultText(message.content as readonly { type: string }[]),
        isError: message.isError === true,
      }
    })
    try {
      // 续轮不重发 prompt：结果交给桥 resolve 上轮 park 的 MCP 调用，agent 在
      // **同一个 ACP prompt** 内继续产出后续 session/update。
      await turn.deliverToolResults(results)
      yield* drainTurn(turn)
    } finally {
      this.#releaseTurnSubscriptionIfClosed(turn)
    }
  }

  /**
   * 确保该回合已订阅桥的 park 事件（幂等）。订阅按**回合**建立：一次 stream
   * 调用的结束不等于 ACP prompt 的结束，而 park 可能在任何时刻到达。
   */
  #subscribeTurn(turn: PromptTurn): void {
    if (this.#turnSubscription?.turn === turn) return
    this.#releaseTurnSubscription()
    this.#turnSubscription = {
      turn,
      unsubscribe: this.#bridge.onParked((call) => turn.handleParked(call)),
    }
  }

  /** 释放 park 订阅；给了 turn 时只释放属于该回合的那一条。幂等。 */
  #releaseTurnSubscription(turn?: PromptTurn): void {
    const subscription = this.#turnSubscription
    if (!subscription) return
    if (turn && subscription.turn !== turn) return
    this.#turnSubscription = undefined
    subscription.unsubscribe()
  }

  /** 回合已收尾（prompt 已应答且不再等待回喂）时才退订。 */
  #releaseTurnSubscriptionIfClosed(turn: PromptTurn): void {
    if (this.#isTurnClosed(turn)) this.#releaseTurnSubscription(turn)
  }

  /**
   * 放弃当前回合：取消 ACP 会话、封口 chunk 队列、清空 bridge 的 park。
   * 不等待 prompt 应答（agent 可能已挂起），避免放弃动作被拖死。
   */
  #abandonTurn(reason: string): void {
    const turn = this.#turn
    this.#turn = undefined
    this.#releaseTurnSubscription(turn)
    if (!turn) return
    if (!turn.promptSettled) void turn.abort(reason)
    turn.finishRound()
    turn.dispose()
    this.#bridge.resetPending(reason)
  }

  #isTurnClosed(turn: PromptTurn): boolean {
    // finished 的判定：回合已结束且不再等待工具结果。
    return turn.promptSettled && !turn.awaitingToolResults
  }

  #handleUnexpectedRequest(method: string, _request: AnyRequest): void {
    if (!this.#turn) return
    this.#turn.handleUnexpectedAgentRequest(method)
  }

  /**
   * 观察一次 ACP 会话配置：刷新模型目录缓存与 model 选择器。
   * `session/new`、`session/set_config_option` 与 `config_option_update` 共用。
   */
  observeSessionConfigOptions(configOptions: readonly SessionConfigOption[] | null | undefined): void {
    const selector = findModelSelector(configOptions)
    this.#catalogObserved = true
    this.#modelSelector = selector
    this.#catalog = toModelCatalog(AGY_PROVIDER_ID, selector)
  }

  /** 是否已经从真实 ACP 会话观测到过配置（listModels 空目录时的诊断依据）。 */
  get catalogObserved(): boolean {
    return this.#catalogObserved
  }

  /**
   * 把 DSH 选定的模型写进 ACP 会话配置。
   *
   * ACP v1 的 `session/set_config_option` 需要既有 sessionId，因此顺序是
   * `session/new` → `set_config_option` → `session/prompt`（initialize 响应
   * 不携带 configOptions，没有「new 之前设置」的通道）。
   */
  async #applyModelSelection(link: AgentLink, sessionId: string, model: string): Promise<void> {
    const selector = this.#modelSelector
    if (!selector) {
      throw new LlmError(
        'Antigravity ACP 会话未声明任何 model 类配置选项（select + category/name 匹配 model），无法为该 provider 选择模型',
        AGY_ADAPTER_ERROR.NO_MODEL_SELECTOR,
      )
    }
    if (selector.currentValue === model) return
    // 目录成员资格按 dsh-llm 语义是建议性的：未登记的 id 仍然照发，由 ACP
    // agent 自己判定是否接受，而不是在这里静默改写成别的模型。
    const response = await link.setConfigOption({ sessionId, configId: selector.configId, value: model })
    this.observeSessionConfigOptions(response.configOptions)
  }
}

/** 把回合的 chunk 队列逐个交给调用方；undefined 表示本轮已取尽。 */
async function* drainTurn(turn: PromptTurn): AsyncGenerator<StreamChunk> {
  for (;;) {
    const chunk = await turn.nextChunk()
    if (chunk === undefined) return
    yield chunk
  }
}

/**
 * 不支持项检查。temperature / maxTokens / stop 没有 ACP 对应通道；显式
 * reasoningEffort 亦然（ACP 侧思考档位由 agent 自己的 configOption 表达，
 * 本 adapter 不代 DSH 映射）。缺省的 reasoningEffort（undefined）不报错。
 */
function assertSupportedOptions(options: GenerateOptions): void {
  const unsupported: string[] = []
  if (options.temperature !== undefined) unsupported.push('temperature')
  if (options.maxTokens !== undefined) unsupported.push('maxTokens')
  if (options.stop !== undefined) unsupported.push('stop')
  if (options.reasoningEffort !== undefined) unsupported.push('reasoningEffort')
  if (unsupported.length === 0) return
  throw new LlmError(
    `Antigravity ACP provider 不支持这些请求项：${unsupported.join('、')}。ACP v1 未为它们定义会话通道，值由官方 agent 自身的会话配置决定`,
    AGY_UNSUPPORTED_OPTION,
  )
}

/** 取 messages 尾部连续的 tool 结果消息（按原顺序）。 */
function trailingToolResults(messages: readonly RequestMessage[]): RequestMessage[] {
  const tail: RequestMessage[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'tool') break
    tail.unshift(message)
  }
  return tail
}

/**
 * 续轮匹配：尾部 tool 结果与**仍在等待回喂**的 park 调用按顺序一一对应。
 *
 * 只统计尚未回喂的 park：同一个 ACP prompt 内可以有多批工具调用，早先批次
 * 交付后仍留在 `parkedCalls` 里作为回合账本；若把它们一并计入长度比较，
 * 第二批之后的续轮永远匹配不上，会被迫放弃回合、重建会话。
 */
function matchesParkedCalls(turn: PromptTurn, tail: readonly RequestMessage[], bridge: McpToolBridge): boolean {
  if (tail.length === 0) return false
  const parked = turn.parkedCalls.filter((call) => bridge.hasPending(call.callId))
  if (parked.length !== tail.length) return false
  return tail.every((message, index) => {
    const call = parked[index]
    return message.role === 'tool' && call !== undefined && call.callId === message.toolCallId
  })
}
