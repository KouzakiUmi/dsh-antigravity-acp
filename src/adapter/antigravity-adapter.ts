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
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  RequestMessage,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AnyRequest, McpServer as AcpMcpServer, SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk'
import type { AgentLink, AgentLinkHandlers } from '../protocol/agent-link.js'
import { McpToolBridge } from '../bridge/mcp-bridge.js'
import type { BridgeToolResult } from '../bridge/mcp-bridge.js'
import {
  AGY_REASONING_EFFORTS,
  AGY_REASONING_EFFORT_NAMES,
  DEFAULT_AGY_REASONING_EFFORT,
  foldAgyModelFamilies,
  modelFamilyId,
  routeTieredModelId,
  tierForModelId,
} from '../runtime/agy-cli.js'
import type { AgyReasoningEffort } from '../runtime/agy-cli.js'
import { findModelSelector, toModelCatalog } from './model-catalog.js'
import type { ModelSelector } from './model-catalog.js'
import { buildPromptContent, renderToolResultText } from './prompt-transcript.js'
import { PromptTurn } from './prompt-turn.js'

/** DSH 侧 provider 标识符；与 cordis.patch.yml 的 id 及文档保持一致。 */
export const AGY_PROVIDER_ID = 'antigravity-acp'

/**
 * GUI 冷启动占位模型。DSH 模型选择器会丢掉 `options.length === 0` 的 provider
 * 分组，因此未观测 ACP 会话前必须至少广告一条目录，否则设置页看不到本路由。
 * 选中该 id 时不调用 session/set_config_option，沿用官方会话默认模型。
 */
export const AGY_PLACEHOLDER_MODEL_ID = 'server-default'

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
  /** 占位模型 server-default 映射到的官方模型 id；空则沿用会话默认。 */
  preferredModel?: string
  /**
   * 冷启动目录读取（磁盘缓存）。返回 undefined 表示没有可用缓存；**不得**抛错。
   * 元数据方法不得触网，因此这里只能读本地文件。
   */
  loadCachedCatalog?: () => Promise<CachedModel[] | undefined>
  /** 观测到真实目录后的落盘回调；失败由实现方自行吞掉。 */
  saveCatalog?: (models: readonly CachedModel[]) => Promise<void> | void
  /**
   * 官方 CLI 模型清单（`agy models` 的只读取数，2026-10-16 授权仅限只读取数
   * 用途）。用于补齐会话观测之外的官方型号；失败由 adapter 吞掉。
   */
  loadCliCatalog?: () => Promise<readonly { id: string; name: string }[]>
  /**
   * 宿主日志（index.ts 接 `ctx.logger`）。仅用于**自诊断**：模型路由决策与
   * `session/set_config_option` 失败原因。缺省时不产任何日志。
   */
  log?: AdapterLog
}

/** 适配器可用的最小日志面（与 cordis 的 `ctx.logger` 结构兼容）。 */
export interface AdapterLog {
  info(message: string): void
  warn(message: string, error?: unknown): void
}

/** 目录缓存条目（只含模型元数据，不含任何凭据）。 */
export interface CachedModel {
  id: string
  name: string
  description?: string
  /** 实测上下文容量（usage_update.size）；官方目录不报告，故可缺省。 */
  contextWindow?: number
}

/*
 * 关于失败重试：**刻意不 override `providerRetryPolicy`**。
 *
 * 宿主若消费该策略（可选的 dsh-llm-retry 插件）在 failed-step 上会**整步重放**
 * `stream()`。而本 adapter 的每一类失败都不可安全重放：
 * - 握手失败 / 链路断开 → 重放等于重新 spawn 一条官方进程；
 * - 认证超时（`AGY_AUTH_TIMEOUT`）→ 重放等于重新弹一次 Google 登录；
 * - `session/prompt` 超时（`AGY_REQUEST_TIMEOUT`）→ 官方 agent 可能已经产出内容或
 *   已发起工具调用，重放会新建会话并重放全部历史，造成重复内容与重复工具调用。
 *
 * 默认词表（`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`）
 * 本 adapter 一个都不会抛：宿主在 `providerRetryPolicy() ?? resolveRetryPolicy(undefined)`
 * 处装上的默认政策因此对本 provider 不生效。这里的前提是「我们抛的码一律带
 * `AGY_` 前缀」，该前提由 `tests/acp-adapter.test.ts` 的「失败码与宿主默认重试
 * 词表无交集」用例锁住——若将来 dsh-llm 把某个 AGY_ 码加进默认词表，测试会红。
 * 真正需要重试语义时，应针对单类失败单独引入可证明幂等的路径，而不是整步重放。
 */

