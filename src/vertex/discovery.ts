import { llmError } from '../runtime/llm-error.js'
import { ProxyTransportError, readProxyText } from '../proxy/transport.js'
import { isVertexPublisherModel } from './endpoints.js'

const PUBLISHER_MODELS_URL = 'https://aiplatform.googleapis.com/v1beta1/publishers/google/models'
const MODEL_PREFIX = 'publishers/google/models/'
const PAGE_SIZE = 100
const MAX_PAGES = 20
const MAX_MODELS = 512
const MAX_PAGE_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 30_000

interface DiscoveryOptions {
  project: string
  token: string
  signal: AbortSignal
  fetch: typeof fetch
  /** Recheck saved scope on async continuation as well as on bus notifications. */
  checkScope(): void
}

export async function discoverVertexModels(options: DiscoveryOptions): Promise<readonly string[]> {
  const deadline = AbortSignal.timeout(TIMEOUT_MS)
  const signal = AbortSignal.any([options.signal, deadline])
  const models = new Set<string>()
  const pages = new Set<string>()
  let pageToken: string | undefined
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      options.checkScope()
      signal.throwIfAborted()
      const result = await fetchPage(options, signal, pageToken)
      options.checkScope()
      signal.throwIfAborted()
      result.ids.forEach(id => models.add(id))
      if (models.size > MAX_MODELS) throw limitError()
      pageToken = result.nextPageToken
      if (pageToken === undefined) return [...models].sort()
      if (pages.has(pageToken)) throw new CatalogError(llmError('Vertex AI 模型目录分页游标重复', 'PROTOCOL_DRIFT'))
      pages.add(pageToken)
    }
    throw limitError()
  } catch (error) {
    options.checkScope()
    if (options.signal.aborted) throw llmError('Vertex AI 模型目录请求已取消', 'CANCELLED')
    if (deadline.aborted || (error instanceof ProxyTransportError && error.code === 'timeout')) throw llmError('Vertex AI 模型目录请求超时', 'TIMEOUT')
    if (error instanceof ProxyTransportError && error.code === 'response-too-large') throw llmError('Vertex AI 模型目录响应超过大小上限', 'REQUEST_LIMIT')
    if (error instanceof CatalogError) throw error.failure
    throw llmError('Vertex AI 模型目录请求失败，请检查网络或代理配置', 'TRANSPORT')
  }
}

async function fetchPage(options: DiscoveryOptions, signal: AbortSignal, pageToken: string | undefined) {
  const url = new URL(PUBLISHER_MODELS_URL)
  url.searchParams.set('pageSize', String(PAGE_SIZE))
  if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken)
  const response = await options.fetch(url.href, {
    method: 'GET', redirect: 'error', signal,
    headers: { authorization: `Bearer ${options.token}`, 'x-goog-user-project': options.project, accept: 'application/json' },
  })
  if (signal.aborted || !response.ok) {
    void response.body?.cancel().catch(() => undefined)
    signal.throwIfAborted()
    throw statusError(response.status)
  }
  const text = await readProxyText(response, { signal, maxBytes: MAX_PAGE_BYTES, totalTimeoutMs: TIMEOUT_MS })
  let value: unknown
  try { value = JSON.parse(text) } catch { throw protocolError() }
  return parsePage(value)
}

function parsePage(value: unknown): { ids: string[]; nextPageToken?: string } {
  const page = record(value)
  if (page === undefined || (page.publisherModels !== undefined && !Array.isArray(page.publisherModels))) throw protocolError()
  const nextPageToken = page.nextPageToken
  if (nextPageToken !== undefined && (typeof nextPageToken !== 'string' || nextPageToken.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(nextPageToken))) throw protocolError()
  const ids = (page.publisherModels ?? []).flatMap((entry: unknown) => {
    const id = publisherGeminiId(entry)
    return id === undefined ? [] : [id]
  })
  return { ids, ...(nextPageToken ? { nextPageToken } : {}) }
}

function publisherGeminiId(value: unknown): string | undefined {
  const row = record(value)
  const name = row?.name
  if (typeof name !== 'string' || !name.startsWith(MODEL_PREFIX)) return undefined
  // Model Garden's @version is a catalog revision, not a Gemini generation alias.
  const match = /^([^@]+)(?:@[0-9]{1,32})?$/u.exec(name.slice(MODEL_PREFIX.length))
  const id = match?.[1]
  if (id === undefined || !isVertexPublisherModel(id)) return undefined
  // Model Garden supportedActions is a CallToAction object, not a list of inference APIs.
  if (Array.isArray(row?.supportedGenerationMethods) && !row.supportedGenerationMethods.some(method => method === 'generateContent' || method === 'streamGenerateContent')) return undefined
  if (Array.isArray(row?.outputModalities) && !row.outputModalities.some(modality => typeof modality === 'string' && modality.toUpperCase() === 'TEXT')) return undefined
  return id
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Avoid echoing upstream response bodies, URLs, pagination tokens or auth headers. */
class CatalogError extends Error {
  constructor(readonly failure: ReturnType<typeof llmError>) { super(failure.message) }
}

function limitError(): CatalogError {
  return new CatalogError(llmError('Vertex AI 模型目录超过读取上限，请手动填写模型 ID', 'REQUEST_LIMIT'))
}

function protocolError(): CatalogError {
  return new CatalogError(llmError('Vertex AI 模型目录响应格式无效', 'PROTOCOL_DRIFT'))
}

function statusError(status: number): CatalogError {
  const code = status === 401 ? 'AUTH' : status === 403 ? 'FORBIDDEN' : status === 429 ? 'RATE_LIMIT' : 'UPSTREAM'
  const guidance = status === 401 ? '；请检查应用默认凭据' : status === 403 ? '；请检查所选项目的 Vertex AI API 与 serviceusage.services.use 权限' : ''
  return new CatalogError(llmError(`Vertex AI 模型目录请求失败（${status}）${guidance}`, code, { status }))
}
