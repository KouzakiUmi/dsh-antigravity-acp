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

export function latestUserIndex(messages: readonly RequestMessage[]): number {
  return messages.findLastIndex(isRealUserMessage)
}

/** 持久消息身份区分内容相同的两次发送，内容指纹仍可识别原消息被编辑。 */
export function computeTurnKey(
  messages: readonly RequestMessage[],
  sessionId?: string,
): string | undefined {
  const index = latestUserIndex(messages)
  const message = messages[index]
  if (message === undefined) return undefined
  return JSON.stringify([sessionId ?? null, message.id ?? index, messageFingerprint(message)])
}

function resolveToolEntries(messages: readonly RequestMessage[]): Array<{ id: string; name?: string; isError: boolean }> {
  const callNames = new Map<string, string>()
  const tools: Array<{ id: string; name?: string; isError: boolean }> = []
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
      tools.push({ id: message.id, name, isError: message.isError === true })
    }
  }
  return tools
}

export function latestToolResultId(messages: readonly RequestMessage[]): string | undefined {
  return messages.slice(latestUserIndex(messages) + 1).findLast(message => message.role === 'tool')?.id
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

  const toolEntries = resolveToolEntries(messages.slice(latestUserIndex(messages) + 1))
  const handled = state.lastPlannedToolResult
  const boundary = handled === undefined ? -1 : toolEntries.findIndex(entry => entry.id === handled)
  const fresh = toolEntries.slice(boundary + 1)
  if (fresh.at(-1)?.isError) {
    return { plan: true, reason: 'tool-error' }
  }

  const recentTools = toolEntries.slice(-4)
  const consecutiveErrors = new Map<string, number>()
  for (const entry of recentTools) {
    if (!entry.name) continue
    if (entry.isError) {
      const next = (consecutiveErrors.get(entry.name) ?? 0) + 1
      if (next >= 2 && fresh.includes(entry)) return { plan: true, reason: 'repeat-failure' }
      consecutiveErrors.set(entry.name, next)
    } else {
      consecutiveErrors.set(entry.name, 0)
    }
  }

  if (handled !== undefined ? fresh.some(entry => entry.isError) : false) return { plan: true, reason: 'tool-error' }

  return { plan: false, reason: 'continue' }
}
