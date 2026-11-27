import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { ModelOverride } from '../settings.js'
import { modelSettingFor, normalizeModelSettings } from '../adapter/model-settings.js'
import { catalogDisplayName, defaultChatModelEnabled } from '../adapter/model-catalog-policy.js'
import type { ModelCapacity } from '../adapter/model-settings.js'
import { isVertexPublisherModel, VERTEX_MODEL_PREFIX, VERTEX_PROVIDER_ID } from './endpoints.js'

interface VertexModel extends LlmModelInfo, ModelCapacity {
  readonly upstreamId: string
  readonly enabled: boolean
}

const knownCapacity = { contextWindow: 1_048_576, maxOutputTokens: 65_536, contextWindowSource: 'audited' } as const
const CAPACITIES = new Map<string, ModelCapacity>([
  // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-hydrogen
  ['gemini-4-hydrogen', knownCapacity],
  // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-neon
  ['gemini-4-neon', knownCapacity],
  // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite
  ['gemini-3.5-flash-lite', knownCapacity],
])

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
    entries.set(publisherId, {
      provider: VERTEX_PROVIDER_ID, id, name: setting.name ?? catalogDisplayName(publisherId), upstreamId,
      inputModalities: ['text'], enabled: setting.enabled,
      ...CAPACITIES.get(upstreamId),
    })
  }
  return [...entries.values()]
}
