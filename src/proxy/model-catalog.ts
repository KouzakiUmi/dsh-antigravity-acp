/** Parse the account's live catalog and intersect it with the pinned proxy definitions. */
import { getAgyNativeModel } from '@cortexkit/antigravity-auth-core'
import type { getPublicModelDefinitions } from '@cortexkit/antigravity-auth-core'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { isNonChatModel } from '../adapter/model-catalog-policy.js'
import { modelDisplayName } from '../adapter/model-settings.js'
import type { ModelCapacity, ModelEffort, ModelSetting } from '../adapter/model-settings.js'
import {
  ORCHESTRATOR_MODEL_ID,
  ORCHESTRATOR_MODEL_NAME,
  convergeOrchestratorEffort,
} from '../orchestrator/index.js'
import type { OrchestratorSettings } from '../orchestrator/index.js'
import { llmError } from '../runtime/llm-error.js'
import { resolveProxyWireModel } from './payload.js'
import { PROXY_PROVIDER_ID } from './replay.js'

export const PROXY_MODEL_EFFORTS: readonly ModelEffort[] = ['low', 'medium', 'high']

export interface LiveProxyModel {
  readonly defaultWire: string
  readonly efforts: readonly ModelEffort[]
  readonly liveGemini?: { readonly name: string; readonly variants: ReadonlyMap<string, string> }
}

export interface LiveWireModel {
  readonly supportsImages?: boolean
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
}

export interface LiveProxyCatalog {
  readonly models: ReadonlyMap<string, LiveProxyModel>
  readonly wire: ReadonlyMap<string, LiveWireModel>
}

const LIVE_GEMINI_FAMILIES = {
  'antigravity-gemini-4-hydrogen': 'Gemini 4 Hydrogen',
  'antigravity-gemini-4-neon': 'Gemini 4 Neon',
} as const

export function isLiveGeminiFamily(id: string): boolean {
  return Object.hasOwn(LIVE_GEMINI_FAMILIES, id)
}

function addLiveGeminiFamilies(catalog: Map<string, LiveProxyModel>, live: ReadonlySet<string>): void {
  for (const [id, name] of Object.entries(LIVE_GEMINI_FAMILIES)) {
    const variants = new Map<string, string>()
    for (const effort of [...PROXY_MODEL_EFFORTS, 'xhigh']) {
      const wire = `${id.slice('antigravity-'.length)}-${effort}`
      if (live.has(wire)) variants.set(effort, wire)
    }
    const defaultWire = variants.get('medium') ?? variants.values().next().value
    if (defaultWire !== undefined) catalog.set(id, { defaultWire, efforts: [], liveGemini: { name, variants } })
  }
}

export function parseLiveProxyCatalog(value: unknown, definitions: ReturnType<typeof getPublicModelDefinitions>): LiveProxyCatalog {
  const root = isRecord(value) && isRecord(value.response) ? value.response : value
  if (!isRecord(root) || !isRecord(root.models)) throw invalidCatalog()
  const entries = Object.entries(root.models)
  if (entries.length > 512) throw llmError('代理模式模型目录超出模型数量上限', 'PROTOCOL_DRIFT')
  const live = new Set<string>()
  const disabled = new Set<string>()
  const metadata = new Map<string, LiveWireModel>()
  for (const [id, row] of entries) {
    if (!safeModelId(id) || !isRecord(row)) throw invalidCatalog()
    if (row.disabled === true) {
      disabled.add(cleanModelId(id))
      continue
    }
    const wire = cleanModelId(id)
    if (isNonChatModel(wire)) continue
    live.add(wire)
    const contextWindow = positiveInteger(row.maxTokens)
    const maxOutputTokens = positiveInteger(row.maxOutputTokens)
    metadata.set(wire, {
      ...(typeof row.supportsImages === 'boolean' ? { supportsImages: row.supportsImages } : {}),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    })
    if (row.modelName !== undefined) {
      if (!safeModelId(row.modelName)) throw invalidCatalog()
      const alias = cleanModelId(row.modelName)
      if (!isNonChatModel(alias)) live.add(alias)
    }
    if (row.displayName !== undefined && (typeof row.displayName !== 'string' || row.displayName.length > 512)) throw invalidCatalog()
  }
  for (const id of disabled) { live.delete(id); metadata.delete(id) }

  const catalog = new Map<string, LiveProxyModel>()
  for (const definition of Object.values(definitions)) {
    if (!isProxyChatDefinition(definition)) continue
    const id = definition.id
    const preferred = resolveProxyWireModel(id)
    const variants = PROXY_MODEL_EFFORTS.map(effort => ({ effort, wire: resolveProxyWireModel(id, effort) }))
    // A fixed-effort model resolves every effort to the same wire ID.
    const available = new Set(variants.map(({ wire }) => wire)).size > 1
      ? variants.filter(({ wire }) => live.has(wire)) : []
    const bare = id.replace(/^antigravity-/u, '')
    const aliases = bare === 'gemini-3.5-flash' ? [bare, 'gemini-3-flash']
      : bare === 'gemini-3.8-flash' ? [bare, 'gemini-3.8-flash-tiered'] : [bare]
    // A bare family is evidence for that ID only, not for all of its variants.
    const defaultWire = live.has(preferred) ? preferred
      : available[0]?.wire ?? aliases.find(alias => live.has(alias))
    if (defaultWire !== undefined) catalog.set(id, { defaultWire, efforts: available.map(({ effort }) => effort) })
  }
  addLiveGeminiFamilies(catalog, live)
  return { models: catalog, wire: metadata }
}

