/**
 * 代理模式的 LlmAdapter：provider 路由 `antigravity-proxy`。
 *
 * 与 ACP 模式（`antigravity-acp`）互斥注册：模式仲裁器（mode-arbiter）保证
 * 同一时刻只有一个路由在册。本 adapter 不 spawn 任何官方进程：
 * - 凭据来自 {@link ProxyCredentialSource}（CLI 导入 / loopback 登录 / 换发）；
 * - 请求经 {@link ProxyTransport} 的字面 agy 线形态直连 Cloud Code Assist；
 * - 模型目录 = core 审计快照 ∩ `fetchAvailableModels` 实况（30s TTL，失败仅保留同账户已观测目录）。
 *
 * 单账户语义：429 不做多账户轮转，直接报 `RATE_LIMIT` 让宿主重试策略处理；
 * 401/403 在未出块前换发一次凭据重试一次。
 */
import { getAgyNativeModel, getPublicModelDefinitions, resolveModelWithTier } from '@cortexkit/antigravity-auth-core'
import { createHash, randomUUID } from 'node:crypto'
import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  FinishReason,
  GenerateOptions,
  LlmImageRequestPricing,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReplayEnvelope,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { PROXY_PROVIDER_ID, createProxyReplayState, proxyModelFamily } from './replay.js'
import type { ProxyReplayBlock } from './replay.js'
import {
  buildProxyGeneratePayload,
  completeProxyExecution,
  createProxySessionStore,
  normalizeReasoningEffort,
  parseProxyProviderEvent,
  reportsContextWindowExceeded,
  resolveProxyWireModel,
} from './payload.js'
import type { ProxyProviderEvent, ProxyProviderPart } from './payload.js'
import { proxyImageRequestTarget, requiredProxyImageOffload } from './image.js'
import type { ProxyAttachmentReader } from './image.js'
import { iterateProxySse, proxyStatusError, readProxyText } from './transport.js'
import type { ProxyTransport } from './transport.js'
import { ProxyTransportError } from './transport.js'
import { PROXY_RESPONSE_HEADER_TIMEOUT_MS, PROXY_IDLE_TIMEOUT_MS, PROXY_TOTAL_TIMEOUT_MS, PROXY_RESPONSE_BYTES, PROXY_FRAME_BYTES } from './transport.js'
import type { ProxyCredential } from './account-store.js'
import type { AntigravityHostConfig } from '../settings.js'
import { modelDisplayName, modelSettingFor, modelVisible, normalizeModelSettings, resolveModelTarget } from '../adapter/model-settings.js'
import type { ModelSetting } from '../adapter/model-settings.js'

export { PROXY_PROVIDER_ID }

const STREAM_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'
const MODELS_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
const MODEL_CATALOG_TTL_MS = 30_000
const MAX_MODEL_CATALOG_BYTES = 256 * 1024
const MAX_NETWORK_RETRIES = 3

export interface ProxyCredentialSource {
  /** 取一份可用凭据；`forceRefresh` 表示先换发再返回。无登录态返回 undefined。 */
  credential(signal?: AbortSignal, options?: { forceRefresh?: boolean }): Promise<ProxyCredential | undefined>
}

/** 设置页读取当前代理路由的目录，手动刷新绕过目录缓存。 */
export interface ProxyModelCatalog {
  models(force: boolean): Promise<readonly LlmModelInfo[]>
}

export interface ProxyAdapterOptions {
  credential: ProxyCredentialSource
  transport?: ProxyTransport
  responseHeaderTimeoutMs?: number
  /** 宿主附件服务的惰性读取面；缺席时图片输入报 UNSUPPORTED_MODALITY，文本能力不受影响。 */
  attachments?: () => ProxyAttachmentReader | undefined
  readSettings?: () => Pick<AntigravityHostConfig, 'modelOverrides'>
  log?: { info(message: string): void; warn(message: string, error?: unknown): void }
}

interface ProxyGeneration {
  readonly settings: ReadonlyMap<string, ModelSetting>
  readonly attachments: ProxyAttachmentReader | undefined
}

interface BlockState {
  readonly index: number
  readonly kind: 'text' | 'reasoning' | 'tool-call'
  readonly id: ReturnType<typeof ToolCallId>
  name?: string
  text: string
  signature?: string
  argumentsComplete?: boolean
}

export class AntigravityProxyAdapter extends LlmAdapter {
  private readonly sessions = createProxySessionStore()
  private readonly definitions = getPublicModelDefinitions()
  private catalogKey: string | undefined
  private catalogRevision = 0
  private catalogLastGoodKey: string | undefined
  private catalogLastGoodIds: ReadonlySet<string> | undefined
  private catalogExpiresAt = 0
  private catalogModelIds = new Set<string>()
  private catalogFailureCode: string | undefined