const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_PARK_SETTLE_MS = 50

export class AntigravityAcpAdapter extends LlmAdapter {
  readonly #getLink: AntigravityAcpAdapterOptions['getLink']
  readonly #registerBridgeTeardown: AntigravityAcpAdapterOptions['registerBridgeTeardown']
  readonly #promptTimeoutMs: number
  readonly #parkSettleMs: number
  readonly #cwd: string
  readonly #preferredModel: string
  readonly #loadCachedCatalog?: AntigravityAcpAdapterOptions['loadCachedCatalog']
  readonly #saveCatalog?: AntigravityAcpAdapterOptions['saveCatalog']
  readonly #loadCliCatalog?: AntigravityAcpAdapterOptions['loadCliCatalog']
  readonly #log?: AdapterLog
  /** 官方 CLI 清单的进程内一次性结果。 */
  #cliCatalog?: Promise<readonly { id: string; name: string }[]>
  /** 家族 → 支持的思考强度档位（由 listModels 折叠得到）。 */
  #familyTiers = new Map<string, ReadonlySet<AgyReasoningEffort>>()
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
  /** 目录缓存的惰性读取结果（只读一次）。 */
  #cacheLoad?: Promise<LlmModelInfo[]>
  /**
   * 各 DSH 路由键（`GenerateOptions.model`）实测到的上下文容量，来自官方
   * `usage_update.size`（ACP 对 `size` 的定义即 total context window size）。
   * 有了它压缩引擎才能量化上下文，而不是每步报「no context capacity」。
   */
  #contextWindows = new Map<string, number>()
  /** 当前 ACP 会话对应的 DSH 路由键，用于把 usage_update 归属到具体模型。 */
  #routeModelId: string | undefined

