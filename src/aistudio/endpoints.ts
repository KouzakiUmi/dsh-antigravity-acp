/**
 * AI Studio（Gemini API）端点常量与路径构造。
 *
 * 标准 Google REST API（`generativelanguage.googleapis.com`），不需要 agy 线身份
 * 伪装或固定头序，普通代理感知 fetch 即可。鉴权用 `x-goog-api-key` 请求头而非
 * `?key=` 查询参数：key 不进 URL，避免出现在日志/错误消息里（设计稿 §8 脱敏要求）。
 *
 * 模型 ID 约定：DSH 选择器键带 `aistudio-` 前缀（与代理线 `antigravity-` 同口径，
 * 供设置页按链路过滤 modelOverrides）；发往上游的线模型去掉前缀。
 */
import { defaultChatModelEnabled, isNonChatModel } from '../adapter/model-catalog-policy.js'

export const AISTUDIO_PROVIDER_ID = 'aistudio'
export const AISTUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta'
export const AISTUDIO_MODEL_PREFIX = 'aistudio-'
/** 上游 ListModels 单页上限；超过即翻页（pageToken）。 */
export const AISTUDIO_MODELS_PAGE_SIZE = 200

/** DSH 目录键 → 线模型（去前缀）；已带前缀才剥，裸线模型原样返回。 */
export function aistudioWireModel(catalogId: string): string {
  return catalogId.startsWith(AISTUDIO_MODEL_PREFIX) ? catalogId.slice(AISTUDIO_MODEL_PREFIX.length) : catalogId
}

/** 线模型 → DSH 目录键（加前缀）。 */
export function aistudioCatalogId(wireModel: string): string {
  return `${AISTUDIO_MODEL_PREFIX}${wireModel}`
}

/**
 * AI Studio 默认启用口径（用户指定「只开 4，其他默认关闭」）：仅 Gemini 4 系默认
 * 进选择器，其余代际 / 非 Gemini 模型默认关闭（目录保留、可显式启用）。与客户端
 * 内置同口径函数的一致性由测试锁定。纯函数，无 IO。
 */
export function aistudioDefaultEnabled(catalogId: string): boolean {
  return defaultChatModelEnabled(aistudioCatalogId(aistudioWireModel(catalogId)))
}

export function isAistudioChatModel(wireModel: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/u.test(wireModel) && !isNonChatModel(wireModel)
}

/** 路径里的模型段：剥 `models/` 前缀后逐段编码（与 magpie GeminiModelPath 同口径）。 */
export function aistudioModelSegment(wireModel: string): string {
  const stripped = wireModel.startsWith('models/') ? wireModel.slice('models/'.length) : wireModel
  return stripped.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

/** 流式生成 URL（不含 key；鉴权经请求头）。 */
export function aistudioStreamUrl(wireModel: string): string {
  return `${AISTUDIO_BASE}/models/${aistudioModelSegment(wireModel)}:streamGenerateContent?alt=sse`
}

/** 模型发现 URL（不含 key）。 */
export function aistudioModelsUrl(pageToken?: string): string {
  const base = `${AISTUDIO_BASE}/models?pageSize=${String(AISTUDIO_MODELS_PAGE_SIZE)}`
  return pageToken === undefined ? base : `${base}&pageToken=${encodeURIComponent(pageToken)}`
}
