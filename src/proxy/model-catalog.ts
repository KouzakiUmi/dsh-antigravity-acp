/** Parse the account's live catalog and intersect it with the pinned proxy definitions. */
import { getAgyNativeModel } from '@cortexkit/antigravity-auth-core'
import type { getPublicModelDefinitions } from '@cortexkit/antigravity-auth-core'
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

export interface ProxyOrchestratorEndpoint {
  readonly familyId: string
  readonly wire: string
  readonly effort: ModelEffort
  readonly availableEfforts: readonly ModelEffort[]
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly supportsImagesFallback: boolean
}

export interface ResolvedProxyOrchestrator {
  readonly planner: ProxyOrchestratorEndpoint
  readonly executor: ProxyOrchestratorEndpoint
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
}

export function toProxyFamilyId(model: string): string {
  const trimmed = model.trim()
  return trimmed.startsWith('antigravity-') ? trimmed : `antigravity-${trimmed}`
}

/**
 * 解析编排端点：从 live 目录读取该家族实际可用档位集合并收敛期望档位，
 * 若期望档位不在 live 集合内则收敛到 `medium` 或最近可用档位。
 */
export function resolveProxyOrchestratorEndpoint(
  model: string,
  effort: ModelEffort,
  catalog: LiveProxyCatalog | undefined,
  definitions: ReturnType<typeof getPublicModelDefinitions>,
): ProxyOrchestratorEndpoint | undefined {
  if (catalog === undefined) return undefined
  const familyId = toProxyFamilyId(model)
  if (isLiveGeminiFamily(familyId)) {
    const observed = catalog.models.get(familyId)
    if (observed?.liveGemini === undefined) return undefined
    const variants = observed.liveGemini.variants
    const availableEfforts = PROXY_MODEL_EFFORTS.filter((candidate) => {
      const w = variants.get(candidate)
      return w !== undefined && catalog.wire.has(w)
    })
    const converged = convergeOrchestratorEffort(effort, availableEfforts) as ModelEffort | undefined
    if (converged === undefined) return undefined
    const wire = variants.get(converged)
    if (wire === undefined) return undefined
    const liveWire = catalog.wire.get(wire)
    if (liveWire === undefined) return undefined
    return {
      familyId,
      wire,
      effort: converged,
      availableEfforts,
      ...(liveWire.contextWindow === undefined ? {} : { contextWindow: liveWire.contextWindow }),
      ...(liveWire.maxOutputTokens === undefined ? {} : { maxOutputTokens: liveWire.maxOutputTokens }),
      supportsImagesFallback: false,
    }
  }
  const definition = definitions[familyId]
  if (definition === undefined || !isProxyChatDefinition(definition)) return undefined
  const observed = catalog.models.get(familyId)
  const definitionEfforts = PROXY_MODEL_EFFORTS.filter((candidate) => catalog.wire.has(resolveProxyWireModel(familyId, candidate)))
  const availableEfforts = observed && observed.efforts.length > 0
    ? observed.efforts.filter((candidate) => catalog.wire.has(resolveProxyWireModel(familyId, candidate)))
    : definitionEfforts
  const converged = convergeOrchestratorEffort(effort, availableEfforts) as ModelEffort | undefined
  if (converged === undefined) return undefined
  const wire = resolveProxyWireModel(familyId, converged)
  if (isNonChatModel(wire) || Object.values(definitions).some(def => !isProxyChatDefinition(def) && resolveProxyWireModel(def.id) === wire)) {
    return undefined
  }
  const liveWire = catalog.wire.get(wire)
  if (liveWire === undefined) return undefined
  const native = getAgyNativeModel(wire)
  const contextWindow = liveWire.contextWindow ?? native?.maxTokens ?? definition.limit.context
  const maxOutputTokens = liveWire.maxOutputTokens ?? native?.maxOutputTokens ?? definition.limit.output
  return {
    familyId,
    wire,
    effort: converged,
    availableEfforts,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    supportsImagesFallback: definition.modalities.input.includes('image'),
  }
}

export function resolveProxyOrchestrator(
  settings: OrchestratorSettings,
  catalog: LiveProxyCatalog | undefined,
  definitions: ReturnType<typeof getPublicModelDefinitions>,
  plannerEffort: ModelEffort = settings.plannerEffort,
  executorEffort: ModelEffort = settings.executorEffort,
): ResolvedProxyOrchestrator | undefined {
  if (!settings.enabled) return undefined
  const planner = resolveProxyOrchestratorEndpoint(settings.plannerModel, plannerEffort, catalog, definitions)
  const executor = resolveProxyOrchestratorEndpoint(settings.executorModel, executorEffort, catalog, definitions)
  if (planner === undefined || executor === undefined) return undefined
  const contextWindow = planner.contextWindow !== undefined && executor.contextWindow !== undefined
    ? Math.min(planner.contextWindow, executor.contextWindow)
    : undefined
  const maxOutputTokens = planner.maxOutputTokens !== undefined && executor.maxOutputTokens !== undefined
    ? Math.min(planner.maxOutputTokens, executor.maxOutputTokens)
    : undefined
  return {
    planner,
    executor,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
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
  plannerEffort?: ModelEffort
  executorEffort?: ModelEffort
}): (LlmModelInfo & ModelCapacity) | undefined {
  const resolved = resolveProxyOrchestrator(
    options.settings,
    options.catalog,
    options.definitions,
    options.plannerEffort ?? options.settings.plannerEffort,
    options.executorEffort ?? options.settings.executorEffort,
  )
  if (resolved === undefined) return undefined
  const liveExecutor = options.catalog.wire.get(resolved.executor.wire)
  const acceptsImages = options.attachmentsAvailable
    && (liveExecutor?.supportsImages ?? resolved.executor.supportsImagesFallback)
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