  constructor(options: AntigravityAcpAdapterOptions) {
    super()
    this.#getLink = options.getLink
    this.#registerBridgeTeardown = options.registerBridgeTeardown
    this.#promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
    this.#parkSettleMs = options.parkSettleMs ?? DEFAULT_PARK_SETTLE_MS
    this.#cwd = options.cwd ?? process.cwd()
    this.#preferredModel = options.preferredModel?.trim() ?? ''
    this.#loadCachedCatalog = options.loadCachedCatalog
    this.#saveCatalog = options.saveCatalog
    this.#loadCliCatalog = options.loadCliCatalog
    this.#log = options.log
    this.#bridge = new McpToolBridge()
    this.#registerBridgeTeardown(async () => {
      this.#releaseTurnSubscription()
      await this.#bridge.close()
    })
    this.#handlers = {
      onSessionUpdate: (notification) => {
        this.#observeUsageUpdate(notification)
        return this.#turn?.handleSessionUpdate(notification)
      },
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
   * 因此本实现在无真实目录时广告一条占位模型（见 AGY_PLACEHOLDER_MODEL_ID），
   * 让 GUI 能选出本 provider；真实目录会在第一次 `stream` 建立会话后由
   * `observeSessionConfigOptions` 写入缓存。
   */
  /**
   * 本 provider 的模型目录：占位项恒在首位，其余是**家族**条目。
   *
   * 家族折叠（2026-10-16 用户指示）：官方把思考强度编码进模型 id
   * （`claude-opus-5-5-{low,medium,high}`），但模型选择只出家族一行，强度由
   * 思考强度菜单路由（见 #applyModelSelection）。会话观测目录与官方 CLI 清单
   * 一并折叠，同 id 去重；被排除的家族（gpt-oss-120b 临近下架）不出现。
   */
  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const placeholder: LlmModelInfo = {
      provider: _provider,
      id: AGY_PLACEHOLDER_MODEL_ID,
      name: 'Antigravity 默认（首次对话登录）',
      description: '使用官方 ACP 会话的默认模型；第一次发消息时会下载/登录',
      inputModalities: ['text'],
    }
    const folded = await this.#foldCatalog(_provider)
    return [
      placeholder,
      ...folded.models.map((model) => ({
        provider: _provider,
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        inputModalities: ['text'] as const,
      })),
    ]
  }

  /**
   * 折叠家族档位表：会话观测目录（或磁盘缓存）+ 官方 CLI 清单。
   * listModels 与模型路由共用；占位 id 不进家族表。
   */
  async #foldCatalog(provider: string): Promise<{
    models: Array<{ id: string; name: string; description?: string }>
    tiers: Map<string, ReadonlySet<AgyReasoningEffort>>
  }> {
    // 未观测到真实目录时用磁盘缓存兜住选择器空窗。
    const source = this.#catalog.length > 0
      ? this.#catalog
      : await this.#cachedModels(provider)
    const folded = foldAgyModelFamilies([
      ...source
        .filter((model) => model.id !== AGY_PLACEHOLDER_MODEL_ID)
        .map((model) => ({
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
        })),
      ...await this.#cliRawRows(),
    ])
    this.#familyTiers = folded.tiers
    return folded
  }

  /** 官方 CLI 模型清单的原始行（进程内只取一次；失败返回空，不影响目录主体）。 */
  async #cliRawRows(): Promise<readonly { id: string; name: string }[]> {
    const load = this.#loadCliCatalog
    if (!load) return []
    this.#cliCatalog ??= (async () => {
      try {
        return await load()
      } catch {
        return []
      }
    })()
    return this.#cliCatalog
  }

  /** 读一次目录缓存（结果记忆在实例上，避免每次列目录都碰文件系统）。 */
  async #cachedModels(provider: string): Promise<LlmModelInfo[]> {
    this.#cacheLoad ??= (async () => {
      if (!this.#loadCachedCatalog) return []
      try {
        const rows = await this.#loadCachedCatalog()
        if (!rows || rows.length === 0) return []
        return rows.map((row) => {
          // 缓存里若带实测上下文容量，重启后压缩引擎无需等下一次 usage_update。
          if (typeof row.contextWindow === 'number' && Number.isFinite(row.contextWindow) && row.contextWindow > 0) {
            this.#contextWindows.set(row.id, row.contextWindow)
          }
          const entry: LlmModelInfo = { provider, id: row.id, name: row.name, inputModalities: ['text'] }
          return row.description === undefined ? entry : { ...entry, description: row.description }
        })
      } catch {
        // 缓存读不出来不是错误，退回占位即可。
        return []
      }
    })()
    return this.#cacheLoad
  }

  /**
   * 本 provider **不声明**任何可重试失败码：宿主若整步重放 `stream()`，握手失败会
   * 重复 spawn、认证超时会重复弹登录、prompt 超时会重放全部历史与工具调用。详见
   * 文件里「关于失败重试」的说明。
   *
   * 注意返回 `undefined` 会让宿主装上自己的默认政策；它对本 provider 不生效的
   * 前提（我们只抛 `AGY_` 前缀码）由测试锁住，不是靠这里的注释维持。
   */
  override providerRetryPolicy(_provider: string) {
    return undefined
  }

  /**
   * 精确模型解析。按 dsh-llm 的目录语义，目录成员资格是**建议性**的
   * （catalog membership remains advisory），因此这里不因未登记的 id 报错；
   * 真正的能力拒绝发生在 ACP 会话侧（模型不存在时 agent 自行报错）。
   */
  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const known = this.#catalog.find((entry) => entry.id === model)
    // 上下文容量只在**实测**过（usage_update.size）或缓存过时才声明；官方目录
    // 不报告容量，绝不填猜测值。缺省时不带 context，压缩引擎按未知处理。
    const contextWindow = this.#contextWindows.get(model)
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      inputModalities: ['text'],
      ...(known?.description === undefined ? {} : { description: known.description }),
      ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
      // 思考强度菜单：官方把强度编码进模型 id 后缀，本 provider 只出家族条目，
      // 由菜单选择路由到对应档位（2026-10-16 用户指示）。
      reasoning: this.#reasoningInfo(model),
    }
  }

  /** 该路由可选的思考强度（low/medium/high，弱→强）；缺省档位为 medium。 */
  #reasoningInfo(model: string): LlmModelReasoningInfo {
    const tiers = this.#familyTiers.get(modelFamilyId(model))
    // 已知该 id 没有档位变体（目录里的普通 id）：强度菜单不适用，不显示。
    if (tiers !== undefined && tiers.size === 0) return { efforts: [] }
    const efforts = AGY_REASONING_EFFORTS
      .filter((effort) => tiers === undefined || tiers.has(effort))
      .map((effort) => ({
        id: ReasoningEffortId(effort),
        name: AGY_REASONING_EFFORT_NAMES[effort],
      }))
    return { efforts, defaultEffort: ReasoningEffortId(DEFAULT_AGY_REASONING_EFFORT) }
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
    // usage_update 的上下文容量归属到本次请求的 DSH 路由键。
    this.#routeModelId = options.model
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
    await this.#applyModelSelection(link, session.sessionId, options.model, options.reasoningEffort)

    const turn = new PromptTurn(session.sessionId, {
      link,
      bridge: this.#bridge,
      promptTimeoutMs: this.#promptTimeoutMs,
      parkSettleMs: this.#parkSettleMs,
      onConfigOptions: (observed) => this.observeSessionConfigOptions(observed),
      // 模型索要原生 fs/terminal 时先拒绝、继续回合（只有反复索要才终止）；
      // 落一条日志，便于判断「选了某个型号没反应」是不是这条路径造成的。
      onNativeRefusal: (info) =>
        this.#log?.warn(
          `antigravity-acp: 已拒绝模型的原生能力索要（${info.kind} ${info.detail}，本回合第 ${info.count} 次），` +
            '请它改用桥过去的 DSH 工具',
        ),
    })
    this.#turn = turn
    this.#subscribeTurn(turn)
    // 回合生命周期打点：选具体型号后「没有反应」这类问题，只靠这条能分清是
    // 「prompt 没送出去」「送出去了但没有块回来」还是「块回来了但没被消费」。
    this.#log?.info(
      `antigravity-acp: 回合开始 model=${options.model} session=${session.sessionId} tools=${tools.length}` +
        `${options.reasoningEffort === undefined ? '' : ` effort=${String(options.reasoningEffort)}`}`,
    )
    turn.startPrompt(buildPromptContent(options.system, options.messages), options.signal)
    try {
      let chunks = 0
      for await (const chunk of drainTurn(turn)) {
        if (chunks === 0) this.#log?.info(`antigravity-acp: 回合首块到达（type=${chunk.type}）`)
        chunks += 1
        yield chunk
      }
      this.#log?.info(`antigravity-acp: 回合结束 model=${options.model} 块数=${chunks}`)
    } catch (error) {
      this.#log?.warn(`antigravity-acp: 回合失败 model=${options.model}`, error)
      throw error
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
   * 从 `usage_update` 观察上下文容量：ACP 对 `size` 的定义是
   * 「Total context window size in tokens」，正好填 `LlmResolvedModelInfo.context`。
   * 归属到当前回合的 DSH 路由键（`#routeModelId`）；只认正的有限数。
   */
  #observeUsageUpdate(notification: SessionNotification): void {
    const update = notification.update
    if (update.sessionUpdate !== 'usage_update') return
    const size = update.size
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return
    const model = this.#routeModelId
    if (!model) return
    if (this.#contextWindows.get(model) === size) return
    this.#contextWindows.set(model, size)
    // 容量随目录一起落盘，重启后压缩引擎不必等下一次 usage_update。
    this.#persistCatalog()
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
    // 观测到真实目录后缓存不再参与 listModels，避免配置变更后仍读到旧磁盘目录。
    this.#cacheLoad = undefined
    // 真实目录只在会话建立后才能观测到；落盘后重启不必退化成占位模型。
    // 写入失败与并发写冲突都无所谓：缓存是优化，不是功能。
    if (selector) this.#persistCatalog()
  }

  /** 把当前目录（含实测上下文容量）落盘；写失败不影响功能。 */
  #persistCatalog(): void {
    if (!this.#saveCatalog || this.#catalog.length === 0) return
    const payload = this.#catalog.map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(this.#contextWindows.get(model.id) === undefined
        ? {}
        : { contextWindow: this.#contextWindows.get(model.id) }),
    }))
    void Promise.resolve(this.#saveCatalog(payload)).catch(() => undefined)
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
   *
   * **家族 + 思考强度路由**（2026-10-16 用户指示）：模型选择只出家族
   * （`claude-opus-5-5`），思考强度菜单（low/medium/high）决定路由到哪个
   * 官方档位模型（`claude-opus-5-5-high`）。未选强度且配置里显式钉了档位时
   * 尊重钉住的档位；否则走默认档位（medium）。
   */
  async #applyModelSelection(
    link: AgentLink,
    sessionId: string,
    model: string,
    effort?: { toString(): string },
  ): Promise<void> {
    const base = model === AGY_PLACEHOLDER_MODEL_ID ? this.#preferredModel : model
    if (!base) return
    // 档位表可能尚未建立（API 直调时选择器还没列过目录）：先折叠一次再路由。
    await this.#foldCatalog(AGY_PROVIDER_ID)
    const family = modelFamilyId(base)
    const pinnedTier = tierForModelId(base)
    const effortTier = normalizeEffort(effort)
    const tiers = this.#familyTiers.get(family)
    const requested = effortTier !== undefined
      ? routeTieredModelId(family, effortTier, tiers)
      : pinnedTier !== undefined
        ? base
        : tiers !== undefined && tiers.size > 0
          ? routeTieredModelId(family, DEFAULT_AGY_REASONING_EFFORT, tiers)
          : family
    const selector = this.#modelSelector
    if (!selector) {
      throw new LlmError(
        'Antigravity ACP 会话未声明任何 model 类配置选项（select + category/name 匹配 model），无法为该 provider 选择模型',
        AGY_ADAPTER_ERROR.NO_MODEL_SELECTOR,
      )
    }
    if (selector.currentValue === requested) return
    // 自诊断：把路由结果落进宿主日志（模型选择出问题时，这是唯一能看到「DSH
    // 给的 id → 我们发出去的 configId/value」的地方）。
    this.#log?.info(
      `antigravity-acp: 模型路由 dsh=${model} → configId=${selector.configId} value=${requested}` +
        `（family=${family}${effortTier ? ` effort=${effortTier}` : ''}${pinnedTier ? ' 档位已钉住' : ''}）`,
    )
    // 目录成员资格按 dsh-llm 语义是建议性的：未登记的 id 仍然照发，由 ACP
    // agent 自己判定是否接受，而不是在这里静默改写成别的模型。
    let response: { configOptions?: readonly SessionConfigOption[] }
    try {
      response = await link.setConfigOption({ sessionId, configId: selector.configId, value: requested })
    } catch (error) {
      this.#log?.warn(
        `antigravity-acp: session/set_config_option 失败（configId=${selector.configId} value=${requested}）`,
        error,
      )
      throw error
    }
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

/** 把 DSH 传来的思考强度归一到官方档位；无法识别时返回 undefined（走默认档位）。 */
function normalizeEffort(effort?: { toString(): string }): AgyReasoningEffort | undefined {
  const raw = effort === undefined ? undefined : effort.toString().toLowerCase()
  return AGY_REASONING_EFFORTS.find((candidate) => candidate === raw)
}

/**
 * 不支持项检查。temperature / stop 没有 ACP 对应通道，显式传入即拒绝。
 *
 * `reasoningEffort` **不是**不支持项：它现在是家族 → 档位模型的路由键
 * （2026-10-16 用户指示「菜单选择思考强度自动路由到对应模型」），见
 * `#applyModelSelection`。`maxTokens` 同样静默忽略（宿主会话标题等流程固定
 * 携带它，硬拒绝会让这些功能永久失败）。
 */
function assertSupportedOptions(options: GenerateOptions): void {
  const unsupported: string[] = []
  if (options.temperature !== undefined) unsupported.push('temperature')
  if (options.stop !== undefined) unsupported.push('stop')
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