  constructor(private readonly options: ProxyAdapterOptions & { transport: ProxyTransport }) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    if (provider !== PROXY_PROVIDER_ID) throw new LlmError('未知的代理模式路由', 'NO_ADAPTER')
    return { id: PROXY_PROVIDER_ID, name: 'Antigravity（代理模式）' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return resolveRetryPolicy({
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['EMPTY_RESPONSE', 'TIMEOUT', 'TRANSPORT', 'UPSTREAM'],
      backoff: { initialDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0.1 },
    }, PROXY_PROVIDER_ID)
  }

  /** 凭据或模式变化后丢弃账户绑定的目录缓存。 */
  invalidateModelCatalog(): void {
    this.catalogRevision += 1
    this.catalogKey = undefined
    this.catalogLastGoodKey = undefined
    this.catalogLastGoodIds = undefined
    this.catalogExpiresAt = 0
    this.catalogModelIds = new Set<string>()
    this.catalogFailureCode = undefined
  }

  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    this.providerInfo(provider)
    const generation = this.captureGeneration()
    let models: readonly LlmModelInfo[]
    let lookupKey: string | undefined
    try {
      const available = await this.readLiveModelIds(signal, false, this.catalogRevision, key => { lookupKey = key })
      models = this.pinnedTextModelInfos(generation).filter(model => available.has(model.id))
    } catch (error) {
      if (error instanceof LlmError && (error.code === 'AUTH' || error.code === 'CANCELLED')) throw error
      if (lookupKey === undefined || this.catalogLastGoodIds === undefined || this.catalogLastGoodKey !== lookupKey) throw error
      this.options.log?.warn('antigravity-proxy: 模型目录刷新失败，保留该账户已观测目录', error)
      models = this.pinnedTextModelInfos(generation).filter(model => this.catalogLastGoodIds!.has(model.id))
    }
    return models.filter(model => modelVisible(generation.settings, model.id))
  }

  async discoverModels(force = false, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    const generation = this.captureGeneration()
    if (force) { this.catalogRevision += 1; this.catalogExpiresAt = 0; this.catalogFailureCode = undefined }
    const available = await this.readLiveModelIds(signal)
    return this.pinnedTextModelInfos(generation).filter(model => available.has(model.id))
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.resolveModelInGeneration(provider, model, this.captureGeneration())
  }

  override async prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const generation = this.captureGeneration()
    return {
      model: this.resolveModelInGeneration(provider, model, generation),
      stream: options => this.streamInGeneration(options, generation),
    }
  }

  override imageRequestTarget(provider: string, _model: string, image: ImageAttachmentRef): ImageRequestTarget {
    this.providerInfo(provider)
    return proxyImageRequestTarget(image)
  }

  private captureGeneration(): ProxyGeneration {
    return { settings: normalizeModelSettings(this.options.readSettings?.().modelOverrides), attachments: this.options.attachments?.() }
  }

  private async readCredential(signal?: AbortSignal, forceRefresh = false): Promise<ProxyCredential | undefined> {
    if (signal?.aborted) throw new LlmError('代理模式请求已取消', 'CANCELLED')
    let onAbort: (() => void) | undefined
    try {
      const operation = this.options.credential.credential(signal, forceRefresh ? { forceRefresh: true } : undefined)
      const credential = signal === undefined ? await operation : await Promise.race([operation, new Promise<never>((_, reject) => {
        onAbort = () => reject(new LlmError('代理模式请求已取消', 'CANCELLED'))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })])
      if (signal?.aborted) throw new LlmError('代理模式请求已取消', 'CANCELLED')
      return credential
    } catch (error) {
      if (signal?.aborted) throw new LlmError('代理模式请求已取消', 'CANCELLED')
      throw toLlmError(error)
    } finally { if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort) }
  }

  private wireModel(model: string, effort: string | undefined, generation: ProxyGeneration): string {
    const normalized = normalizeReasoningEffort(effort)
    const wire = resolveModelTarget({
      settings: generation.settings,
      model,
      ...(normalized === undefined ? {} : { effort: normalized }),
      route: tier => resolveProxyWireModel(model, tier),
    })
    if (wire.length === 0 || wire.length > 256 || containsControl(wire)) throw new LlmError('代理模式模型映射无效', 'INVALID_MODEL')
    if (Object.values(this.definitions).some(definition => definition.modalities.output.includes('image') && resolveProxyWireModel(definition.id) === wire)) throw new LlmError('代理模式文本路由不接受图片生成模型映射', 'INVALID_MODEL')
    return wire
  }

  private resolveModelInGeneration(provider: string, model: string, generation: ProxyGeneration): LlmResolvedModelInfo {
    this.providerInfo(provider)
    if (typeof model !== 'string' || model.trim().length === 0 || model.length > 256) throw new LlmError('代理模式模型 id 无效', 'INVALID_MODEL')
    const definition = this.definitions[model]
    if (definition === undefined || definition.modalities.output.includes('image')) throw new LlmError('该模型不在代理模式审计文本快照内', 'INVALID_MODEL')
    const setting = modelSettingFor(generation.settings, model)
    const wireModel = this.wireModel(model, undefined, generation)
    const native = getAgyNativeModel(wireModel)
    const routedDefinition = this.definitionForWireModel(wireModel)
    const reasoning = routedDefinition === undefined ? undefined : modelReasoningEfforts(setting.target === undefined ? model : wireModel)
    if (reasoning !== undefined && setting.effort !== undefined && setting.target === undefined) reasoning.defaultEffort = ReasoningEffortId(setting.effort)
    return {
      provider: PROXY_PROVIDER_ID,
      id: definition.id,
      name: modelDisplayName(generation.settings, model, cleanModelDisplayName(definition.name)),
      inputModalities: (routedDefinition?.modalities.input ?? ['text']).filter((item): item is 'text' | 'image' => item === 'text' || (item === 'image' && generation.attachments !== undefined)),
      ...(routedDefinition === undefined ? {} : {
        context: { contextWindow: native?.maxTokens ?? routedDefinition.limit.context },
        defaultMaxTokens: native?.maxOutputTokens ?? routedDefinition.limit.output,
      }),
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  }

  private definitionForWireModel(wireModel: string): ReturnType<typeof getPublicModelDefinitions>[string] | undefined {
    return Object.values(this.definitions).find(definition => !definition.modalities.output.includes('image')
      && [undefined, 'low', 'medium', 'high'].some(effort => resolveProxyWireModel(definition.id, effort) === wireModel))
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamInGeneration(options, this.captureGeneration())
  }

  private async *streamInGeneration(options: GenerateOptions, generation: ProxyGeneration): AsyncIterable<StreamChunk> {
    if (options.provider !== PROXY_PROVIDER_ID) throw new LlmError('代理模式 adapter 收到未知路由', 'NO_ADAPTER')
    const signal = options.signal
    const requested = this.definitions[options.model]
    if (requested === undefined || requested.modalities.output.includes('image')) {
      throw new LlmError('该模型不在代理模式审计文本快照内', 'INVALID_MODEL')
    }
    if (signal?.aborted) { yield finishChunk('aborted', 'CANCELLED'); return }
    const wireModel = this.wireModel(options.model, options.reasoningEffort, generation)
    const attachments = this.definitionForWireModel(wireModel)?.modalities.input.includes('image') ? generation.attachments : undefined
    const hasEmitted = { value: false }
    let refreshed = false
    let refreshNext = false
    let networkRetries = 0
    for (;;) {
      const credential = await this.readCredential(signal, refreshNext)
      refreshNext = false
      if (credential === undefined) throw new LlmError('代理模式需要登录：请在设置页连接代理账户', 'AUTH')
      let payload: Awaited<ReturnType<typeof buildProxyGeneratePayload>>
      try {
        payload = await buildProxyGeneratePayload(options, credential, this.sessions, Date.now(), attachments, signal, wireModel)
      } catch (error) {
        if (signal?.aborted) throw new LlmError('代理模式请求已取消', 'CANCELLED')
        if (error instanceof LlmError) throw error
        throw new LlmError('代理模式图片输入无法安全准入', 'UNSUPPORTED_MODALITY', { cause: error })
      }
      // 内联图片超预算：按「最旧优先」协商 offload，宿主卸载后重试本回合。
      const offload = requiredProxyImageOffload(options.messages, payload.sentImageBytes)
      if (offload > 0) {
        throw new LlmError(
          `代理模式图片超出内联预算；请 offload 最旧的 ${String(offload)} 张保留图片后重试`,
          IMAGE_OFFLOAD_REQUIRED_CODE,
          { offloadImages: offload } as Record<string, unknown>,
        )
      }
      const serialized = JSON.stringify({
        ...(payload.project === undefined ? {} : { project: payload.project }),
        requestId: payload.requestId,
        request: payload.request,
        model: payload.model,
        userAgent: payload.userAgent,
        requestType: payload.requestType,
      })
      if (new TextEncoder().encode(serialized).byteLength > 16 * 1024 * 1024) {
        throw new LlmError('代理模式请求超出传输字节上限', 'REQUEST_LIMIT')
      }
      let response: Response
      try {
        response = await this.options.transport.request({
          url: STREAM_ENDPOINT,
          accessToken: credential.accessToken,
          body: serialized,
          ...(signal === undefined ? {} : { signal }),
          ...(this.options.responseHeaderTimeoutMs === undefined ? {} : { responseHeaderTimeoutMs: this.options.responseHeaderTimeoutMs }),
        })
      } catch (error) {
        if (networkRetries < MAX_NETWORK_RETRIES && !hasEmitted.value && !signal?.aborted && isRetryableNetworkError(error)) {
          networkRetries += 1
          await waitBackoff(networkRetries, signal)
          continue
        }
        throw toLlmError(error)
      }
      const statusError = proxyStatusError(response.status)
      if (statusError !== undefined) {
        if ((statusError.code === 'authentication' || statusError.code === 'forbidden') && !refreshed && !hasEmitted.value && !signal?.aborted) {
          await cancelResponse(response)
          refreshed = true
          refreshNext = true
          continue
        }
        if (statusError.code === 'rate-limited' && !hasEmitted.value) {
          await cancelResponse(response)
          throw new LlmError('代理模式账户被上游限流（429）；稍后重试或切换回 ACP 模式', 'RATE_LIMIT', { status: response.status })
        }
        if ((response.status === 502 || response.status === 503 || response.status === 504) && networkRetries < MAX_NETWORK_RETRIES && !hasEmitted.value && !signal?.aborted) {
          await cancelResponse(response)
          networkRetries += 1
          await waitBackoff(networkRetries, signal)
          continue
        }
        if (response.status === 400 && await responseReportsContextWindowExceeded(response, signal)) {
          throw new LlmError('上下文超出代理模式模型容量', CONTEXT_WINDOW_EXCEEDED_CODE, { status: response.status })
        }
        await cancelResponse(response)
        throw toLlmError(statusError)
      }
      try {
        const completed = yield* this.streamResponse(response, options, hasEmitted, wireModel)
        if (completed) completeProxyExecution(this.sessions, options)
        return
      } catch (error) {
        const transportError = error instanceof Error && error.name === 'ProxyTransportError' ? error as ProxyTransportError : undefined
        if ((transportError?.code === 'authentication' || transportError?.code === 'forbidden') && !refreshed && !hasEmitted.value && !signal?.aborted) {
          refreshed = true
          refreshNext = true
          continue
        }
        if (networkRetries < MAX_NETWORK_RETRIES && !hasEmitted.value && !signal?.aborted && isRetryableNetworkError(error)) {
          networkRetries += 1
          await waitBackoff(networkRetries, signal)
          continue
        }
        throw toLlmError(error)
      }
    }
  }

  private async *streamResponse(response: Response, options: GenerateOptions, hasEmitted: { value: boolean }, wireModel: string): AsyncGenerator<StreamChunk, boolean> {
    const states: BlockState[] = []
    let current: BlockState | undefined
    let usage: TokenUsage | undefined
    let finish: string | undefined
    let sawDone = false
    let eventError: ProxyProviderEvent['error']
    for await (const sse of iterateProxySse(response, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      idleTimeoutMs: PROXY_IDLE_TIMEOUT_MS,
      totalTimeoutMs: PROXY_TOTAL_TIMEOUT_MS,
      maxBytes: PROXY_RESPONSE_BYTES,
      maxFrameBytes: PROXY_FRAME_BYTES,
    })) {
      if (sse.data.trim() === '[DONE]') { sawDone = true; break }
      let event: ProxyProviderEvent
      try {
        event = parseProxyProviderEvent(sse.data)
      } catch (error) {
        if (hasEmitted.value) throw new LlmError('代理模式响应流在中途截断', 'TRANSPORT', { cause: error })
        throw error
      }
      if (event.error !== undefined) {
        eventError = event.error
        if (event.error.status === 401 || isAuthenticationCode(event.error.code)) {
          throw new ProxyTransportError('authentication', '代理模式凭据被上游拒绝', { status: event.error.status ?? 401 })
        }
        if (event.error.status === 403 || event.error.code?.toUpperCase() === 'PERMISSION_DENIED') throw new ProxyTransportError('forbidden', '代理模式账户被上游拒绝', { status: 403 })
        break
      }
      if (event.usage !== undefined) usage = event.usage
      if (event.finish !== undefined) finish = event.finish
      for (const part of event.parts) {
        if (part.signatureOnly === true && current !== undefined) { current.signature = part.signature; continue }
        if (current === undefined || !sameBlock(current, part)) {
          if (current !== undefined) yield endBlock(current)
          current = beginBlock(states, part)
          yield { type: 'block-start', index: current.index, blockType: current.kind }
        }
        if (part.kind === 'tool-call') {
          if (part.name !== undefined) current.name = assembleFunctionName(current.name, part.name)
          current.text += part.arguments ?? ''
          current.argumentsComplete = part.argumentsComplete
          hasEmitted.value ||= (part.arguments?.length ?? 0) > 0 || part.name !== undefined
          yield {
            type: 'tool-call-delta',
            index: current.index,
            id: current.id,
            ...(part.name === undefined ? {} : { name: part.name }),
            argumentsDelta: part.arguments ?? '',
          }
        } else {
          current.text += part.text ?? ''
          hasEmitted.value ||= (part.text?.length ?? 0) > 0
          if ((part.text?.length ?? 0) > 0) yield { type: part.kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: current.index, text: part.text ?? '' }
        }
        if (part.signature !== undefined) current.signature = part.signature
      }
    }
    if (current !== undefined) yield endBlock(current)
    if (usage !== undefined) yield { type: 'usage', usage }
    if (eventError !== undefined) {
      yield finishChunk(
        'error',
        eventError.contextWindowExceeded === true ? CONTEXT_WINDOW_EXCEEDED_CODE : safeProviderErrorCode(eventError.code, eventError.status),
        eventError.status,
      )
      return false
    }
    if (options.signal?.aborted) { yield finishChunk('aborted', 'CANCELLED'); return false }
    if (mapFinishReason(finish) === 'error') { yield finishChunk('error', finish ?? 'UPSTREAM'); return false }
    if (states.length === 0) { yield finishChunk('error', 'EMPTY_RESPONSE'); return false }
    if (finish === undefined && !sawDone) throw new LlmError('代理模式响应流在完成标记之前结束', 'TRANSPORT')
    const replayBlocks: ProxyReplayBlock[] = states.map((state) => ({ kind: state.kind, ...(state.signature === undefined ? {} : { signature: state.signature }) }))
    const reason = mapFinishReason(finish)
    yield finishChunk(reason === 'stop' && states.some(state => state.kind === 'tool-call') ? 'tool-calls' : reason, finish ?? 'STOP', undefined,
      createProxyReplayState(options.model, proxyModelFamily(wireModel), finish, replayBlocks, wireModel))
    return reason !== 'error'
  }

  private pinnedTextModelInfos(generation: ProxyGeneration): readonly LlmModelInfo[] {
    return Object.values(this.definitions)
      .filter((definition) => !definition.modalities.output.includes('image'))
      .map((definition) => {
        const resolved = this.resolveModelInGeneration(PROXY_PROVIDER_ID, definition.id, generation)
        return { provider: resolved.provider, id: resolved.id, name: resolved.name, inputModalities: resolved.inputModalities }
      })
  }

  private async readLiveModelIds(signal?: AbortSignal, force = false, revision = this.catalogRevision, onCredentialKey?: (key: string) => void): Promise<ReadonlySet<string>> {
    const credential = await this.readCredential(signal, force)
    this.assertCatalogCurrent(revision, signal)
    if (credential === undefined) throw new LlmError('代理模式需要登录后才能读取模型目录', 'AUTH')
    const key = createHash('sha256').update(JSON.stringify([credential.email ?? credential.refreshToken ?? credential.accessToken, credential.projectId])).digest('hex')
    onCredentialKey?.(key)
    if (!force && this.catalogKey === key && Date.now() < this.catalogExpiresAt) {
      if (this.catalogFailureCode !== undefined) throw new LlmError('代理模式模型目录仍不可用', this.catalogFailureCode)
      return this.catalogModelIds
    }
    const body = credential.projectId ? { project: credential.projectId } : {}
    let response: Response
    try {
      response = await this.options.transport.request({
        url: MODELS_ENDPOINT,
        accessToken: credential.accessToken,
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      })
      if (revision !== this.catalogRevision || signal?.aborted) { await cancelResponse(response); this.assertCatalogCurrent(revision, signal) }
    } catch (error) {
      const failure = toLlmError(error)
      this.rememberCatalogFailure(key, failure, revision)
      throw failure
    }
    if (response.status === 403 && credential.projectId) {
      try {
        const retry = await this.options.transport.request({
          url: MODELS_ENDPOINT,
          accessToken: credential.accessToken,
          body: JSON.stringify({}),
          ...(signal === undefined ? {} : { signal }),
        })
        if (revision !== this.catalogRevision || signal?.aborted) { await cancelResponse(retry); await cancelResponse(response); this.assertCatalogCurrent(revision, signal) }
        if (retry.ok) { await cancelResponse(response); response = retry } else await cancelResponse(retry)
      } catch (error) {
        this.assertCatalogCurrent(revision, signal)
        if (error instanceof LlmError && error.code === 'CANCELLED') throw error
        // 保留原始 403 作为权威失败。
      }
    }
    const statusError = proxyStatusError(response.status)
    if (statusError !== undefined) {
      await cancelResponse(response)
      if (statusError.code === 'authentication' && !force && !signal?.aborted) {
        this.catalogExpiresAt = 0
        return this.readLiveModelIds(signal, true, revision, onCredentialKey)
      }
      const failure = toLlmError(statusError)
      this.rememberCatalogFailure(key, failure, revision)
      throw failure
    }
    let value: unknown
    try {
      value = JSON.parse(await readProxyText(response, {
        ...(signal === undefined ? {} : { signal }),
        idleTimeoutMs: PROXY_IDLE_TIMEOUT_MS,
        totalTimeoutMs: PROXY_TOTAL_TIMEOUT_MS,
        maxBytes: Math.min(PROXY_RESPONSE_BYTES, MAX_MODEL_CATALOG_BYTES),
      })) as unknown
    } catch (error) {
      const failure = toLlmError(error)
      this.rememberCatalogFailure(key, failure, revision)
      throw failure
    }
    let ids: Set<string>
    try {
      ids = parseLiveModelIds(value, this.definitions)
    } catch (error) {
      const failure = error instanceof LlmError ? error : new LlmError('代理模式模型目录不符合预期结构', 'PROTOCOL_DRIFT')
      this.rememberCatalogFailure(key, failure, revision)
      throw failure
    }
    this.assertCatalogCurrent(revision, signal)
    this.catalogKey = key
    this.catalogModelIds = ids
    this.catalogLastGoodKey = key
    this.catalogLastGoodIds = ids
    this.catalogFailureCode = undefined
    this.catalogExpiresAt = Date.now() + MODEL_CATALOG_TTL_MS
    return ids
  }

  private assertCatalogCurrent(revision: number, signal?: AbortSignal): void {
    if (revision !== this.catalogRevision || signal?.aborted) throw new LlmError('代理模式模型目录请求已失效或取消', 'CANCELLED')
  }

  private rememberCatalogFailure(key: string, failure: LlmError, revision: number): void {
    this.assertCatalogCurrent(revision)
    if (failure.code === 'AUTH' || failure.code === 'CANCELLED') return
    this.catalogKey = key
    this.catalogModelIds = new Set<string>()
    this.catalogFailureCode = failure.code
    this.catalogExpiresAt = Date.now() + MODEL_CATALOG_TTL_MS
  }
}

