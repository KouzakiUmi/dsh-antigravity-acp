/**
 * 模型目录和生成请求的逐模型用户设置。
 *
 * 设计边界（与 ACP v1 契约对齐）：
 * - 目录条目只来自会话 `configOptions` 与官方 CLI 的只读清单，用户设置**不新增**
 *   自造模型，只作用于已观测到的条目；映射的 `target` 仍由官方 agent 判定是否
 *   接受，未登记 ID 不会被这里静默改写成别的模型。
 * - 停用是「不列入选择器」，不是删除目录条目：已知模型的显示名、上下文容量与
 *   路由仍保留，避免重新启用时退回裸 ID。
 * - 旧版和已公告退役的家族默认关闭；只有显式布尔开关覆盖所在路由的默认值。
 * - 默认档位只决定**未显式选择**思考强度时的路由结果；DSH 思考强度菜单的选择
 *   始终优先。
 *
 * 本模块只有纯函数，无 IO。
 */
import { isRetiringModel } from './model-retirement.js'
import { catalogDisplayName, defaultChatModelEnabled } from './model-catalog-policy.js'

function defaultEnabledFor(id: string): boolean {
  return defaultChatModelEnabled(id) && !isRetiringModel(id)
}

/** 目录观测或审计得到的容量，与用户覆盖分开。 */
export interface ModelCapacity {
  contextWindow?: number
  maxOutputTokens?: number
  /** 容量来源：实测（usage_update / 磁盘缓存）或审计参考；缺省表示未知。 */
  contextWindowSource?: 'observed' | 'audited'
}

/** 与 runtime/agy-cli.ts 的档位顺序一致（弱 → 强）。 */
export type ModelEffort = 'low' | 'medium' | 'high'
const EFFORTS: readonly ModelEffort[] = ['low', 'medium', 'high']

/** 标准 Gemini 请求档位，独立于 ACP / agy 的路由档位。 */
export const GEMINI_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type GeminiReasoningEffort = typeof GEMINI_REASONING_EFFORTS[number]

export const MAX_MODEL_CONTEXT_WINDOW = 10_000_000
export const MAX_MODEL_OUTPUT_TOKENS = 1_000_000
export const MAX_MODEL_TEMPERATURE = 2
export const MAX_MODEL_STOP_SEQUENCES = 5
export const MAX_MODEL_STOP_LENGTH = 256

function isEffort(value: unknown): value is ModelEffort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
}

function isGeminiReasoningEffort(value: unknown): value is GeminiReasoningEffort {
  return typeof value === 'string' && (GEMINI_REASONING_EFFORTS as readonly string[]).includes(value)
}

function positiveInteger(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max
}

function normalizeStop(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_MODEL_STOP_SEQUENCES) return undefined
  const stops: unknown[] = Array.from(value)
  return stops.every((stop): stop is string => typeof stop === 'string' && /\S/u.test(stop) && stop.length <= MAX_MODEL_STOP_LENGTH)
    ? stops
    : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export interface ModelSetting {
  enabled: boolean
  effort?: ModelEffort
  name?: string
  target?: string
  contextWindow?: number
  maxTokens?: number
  temperature?: number
  stop?: string[]
  supportsImage?: boolean
  reasoningEffort?: GeminiReasoningEffort
}

/**
 * 把配置里的原始记录收敛成可用设置：非法档位、空串与非对象条目一律丢弃，
 * 不让一份手写配置让整个目录失败。
 */
