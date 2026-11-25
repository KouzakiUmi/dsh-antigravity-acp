/**
 * 编排规划触发判定（shouldPlan）与用户回合键计算。
 */
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import { messageFingerprint, messageSourceKind } from '../adapter/session-reuse.js'
import type { OrchestratorSettings, OrchestratorState } from './types.js'

export type ShouldPlanReason =
  | 'disabled'
  | 'budget'
  | 'no-plan'
  | 'new-goal'
  | 'tool-error'
  | 'repeat-failure'
  | 'continue'

export interface ShouldPlanInput {
  messages: readonly RequestMessage[]
  state: OrchestratorState
  goal: string
  settings: OrchestratorSettings
  sessionId?: string
}

export interface ShouldPlanResult {
  plan: boolean
  reason: ShouldPlanReason
}

function isRealUserMessage(message: RequestMessage): boolean {
  if (message.role !== 'user') return false
  const kind = messageSourceKind(message)
  return kind === undefined || kind === 'user'
}

/**
 * 计算当前用户回合标识：`sessionId + ':' + 最后一条真实用户消息指纹`。
 */
export function computeTurnKey(
  messages: readonly RequestMessage[],
  sessionId?: string,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    if (isRealUserMessage(message)) {
      return `${sessionId ?? 'anonymous'}:${messageFingerprint(message)}`
    }
  }
  return undefined
}

function resolveToolEntries(messages: readonly RequestMessage[]): Array<{ name?: string; isError: boolean }> {
  const callNames = new Map<string, string>()
  const tools: Array<{ name?: string; isError: boolean }> = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool-call') {
          callNames.set(block.id, block.name)
        }
      }
    } else if (message.role === 'tool') {
      const explicitName = (message as { readonly name?: unknown }).name
      const name = callNames.get(message.toolCallId)
        ?? (typeof explicitName === 'string' && explicitName.length > 0 ? explicitName : undefined)
      tools.push({ name, isError: message.isError === true })
    }
  }
  return tools
}

/**
 * 按规格 §5 顺序判定本轮是否需要运行 planner，先命中先返回。
 */
export function shouldPlan(input: ShouldPlanInput): ShouldPlanResult {
  const { messages, state, settings, sessionId } = input

  if (settings.enabled === false) {
    return { plan: false, reason: 'disabled' }
  }

  if (state.plansThisTurn >= settings.maxPlansPerTurn) {
    return { plan: false, reason: 'budget' }
  }

  if (state.plan === undefined) {
    return { plan: true, reason: 'no-plan' }
  }

  const currentTurnKey = computeTurnKey(messages, sessionId)
  if (currentTurnKey !== undefined && currentTurnKey !== state.turnKey) {
    return { plan: true, reason: 'new-goal' }
  }

  const toolEntries = resolveToolEntries(messages)
  const lastTool = toolEntries.at(-1)
  if (lastTool !== undefined && lastTool.isError) {
    return { plan: true, reason: 'tool-error' }
  }

  const recentTools = toolEntries.slice(-4)
  const consecutiveErrors = new Map<string, number>()
  for (const entry of recentTools) {
    if (!entry.name) continue
    if (entry.isError) {
      const next = (consecutiveErrors.get(entry.name) ?? 0) + 1
      if (next >= 2) return { plan: true, reason: 'repeat-failure' }
      consecutiveErrors.set(entry.name, next)
    } else {
      consecutiveErrors.set(entry.name, 0)
    }
  }

  return { plan: false, reason: 'continue' }
}
