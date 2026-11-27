/**
 * AI Studio 的 LlmAdapter：provider 路由 `aistudio`。
 *
 * 独立 provider，与 ACP / 代理两条互斥链路并存（服务不同的 Gemini 模型），
 * 不参与模式仲裁。标准 Google REST API（generativelanguage.googleapis.com），
 * 鉴权经 `x-goog-api-key` 请求头（key 不进 URL/日志），出网用代理感知 fetch。
 *
 * - 凭据经宿主 credentials 接缝按操作解析（引用名 → 值），本 adapter 只收解析闭包；
 * - 模型目录 = `GET /v1beta/models` 实时发现（5min TTL，失败保留已观测目录）；
 * - 流式块组装与 finish/错误映射复用端点无关的 gemini-stream 共享层；
 * - 首期文本模态：图片输入报 UNSUPPORTED_MODALITY，思考块按上游真实签名保留。
 *
 * 单 key 语义：429 直接报 RATE_LIMIT 交宿主重试策略；不做多 key 轮转或 OAuth 换发。
 */
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AdapterPreparedCall, AdapterRequestOptions } from '../adapter/request-options.js'
import { modelDisplayName, modelSettingFor, modelVisible, normalizeModelSettings } from '../adapter/model-settings.js'
import type { ModelCapacity, ModelSetting } from '../adapter/model-settings.js'
import { assembleGeminiStream, containsControl, createGeminiBlockAssembler } from '../proxy/gemini-stream.js'
import { readProxyText } from '../proxy/transport.js'
import { llmError } from '../runtime/llm-error.js'
import type { ModelOverride } from '../settings.js'
import { buildAistudioPayload } from './payload.js'
import { parseAistudioModels } from './discovery.js'
import type { AistudioModel } from './discovery.js'
import { createAistudioReplayState } from './replay.js'
import type { AistudioReplayBlock } from './replay.js'
import { AISTUDIO_PROVIDER_ID, aistudioDefaultEnabled, aistudioModelsUrl, aistudioStreamUrl, aistudioWireModel } from './endpoints.js'
import { inspectAistudioEvent, readAistudioError, redactAistudioError } from './response-observation.js'
import { AistudioUsageStore } from './usage.js'
import type { AistudioUsageResult } from './usage.js'

const AISTUDIO_BLOCKS = createGeminiBlockAssembler({ label: 'AI Studio', idPrefix: 'aistudio' })
const { finishChunk, mapFinishReason, safeProviderErrorCode } = AISTUDIO_BLOCKS

const AISTUDIO_IDLE_TIMEOUT_MS = 240_000
const AISTUDIO_TOTAL_TIMEOUT_MS = 600_000
const AISTUDIO_STREAM_RESPONSE_BYTES = 64 * 1024 * 1024
const AISTUDIO_FRAME_BYTES = 2 * 1024 * 1024
const AISTUDIO_RESPONSE_BYTES = 8 * 1024 * 1024
const CATALOG_TTL_MS = 5 * 60_000
const MAX_CATALOG_MODELS = 1000
const MAX_CATALOG_PAGES = 20

export interface AistudioAdapterOptions {
  /** 按操作解析 API key（宿主 credentials 接缝）；未配置返回 undefined。 */
  credential: (signal?: AbortSignal) => Promise<string | undefined>
  /** 代理感知 fetch（createLiveProxiedFetch）。 */
  fetch: typeof fetch
  dispatch?: (input: string, init: RequestInit, onDispatch: () => void) => Promise<Response>
  readSettings?: () => { modelOverrides?: Record<string, ModelOverride> } | undefined
  log?: { warn: (message: string, error?: unknown) => void }
}

export class AistudioAdapter extends LlmAdapter {
  private catalog: Map<string, AistudioModel> | undefined
  private catalogExpiresAt = 0
  private catalogDigest: string | undefined
  private catalogVersion = 0
  private readonly usage = new AistudioUsageStore()
  private credentialVersion = 0
  private readSequence = 0
  private resolvedSequence = 0
  private activeDigest: string | undefined
  private credentialEpoch = 0