export function normalizeModelSettings(input: unknown, defaultEnabled?: (id: string) => boolean): Map<string, ModelSetting> {
  const settings = new Map<string, ModelSetting>()
  if (!input || typeof input !== 'object' || Array.isArray(input)) return settings
  for (const [rawId, row] of Object.entries(input as Record<string, unknown>)) {
    const id = text(rawId)
    if (!id || !row || typeof row !== 'object' || Array.isArray(row)) continue
    const record = row as Record<string, unknown>
    const name = text(record.name)
    const target = text(record.target)
    const { contextWindow, maxTokens, temperature, supportsImage, reasoningEffort } = record
    const stop = normalizeStop(record.stop)
    // 仅显式布尔值覆盖目录默认。改名和映射不会顺带启用旧版。
    const enabled = typeof record.enabled === 'boolean' ? record.enabled : (defaultEnabled ?? defaultEnabledFor)(id)
    settings.set(id, {
      enabled,
      ...(isEffort(record.effort) ? { effort: record.effort } : {}),
      ...(name === '' ? {} : { name }),
      ...(target === '' ? {} : { target }),
      ...(positiveInteger(contextWindow, MAX_MODEL_CONTEXT_WINDOW) && contextWindow >= 2 ? { contextWindow } : {}),
      ...(positiveInteger(maxTokens, MAX_MODEL_OUTPUT_TOKENS) ? { maxTokens } : {}),
      ...(typeof temperature === 'number' && temperature >= 0 && temperature <= MAX_MODEL_TEMPERATURE ? { temperature } : {}),
      ...(stop === undefined ? {} : { stop }),
      ...(typeof supportsImage === 'boolean' ? { supportsImage } : {}),
      ...(isGeminiReasoningEffort(reasoningEffort) ? { reasoningEffort } : {}),
    })
  }
  return settings
}

/** 未配置的模型继承所在路由的默认状态，不生成覆盖项。 */
export function modelSettingFor(settings: ReadonlyMap<string, ModelSetting>, id: string, defaultEnabled?: (id: string) => boolean): ModelSetting {
  const stored = settings.get(id)
  if (stored) return stored
  // 未显式配置时，官方公告即将下线的家族默认关闭；用户仍可在设置页手动打开。
  return { enabled: (defaultEnabled ?? defaultEnabledFor)(id) }
}

/** 是否列入 DSH 模型选择器。 */
export function modelVisible(settings: ReadonlyMap<string, ModelSetting>, id: string, defaultEnabled?: (id: string) => boolean): boolean {
  return modelSettingFor(settings, id, defaultEnabled).enabled
}

/**
 * 应用显示名覆盖；停用不影响调用，因此本函数只处理名称，不做过滤。
 */
export function modelDisplayName(settings: ReadonlyMap<string, ModelSetting>, id: string, fallback: string): string {
  const name = modelSettingFor(settings, id).name
  return name ?? catalogDisplayName(id, fallback)
}

/**
 * 决定写入 ACP 的官方模型 ID。
 *
 * 顺序：显式 `target` 映射 → 家族 + 档位路由（`route` 回调）。
 * 档位取「本次显式选择」优先，其次该模型的默认档位，最后交给路由回调决定默认。
 */
export function resolveModelTarget(options: {
  settings: ReadonlyMap<string, ModelSetting>
  /** DSH 请求里的路由键（家族 id 或完整档位 id）。 */
  model: string
  /** 本次显式选择的思考强度；未选择时为 undefined。 */
  effort?: ModelEffort
  /** 未给出映射与档位时的官方路由结果。 */
  route(tier: ModelEffort | undefined): string
}): string {
  const setting = modelSettingFor(options.settings, options.model)
  if (setting.target !== undefined) return setting.target
  return options.route(options.effort ?? setting.effort)
}

/** 模型条目的原始记录（目录观测或 CLI 清单）；只保留需要的字段。 */
export interface CatalogRow {
  id: string
  name: string
  description?: string
}

/**
 * 折叠后的目录条目套用用户设置：显示名覆盖 + 隐藏停用项。
 *
 * 停用的条目仍然参与家族档位折叠（在调用方完成），这里只决定最终列表。
 */
export function applyModelSettings(
  settings: ReadonlyMap<string, ModelSetting>,
  rows: readonly CatalogRow[],
  includeDisabled = false,
): CatalogRow[] {
  const result: CatalogRow[] = []
  for (const row of rows) {
    const setting = modelSettingFor(settings, row.id)
    if (!includeDisabled && !setting.enabled) continue
    result.push({ ...row, name: setting.name ?? catalogDisplayName(row.id, row.name) })
  }
  return result
}
