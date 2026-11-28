/**
 * 端点无关的 Gemini 流式块组装与 finish/错误映射。
 *
 * 从代理 adapter 抽出的纯逻辑：上游 SSE 事件经 `parseProxyProviderEvent`（payload.ts）
 * 解析成 part 后，这里把 part 组装成 DSH 的 text / reasoning / tool-call 块并产出
 * StreamChunk。代理线（antigravity-proxy）与 AI Studio 线（aistudio）共用同一套组装与
 * 映射规则，差异只在措辞与生成 ID 前缀——经 {@link GeminiStreamLabels} 参数化，不复制逻辑。
 *
 * 本模块不依赖 agy 线身份、OAuth 换发或代理传输：那些是各 adapter 自己的编排职责。
 */
import { randomUUID } from 'node:crypto'
import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { FinishReason, ReplayEnvelope, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { llmError } from '../runtime/llm-error.js'
import { parseProxyProviderEvent } from './payload.js'
import type { ProxyProviderEvent, ProxyProviderPart } from './payload.js'
import { iterateProxySse } from './transport.js'
import type { BoundedReadOptions } from './transport.js'

/** 一条路由的措辞与生成 ID 前缀：代理线用「代理模式」/`proxy`，AI Studio 用「AI Studio」/`aistudio`。 */
export interface GeminiStreamLabels {
  readonly label: string
  readonly idPrefix: string
}

/** 流式组装中的一个开放块（text / reasoning / tool-call）。 */
export interface BlockState {
  readonly index: number
  readonly kind: 'text' | 'reasoning' | 'tool-call'
  readonly id: ReturnType<typeof ToolCallId>
  /** Upstream functionCall.id, distinct from a locally generated fallback ID. */
  readonly wireCallId?: string
  name?: string
  text: string
  signature?: string
  argumentsComplete?: boolean
}

/** 绑定了一条路由措辞与前缀的块组装器；调用点与抽取前逐字一致。 */
export interface GeminiBlockAssembler {
  beginBlock(states: BlockState[], part: ProxyProviderPart): BlockState
  sameBlock(state: BlockState, part: ProxyProviderPart): boolean
  assembleFunctionName(current: string | undefined, fragment: string): string
  endBlock(state: BlockState): StreamChunk
  finishChunk(kind: FinishReason['kind'], code: string, status?: number, replayState?: ReplayEnvelope, detail?: string): StreamChunk
  mapFinishReason(value: string | undefined): FinishReason['kind']
  safeProviderErrorCode(code: string | undefined, status?: number): string
  isAuthenticationCode(code: string | undefined): boolean
}

export function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** 上游 finishReason → DSH FinishReason 种类（端点无关）。 */
export function mapGeminiFinishReason(value: string | undefined): FinishReason['kind'] {
  const normalized = value?.toUpperCase()
  if (normalized === 'MAX_TOKENS' || normalized === 'LENGTH') return 'max-tokens'
  if (normalized === 'SAFETY' || normalized === 'BLOCKLIST' || normalized === 'ERROR') return 'error'
  if (normalized === 'TOOL_CALLS' || normalized === 'FUNCTION_CALL') return 'tool-calls'
  if (normalized !== undefined && normalized !== 'STOP') return 'error'
  return 'stop'
}

/** 上游错误 code/status → 安全的 DSH 错误码（端点无关）。 */
export function safeGeminiErrorCode(code: string | undefined, status?: number): string {
  if (status === 429) return 'RATE_LIMIT'
  if (status === 401) return 'AUTH'
  if (status === 403) return 'FORBIDDEN'
  const normalized = code?.toUpperCase()
  if (normalized === undefined) return 'UPSTREAM'
  if (normalized.includes('RATE') || normalized === 'RESOURCE_EXHAUSTED') return 'RATE_LIMIT'
  if (normalized.includes('QUOTA')) return 'RATE_LIMIT'
  if (normalized === 'UNAUTHENTICATED' || normalized === 'INVALID_GRANT') return 'AUTH'
  if (normalized === 'PERMISSION_DENIED' || normalized === 'FORBIDDEN') return 'FORBIDDEN'
  if (normalized.includes('INVALID') || normalized.includes('BAD_REQUEST')) return 'PROTOCOL_DRIFT'
  return 'UPSTREAM'
}

/** 上游错误 code 是否代表鉴权失败（端点无关）。 */
export function isGeminiAuthenticationCode(code: string | undefined): boolean {
  const normalized = code?.toUpperCase()
  return normalized === 'UNAUTHENTICATED' || normalized === 'AUTHENTICATION' || normalized === 'INVALID_GRANT' || normalized === 'UNAUTHENTICATED_REQUEST'
}

/** 按一条路由的措辞与前缀创建块组装器。 */
export function createGeminiBlockAssembler(labels: GeminiStreamLabels): GeminiBlockAssembler {
  const { label, idPrefix } = labels

  function beginBlock(states: BlockState[], part: ProxyProviderPart): BlockState {
    const index = states.length
    const block: BlockState = part.kind === 'tool-call'
      ? {
          index,
          kind: 'tool-call',
          id: ToolCallId(part.id ?? `${idPrefix}-call-${randomUUID()}`),
          ...(part.id === undefined ? {} : { wireCallId: part.id }),
          ...(part.name === undefined ? {} : { name: part.name }),
          text: '',
          ...(part.signature === undefined ? {} : { signature: part.signature }),
        }
      : {
          index,
          kind: part.kind,
          id: ToolCallId(`${idPrefix}-block-${String(index)}`),
          text: '',
          ...(part.signature === undefined ? {} : { signature: part.signature }),
        }
    states.push(block)
    return block
  }

  function sameBlock(state: BlockState, part: ProxyProviderPart): boolean {
    if (state.kind !== part.kind) return false
    if (part.kind !== 'tool-call') return true
    if (part.id !== undefined) return part.id === String(state.id)
    // Gemini 的并行调用可省略 id，每个完整参数对象都对应独立的调用。
    return state.argumentsComplete !== true
  }

  function assembleFunctionName(current: string | undefined, fragment: string): string {
    if (fragment.length === 0 || fragment.length > 256 || containsControl(fragment)) throw llmError(`${label}工具调用名无效`, 'PROTOCOL_DRIFT')
    if (current === undefined || current.length === 0) return fragment
    if (fragment === current) return current
    if (fragment.startsWith(current)) return fragment
    const combined = `${current}${fragment}`
    if (combined.length > 256) throw llmError(`${label}工具调用名超出上限`, 'PROTOCOL_DRIFT')
    return combined
  }

  function endBlock(state: BlockState): StreamChunk {
    if (state.kind === 'text') return { type: 'block-end', index: state.index, block: { type: 'text', text: state.text } }
    if (state.kind === 'reasoning') return { type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.text } }
    try {
      const parsed: unknown = JSON.parse(state.text || '{}')
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    } catch {
      throw llmError(`${label}工具调用参数不是完整 JSON`, 'PROTOCOL_DRIFT')
    }
    if (state.name === undefined || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/u.test(state.name)) {
      throw llmError(`${label}工具调用名缺失或无效`, 'PROTOCOL_DRIFT')
    }
    return { type: 'block-end', index: state.index, block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.text || '{}' } }
  }

  function finishChunk(kind: FinishReason['kind'], code: string, status?: number, replayState?: ReplayEnvelope, detail?: string): StreamChunk {
    const reason: FinishReason = kind === 'aborted'
      ? { kind: 'aborted', failure: { code, message: `${label}请求已取消` } }
      : kind === 'error'
        ? { kind: 'error', failure: { code, message: detail === undefined ? `${label}上游请求失败` : `${label}上游请求失败：${detail}`, ...(status === undefined ? {} : { status }) } }
        : kind === 'max-tokens'
          ? { kind: 'max-tokens' }
          : kind === 'tool-calls'
            ? { kind: 'tool-calls' }
            : { kind: 'stop' }
    return { type: 'finish', reason, ...(replayState === undefined ? {} : { replayState }) }
  }

  return {
    beginBlock,
    sameBlock,
    assembleFunctionName,
    endBlock,
    finishChunk,
    mapFinishReason: mapGeminiFinishReason,
    safeProviderErrorCode: safeGeminiErrorCode,
    isAuthenticationCode: isGeminiAuthenticationCode,
  }
}

