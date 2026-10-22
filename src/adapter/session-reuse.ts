/** ACP 会话的输入前缀、已交付输出与上下文去重。DSH 始终是历史权威。 */
import { createHash } from 'node:crypto'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { messageValue, stable } from './continuation-state.js'

export function reusableSessionKey(options: Pick<GenerateOptions, 'sessionId' | 'purpose'>): string | undefined {
  if (options.purpose !== undefined || !options.sessionId) return undefined
  return `${options.sessionId}::chat`
}

export function messageSourceKind(message: RequestMessage): string | undefined {
  const source = (message as { readonly source?: { readonly kind?: unknown } }).source
  return source && typeof source.kind === 'string' ? source.kind : undefined
}

export function messageSourceForm(message: RequestMessage): string | undefined {
  const source = (message as { readonly source?: { readonly form?: unknown } }).source
  return source && typeof source.form === 'string' ? source.form : undefined
}

/** assistant 只有通过 outputMatches 验证后才可跳过；context form 本身不是丢弃依据。 */
export function shouldSendIncrement(message: RequestMessage): boolean {
  return message.role !== 'assistant'
}

/** 只对上下文载体去重；真实用户输入、notice、relay 与未知类别每次都保留。 */
function contextKey(message: RequestMessage): string | undefined {
  if (message.role !== 'user') return undefined
  const kind = messageSourceKind(message)
  if (!kind || kind === 'user' || kind === 'compact-checkpoint' || kind === 'model-selection') return undefined
  const form = messageSourceForm(message)
  if (!['snapshot', 'catalog', 'instructions', 'recall'].includes(form ?? '')) return undefined
  return stable([kind, form])
}

/**
 * 只省略确实已经发送的相同上下文。快照/目录跟踪最近版本，A→B→A 仍须发送 A；
 * 指令也可能撤回/恢复旧版本，未知文件身份时保守按最近版本判断；仅召回材料按完整内容去重。
 */
export function incrementalMessages(messages: readonly RequestMessage[], sentCount: number): RequestMessage[] {
  const latest = new Map<string, string>()
  const seen = new Set<string>()
  const result: RequestMessage[] = []
  for (const [index, message] of messages.entries()) {
    const key = contextKey(message)
    let duplicate = false
    if (key !== undefined) {
      const fingerprint = messageFingerprint(message)
      const stateful = messageSourceForm(message) !== 'recall'
      duplicate = stateful ? latest.get(key) === fingerprint : seen.has(`${key}\0${fingerprint}`)
      latest.set(key, fingerprint)
      seen.add(`${key}\0${fingerprint}`)
    }
    if (index >= sentCount && shouldSendIncrement(message) && !duplicate) result.push(message)
  }
  // 当前用户请求最后强调；其余新增消息的相对顺序保持不变。
  const latestUser = result.findLastIndex(message => message.role === 'user'
    && (messageSourceKind(message) === undefined || messageSourceKind(message) === 'user'))
  if (latestUser >= 0 && latestUser < result.length - 1) result.push(...result.splice(latestUser, 1))
  return result
}

export function messageFingerprint(message: RequestMessage): string {
  return stable(messageValue(message))
}

export function prefixHash(messages: readonly RequestMessage[], count: number = messages.length): string {
  const hash = createHash('sha256')
  for (const message of messages.slice(0, count)) hash.update(messageFingerprint(message)).update('\0')
  return hash.digest('hex')
}

export function prefixMatches(messages: readonly RequestMessage[], sentCount: number, sentHash: string): boolean {
  return Number.isSafeInteger(sentCount) && sentCount >= 0 && sentCount <= messages.length
    && prefixHash(messages, sentCount) === sentHash
}

/** 存储实际交付的 blocks 指纹，不落盘输出正文。 */
export function outputHash(blocks: readonly ContentBlock[]): string {
  return createHash('sha256').update(stable(blocks)).digest('hex')
}

/** 新历史中的 assistant 必须正好是上一步交付的输出，且位于所有新输入之前。 */
export function outputMatches(fresh: readonly RequestMessage[], expected: string | undefined): boolean {
  if (expected === undefined) return false
  const blocks: ContentBlock[] = []
  let inputSeen = false
  for (const message of fresh) {
    if (message.role === 'assistant') {
      if (inputSeen) return false
      blocks.push(...message.content)
    } else inputSeen = true
  }
  return outputHash(blocks) === expected
}

export function routeFingerprint(options: Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort' | 'system' | 'tools'>): string {
  return createHash('sha256').update(stable({
    provider: options.provider, model: options.model, effort: options.reasoningEffort?.toString(),
    system: options.system ?? '',
    tools: [...(options.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  })).digest('hex')
}
