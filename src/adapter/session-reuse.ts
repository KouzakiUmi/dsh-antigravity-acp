/**
 * ACP 会话复用判定：同一 DSH 对话的下一轮能否只发送新增消息。
 *
 * 依据（2026-10-23 真机验证）：官方 agy_acp_server 在同一 ACP session 内连续
 * `session/prompt` 会保留上一次的上下文（暗号复述成功），并且声明了
 * `loadSession`。因此没有必要每轮 `session/new` 再重放全部历史。
 *
 * 复用必须满足：路由指纹一致（模型/强度/系统提示/工具目录），当前 DSH 历史
 * 仍是「已发送前缀」的严格追加，且新增部分不含 tool 消息（工具结果只走 MCP
 * 回喂，不能当 prompt 文本重发）。
 */
import { createHash } from 'node:crypto'
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { messageValue, stable } from './continuation-state.js'

/**
 * 会话复用的键：按 DSH 对话与用途区分。
 *
 * 只有普通聊天（purpose 未声明）参与复用；标题、压缩等一次性请求共用同一
 * DSH 会话会污染对话历史，一律新建独立 ACP 会话。
 */
export function reusableSessionKey(options: Pick<GenerateOptions, 'sessionId' | 'purpose'>): string | undefined {
  if (options.purpose !== undefined) return undefined
  if (!options.sessionId) return undefined
  return `${options.sessionId}::chat`
}

/**
 * 消息的来源类别（DSH 的 MessageSource.kind）。真实用户消息为 'user'；
 * 一次性请求（RequestUserInput）没有 source。
 */
export function messageSourceKind(message: RequestMessage): string | undefined {
  const source = (message as { readonly source?: { readonly kind?: unknown } }).source
  return source && typeof source.kind === 'string' ? source.kind : undefined
}

/** 消息 context form（snapshot / recall / instructions / catalog / notice / relay）。 */
export function messageSourceForm(message: RequestMessage): string | undefined {
  const source = (message as { readonly source?: { readonly form?: unknown } }).source
  return source && typeof source.form === 'string' ? source.form : undefined
}

/**
 * 增量 prompt 是否要发送这条消息。
 *
 * - assistant：agent 自己产生的回答已经在它的会话历史里，重发只会浪费 token；
 * - 快照 / 回忆 / 指令 / 目录类注入（runtime-context、time-context、hindsight、
 *   AGENTS.md 指令、技能目录）：首轮或重建时已完整发送，增量不再重复；
 * - 其余（真实用户输入、压缩检查点、模型切换通知、notice/relay/未知 kind）：
 *   可能是本轮才有意义的信息，照常发送。
 */
export function shouldSendIncrement(message: RequestMessage): boolean {
  if (message.role === 'assistant') return false
  if (message.role !== 'user') return true
  const kind = messageSourceKind(message)
  if (kind === undefined || kind === 'user') return true
  if (kind === 'compact-checkpoint' || kind === 'model-selection') return true
  const form = messageSourceForm(message)
  if (form === 'snapshot' || form === 'recall' || form === 'instructions' || form === 'catalog') return false
  return true
}

/** 一条消息的稳定指纹（只含模型可见值，不含持久 id）。 */
export function messageFingerprint(message: RequestMessage): string {
  return stable(messageValue(message))
}

/** 前 count 条消息的滚动指纹。 */
export function prefixHash(messages: readonly RequestMessage[], count: number = messages.length): string {
  const hash = createHash('sha256')
  for (let index = 0; index < count; index += 1) {
    const message = messages[index]
    if (!message) break
    hash.update(messageFingerprint(message))
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

/** 已发送前缀是否仍是当前历史的严格前缀。 */
export function prefixMatches(messages: readonly RequestMessage[], sentCount: number, sentHash: string): boolean {
  if (sentCount > messages.length) return false
  return prefixHash(messages, sentCount) === sentHash
}

/** 路由指纹：任一字段变化都不能沿用旧会话。 */
export function routeFingerprint(
  options: Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort' | 'system' | 'tools'>,
): string {
  // 只返回 sha256：这个值会随会话映射落盘，明文会把 system 提示与工具 schema
  // 写进缓存目录。
  return createHash('sha256').update(stable({
    provider: options.provider,
    model: options.model,
    effort: options.reasoningEffort?.toString(),
    system: options.system ?? '',
    tools: [...(options.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  })).digest('hex')
}