/** 生成器交回各 adapter 处理专属 tail（错误分类 / replay / finish）所需的事实。 */
export interface GeminiStreamResult {
  finish?: string
  usage?: TokenUsage
  eventError?: ProxyProviderEvent['error']
  states: BlockState[]
  sawDone: boolean
}

export interface GeminiStreamOptions {
  signal?: AbortSignal
  /** SSE 有界读取预算（各路由自定 idle/total/maxBytes/maxFrameBytes）。 */
  sse: BoundedReadOptions
  blocks: GeminiBlockAssembler
  /** 共享的「已出块」标志：中途抛错时调用方据此决定是否还能换发重试。 */
  hasEmitted: { value: boolean }
  /** 中途截断错误措辞前缀（代理模式 / AI Studio）。 */
  label: string
  /** Receive the bounded data frame before normalization, including partial usage and errors. */
  onEventData?: (data: string) => void
  /**
   * 流内 401/403/鉴权错误事件的钩子：代理线在此抛 ProxyTransportError 触发换发；
   * AI Studio 不传，错误事件落回 eventError 由 tail 映射成 AUTH/FORBIDDEN。
   */
  onAuthError?: (error: NonNullable<ProxyProviderEvent['error']>) => void
}

/**
 * 端点无关的 Gemini 流式生成器：SSE 迭代 → parseProxyProviderEvent → 块组装 →
 * 产出 block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage，
 * 交回 {@link GeminiStreamResult}。finish 块与错误分类由各 adapter 的 tail 负责
 * （代理线有 suspended/replay/换发，AI Studio 是标准 REST），不在此处耦合。
 */
