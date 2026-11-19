/** Parse the account's live catalog and intersect it with the pinned proxy definitions. */
import type { getPublicModelDefinitions } from '@cortexkit/antigravity-auth-core'
import type { ModelEffort } from '../adapter/model-settings.js'
import { llmError } from '../runtime/llm-error.js'
import { resolveProxyWireModel } from './payload.js'

export const PROXY_MODEL_EFFORTS: readonly ModelEffort[] = ['low', 'medium', 'high']

export interface LiveProxyModel {
  readonly defaultWire: string
  readonly efforts: readonly ModelEffort[]
  readonly liveGemini?: { readonly name: string; readonly variants: ReadonlyMap<string, string> }
}

export type LiveProxyCatalog = ReadonlyMap<string, LiveProxyModel>

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
  for (const [id, row] of entries) {
    if (!safeModelId(id) || !isRecord(row)) throw invalidCatalog()
    if (row.disabled === true) {
      disabled.add(cleanModelId(id))
      continue
    }
    live.add(cleanModelId(id))
    if (row.modelName !== undefined) {
      if (!safeModelId(row.modelName)) throw invalidCatalog()
      live.add(cleanModelId(row.modelName))
    }
    if (row.displayName !== undefined && (typeof row.displayName !== 'string' || row.displayName.length > 512)) throw invalidCatalog()
  }
  for (const id of disabled) live.delete(id)

  const catalog = new Map<string, LiveProxyModel>()
  for (const definition of Object.values(definitions)) {
    if (definition.modalities.output.includes('image')) continue
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
  return catalog
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
