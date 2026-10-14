/**
 * 一个 ACP prompt 回合的状态机：session/update → DSH StreamChunk 映射、
 * 回合边界判定、工具 park 聚合与 finish 产出（原创实现）。
 *
 * 回合边界（本包的原创判定，ACP 规范未规定 DSH 侧的切分点）：
 * 1. `session/prompt` 应答回来（stopReason）；
 * 2. 桥上出现 park 的 MCP `tools/call`，且在 `parkSettleMs` 内没有新的
 *    park（用于把同一 agent 批次里并发发出的多个调用收进同一轮）；
 * 3. 调用方 abort；或回合内出现失败（权限被拒 / 非预期原生活动）。
 * 先到者触发 `finishRound`，幂等。
 *
 * 关键性质：**finish 之后队列不再追加任何 chunk**，因此 `nextChunk()` 返回
 * undefined 时消费者已经拿全了本轮的全部内容（含 usage 与最后的 finish）。
 */
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {
  ConfigOptionUpdate,
  ContentBlock,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  StopReason,
  Usage,
} from '@agentclientprotocol/sdk'
import type { AgentLink } from '../protocol/agent-link.js'
import type { BridgeParkedCall, BridgeToolResult, McpToolBridge } from '../bridge/mcp-bridge.js'

/** 本文件使用的原创错误码（AGY_* 体系，与 agent-link / mcp-bridge 同族）。 */
export const AGY_TURN_ERROR = {
  /** agent 请求本地能力被拒（无人值守策略）。 */
  PERMISSION_DENIED: 'AGY_PERMISSION_DENIED',
  /** agent 发起了 clientCapabilities 已关闭的原生能力请求（fs/terminal/…）。 */
  NATIVE_ACTIVITY_REFUSED: 'AGY_NATIVE_ACTIVITY_REFUSED',
  /** 调用方 abort 导致的回合终止。 */
  ABORTED: 'AGY_ABORTED',
  /** agent 以 refusal 结束本轮。 */
  REFUSED: 'AGY_AGENT_REFUSED',
  /** 本回合没有等待回喂的 park 调用，却收到了续轮回喂请求。 */
  NO_PENDING_TOOL_CALL: 'AGY_NO_PENDING_TOOL_CALL',
} as const

/** 未分类的意外状态（link 关闭、agent 异常取消等）在此码下归一。 */
export const AGY_TURN_UNEXPECTED = 'AGY_UNEXPECTED'

type FinishChunk = Extract<StreamChunk, { type: 'finish' }>

type OpenBlock = {
  index: number
  blockType: 'text' | 'reasoning'
  messageId: string | undefined
  parts: string[]
}

/** ACP prompt 的 content 形状（与 SDK `PromptRequest.prompt` 对齐）。 */
export type PromptContent = ContentBlock[]

export interface PromptTurnOptions {
  /** 已握手已认证的 ACP 链接。 */
  link: AgentLink
  /** 本回合使用的 MCP 工具桥。 */
  bridge: McpToolBridge
  /** session/prompt 的等待上限（毫秒）。 */
  promptTimeoutMs: number
  /** 并发 park 的聚合窗口（毫秒）。 */
  parkSettleMs: number
  /** config_option_update 的观察者（用于刷新模型目录）。 */
  onConfigOptions?(options: readonly SessionConfigOption[]): void
}

export class PromptTurn {
  /** ACP 会话 id。 */
  readonly sessionId: string
  readonly #link: AgentLink
  readonly #bridge: McpToolBridge
  readonly #promptTimeoutMs: number
  readonly #parkSettleMs: number
  readonly #queue: StreamChunk[] = []
  #waiters: Array<() => void> = []
  readonly #parked: BridgeParkedCall[] = []
  #settledWaiters: Array<() => void> = []
  #onConfigOptions: ((options: readonly SessionConfigOption[]) => void) | undefined
  #nextIndex = 0
  #open: OpenBlock | undefined
  #producerDone = false
  #roundEnded = false
  #promptSettled = false
  #failure: LlmFailure | undefined
  #aborted = false
  #truncated = false
  #parkTimer: ReturnType<typeof setTimeout> | undefined
  #abortCleanup: (() => void) | undefined

  constructor(sessionId: string, options: PromptTurnOptions) {
    this.sessionId = sessionId
    this.#link = options.link
    this.#bridge = options.bridge
    this.#promptTimeoutMs = options.promptTimeoutMs
    this.#parkSettleMs = options.parkSettleMs
    this.#onConfigOptions = options.onConfigOptions
  }