export async function* assembleGeminiStream(response: Response, options: GeminiStreamOptions): AsyncGenerator<StreamChunk, GeminiStreamResult> {
  const { blocks, hasEmitted, label } = options
  const states: BlockState[] = []
  let current: BlockState | undefined
  let usage: TokenUsage | undefined
  let finish: string | undefined
  let sawDone = false
  let eventError: ProxyProviderEvent['error']
  for await (const sse of iterateProxySse(response, options.sse)) {
    if (sse.data.trim() === '[DONE]') { sawDone = true; break }
    options.onEventData?.(sse.data)
    let event: ProxyProviderEvent
    try {
      event = parseProxyProviderEvent(sse.data, label)
    } catch (error) {
      if (hasEmitted.value) throw new LlmError(`${label}响应流在中途截断`, 'TRANSPORT', { cause: error })
      throw error
    }
    if (event.error !== undefined) {
      eventError = event.error
      if (options.onAuthError !== undefined
        && (event.error.status === 401 || blocks.isAuthenticationCode(event.error.code) || event.error.status === 403 || event.error.code?.toUpperCase() === 'PERMISSION_DENIED')) {
        options.onAuthError(event.error)
      }
      break
    }
    if (event.usage !== undefined) usage = event.usage
    if (event.finish !== undefined) finish = event.finish
    for (const part of event.parts) {
      if (part.signatureOnly === true && current !== undefined) { current.signature = part.signature; continue }
      if (current === undefined || !blocks.sameBlock(current, part)) {
        if (current !== undefined) yield blocks.endBlock(current)
        current = blocks.beginBlock(states, part)
        yield { type: 'block-start', index: current.index, blockType: current.kind }
      }
      if (part.kind === 'tool-call') {
        if (part.name !== undefined) current.name = blocks.assembleFunctionName(current.name, part.name)
        current.text += part.arguments ?? ''
        current.argumentsComplete = part.argumentsComplete
        hasEmitted.value ||= (part.arguments?.length ?? 0) > 0 || part.name !== undefined
        yield {
          type: 'tool-call-delta',
          index: current.index,
          id: current.id,
          ...(part.name === undefined ? {} : { name: part.name }),
          argumentsDelta: part.arguments ?? '',
        }
      } else {
        current.text += part.text ?? ''
        hasEmitted.value ||= (part.text?.length ?? 0) > 0
        if ((part.text?.length ?? 0) > 0) yield { type: part.kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: current.index, text: part.text ?? '' }
      }
      if (part.signature !== undefined) current.signature = part.signature
    }
  }
  if (current !== undefined) {
    try {
      yield blocks.endBlock(current)
    } catch (error) {
      // 上游已经给出错误事件（429 / SAFETY / 上下文超限）或本轮被取消时，半截
      // 工具调用参数不该把真实原因盖成 PROTOCOL_DRIFT。
      if (eventError === undefined && !options.signal?.aborted) throw error
    }
  }
  if (usage !== undefined) yield { type: 'usage', usage }
  return { finish, usage, eventError, states, sawDone }
}