// ---------------------------------------------------------------- internals

export function cleanModelDisplayName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/u, '').trim()
}

function modelReasoningEfforts(modelId: string): { efforts: readonly { id: ReturnType<typeof ReasoningEffortId>; name: string }[]; defaultEffort: ReturnType<typeof ReasoningEffortId> } | undefined {
  const lower = modelId.toLowerCase()
  if (lower.includes('gemini-4-argon') || (lower.includes('flash') && !lower.includes('image'))) {
    return {
      efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('medium'), name: 'Medium' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ],
      defaultEffort: ReasoningEffortId(/-(low|medium|high)$/u.exec(lower)?.[1] ?? 'medium'),
    }
  }
  if (lower.includes('claude-sonnet-5-5') || lower.includes('claude-opus-5-5')) {
    return {
      efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('medium'), name: 'Medium' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ],
      defaultEffort: ReasoningEffortId(/-(low|medium|high)$/u.exec(lower)?.[1] ?? 'low'),
    }
  }
  return undefined
}

function parseLiveModelIds(value: unknown, definitions: ReturnType<typeof getPublicModelDefinitions>): Set<string> {
  const root = isRecord(value) && isRecord(value.response) ? value.response : value
  if (!isRecord(root) || !isRecord(root.models)) throw new LlmError('代理模式模型目录不符合预期结构', 'PROTOCOL_DRIFT')
  const entries = Object.entries(root.models)
  if (entries.length > 512) throw new LlmError('代理模式模型目录超出模型数量上限', 'PROTOCOL_DRIFT')
  const live = new Set<string>()
  for (const [id, rawEntry] of entries) {
    if (!safeModelId(id) || !isRecord(rawEntry)) throw new LlmError('代理模式模型目录不符合预期结构', 'PROTOCOL_DRIFT')
    const cleanId = cleanModelId(id)
    live.add(cleanId)
    live.add(id)
    for (const alias of familyAliases(cleanId)) live.add(alias)
    const modelName = rawEntry.modelName
    if (modelName !== undefined) {
      if (typeof modelName !== 'string' || !safeModelId(modelName)) throw new LlmError('代理模式模型目录不符合预期结构', 'PROTOCOL_DRIFT')
      const cleanName = cleanModelId(modelName)
      live.add(cleanName)
      for (const alias of familyAliases(cleanName)) live.add(alias)
    }
    if (rawEntry.displayName !== undefined && (typeof rawEntry.displayName !== 'string' || rawEntry.displayName.length > 512)) {
      throw new LlmError('代理模式模型目录不符合预期结构', 'PROTOCOL_DRIFT')
    }
  }
  const available = new Set<string>()
  for (const definition of Object.values(definitions)) {
    const resolved = resolveModelWithTier(definition.id).actualModel
    const cleanResolved = cleanModelId(resolved)
    if (live.has(cleanResolved) || live.has(resolved) || live.has(definition.id)
      || (definition.id === 'antigravity-gemini-3.5-flash' && (live.has('gemini-3-flash') || live.has('gemini-3.5-flash')))) {
      available.add(definition.id)
    }
  }
  return available
}

