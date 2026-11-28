/**
 * 计划解析与稳定渲染。
 *
 * 同一 {@link OrchestratorPlan} 经 {@link renderPlanForExecutor} 必须逐字节稳定，
 * 以避免破坏 executor 侧的会话续轮指纹（routeFingerprint / ContinuationState）。
 */
import type { OrchestratorPlan, PlanStep } from './types.js'

const MAX_STEPS = 32
const MAX_HANDBACK = 16
const MAX_TEXT = 2000

const PLAN_TAG_RE = /<plan\b[^>]*>([\s\S]*?)<\/plan>/giu
const FENCE_RE = /^\s*```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/iu

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim()
  const match = FENCE_RE.exec(trimmed)
  return match ? match[1]!.trim() : trimmed
}

function cleanText(value: unknown, limit = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.slice(0, limit)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 宽松解析 `<plan>{json}</plan>`：容忍前后解释文本与 markdown 代码围栏。
 * 若存在多个 `<plan>` 块，取最后一个合法块；全部无效则返回 `undefined`。
 */
export function parsePlan(text: string, previous?: OrchestratorPlan): OrchestratorPlan | undefined {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined
  const matches = [...text.matchAll(PLAN_TAG_RE)]
  if (matches.length === 0) return undefined

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const inner = stripCodeFence(matches[i]![1] ?? '')
    if (!inner) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(inner) as unknown
    } catch {
      continue
    }
    if (!isPlainRecord(parsed)) continue
    const goal = cleanText(parsed.goal)
    if (goal === undefined || !Array.isArray(parsed.steps)) continue

    const steps: PlanStep[] = []
    for (const rawStep of parsed.steps) {
      if (steps.length >= MAX_STEPS) break
      if (!isPlainRecord(rawStep)) continue
      const title = cleanText(rawStep.title)
      if (title === undefined) continue
      const id = cleanText(rawStep.id, 64) ?? `p${steps.length + 1}`
      const verification = cleanText(rawStep.verification)
      steps.push(verification === undefined ? { id, title } : { id, title, verification })
    }
    if (steps.length === 0) continue

    const handback: string[] = []
    if (Array.isArray(parsed.handback)) {
      for (const item of parsed.handback) {
        if (handback.length >= MAX_HANDBACK) break
        const line = cleanText(item)
        if (line !== undefined) handback.push(line)
      }
    }

    if (previous !== undefined && previous.goal === goal
        && JSON.stringify(previous.steps) === JSON.stringify(steps)
        && JSON.stringify(previous.handback) === JSON.stringify(handback)) return previous

    return {
      goal,
      steps,
      handback,
      revision: (previous?.revision ?? 0) + 1,
      createdAt: Date.now(),
    }
  }

  return undefined
}

/**
 * 将计划渲染为稳定的注入文本（同一 plan 逐字节相同）。
 */
export function renderPlanForExecutor(plan: OrchestratorPlan): string {
  const lines: string[] = [
    `[Orchestrator Plan rev=${plan.revision}]`,
    `Goal: ${plan.goal}`,
    'Steps:',
  ]
  for (let i = 0; i < plan.steps.length; i += 1) {
    const step = plan.steps[i]!
    const verify = step.verification ? ` | verify: ${step.verification}` : ''
    lines.push(`${i + 1}. [${step.id}] ${step.title}${verify}`)
  }
  if (plan.handback.length > 0) {
    lines.push('Handback conditions (stop and ask/replan if met):')
    for (const condition of plan.handback) {
      lines.push(`- ${condition}`)
    }
  }
  return lines.join('\n')
}