  constructor(private readonly options: AistudioAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    if (provider !== AISTUDIO_PROVIDER_ID) throw new LlmError('未知的 AI Studio 路由', 'NO_ADAPTER')
    return { id: AISTUDIO_PROVIDER_ID, name: 'Google AI Studio' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return resolveRetryPolicy({
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['EMPTY_RESPONSE', 'TIMEOUT', 'TRANSPORT', 'UPSTREAM'],
      backoff: { initialDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0.1 },
    }, AISTUDIO_PROVIDER_ID)
  }

  /** 凭据引用或设置变化后丢弃目录缓存。 */
  invalidateModelCatalog(): void {
    this.catalogVersion += 1
    this.catalog = undefined
    this.catalogExpiresAt = 0
  }

  invalidateCredential(key?: string): void {
    this.credentialVersion += 1
    const digest = key === undefined ? undefined : this.usage.fingerprint(key)
    if (this.activeDigest !== digest) this.credentialEpoch += 1
    this.activeDigest = digest
    this.usage.activate(this.activeDigest)
    this.invalidateModelCatalog()
  }

  async readUsage(): Promise<AistudioUsageResult> {
    try {
      const { epoch } = await this.readKey()
      if (epoch !== this.credentialEpoch) return { status: 'error' }
      return this.usage.snapshot()
    } catch (error) {
      return { status: error instanceof LlmError && error.code === 'AUTH' ? 'unconfigured' : 'error' }
    }
  }

  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    this.providerInfo(provider)
    const settings = this.settings()
    const catalog = await this.readCatalogSafe(signal, false)
    return this.modelInfos(catalog, settings).filter(model => modelVisible(settings, model.id, aistudioDefaultEnabled))
  }