function familyAliases(cleanId: string): string[] {
  const aliases: string[] = []
  if (cleanId === 'gemini-3-flash' || cleanId.startsWith('gemini-3-flash') || cleanId.startsWith('gemini-3.5-flash')) {
    aliases.push('gemini-3.5-flash', 'gemini-3-flash-agent', 'gemini-3.5-flash-low', 'gemini-3.5-flash-extra-low')
  }
  if (cleanId === 'gemini-3.8-flash-tiered' || cleanId.startsWith('gemini-3.8-flash')) {
    aliases.push('gemini-3.8-flash', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'gemini-3.8-flash-high')
  }
  if (cleanId.startsWith('gemini-4-argon')) aliases.push('gemini-4-argon', 'gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high')
  if (cleanId.startsWith('claude-sonnet-5-5')) aliases.push('claude-sonnet-5-5', 'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high')
  if (cleanId.startsWith('claude-opus-5-5')) aliases.push('claude-opus-5-5', 'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high')
  return aliases
}

function cleanModelId(value: string): string {
  return value.replace(/^(?:publishers\/[^/]+\/)?models\//, '')
}

function safeModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !containsControl(value)
}

function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function beginBlock(states: BlockState[], part: ProxyProviderPart): BlockState {
  const index = states.length
  const block: BlockState = part.kind === 'tool-call'
    ? {
        index,
        kind: 'tool-call',
        id: ToolCallId(part.id ?? `proxy-call-${randomUUID()}`),
        ...(part.name === undefined ? {} : { name: part.name }),
        text: '',
        ...(part.signature === undefined ? {} : { signature: part.signature }),
      }
    : {
        index,
        kind: part.kind,
        id: ToolCallId(`proxy-block-${String(index)}`),
        text: '',
        ...(part.signature === undefined ? {} : { signature: part.signature }),
      }
  states.push(block)
  return block
}

