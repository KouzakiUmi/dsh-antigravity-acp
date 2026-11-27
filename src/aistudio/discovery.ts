/**
 * AI Studio 模型发现：解析 `GET /v1beta/models` 的 ListModels 响应。
 *
 * 实时发现，不做 curated allowlist（设计稿 §6）：过滤 `supportedGenerationMethods`
 * 含 `generateContent` 的条目，容量取 `inputTokenLimit` / `outputTokenLimit`。
 * 只收录可输出文本的模型。纯函数，无 IO，可独立单测。
 */
import { catalogDisplayName } from '../adapter/model-catalog-policy.js'
import { aistudioCatalogId, aistudioWireModel, isAistudioChatModel } from './endpoints.js'

export interface AistudioModel {
  /** 发往上游的线模型（去 `models/` 前缀）。 */
  wireModel: string
  /** DSH 选择器键（带 `aistudio-` 前缀）。 */
  catalogId: string
  name: string
  description?: string
  contextWindow?: number
  maxOutputTokens?: number
}

export interface AistudioModelPage {
  models: AistudioModel[]
  nonChatIds?: string[]
  nextPageToken?: string
}

const MAX_MODELS = 1000

/** 解析一页 ListModels 响应；非法形状返回空页（不猜）。 */
export function parseAistudioModels(value: unknown): AistudioModelPage {
  if (!isRecord(value) || !Array.isArray(value.models)) return { models: [] }
  const models: AistudioModel[] = []
  const nonChatIds = new Set<string>()
  const seen = new Set<string>()
  for (const item of value.models) {
    if (models.length >= MAX_MODELS) break
    const wireModel = wireId(item)
    if (wireModel === undefined || !isRecord(item)) continue
    if (hasNonChatMetadata(item)) {
      if (nonChatIds.size < MAX_MODELS) nonChatIds.add(wireModel)
      continue
    }
    const model = parseModel(item, wireModel)
    if (model === undefined || seen.has(model.wireModel)) continue
    seen.add(model.wireModel)
    models.push(model)
  }
  const nextPageToken = typeof value.nextPageToken === 'string' && value.nextPageToken.length > 0 ? value.nextPageToken : undefined
  return { models, ...(nonChatIds.size === 0 ? {} : { nonChatIds: [...nonChatIds] }), ...(nextPageToken === undefined ? {} : { nextPageToken }) }
}

function wireId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const rawName = typeof value.name === 'string' ? value.name : undefined
  if (rawName === undefined || rawName.length === 0) return undefined
  const wireModel = aistudioWireModel(rawName.startsWith('models/') ? rawName.slice('models/'.length) : rawName)
  return isAistudioChatModel(wireModel) ? wireModel : undefined
}

function hasNonChatMetadata(value: Record<string, unknown>): boolean {
  const modalities = value.outputModalities
  return (Array.isArray(value.supportedGenerationMethods) && !value.supportedGenerationMethods.includes('generateContent'))
    || (Array.isArray(modalities) && modalities.length > 0
      && modalities.every(modality => typeof modality === 'string')
      && !modalities.some(modality => modality.toUpperCase() === 'TEXT'))
}

function parseModel(value: Record<string, unknown>, wireModel: string): AistudioModel | undefined {
  const methods = Array.isArray(value.supportedGenerationMethods) ? value.supportedGenerationMethods : []
  if (!methods.includes('generateContent')) return undefined
  const upstreamName = typeof value.displayName === 'string' ? value.displayName.trim() : ''
  const displayName = catalogDisplayName(wireModel, upstreamName || undefined)
  const description = typeof value.description === 'string' && value.description.trim() ? value.description.trim().slice(0, 512) : undefined
  const contextWindow = positiveInteger(value.inputTokenLimit)
  const maxOutputTokens = positiveInteger(value.outputTokenLimit)
  return {
    wireModel,
    catalogId: aistudioCatalogId(wireModel),
    name: displayName.slice(0, 256),
    ...(description === undefined ? {} : { description }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