  async discoverModels(force = false, signal?: AbortSignal): Promise<readonly (LlmModelInfo & ModelCapacity)[]> {
    const settings = this.settings()
    const catalog = await this.readCatalog(signal, force)
    return this.modelInfos(catalog, settings)
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    this.providerInfo(provider)
    this.validateModelId(model)
    const settings = this.settings()
    const catalog = await this.readCatalogSafe(signal, false)
    return this.resolveInCatalog(model, settings, catalog)
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<AdapterPreparedCall> {
    this.providerInfo(provider)
    this.validateModelId(model)
    const settings = this.settings()
    const catalog = await this.readCatalogSafe(signal, false)
    const resolved = this.resolveInCatalog(model, settings, catalog)
    const wireModel = this.wireModel(model, settings)
    return { model: resolved, stream: options => this.streamCall(options, wireModel) }
  }

  override async *stream(options: AdapterRequestOptions): AsyncIterable<StreamChunk> {
    this.providerInfo(options.provider)
    this.validateModelId(options.model)
    const wireModel = this.wireModel(options.model, this.settings())
    yield* this.streamCall(options, wireModel)
  }

  private settings(): Map<string, ModelSetting> {
    return normalizeModelSettings(this.options.readSettings?.()?.modelOverrides, aistudioDefaultEnabled)
  }

  private validateModelId(model: string): void {
    if (typeof model !== 'string' || model.trim().length === 0 || model.length > 256) throw llmError('AI Studio 模型 id 无效', 'INVALID_MODEL')
  }

  private wireModel(model: string, settings: Map<string, ModelSetting>): string {
    const setting = modelSettingFor(settings, model, aistudioDefaultEnabled)
    const wire = setting.target !== undefined ? setting.target : aistudioWireModel(model)
    if (wire.length === 0 || wire.length > 256 || containsControl(wire)) throw llmError('AI Studio 模型映射无效', 'INVALID_MODEL')
    return wire
  }

  private resolveInCatalog(model: string, settings: Map<string, ModelSetting>, catalog: Map<string, AistudioModel>): LlmResolvedModelInfo {
    const entry = catalog.get(model)
    if (entry === undefined) throw llmError('该模型不在 AI Studio 当前目录内', 'INVALID_MODEL')
    return {
      provider: AISTUDIO_PROVIDER_ID,
      id: model,
      name: modelDisplayName(settings, model, entry.name),
      inputModalities: ['text'],
      ...(entry.contextWindow === undefined ? {} : { context: { contextWindow: entry.contextWindow } }),
      ...(entry.maxOutputTokens === undefined ? {} : { defaultMaxTokens: entry.maxOutputTokens }),
    }
  }

  private modelInfos(catalog: Map<string, AistudioModel>, settings: Map<string, ModelSetting>): (LlmModelInfo & ModelCapacity)[] {
    return [...catalog.values()].map(entry => ({
      provider: AISTUDIO_PROVIDER_ID,
      id: entry.catalogId,
      name: modelDisplayName(settings, entry.catalogId, entry.name),
      inputModalities: ['text'] as const,
      ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow, contextWindowSource: 'observed' as const }),
      ...(entry.maxOutputTokens === undefined ? {} : { maxOutputTokens: entry.maxOutputTokens }),
    }))
  }

  private async readKey(signal?: AbortSignal): Promise<{ key: string; digest: string; epoch: number }> {
    if (signal?.aborted) throw llmError('AI Studio 请求已取消', 'CANCELLED')
    const version = this.credentialVersion
    const sequence = ++this.readSequence
    let key: string | undefined
    try {
      key = (await this.options.credential(signal))?.trim() || undefined
    } catch {
      if (signal?.aborted) throw llmError('AI Studio 请求已取消', 'CANCELLED')
      if (version === this.credentialVersion && sequence >= this.resolvedSequence) {
        this.resolvedSequence = sequence
        this.invalidateCredential()
      }
      throw llmError('AI Studio 凭据读取失败', 'TRANSPORT')
    }
    const digest = key === undefined ? undefined : this.usage.fingerprint(key)
    if (signal?.aborted || version !== this.credentialVersion || (sequence < this.resolvedSequence && digest !== this.activeDigest)) {
      throw llmError('AI Studio 请求已取消', 'CANCELLED')
    }
    if (sequence >= this.resolvedSequence) {
      this.resolvedSequence = sequence
      if (this.activeDigest !== digest) {
        this.credentialEpoch += 1
        this.invalidateModelCatalog()
      }
      this.activeDigest = digest
      this.usage.activate(digest)
    }
    if (key === undefined || digest === undefined) throw llmError('AI Studio 未配置 API key；请在设置页填写凭据引用', 'AUTH')
    return { key, digest, epoch: this.credentialEpoch }
  }

  private async readCatalogSafe(signal: AbortSignal | undefined, force: boolean): Promise<Map<string, AistudioModel>> {
    try {
      return await this.readCatalog(signal, force)
    } catch (error) {
      if (error instanceof LlmError && (error.code === 'AUTH' || error.code === 'CANCELLED')) throw error
      if (this.catalog !== undefined && this.catalogDigest === this.activeDigest) {
        this.options.log?.warn('antigravity-aistudio: 模型目录刷新失败，保留已观测目录', error)
        return this.catalog
      }
      throw error
    }
  }

  private async readCatalog(signal?: AbortSignal, force = false): Promise<Map<string, AistudioModel>> {
    const { key, digest, epoch } = await this.readKey(signal)
    const version = this.catalogVersion
    if (epoch !== this.credentialEpoch) throw llmError('AI Studio 凭据或设置已变更', 'CANCELLED')
    if (!force && this.catalogDigest === digest && this.catalog !== undefined && Date.now() < this.catalogExpiresAt) return this.catalog
    const models = new Map<string, AistudioModel>()
    let pageToken: string | undefined
    let pages = 0
    do {
      if (signal?.aborted) throw llmError('AI Studio 请求已取消', 'CANCELLED')
      const init: RequestInit = {
        method: 'GET', redirect: 'error',
        headers: { 'x-goog-api-key': key },
        ...(signal === undefined ? {} : { signal }),
      }
      let response: Response
      try { response = await this.options.fetch(aistudioModelsUrl(pageToken), init) } catch (error) { throw toAistudioError(error, key) }
      if (!response.ok) throw aistudioStatusError(response.status, (await readAistudioError(response, key, Date.now(), signal)).detail)
      const page = parseAistudioModels(await readBoundedJson(response))
      for (const model of page.models) {
        if (models.size >= MAX_CATALOG_MODELS) break
        models.set(model.catalogId, model)
      }
      pageToken = page.nextPageToken
      pages += 1
    } while (pageToken !== undefined && pages < MAX_CATALOG_PAGES && models.size < MAX_CATALOG_MODELS)
    if (digest !== this.activeDigest || version !== this.catalogVersion) throw llmError('AI Studio 凭据或设置已变更', 'CANCELLED')
    this.catalog = models
    this.catalogDigest = digest
    this.catalogExpiresAt = Date.now() + CATALOG_TTL_MS
    return models
  }

  private async *streamCall(options: AdapterRequestOptions, wireModel: string): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal?.aborted) { yield finishChunk('aborted', 'CANCELLED'); return }
    const { key, digest, epoch } = await this.readKey(signal)
    const payload = buildAistudioPayload(options, wireModel)
    const hasEmitted = { value: false }
    let attempt: ReturnType<AistudioUsageStore['start']>
    const onDispatch = () => {
      if (epoch !== this.credentialEpoch) throw llmError('AI Studio 凭据已变更', 'CANCELLED')
      attempt = this.usage.start(digest, wireModel.includes(key) ? null : wireModel)
    }
    const url = aistudioStreamUrl(wireModel)
    const init: RequestInit = {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(payload),
      ...(signal === undefined ? {} : { signal }),
    }
    let response: Response
    try {
      if (signal?.aborted) { yield finishChunk('aborted', 'CANCELLED'); return }
      if (this.options.dispatch !== undefined) response = await this.options.dispatch(url, init, onDispatch)
      else { onDispatch(); response = await this.options.fetch(url, init) }
    } catch (error) {
      if (signal?.aborted || (error instanceof LlmError && error.code === 'CANCELLED')) { yield finishChunk('aborted', 'CANCELLED'); return }
      throw toAistudioError(error, key)
    }
    if (!response.ok) {
      const at = Date.now()
      const observation = await readAistudioError(response, key, at, signal)
      if (response.status === 429 && attempt !== undefined) this.usage.record429(attempt, 'http', observation.rateLimit, at)
      throw aistudioStatusError(response.status, observation.detail)
    }
    yield* this.streamResponse(response, options, hasEmitted, wireModel, attempt)
  }

  private async *streamResponse(response: Response, options: AdapterRequestOptions, hasEmitted: { value: boolean }, wireModel: string, attempt: ReturnType<AistudioUsageStore['start']>): AsyncGenerator<StreamChunk, boolean> {
    let limitedFrame = false
    const { finish, eventError, states, sawDone } = yield* assembleGeminiStream(response, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      sse: {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        idleTimeoutMs: AISTUDIO_IDLE_TIMEOUT_MS,
        totalTimeoutMs: AISTUDIO_TOTAL_TIMEOUT_MS,
        maxBytes: AISTUDIO_STREAM_RESPONSE_BYTES,
        maxFrameBytes: AISTUDIO_FRAME_BYTES,
      },
      blocks: AISTUDIO_BLOCKS,
      hasEmitted,
      label: 'AI Studio',
      onEventData: (data: string) => {
        const { input, limited } = inspectAistudioEvent(data)
        limitedFrame ||= limited !== undefined
        if (attempt === undefined) return
        if (input !== undefined) this.usage.reportInput(attempt, input)
        if (limited !== undefined) this.usage.record429(attempt, 'sse', limited)
      },
    })
    if (eventError !== undefined) {
      const code = limitedFrame ? 'RATE_LIMIT' : eventError.contextWindowExceeded === true ? CONTEXT_WINDOW_EXCEEDED_CODE : safeProviderErrorCode(eventError.code, eventError.status)
      yield finishChunk('error', code, limitedFrame ? 429 : eventError.status)
      return false
    }
    if (options.signal?.aborted) { yield finishChunk('aborted', 'CANCELLED'); return false }
    if (mapFinishReason(finish) === 'error') {
      const known = new Set(['SAFETY', 'BLOCKLIST', 'ERROR', 'RECITATION', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'OTHER'])
      yield finishChunk('error', finish !== undefined && known.has(finish) ? finish : 'UPSTREAM')
      return false
    }
    if (states.length === 0) { yield finishChunk('error', 'EMPTY_RESPONSE'); return false }
    if (finish === undefined && !sawDone) throw new LlmError('AI Studio 响应流在完成标记之前结束', 'TRANSPORT')
    const replayBlocks: AistudioReplayBlock[] = states.map(state => ({ kind: state.kind, ...(state.signature === undefined ? {} : { signature: state.signature }) }))
    const reason = mapFinishReason(finish)
    yield finishChunk(reason === 'stop' && states.some(state => state.kind === 'tool-call') ? 'tool-calls' : reason, finish ?? 'STOP', undefined,
      createAistudioReplayState(options.model, finish, replayBlocks, wireModel))
    return reason !== 'error'
  }
}