function sameBlock(state: BlockState, part: ProxyProviderPart): boolean {
  if (state.kind !== part.kind) return false
  if (part.kind !== 'tool-call') return true
  if (part.id !== undefined) return part.id === String(state.id)
  // Gemini 的并行调用可省略 id，每个完整参数对象都对应独立的调用。
  return state.argumentsComplete !== true
}

function assembleFunctionName(current: string | undefined, fragment: string): string {
  if (fragment.length === 0 || fragment.length > 256 || containsControl(fragment)) throw new LlmError('代理模式工具调用名无效', 'PROTOCOL_DRIFT')
  if (current === undefined || current.length === 0) return fragment
  if (fragment === current) return current
  if (fragment.startsWith(current)) return fragment
  const combined = `${current}${fragment}`
  if (combined.length > 256) throw new LlmError('代理模式工具调用名超出上限', 'PROTOCOL_DRIFT')
  return combined
}

function endBlock(state: BlockState): StreamChunk {
  if (state.kind === 'text') return { type: 'block-end', index: state.index, block: { type: 'text', text: state.text } }
  if (state.kind === 'reasoning') return { type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.text } }
  try {
    const parsed: unknown = JSON.parse(state.text || '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
  } catch {
    throw new LlmError('代理模式工具调用参数不是完整 JSON', 'PROTOCOL_DRIFT')
  }
  if (state.name === undefined || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/u.test(state.name)) {
    throw new LlmError('代理模式工具调用名缺失或无效', 'PROTOCOL_DRIFT')
  }
  return { type: 'block-end', index: state.index, block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.text || '{}' } }
}