  /** 本回合的 ACP prompt 是否已有应答；应答后无法再「在同一 prompt 内续轮」。 */
  get promptSettled(): boolean {
    return this.#promptSettled
  }

  /** 本回合 park 的工具调用（按 park 顺序）。 */
  get parkedCalls(): readonly BridgeParkedCall[] {
    return this.#parked
  }

  /** 本回合是否停在「等待 DSH 回喂工具结果」的续轮状态。 */
  get awaitingToolResults(): boolean {
    return this.#roundEnded && this.#parked.some((call) => this.#bridge.hasPending(call.callId))
  }

  /** 把 session/update 交给当前回合（由 adapter 的稳定 handler 转发）。 */
  handleSessionUpdate(notification: SessionNotification): void {
    if (this.#roundEnded) return
    if (notification.sessionId !== this.sessionId) return
    this.#applyUpdate(notification.update)
  }

  /**
   * 权限询问一律拒绝（无人值守）：优先回绝选项，无可选项时回 cancelled。
   * 拒绝同时终止本回合——无人值守语境下不应授予 agent 任何本地能力。
   */
  handleRequestPermission(request: RequestPermissionRequest): RequestPermissionResponse {
    const rejection = request.options.find((option) => option.kind === 'reject_once')
      ?? request.options.find((option) => option.kind === 'reject_always')
    this.#fail({
      code: AGY_TURN_ERROR.PERMISSION_DENIED,
      message: `Antigravity ACP 请求的本地能力已被拒绝（${request.toolCall.toolCallId}）：本插件在无人值守模式下不授予 agent 任何 fs/terminal 权限`,
    })
    return rejection
      ? { outcome: { outcome: 'selected', optionId: rejection.optionId } }
      : { outcome: { outcome: 'cancelled' } }
  }

  /** clientCapabilities 已全部关闭，因此这里出现的任何 agent→client 请求都是非预期的。 */
  handleUnexpectedAgentRequest(method: string): void {
    this.#fail({
      code: AGY_TURN_ERROR.NATIVE_ACTIVITY_REFUSED,
      message: `Antigravity ACP 发起了未预期的原生请求 ${method}：本插件已关闭 fs/terminal 能力，工具一律经私有 MCP 桥暴露`,
    })
  }

  /**
   * 启动 session/prompt 并驱动回合收尾（不阻塞调用方）。
   * 调用时信号已 aborted 的请求根本不发出 prompt：无人应答的回合没有价值，
   * 也不该在 ACP 侧留下一次无人接收的 prompt。
   */
  startPrompt(content: PromptContent, signal?: AbortSignal): void {
    if (signal?.aborted) {
      this.#aborted = true
      this.#fail({ code: AGY_TURN_ERROR.ABORTED, message: `Antigravity ACP 回合在发起前即被调用方中止：${String(signal.reason ?? 'aborted')}` })
      return
    }
    const prompt = this.#link.prompt({ sessionId: this.sessionId, prompt: content }, { timeoutMs: this.#promptTimeoutMs })
    void this.#drive(prompt)
    if (signal) this.#attachAbort(signal)
  }

  /** 收到 abort 信号：取消 ACP 会话当前回合并以 aborted 结束。 */
  abort(reason: string): void {
    if (this.#roundEnded) return
    this.#aborted = true
    this.#fail({ code: AGY_TURN_ERROR.ABORTED, message: `Antigravity ACP 回合被调用方中止：${reason}` })
    void this.#link.cancel(this.sessionId).catch(() => undefined)
  }

  /** 桥 park 了新调用：进入当前回合。 */
  handleParked(call: BridgeParkedCall): void {
    if (this.#roundEnded) return
    this.#parked.push(call)
    this.#emitToolCallBlock(call)
    // 重置聚合窗口，让同一批次里随后到达的并发调用并入同一轮。
    if (this.#parkTimer) clearTimeout(this.#parkTimer)
    const timer = setTimeout(() => {
      this.#parkTimer = undefined
      this.finishRound()
    }, this.#parkSettleMs)
    timer.unref?.()
    this.#parkTimer = timer
  }

  /**
   * 续轮复位：上一轮以 finish(tool-calls) 封口后，生产者已停摆。续轮要继续
   * 在**同一个 ACP prompt** 内接收后续 session/update，因此重新打开队列与
   * 回合边界，并（若给了 signal）重新挂上 abort 监听。
   *
   * 上一轮已产出的 chunk（含 finish）不会重放——续轮只交付新内容。
   */
  resume(signal?: AbortSignal): void {
    this.#queue.length = 0
    this.#producerDone = false
    this.#roundEnded = false
    this.#failure = undefined
    this.#aborted = false
    this.#truncated = false
    if (signal) this.#attachAbort(signal)
  }

  /** 续轮回喂：把 DSH 的 tool result 交给桥 resolve 对应的 MCP 调用。 */
  async deliverToolResults(results: readonly BridgeToolResult[]): Promise<void> {
    for (const result of results) {
      if (!this.#bridge.hasPending(result.callId)) {
        throw new Error(`${AGY_TURN_ERROR.NO_PENDING_TOOL_CALL}: 本回合没有等待回喂的工具调用 ${result.callId}`)
      }
    }
    await this.#bridge.deliverResults(results)
  }

  /** 消费者侧：取下一个 chunk；undefined 表示本轮（含 finish）已取尽。 */
  async nextChunk(): Promise<StreamChunk | undefined> {
    for (;;) {
      const chunk = this.#queue.shift()
      if (chunk !== undefined) return chunk
      if (this.#producerDone) return undefined
      await new Promise<void>((resolve) => this.#waiters.push(resolve))
    }
  }

  /** 等待 ACP prompt 应答（测试与诊断使用）。 */
  async settled(): Promise<void> {
    if (this.#promptSettled) return
    await new Promise<void>((resolve) => this.#settledWaiters.push(resolve))
  }

  /** 释放定时器与 abort 监听（回合结束或回合被放弃时调用）。 */
  dispose(): void {
    if (this.#parkTimer) {
      clearTimeout(this.#parkTimer)
      this.#parkTimer = undefined
    }
    this.#abortCleanup?.()
    this.#abortCleanup = undefined
  }

  async #drive(prompt: Promise<PromptResponse>): Promise<void> {
    try {
      const response = await prompt
      this.#markPromptSettled()
      this.#finishWith(response)
    } catch (error) {
      this.#markPromptSettled()
      this.#fail({
        code: readErrorCode(error),
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  #markPromptSettled(): void {
    this.#promptSettled = true
    const waiters = this.#settledWaiters
    this.#settledWaiters = []
    for (const resolve of waiters) resolve()
  }

  #finishWith(response: PromptResponse): void {
    const reason = this.#mapStopReason(response.stopReason)
    if (reason) {
      this.#fail(reason)
      return
    }
    this.finishRound(mapUsage(response.usage))
  }

  #mapStopReason(stopReason: StopReason): LlmFailure | undefined {
    if (this.#failure) return this.#failure
    switch (stopReason) {
      case 'end_turn':
        return undefined
      case 'refusal':
        return { code: AGY_TURN_ERROR.REFUSED, message: 'Antigravity ACP agent 拒绝了本轮请求（stopReason=refusal）' }
      case 'cancelled':
        return { code: AGY_TURN_UNEXPECTED, message: 'Antigravity ACP agent 在未收到调用方 abort 的情况下取消了本轮（stopReason=cancelled）' }
      case 'max_tokens':
      case 'max_turn_requests':
        // 截断类 stop 在 StreamChunk 词表里有专门 kind，不算失败。
        this.#truncated = true
        return undefined
      default:
        return { code: AGY_TURN_UNEXPECTED, message: `Antigravity ACP 返回未知的 stopReason: ${String(stopReason)}` }
    }
  }

  #fail(failure: LlmFailure): void {
    this.#failure ??= failure
    this.finishRound()
  }

  /**
   * 结束本回合并向队列封口：先 usage 后 finish；finish 入队后生产者停止，
   * 因此消费者不会看到 finish 之后的任何 chunk。幂等。
   */
  finishRound(usage?: TokenUsage): void {
    if (this.#roundEnded) return
    this.#roundEnded = true
    this.closeOpenBlock()
    if (usage) this.#push({ type: 'usage', usage })
    this.#push({ type: 'finish', reason: this.#resolveFinish() })
    this.#producerDone = true
    this.#wake()
    this.dispose()
  }

  #resolveFinish(): FinishChunk['reason'] {
    if (this.#failure) {
      return this.#aborted
        ? { kind: 'aborted', failure: this.#failure }
        : { kind: 'error', failure: this.#failure }
    }
    // 只在**仍有未回喂的 park** 时才是 tool-calls：续轮把结果交付后，同一批
    // park 已经结算，本轮的结束原因回到 stop/max-tokens。
    if (this.#parked.some((call) => this.#bridge.hasPending(call.callId))) return { kind: 'tool-calls' }
    if (this.#truncated) return { kind: 'max-tokens' }
    return { kind: 'stop' }
  }

  #applyUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.#appendText('text', update.messageId ?? undefined, update.content)
        return
      case 'agent_thought_chunk':
        this.#appendText('reasoning', update.messageId ?? undefined, update.content)
        return
      case 'config_option_update': {
        const configUpdate: ConfigOptionUpdate = update
        this.#onConfigOptions?.(configUpdate.configOptions)
        return
      }
      default:
        // 其余 update（plan / tool_call / usage_update / mode / compaction …）
        // 是进度或遥测信息，DSH StreamChunk 词表无对应表达；内容只存在于上面
        // 两个 *_chunk 分支，因此这里丢弃的只有进度信息。
        return
    }
  }

  #appendText(blockType: 'text' | 'reasoning', messageId: string | undefined, content: unknown): void {
    const text = renderContentText(content)
    if (text === undefined) return
    if (this.#open && (this.#open.blockType !== blockType || this.#open.messageId !== messageId)) {
      this.closeOpenBlock()
    }
    if (!this.#open) {
      this.#open = { index: this.#nextIndex++, blockType, messageId, parts: [] }
      this.#push({ type: 'block-start', index: this.#open.index, blockType })
    }
    this.#open.parts.push(text)
    this.#push(blockType === 'text'
      ? { type: 'text-delta', index: this.#open.index, text }
      : { type: 'reasoning-delta', index: this.#open.index, text })
  }

  #emitToolCallBlock(call: BridgeParkedCall): void {
    this.closeOpenBlock()
    const index = this.#nextIndex++
    this.#push({ type: 'block-start', index, blockType: 'tool-call' })
    this.#push({
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: ToolCallId(call.callId), name: call.name, arguments: call.arguments },
    })
  }

  /** 关闭当前打开中的 text/reasoning block（幂等）。 */
  closeOpenBlock(): void {
    const open = this.#open
    if (!open) return
    this.#open = undefined
    this.#push({ type: 'block-end', index: open.index, block: { type: open.blockType, text: open.parts.join('') } })
  }

  #push(chunk: StreamChunk): void {
    if (this.#producerDone) return
    this.#queue.push(chunk)
    this.#wake()
  }

  #wake(): void {
    // 必须整体换新数组：若只清空长度，捕获的局部变量与字段是同一个对象，
    // 后面的 for…of 会遍历到空数组，等待者永远不会被唤醒。
    const waiters = this.#waiters
    this.#waiters = []
    for (const resolve of waiters) resolve()
  }

  #attachAbort(signal: AbortSignal): void {
    if (signal.aborted) {
      this.abort(String(signal.reason ?? 'aborted'))
      return
    }
    const onAbort = (): void => this.abort(String(signal.reason ?? 'aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    this.#abortCleanup = () => signal.removeEventListener('abort', onAbort)
  }
}

function readErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return AGY_TURN_UNEXPECTED
}

/**
 * 把一个 ACP ContentBlock 渲染为纯文本。
 * 本 provider 只声明 text 输出模态，因此非文本内容（图片/资源链接/音频）
 * 按其 JSON 原样作为文本传递，保留信息而不是静默丢弃。
 */
function renderContentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (content && typeof content === 'object' && 'type' in content) {
    const block = content as { type: string; text?: unknown }
    if (block.type === 'text' && typeof block.text === 'string') return block.text
    return JSON.stringify(content)
  }
  return undefined
}

/**
 * ACP Usage → DSH TokenUsage。
 *
 * ACP 的 usage 是**会话累计**值；由于本 adapter 把整段 DSH 历史重放进单个
 * ACP prompt 回合（一回合一次 session/prompt），该累计值恰好等于本回合用量。
 */
export function mapUsage(usage: Usage | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined
  let mapped: TokenUsage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
  if (usage.totalTokens !== undefined) mapped = { ...mapped, totalTokens: usage.totalTokens }
  if (usage.cachedReadTokens != null) mapped = { ...mapped, cacheReadTokens: usage.cachedReadTokens }
  if (usage.cachedWriteTokens != null) mapped = { ...mapped, cacheWriteTokens: usage.cachedWriteTokens }
  if (usage.thoughtTokens != null) mapped = { ...mapped, reasoningTokens: usage.thoughtTokens }
  return mapped
}
