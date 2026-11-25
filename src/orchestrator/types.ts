/**
 * 编排层（planner → executor）共享类型与设置规范化。
 *
 * ACP 链路与代理链路共用 {@link ORCHESTRATOR_MODEL_ID} 与这里的纯类型契约；
 * 本模块无 IO、无宿主依赖。
 */
import type { ModelEffort } from '../adapter/model-settings.js'

export const ORCHESTRATOR_MODEL_ID = 'antigravity-orchestrator' as const
export const ORCHESTRATOR_MODEL_NAME = 'Orchestrator（插件编排）' as const

export const ORCHESTRATOR_PLANNER_MODELS = ['gemini-4-neon', 'gemini-4-argon', 'claude-opus-5-5'] as const
export type OrchestratorPlannerModel = typeof ORCHESTRATOR_PLANNER_MODELS[number]
export const ORCHESTRATOR_EXECUTOR_MODELS = ['gemini-4-hydrogen', 'claude-sonnet-5-5'] as const
export type OrchestratorExecutorModel = typeof ORCHESTRATOR_EXECUTOR_MODELS[number]
/** executor 默认模型；对齐官方 Antigravity 编排设置的 Hydrogen 默认项。 */
export const ORCHESTRATOR_EXECUTOR_MODEL: OrchestratorExecutorModel = 'gemini-4-hydrogen'

export type OrchestratorStage = 'idle' | 'planning' | 'executing'

export interface PlanStep {
  id: string
  title: string
  verification?: string
}

export interface OrchestratorPlan {
  goal: string
  steps: readonly PlanStep[]
  handback: readonly string[]
  revision: number
  createdAt: number
}

export interface OrchestratorState {
  plan?: OrchestratorPlan
  stage: OrchestratorStage
  plansThisTurn: number
  turnKey?: string
  lastError?: string
}

export interface OrchestratorSettings {
  enabled: boolean
  plannerModel: OrchestratorPlannerModel
  plannerEffort: ModelEffort
  executorModel: OrchestratorExecutorModel
  executorEffort: ModelEffort
  maxPlansPerTurn: number
  plannerTimeoutMs: number
  showPlan: boolean
}

export const DEFAULT_ORCHESTRATOR_SETTINGS: Readonly<OrchestratorSettings> = {
  enabled: true,
  plannerModel: 'claude-opus-5-5',
  plannerEffort: 'medium',
  executorModel: ORCHESTRATOR_EXECUTOR_MODEL,
  executorEffort: 'medium',
  maxPlansPerTurn: 2,
  plannerTimeoutMs: 20_000,
  showPlan: false,
}

const VALID_EFFORTS: readonly ModelEffort[] = ['low', 'medium', 'high']

function isEffort(value: unknown): value is ModelEffort {
  return typeof value === 'string' && (VALID_EFFORTS as readonly string[]).includes(value)
}

function normalizePlannerModel(value: unknown): OrchestratorPlannerModel {
  if (typeof value !== 'string') return DEFAULT_ORCHESTRATOR_SETTINGS.plannerModel
  const trimmed = value.trim()
  return (ORCHESTRATOR_PLANNER_MODELS as readonly string[]).includes(trimmed)
    ? (trimmed as OrchestratorPlannerModel)
    : DEFAULT_ORCHESTRATOR_SETTINGS.plannerModel
}

function normalizeExecutorModel(value: unknown): OrchestratorExecutorModel {
  if (typeof value !== 'string') return DEFAULT_ORCHESTRATOR_SETTINGS.executorModel
  const trimmed = value.trim()
  return (ORCHESTRATOR_EXECUTOR_MODELS as readonly string[]).includes(trimmed)
    ? (trimmed as OrchestratorExecutorModel)
    : DEFAULT_ORCHESTRATOR_SETTINGS.executorModel
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'] as const

/**
 * 将请求/配置期望的档位收敛到模型实际提供的档位集合：
 * 命中则返回原值；否则优先回落 `medium`，再退回距离最近的可用档位。
 */
export function convergeOrchestratorEffort(
  wanted: string | undefined,
  available: readonly string[],
): string | undefined {
  if (available.length === 0) return undefined
  const normalized = wanted?.trim().toLowerCase()
  if (normalized !== undefined && available.includes(normalized)) return normalized
  if (available.includes('medium')) return 'medium'
  const anchor = normalized !== undefined && (EFFORT_ORDER as readonly string[]).includes(normalized)
    ? EFFORT_ORDER.indexOf(normalized as typeof EFFORT_ORDER[number])
    : EFFORT_ORDER.indexOf('medium')
  let best: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of EFFORT_ORDER) {
    if (!available.includes(candidate)) continue
    const distance = Math.abs(EFFORT_ORDER.indexOf(candidate) - anchor)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best ?? available[0]
}

/**
 * 与 model-settings.ts 同风格：非法值静默丢弃并回退默认值，绝不抛错。
 */
export function normalizeOrchestratorSettings(input: unknown): OrchestratorSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_ORCHESTRATOR_SETTINGS }
  }
  const raw = input as Record<string, unknown>
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_ORCHESTRATOR_SETTINGS.enabled
  const plannerModel = normalizePlannerModel(raw.plannerModel)
  const executorModel = normalizeExecutorModel(raw.executorModel)
  const plannerEffort = isEffort(raw.plannerEffort) ? raw.plannerEffort : DEFAULT_ORCHESTRATOR_SETTINGS.plannerEffort
  const executorEffort = isEffort(raw.executorEffort) ? raw.executorEffort : DEFAULT_ORCHESTRATOR_SETTINGS.executorEffort
  const maxPlansPerTurn = typeof raw.maxPlansPerTurn === 'number'
    && Number.isSafeInteger(raw.maxPlansPerTurn)
    && raw.maxPlansPerTurn >= 1
    && raw.maxPlansPerTurn <= 4
    ? raw.maxPlansPerTurn
    : DEFAULT_ORCHESTRATOR_SETTINGS.maxPlansPerTurn
  const plannerTimeoutMs = typeof raw.plannerTimeoutMs === 'number'
    && Number.isFinite(raw.plannerTimeoutMs)
    && raw.plannerTimeoutMs >= 5000
    && raw.plannerTimeoutMs <= 300_000
    ? Math.floor(raw.plannerTimeoutMs)
    : DEFAULT_ORCHESTRATOR_SETTINGS.plannerTimeoutMs
  const showPlan = typeof raw.showPlan === 'boolean' ? raw.showPlan : DEFAULT_ORCHESTRATOR_SETTINGS.showPlan

  return {
    enabled,
    plannerModel,
    plannerEffort,
    executorModel,
    executorEffort,
    maxPlansPerTurn,
    plannerTimeoutMs,
    showPlan,
  }
}