function finishChunk(kind: FinishReason['kind'], code: string, status?: number, replayState?: ReplayEnvelope): StreamChunk {
  const reason: FinishReason = kind === 'aborted'
    ? { kind: 'aborted', failure: { code, message: '代理模式请求已取消' } }
    : kind === 'error'
      ? { kind: 'error', failure: { code, message: '代理模式上游请求失败', ...(status === undefined ? {} : { status }) } }
      : kind === 'max-tokens'
        ? { kind: 'max-tokens' }
        : kind === 'tool-calls'
          ? { kind: 'tool-calls' }
          : { kind: 'stop' }
  return { type: 'finish', reason, ...(replayState === undefined ? {} : { replayState }) }
}

function mapFinishReason(value: string | undefined): FinishReason['kind'] {
  const normalized = value?.toUpperCase()
  if (normalized === 'MAX_TOKENS' || normalized === 'LENGTH') return 'max-tokens'
  if (normalized === 'SAFETY' || normalized === 'BLOCKLIST' || normalized === 'ERROR') return 'error'
  if (normalized === 'TOOL_CALLS' || normalized === 'FUNCTION_CALL') return 'tool-calls'
  if (normalized !== undefined && normalized !== 'STOP') return 'error'
  return 'stop'
}

function safeProviderErrorCode(code: string | undefined, status?: number): string {
  if (status === 401) return 'AUTH'
  if (status === 403) return 'FORBIDDEN'
  if (status === 429) return 'RATE_LIMIT'
  const normalized = code?.toUpperCase()
  if (normalized === undefined) return 'UPSTREAM'
  if (normalized.includes('RATE') || normalized === 'RESOURCE_EXHAUSTED') return 'RATE_LIMIT'
  if (normalized.includes('QUOTA')) return 'RATE_LIMIT'
  if (normalized === 'UNAUTHENTICATED' || normalized === 'INVALID_GRANT') return 'AUTH'
  if (normalized === 'PERMISSION_DENIED' || normalized === 'FORBIDDEN') return 'FORBIDDEN'
  if (normalized.includes('INVALID') || normalized.includes('BAD_REQUEST')) return 'PROTOCOL_DRIFT'
  return 'UPSTREAM'
}