/** 普通 fetch 错误 → LlmError（AI Studio 无 ProxyTransportError）。 */
function toAistudioError(error: unknown, key: string): LlmError {
  if (error instanceof Error && error.name === 'AbortError') return llmError('AI Studio 请求已取消', 'CANCELLED')
  return llmError(redactAistudioError(error instanceof Error ? error.message : String(error), key), error instanceof LlmError ? error.code : 'TRANSPORT')
}

/** 有界读取 JSON 响应体（目录/错误）；超限报 REQUEST_LIMIT。 */
async function readBoundedJson(response: Response): Promise<unknown> {
  const text = await readProxyText(response, { maxBytes: AISTUDIO_RESPONSE_BYTES, totalTimeoutMs: 30_000 })
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw llmError('AI Studio 响应不是合法 JSON', 'PROTOCOL_DRIFT')
  }
}

function aistudioStatusError(status: number, detail: string): LlmError {
  if (status === 400 && /context window|token limit|too many tokens|prompt is too long/iu.test(detail)) {
    return llmError('上下文超出 AI Studio 模型容量', CONTEXT_WINDOW_EXCEEDED_CODE, { status })
  }
  const code = safeProviderErrorCode(undefined, status)
  const suffix = detail.length > 0 ? `：${detail}` : ''
  return llmError(`AI Studio 上游错误（${String(status)}）${suffix}`, code, { status })
}
