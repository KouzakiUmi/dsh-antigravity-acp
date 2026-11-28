/**
 * Planner 与 Executor 的提示词构造与工具证据提取。
 */
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import { renderPlanForExecutor } from './plan-schema.js'
import type { OrchestratorPlan } from './types.js'

const MAX_EVIDENCE_ITEMS = 6
const MAX_EVIDENCE_CHARS = 1200

export const PLANNER_SYSTEM_SUFFIX = [
  'You are the planning phase of an orchestrator (planner -> executor).',
  'Do NOT call any tools or emit code to execute directly; produce only a concise execution plan.',
  'Wrap the plan as valid JSON inside <plan>...</plan> tags with this schema:',
  '{"goal": string, "steps": [{"id": "p1", "title": string, "verification": string}], "handback": [string]}',
  '- Include concrete, verifiable steps in execution order.',
  '- Under "handback", list conditions where the executor must stop and ask/replan (e.g. missing requirements, repeated failures, ambiguous choices).',
].join('\n')

import { latestUserIndex } from './triggers.js'

function blocksToPlainText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 从会话消息中提取最新真实用户目标与最近 6 条工具结果摘要（每条 ≤ 1200 字符，不含图片）。
 */
export function extractGoalAndEvidence(messages: readonly RequestMessage[]): {
  goal: string
  evidence: readonly string[]
} {
  const goal = blocksToPlainText(messages[latestUserIndex(messages)]?.content ?? [])

  const callNames = new Map<string, string>()
  const toolMessages: Array<{ toolCallId?: string; isError?: boolean; text: string }> = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool-call') {
          callNames.set(block.id, block.name)
        }
      }
    } else if (message.role === 'tool') {
      const text = blocksToPlainText(message.content)
      toolMessages.push({
        toolCallId: message.toolCallId,
        ...(message.isError === true ? { isError: true } : {}),
        text,
      })
    }
  }

  const evidence = toolMessages.slice(-MAX_EVIDENCE_ITEMS).map((item) => {
    const toolName = item.toolCallId ? callNames.get(item.toolCallId) : undefined
    const status = item.isError ? 'ERROR' : 'OK'
    const prefix = toolName ? `[${toolName} | ${status}] ` : `[${status}] `
    const body = item.text.length > 0 ? item.text : '(empty output)'
    const combined = `${prefix}${body}`
    return combined.length > MAX_EVIDENCE_CHARS
      ? `${combined.slice(0, MAX_EVIDENCE_CHARS - 3)}...`
      : combined
  })

  return { goal, evidence }
}

/**
 * 构造 planner 的单轮纯文本消息列表（不含图片与工具块）。
 */
export function buildPlannerMessages(
  goal: string,
  evidence: readonly string[],
  prior?: OrchestratorPlan,
): readonly RequestMessage[] {
  const sections: string[] = [
    `Goal:\n${goal.trim() || '(no explicit user text; infer goal from context)'}`,
  ]

  if (prior !== undefined) {
    sections.push(`Prior Plan:\n${renderPlanForExecutor(prior)}`)
  }

  const boundedEvidence = evidence
    .slice(-MAX_EVIDENCE_ITEMS)
    .map((entry) => entry.length > MAX_EVIDENCE_CHARS ? `${entry.slice(0, MAX_EVIDENCE_CHARS - 3)}...` : entry)

  if (boundedEvidence.length > 0) {
    sections.push(`Recent Tool Evidence (${boundedEvidence.length}):\n${boundedEvidence.map((item, i) => `${i + 1}. ${item}`).join('\n')}`)
  }

  sections.push('Output the updated execution plan inside <plan>{...}</plan>.')

  return [{
    role: 'user',
    content: [{ type: 'text', text: sections.join('\n\n') }],
  }]
}

/**
 * 将已渲染计划稳定追加到 executor 的 system prompt 尾部。
 */
export function buildExecutorSystem(base: string | undefined, plan: OrchestratorPlan): string {
  const rendered = renderPlanForExecutor(plan)
  if (typeof base !== 'string' || base.trim().length === 0) return rendered
  return `${base}\n\n${rendered}`
}