function isAuthenticationCode(code: string | undefined): boolean {
  const normalized = code?.toUpperCase()
  return normalized === 'UNAUTHENTICATED' || normalized === 'AUTHENTICATION' || normalized === 'INVALID_GRANT' || normalized === 'UNAUTHENTICATED_REQUEST'
}

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof LlmError) return ['TRANSPORT', 'TIMEOUT', 'UPSTREAM'].includes(error.code)
  const name = error instanceof Error ? error.name : ''
  return name === 'ProxyTransportError' && ['offline', 'timeout', 'upstream'].includes((error as ProxyTransportError).code)
}

async function waitBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new LlmError('代理模式请求已取消', 'CANCELLED')
  const ms = Math.min(1000 * 2 ** (attempt - 1), 4000)
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(new LlmError('代理模式请求已取消', 'CANCELLED')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function cancelResponse(response: Response): Promise<void> {
  try { await response.body?.cancel() } catch { /* best effort */ }
}

async function responseReportsContextWindowExceeded(response: Response, signal?: AbortSignal): Promise<boolean> {
  try {
    for await (const event of iterateProxySse(response, {
      ...(signal === undefined ? {} : { signal }),
      maxBytes: 64 * 1024,
      idleTimeoutMs: 20_000,
      totalTimeoutMs: 30_000,
    })) {
      const text = event.data.trim().replace(/^\)\]\}'(?:\r?\n)?/u, '')
      let value: unknown
      try { value = JSON.parse(text) as unknown } catch { if (/context window|token limit|prompt is too long/iu.test(text)) return true; continue }
      if (isRecord(value) && reportsContextWindowExceeded(value)) return true
    }
    return false
  } catch (error) {
    if (signal?.aborted || error instanceof ProxyTransportError && error.code === 'cancelled') throw new LlmError('代理模式请求已取消', 'CANCELLED')
    return false
  }
}

