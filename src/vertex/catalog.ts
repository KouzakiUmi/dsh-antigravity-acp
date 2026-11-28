import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { ModelOverride } from '../settings.js'
import { resolveGeminiControls } from '../adapter/gemini-model-controls.js'
import { modelSettingFor, normalizeModelSettings } from '../adapter/model-settings.js'
import { catalogDisplayName, defaultChatModelEnabled } from '../adapter/model-catalog-policy.js'
import type { ModelCapacity } from '../adapter/model-settings.js'
import { isVertexPublisherModel, VERTEX_MODEL_PREFIX, VERTEX_PROVIDER_ID } from './endpoints.js'

type ResolvedControls = ReturnType<typeof resolveGeminiControls>

interface VertexModel extends LlmModelInfo, ModelCapacity, Pick<LlmResolvedModelInfo, 'defaultMaxTokens' | 'reasoning'> {
  readonly upstreamId: string
  readonly enabled: boolean
  readonly compat: ResolvedControls['compat']
  readonly controls: ResolvedControls['controls']
  readonly resolvedContextWindow?: number
}

/** Only explicitly configured Google publisher IDs; no discovery/permission probe. */
export function listConfiguredVertexModels(models: readonly string[], overrides?: Record<string, ModelOverride>): VertexModel[] {
  const settings = normalizeModelSettings(overrides, defaultChatModelEnabled)
  const entries = new Map<string, VertexModel>()
  for (const raw of models) {
    const publisherId = raw.trim()
    if (!isVertexPublisherModel(publisherId) || entries.has(publisherId)) continue
    const id = `${VERTEX_MODEL_PREFIX}${publisherId}`
    const setting = modelSettingFor(settings, id, defaultChatModelEnabled)
    const upstreamId = setting.target ?? publisherId
    if (!isVertexPublisherModel(upstreamId)) continue
    const resolved = resolveGeminiControls(upstreamId, setting, undefined, 'vertex-v1')
    entries.set(publisherId, {
      provider: VERTEX_PROVIDER_ID, id, name: setting.name ?? catalogDisplayName(publisherId), upstreamId,
      inputModalities: ['text'], enabled: setting.enabled, compat: resolved.compat, controls: resolved.controls,
      ...(resolved.compat.upstreamContextWindow === undefined ? {} : {
        contextWindow: resolved.compat.upstreamContextWindow,
        contextWindowSource: 'audited',
      }),
      ...(resolved.contextWindow === undefined ? {} : { resolvedContextWindow: resolved.contextWindow }),
      ...(resolved.compat.protocolMaxOutputTokens === undefined ? {} : { maxOutputTokens: resolved.compat.protocolMaxOutputTokens }),
      ...(resolved.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: resolved.defaultMaxTokens }),
      ...(resolved.reasoning === undefined ? {} : { reasoning: resolved.reasoning }),
    })
  }
  return [...entries.values()]
}
