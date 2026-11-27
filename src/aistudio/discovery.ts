/**
 * AI Studio 模型发现：解析 `GET /v1beta/models` 的 ListModels 响应。
 *
 * 实时发现，不做 curated allowlist（设计稿 §6）：过滤 `supportedGenerationMethods`
 * 含 `generateContent` 的条目，容量取 `inputTokenLimit` / `outputTokenLimit`。
 * 首期文本模态：排除图像生成模型（线模型名含 `image`），避免把图像输出模型塞进
 * 文本选择器。纯函数，无 IO，可独立单测。
 */
import { aistudioCatalogId, aistudioWireModel } from './endpoints.js'

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
  nextPageToken?: string
}

const MAX_MODELS = 1000

/**
 * 非聊天模态模型（图像 / TTS / 音乐 / 视频 / 嵌入 / 实时音频等）不进文本选择器。
 * 仅靠 `generateContent` 不足以排除它们（TTS / 图像预览也声明 generateContent），
 * 故按线模型名的专用家族标记过滤。这些模态的「单独调用接口」另立任务（设计稿 §7）。
 */
const NON_CHAT_MODEL = /(image|imagen|tts|text-to-speech|speech|audio|music|lyria|veo|video|embed|embedding|aqa|live|realtime)/iu

/** 解析一页 ListModels 响应；非法形状返回空页（不猜）。 */
export function parseAistudioModels(value: unknown): AistudioModelPage {
  if (!isRecord(value) || !Array.isArray(value.models)) return { models: [] }
  const models: AistudioModel[] = []
  const seen = new Set<string>()
  for (const item of value.models) {
    if (models.length >= MAX_MODELS) break
    const model = parseModel(item)
    if (model === undefined || seen.has(model.wireModel)) continue
    seen.add(model.wireModel)
    models.push(model)
  }
  const nextPageToken = typeof value.nextPageToken === 'string' && value.nextPageToken.length > 0 ? value.nextPageToken : undefined
  return { models, ...(nextPageToken === undefined ? {} : { nextPageToken }) }
}

function parseModel(value: unknown): AistudioModel | undefined {
  if (!isRecord(value)) return undefined
  const rawName = typeof value.name === 'string' ? value.name : undefined
  if (rawName === undefined || rawName.length === 0) return undefined
  const wireModel = aistudioWireModel(rawName.startsWith('models/') ? rawName.slice('models/'.length) : rawName)
  if (wireModel.length === 0 || wireModel.length > 256) return undefined
  // 首期文本模态：图像 / TTS / 音乐 / 视频等非聊天模型不进文本选择器。
  if (NON_CHAT_MODEL.test(wireModel)) return undefined
  const methods = Array.isArray(value.supportedGenerationMethods) ? value.supportedGenerationMethods : []
  if (!methods.includes('generateContent')) return undefined
  const displayName = typeof value.displayName === 'string' && value.displayName.trim() ? value.displayName.trim() : wireModel
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