export function isProxyChatDefinition(definition: ReturnType<typeof getPublicModelDefinitions>[string]): boolean {
  return definition.modalities.output.includes('text') && !isNonChatModel(definition.id)
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function cleanModelId(value: string): string {
  return value.replace(/^(?:publishers\/[^/]+\/)?models\//u, '').replace(/^antigravity-/u, '')
}

function safeModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalidCatalog() {
  return llmError('代理模式模型目录不符合预期结构', 'PROTOCOL_DRIFT')
}

type OrchestratorCapacity = Pick<ModelCapacity, 'contextWindow' | 'maxOutputTokens'>

export interface ProxyOrchestratorEndpoint extends OrchestratorCapacity {
  readonly familyId: string
  readonly wire: string
  readonly effort?: ModelEffort | 'xhigh'
  readonly availableEfforts: readonly (ModelEffort | 'xhigh')[]
  /** Common bound across all advertised tiers, or just the exact wire for a fixed target. */
  readonly sharedCapacity: OrchestratorCapacity
  readonly supportsImages: boolean
}

export interface ResolvedProxyOrchestrator extends OrchestratorCapacity {
  readonly planner: ProxyOrchestratorEndpoint
  readonly executor: ProxyOrchestratorEndpoint
}

export function toProxyFamilyId(model: string): string {
  const trimmed = model.trim()
  return trimmed.startsWith('antigravity-') ? trimmed : `antigravity-${trimmed}`
}

type ProxyDefinitions = ReturnType<typeof getPublicModelDefinitions>

export function isNonChatProxyWire(wire: string, definitions: ProxyDefinitions): boolean {
  return isNonChatModel(wire) || Object.values(definitions).some(def => !isProxyChatDefinition(def) && resolveProxyWireModel(def.id) === wire)
}

export function proxyDefinitionForWire(wire: string, definitions: ProxyDefinitions): ProxyDefinitions[string] | undefined {
  return Object.values(definitions).find(def => isProxyChatDefinition(def)
    && [undefined, ...PROXY_MODEL_EFFORTS].some(tier => resolveProxyWireModel(def.id, tier) === wire))
}

/** A target pins the observed wire; without one, converge to an observed tier. */
export function resolveProxyOrchestratorEndpoint(
  model: string,
  effort: ModelEffort | 'xhigh',
  catalog: LiveProxyCatalog | undefined,
  definitions: ProxyDefinitions,
  modelSettings?: ReadonlyMap<string, ModelSetting>,
): ProxyOrchestratorEndpoint | undefined {
  if (catalog === undefined) return undefined
  const familyId = toProxyFamilyId(model)
  const observed = catalog.models.get(familyId)
  if (observed === undefined) return undefined
  const definition = definitions[familyId]
  if (observed.liveGemini === undefined && (definition === undefined || !isProxyChatDefinition(definition))) return undefined

  const target = modelSettings?.get(familyId)?.target
  if (target !== undefined) {
    if (!safeModelId(target) || isNonChatProxyWire(target, definitions)) {
      throw llmError(`编排模型 ${familyId} 的映射不是有效的文本模型`, 'INVALID_MODEL')
    }
    const liveWire = catalog.wire.get(target)
    if (liveWire === undefined) {
      throw llmError(`编排模型 ${familyId} 的映射目标不在当前目录`, 'INVALID_MODEL')
    }
    const routed = proxyDefinitionForWire(target, definitions)
    const targetEffort = mappedWireEffort(target, catalog, routed)
    const { supportsImages, ...capacity } = wireCapabilities(target, liveWire, routed)
    return { familyId, wire: target, ...(targetEffort === undefined ? {} : { effort: targetEffort }),
      availableEfforts: [], ...capacity, sharedCapacity: capacity, supportsImages }
  }

  const tiers: readonly (ModelEffort | 'xhigh')[] = observed.liveGemini !== undefined
    ? [...PROXY_MODEL_EFFORTS, 'xhigh'] : observed.efforts.length > 0 ? observed.efforts : PROXY_MODEL_EFFORTS
  const candidates = tiers
    .flatMap(tier => {
      const wire = observed.liveGemini === undefined
        ? resolveProxyWireModel(familyId, tier) : observed.liveGemini.variants.get(tier)
      if (wire === undefined || isNonChatProxyWire(wire, definitions)) return []
      const liveWire = catalog.wire.get(wire)
      return liveWire === undefined ? [] : [{ wire, effort: tier, ...wireCapabilities(wire, liveWire, definition) }]
    })
  const availableEfforts = candidates.map(candidate => candidate.effort)
  const effectiveEffort = convergeOrchestratorEffort(effort, availableEfforts)
  const selected = candidates.find(candidate => candidate.effort === effectiveEffort)
  if (selected === undefined) return undefined
  return { familyId, ...selected, availableEfforts, sharedCapacity: commonCapacity(candidates) }
}

function mappedWireEffort(wire: string, catalog: LiveProxyCatalog, definition?: ProxyDefinitions[string]): ModelEffort | undefined {
  return PROXY_MODEL_EFFORTS.find(tier => definition !== undefined
    ? resolveProxyWireModel(definition.id, tier) === wire
      && PROXY_MODEL_EFFORTS.some(other => resolveProxyWireModel(definition.id, other) !== wire)
    : Array.from(catalog.models.values()).some(row => row.liveGemini?.variants.get(tier) === wire))
}

function wireCapabilities(wire: string, liveWire: LiveWireModel, definition?: ProxyDefinitions[string]) {
  const native = getAgyNativeModel(wire)
  return {
    contextWindow: liveWire.contextWindow ?? native?.maxTokens ?? definition?.limit.context,
    maxOutputTokens: liveWire.maxOutputTokens ?? native?.maxOutputTokens ?? definition?.limit.output,
    supportsImages: liveWire.supportsImages ?? (definition?.modalities.input.includes('image') === true),
  }
}

function commonCapacity(models: readonly OrchestratorCapacity[]): OrchestratorCapacity {
  const minimum = (key: keyof OrchestratorCapacity) => {
    const values = models.map(model => model[key]).filter(value => value !== undefined)
    return values.length > 0 && values.length === models.length ? Math.min(...values) : undefined
  }
  const contextWindow = minimum('contextWindow')
  const maxOutputTokens = minimum('maxOutputTokens')
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
}

export function resolveProxyOrchestrator(
  settings: OrchestratorSettings,
  catalog: LiveProxyCatalog | undefined,
  definitions: ReturnType<typeof getPublicModelDefinitions>,
  plannerEffort: ModelEffort | 'xhigh' = settings.plannerEffort,
  executorEffort: ModelEffort = settings.executorEffort,
  modelSettings?: ReadonlyMap<string, ModelSetting>,
): ResolvedProxyOrchestrator | undefined {
  if (!settings.enabled) return undefined
  const planner = resolveProxyOrchestratorEndpoint(settings.plannerModel, plannerEffort, catalog, definitions, modelSettings)
  const executor = resolveProxyOrchestratorEndpoint(settings.executorModel, executorEffort, catalog, definitions, modelSettings)
  if (planner === undefined || executor === undefined) return undefined
  // Planner effort can change on each request; the executor remains on its configured wire.
  return { planner, executor, ...commonCapacity([planner.sharedCapacity, executor]) }
}

/**
 * 仅当编排启用且 planner / executor 两条 wire 都在 live 目录与受支持模型集合中时，
 * 合成 `antigravity-orchestrator` 目录条目；否则返回 undefined，不影响其它条目。
 */
export function synthesizeProxyOrchestratorModel(options: {
  settings: OrchestratorSettings
  catalog: LiveProxyCatalog
  definitions: ReturnType<typeof getPublicModelDefinitions>
  attachmentsAvailable: boolean
  modelSettings?: ReadonlyMap<string, ModelSetting>
  plannerEffort?: ModelEffort | 'xhigh'
  executorEffort?: ModelEffort
  resolved?: ResolvedProxyOrchestrator
}): (LlmModelInfo & ModelCapacity) | undefined {
  if (!options.settings.enabled) return undefined
  let resolved = options.resolved
  if (resolved === undefined) {
    try {
      resolved = resolveProxyOrchestrator(
        options.settings, options.catalog, options.definitions, options.plannerEffort, options.executorEffort, options.modelSettings,
      )
    } catch (error) {
      if (error instanceof LlmError && error.code === 'INVALID_MODEL') return undefined
      throw error
    }
  }
  if (resolved === undefined) return undefined
  const acceptsImages = options.attachmentsAvailable && resolved.executor.supportsImages
  const name = options.modelSettings !== undefined
    ? modelDisplayName(options.modelSettings, ORCHESTRATOR_MODEL_ID, ORCHESTRATOR_MODEL_NAME)
    : ORCHESTRATOR_MODEL_NAME
  return {
    provider: PROXY_PROVIDER_ID,
    id: ORCHESTRATOR_MODEL_ID,
    name,
    inputModalities: acceptsImages ? ['text', 'image'] : ['text'],
    contextWindow: resolved.contextWindow,
    maxOutputTokens: resolved.maxOutputTokens,
  }
}