function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  const transport = error instanceof Error && error.name === 'ProxyTransportError' ? error as ProxyTransportError : undefined
  if (transport !== undefined) {
    const code = transport.code === 'cancelled' ? 'CANCELLED'
      : transport.code === 'timeout' ? 'TIMEOUT'
        : transport.code === 'authentication' ? 'AUTH'
          : transport.code === 'forbidden' ? 'FORBIDDEN'
            : transport.code === 'rate-limited' ? 'RATE_LIMIT'
              : transport.code === 'upstream' ? 'UPSTREAM'
                : transport.code === 'request-too-large' || transport.code === 'response-too-large' || transport.code === 'frame-too-large' ? 'REQUEST_LIMIT'
                  : transport.code === 'proxy-unsupported' ? 'AGY_INVALID_PROXY'
                    : transport.code === 'protocol-drift' || transport.code === 'invalid-response' ? 'PROTOCOL_DRIFT'
                      : 'TRANSPORT'
    return new LlmError(transport.message, code, ...(transport.status === undefined ? [] : [{ status: transport.status }]))
  }
  return new LlmError(error instanceof Error ? error.message : String(error), 'TRANSPORT', { cause: error })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export { PROXY_RESPONSE_HEADER_TIMEOUT_MS }
export { normalizeReasoningEffort }
