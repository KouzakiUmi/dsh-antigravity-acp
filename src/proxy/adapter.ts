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
import { getAgyNativeModel, getPublicModelDefinitions } from '@cortexkit/antigravity-auth-core'
import { createHash } from 'node:crypto'
import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  LlmImageRequestPricing,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AdapterPreparedCall, AdapterRequestOptions } from '../adapter/request-options.js'
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
import type { ProxyProviderEvent } from './payload.js'
import { proxyImageRequestTarget, requiredProxyImageOffload } from './image.js'
import type { ProxyAttachmentReader } from './image.js'
import { iterateProxySse, proxyStatusError, readProxyText } from './transport.js'
import type { ProxyTransport } from './transport.js'
import { ProxyTransportError } from './transport.js'
import { assembleGeminiStream, createGeminiBlockAssembler, containsControl } from './gemini-stream.js'
import { redactSensitiveText } from '../runtime/redact.js'
import { PROXY_RESPONSE_HEADER_TIMEOUT_MS, PROXY_IDLE_TIMEOUT_MS, PROXY_TOTAL_TIMEOUT_MS, PROXY_RESPONSE_BYTES, PROXY_STREAM_RESPONSE_BYTES, PROXY_FRAME_BYTES } from './transport.js'
import type { ProxyCredential } from './account-store.js'
import type { AntigravityHostConfig } from '../settings.js'
import { modelDisplayName, modelSettingFor, modelVisible, normalizeModelSettings, resolveModelTarget } from '../adapter/model-settings.js'
import type { ModelCapacity, ModelSetting } from '../adapter/model-settings.js'
import { llmError } from '../runtime/llm-error.js'
import {
  ORCHESTRATOR_MODEL_ID,
  ORCHESTRATOR_MODEL_NAME,
  OrchestratorStore,
  PLANNER_SYSTEM_SUFFIX,
  buildExecutorSystem,
  buildPlannerMessages,
  computeTurnKey,
  extractGoalAndEvidence,
  normalizeOrchestratorSettings,
  parsePlan,
  renderPlanForExecutor,
  shouldPlan,
} from '../orchestrator/index.js'
import type { OrchestratorPlan, OrchestratorSettings } from '../orchestrator/index.js'
import {
  isLiveGeminiFamily,
  parseLiveProxyCatalog,
  PROXY_MODEL_EFFORTS,
  resolveProxyOrchestrator,
  synthesizeProxyOrchestratorModel,
  toProxyFamilyId,
} from './model-catalog.js'
import type { LiveProxyCatalog, LiveProxyModel } from './model-catalog.js'

export { PROXY_PROVIDER_ID }

const PROXY_BLOCKS = createGeminiBlockAssembler({ label: '代理模式', idPrefix: 'proxy' })
const { finishChunk, mapFinishReason, safeProviderErrorCode, isAuthenticationCode } = PROXY_BLOCKS

const STREAM_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'
const MODELS_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
const MODEL_CATALOG_TTL_MS = 30_000
const MAX_NETWORK_RETRIES = 3
/** 上游模型侧工具参数校验失败（MALFORMED_FUNCTION_CALL）未出块时的有界重试次数。 */
const MAX_MALFORMED_RETRIES = 1

export interface ProxyCredentialSource {
  /** 取一份可用凭据；`forceRefresh` 表示先换发再返回。无登录态返回 undefined。 */
  credential(signal?: AbortSignal, options?: { forceRefresh?: boolean }): Promise<ProxyCredential | undefined>
}

/** 设置页读取当前代理路由的目录，手动刷新绕过目录缓存。 */
export interface ProxyModelCatalog {
  models(force: boolean): Promise<readonly (LlmModelInfo & ModelCapacity)[]>
}

export interface ProxyAdapterOptions {
  credential: ProxyCredentialSource
  transport?: ProxyTransport
  responseHeaderTimeoutMs?: number
  /** 宿主附件服务的惰性读取面；缺席时图片输入报 UNSUPPORTED_MODALITY，文本能力不受影响。 */
  attachments?: () => ProxyAttachmentReader | undefined
  readSettings?: () => Pick<AntigravityHostConfig, 'modelOverrides' | 'orchestrator'>
  log?: { info(message: string): void; warn(message: string, error?: unknown): void }
}

interface CatalogSnapshot {
  readonly key: string
  readonly data: LiveProxyCatalog
}

interface ProxyGeneration {
  readonly settings: ReadonlyMap<string, ModelSetting>
  readonly orchestrator: OrchestratorSettings
  readonly attachments: ProxyAttachmentReader | undefined
  readonly catalog?: CatalogSnapshot
}

export class AntigravityProxyAdapter extends LlmAdapter {
  private readonly sessions = createProxySessionStore()
  private readonly plannerSessions = createProxySessionStore()
  private readonly orchestrators = new OrchestratorStore()
  private readonly definitions = getPublicModelDefinitions()
  private catalogKey: string | undefined
  private catalogRevision = 0
  private catalogLastGood: CatalogSnapshot | undefined
  private catalogExpiresAt = 0
  private catalogFailureCode: string | undefined

  constructor(private readonly options: ProxyAdapterOptions & { transport: ProxyTransport }) {
    super()
  }

  dispose(): void {
    this.orchestrators.dispose()
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
    this.catalogLastGood = undefined
    this.catalogExpiresAt = 0
    this.catalogFailureCode = undefined
  }

  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    this.providerInfo(provider)
    const generation = this.captureGeneration()
    let catalog: CatalogSnapshot
    let lookupKey: string | undefined
    try {
      catalog = await this.readLiveCatalog(signal, false, this.catalogRevision, key => { lookupKey = key })
    } catch (error) {
      if (error instanceof LlmError && (error.code === 'AUTH' || error.code === 'CANCELLED')) throw error
      if (this.catalogLastGood === undefined || this.catalogLastGood.key !== lookupKey) throw error
      this.options.log?.warn('antigravity-proxy: 模型目录刷新失败，保留该账户已观测目录', error)
      catalog = this.catalogLastGood
    }
    return this.pinnedTextModelInfos(generation, catalog).filter(model => modelVisible(generation.settings, model.id))
  }

  async discoverModels(force = false, signal?: AbortSignal): Promise<readonly (LlmModelInfo & ModelCapacity)[]> {
    const generation = this.captureGeneration()
    if (force) { this.catalogRevision += 1; this.catalogExpiresAt = 0; this.catalogFailureCode = undefined }
    const catalog = await this.readLiveCatalog(signal)
    return this.pinnedTextModelInfos(generation, catalog)
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    this.providerInfo(provider)
    return this.resolveModelInGeneration(provider, model, await this.captureModelGeneration(model, signal))
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<AdapterPreparedCall> {
    this.providerInfo(provider)
    const generation = await this.captureModelGeneration(model, signal)
    return {
      model: this.resolveModelInGeneration(provider, model, generation),
      stream: options => options.model === ORCHESTRATOR_MODEL_ID
        ? this.streamOrchestrated(options, generation)
        : this.streamInGeneration(options, generation),
    }
  }

  override imageRequestTarget(provider: string, _model: string, image: ImageAttachmentRef): ImageRequestTarget {
    this.providerInfo(provider)
    return proxyImageRequestTarget(image)
  }

  private captureGeneration(): ProxyGeneration {
    const catalog = this.catalogLastGood
    const rawSettings = this.options.readSettings?.()
    return {
      settings: normalizeModelSettings(rawSettings?.modelOverrides),
      orchestrator: normalizeOrchestratorSettings(rawSettings?.orchestrator),
      attachments: this.options.attachments?.(),
      ...(catalog !== undefined && catalog.key === this.catalogKey ? { catalog } : {}),
    }
  }

  private async captureModelGeneration(model: string, signal?: AbortSignal): Promise<ProxyGeneration> {
    const generation = this.captureGeneration()
    if ((!isLiveGeminiFamily(model) && model !== ORCHESTRATOR_MODEL_ID) || generation.catalog !== undefined) return generation
    return { ...generation, catalog: await this.readLiveCatalog(signal) }
  }

  private async readCredential(signal?: AbortSignal, forceRefresh = false): Promise<ProxyCredential | undefined> {
    if (signal?.aborted) throw llmError('代理模式请求已取消', 'CANCELLED')
    let onAbort: (() => void) | undefined
    try {
      const operation = this.options.credential.credential(signal, forceRefresh ? { forceRefresh: true } : undefined)
      const credential = signal === undefined ? await operation : await Promise.race([operation, new Promise<never>((_, reject) => {
        onAbort = () => reject(llmError('代理模式请求已取消', 'CANCELLED'))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })])
      if (signal?.aborted) throw llmError('代理模式请求已取消', 'CANCELLED')
      return credential
    } catch (error) {
      if (signal?.aborted) throw llmError('代理模式请求已取消', 'CANCELLED')
      throw toLlmError(error)
    } finally { if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort) }
  }

  private wireModel(model: string, effort: string | undefined, generation: ProxyGeneration): string {
    const normalized = normalizeReasoningEffort(effort)
    const observed = generation.catalog?.data.models.get(model)
    const wire = isLiveGeminiFamily(model) ? selectLiveGeminiWire(observed, modelSettingFor(generation.settings, model), effort) : resolveModelTarget({
      settings: generation.settings,
      model,
      ...(normalized === undefined ? {} : { effort: normalized }),
      route: tier => {
        if (generation.catalog === undefined) return resolveProxyWireModel(model, tier)
        if (observed === undefined) throw new LlmError('当前账户的模型目录未提供此模型', 'MODEL_UNSUPPORTED')
        if (tier !== undefined && observed.efforts.includes(tier)) return resolveProxyWireModel(model, tier)
        if (normalized !== undefined && modelReasoningEfforts(model) !== undefined) {
          throw new LlmError('当前账户的模型目录未提供所选思考档位', 'UNSUPPORTED_REASONING_EFFORT')
        }
        return observed.defaultWire
      },
    })
    if (wire.length === 0 || wire.length > 256 || containsControl(wire)) throw llmError('代理模式模型映射无效', 'INVALID_MODEL')
    if (Object.values(this.definitions).some(definition => definition.modalities.output.includes('image') && resolveProxyWireModel(definition.id) === wire)) throw llmError('代理模式文本路由不接受图片生成模型映射', 'INVALID_MODEL')
    return wire
  }

  private resolveModelInGeneration(provider: string, model: string, generation: ProxyGeneration): LlmResolvedModelInfo {
    this.providerInfo(provider)
    if (typeof model !== 'string' || model.trim().length === 0 || model.length > 256) throw llmError('代理模式模型 id 无效', 'INVALID_MODEL')
    if (model === ORCHESTRATOR_MODEL_ID) return this.resolveOrchestratorModel(generation)
    if (isLiveGeminiFamily(model)) return this.resolveLiveGemini(model, generation)
    const definition = this.definitions[model]
    if (definition === undefined || definition.modalities.output.includes('image')) throw llmError('该模型不在代理模式审计文本快照内', 'INVALID_MODEL')
    const setting = modelSettingFor(generation.settings, model)
    const wireModel = this.wireModel(model, undefined, generation)
    const native = getAgyNativeModel(wireModel)
    const routedDefinition = setting.target === undefined ? definition : this.definitionForWireModel(wireModel)
    const reasoning = setting.target === undefined ? modelReasoningEfforts(model) : undefined
    if (reasoning !== undefined) {
      const observed = generation.catalog?.data.models.get(model)
      if (observed !== undefined) {
        reasoning.efforts = reasoning.efforts.filter(({ id }) => observed.efforts.some(effort => effort === id))
        const selected = observed.efforts.find(effort => resolveProxyWireModel(model, effort) === wireModel)
        if (selected !== undefined) reasoning.defaultEffort = ReasoningEffortId(selected)
      } else if (setting.effort !== undefined) reasoning.defaultEffort = ReasoningEffortId(setting.effort)
    }
    const candidates = this.possibleWires(model, wireModel, generation)
    const contextWindow = this.liveLimits(candidates, generation).contextWindow ?? native?.maxTokens ?? routedDefinition?.limit.context
    return {
      provider: PROXY_PROVIDER_ID,
      id: definition.id,
      name: modelDisplayName(generation.settings, model, cleanModelDisplayName(definition.name)),
      inputModalities: this.inputModalities(candidates, generation, routedDefinition?.modalities.input.includes('image') === true),
      ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
      ...(routedDefinition === undefined ? {} : {
        defaultMaxTokens: native?.maxOutputTokens ?? routedDefinition.limit.output,
      }),
      ...(reasoning === undefined || reasoning.efforts.length === 0 ? {} : { reasoning }),
    }
  }

  private resolveOrchestratorModel(generation: ProxyGeneration): LlmResolvedModelInfo {
    const orch = generation.orchestrator
    const resolved = resolveProxyOrchestrator(
      orch,
      generation.catalog?.data,
      this.definitions,
      orch.plannerEffort,
      orch.executorEffort,
    )
    if (resolved === undefined || generation.catalog === undefined) {
      throw llmError('编排模式的 planner/executor 模型不在当前目录', 'INVALID_MODEL')
    }
    const synthesized = synthesizeProxyOrchestratorModel({
      settings: orch,
      catalog: generation.catalog.data,
      definitions: this.definitions,
      attachmentsAvailable: generation.attachments !== undefined,
      modelSettings: generation.settings,
      plannerEffort: orch.plannerEffort,
      executorEffort: orch.executorEffort,
    })
    if (synthesized === undefined) {
      throw llmError('编排模式的 planner/executor 模型不在当前目录', 'INVALID_MODEL')
    }
    const efforts = resolved.planner.availableEfforts.length > 0
      ? resolved.planner.availableEfforts
      : [resolved.planner.effort]
    return {
      provider: PROXY_PROVIDER_ID,
      id: ORCHESTRATOR_MODEL_ID,
      name: synthesized.name || ORCHESTRATOR_MODEL_NAME,
      inputModalities: synthesized.inputModalities ?? ['text'],
      ...(synthesized.contextWindow === undefined ? {} : { context: { contextWindow: synthesized.contextWindow } }),
      ...(synthesized.maxOutputTokens === undefined ? {} : { defaultMaxTokens: synthesized.maxOutputTokens }),
      reasoning: {
        efforts: efforts.map((effort) => ({
          id: ReasoningEffortId(effort),
          name: effort[0]!.toUpperCase() + effort.slice(1),
        })),
        defaultEffort: ReasoningEffortId(resolved.planner.effort),
      },
    }
  }

  private resolveLiveGemini(model: string, generation: ProxyGeneration): LlmResolvedModelInfo {
    const wire = this.wireModel(model, undefined, generation)
    const observed = generation.catalog!.data.models.get(model)!
    const family = observed.liveGemini!
    const target = modelSettingFor(generation.settings, model).target
    const selected = Array.from(family.variants).find(([, id]) => id === wire)?.[0]
    const candidates = this.possibleWires(model, wire, generation)
    const { contextWindow } = this.liveLimits(candidates, generation)
    return {
      provider: PROXY_PROVIDER_ID, id: model, name: modelDisplayName(generation.settings, model, family.name),
      inputModalities: this.inputModalities(candidates, generation),
      ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
      ...(target === undefined && selected !== undefined ? { reasoning: {
        efforts: Array.from(family.variants.keys(), effort => ({ id: ReasoningEffortId(effort), name: effort === 'xhigh' ? 'Extra High' : effort[0]!.toUpperCase() + effort.slice(1) })),
        defaultEffort: ReasoningEffortId(selected),
      } } : {}),
    }
  }

  private possibleWires(model: string, wire: string, generation: ProxyGeneration): readonly string[] {
    const row = generation.catalog?.data.models.get(model)
    if (modelSettingFor(generation.settings, model).target !== undefined || row === undefined) return [wire]
    const alternates = row.liveGemini === undefined ? row.efforts.map(effort => resolveProxyWireModel(model, effort)) : [...row.liveGemini.variants.values()]
    return [...new Set([wire, ...alternates])]
  }

  private liveLimits(wires: readonly string[], generation: ProxyGeneration): { contextWindow?: number; maxOutputTokens?: number } {
    const bounded = (key: 'contextWindow' | 'maxOutputTokens') => {
      const values = wires.map(wire => generation.catalog?.data.wire.get(wire)?.[key])
      const known = values.filter(value => value !== undefined)
      return known.length === wires.length && known.length > 0 ? Math.min(...known) : undefined
    }
    return { contextWindow: bounded('contextWindow'), maxOutputTokens: bounded('maxOutputTokens') }
  }

  private acceptsImage(wire: string, generation: ProxyGeneration, fallback = false): boolean {
    return generation.catalog?.data.wire.get(wire)?.supportsImages
      ?? this.definitionForWireModel(wire)?.modalities.input.includes('image') ?? fallback
  }

  private inputModalities(wires: readonly string[], generation: ProxyGeneration, fallback = false): readonly ('text' | 'image')[] {
    // Core projects images before the adapter sees the selected effort. Preserve
    // them at route level if any tier supports them, then validate the exact wire.
    return generation.attachments !== undefined && wires.some(wire => this.acceptsImage(wire, generation, fallback)) ? ['text', 'image'] : ['text']
  }

  private definitionForWireModel(wireModel: string): ReturnType<typeof getPublicModelDefinitions>[string] | undefined {
    return Object.values(this.definitions).find(definition => !definition.modalities.output.includes('image')
      && [undefined, ...PROXY_MODEL_EFFORTS].some(effort => resolveProxyWireModel(definition.id, effort) === wireModel))
  }

  override async *stream(options: AdapterRequestOptions): AsyncIterable<StreamChunk> {
    this.providerInfo(options.provider)
    const generation = this.captureGeneration()
    if (options.model === ORCHESTRATOR_MODEL_ID) {
      if (!options.signal?.aborted && generation.orchestrator.enabled && generation.catalog === undefined) {
        const catalog = await this.readLiveCatalog(options.signal)
        yield* this.streamOrchestrated(options, { ...generation, catalog })
        return
      }
      yield* this.streamOrchestrated(options, generation)
      return
    }
    if (!options.signal?.aborted && isLiveGeminiFamily(options.model) && generation.catalog === undefined) {
      const catalog = await this.readLiveCatalog(options.signal)
      yield* this.streamInGeneration(options, { ...generation, catalog })
      return
    }
    yield* this.streamInGeneration(options, generation)
  }

  private async *streamOrchestrated(options: AdapterRequestOptions, initialGeneration: ProxyGeneration): AsyncIterable<StreamChunk> {
    if (options.provider !== PROXY_PROVIDER_ID) throw new LlmError('代理模式 adapter 收到未知路由', 'NO_ADAPTER')
    const signal = options.signal
    if (signal?.aborted) { yield finishChunk('aborted', 'CANCELLED'); return }
    const orch = initialGeneration.orchestrator
    if (!orch.enabled) {
      const executorFamily = toProxyFamilyId(orch.executorModel)
      const nextGeneration = isLiveGeminiFamily(executorFamily) && initialGeneration.catalog === undefined
        ? { ...initialGeneration, catalog: await this.readLiveCatalog(signal) }
        : initialGeneration
      yield* this.streamInGeneration({
        ...options,
        model: executorFamily,
        reasoningEffort: ReasoningEffortId(orch.executorEffort),
      }, nextGeneration)
      return
    }

    const generation = initialGeneration.catalog === undefined
      ? { ...initialGeneration, catalog: await this.readLiveCatalog(signal) }
      : initialGeneration
    if (signal?.aborted) { yield finishChunk('aborted', 'CANCELLED'); return }

    const plannerEffort = normalizeReasoningEffort(options.reasoningEffort) ?? orch.plannerEffort
    const executorEffort = orch.executorEffort
    const resolved = resolveProxyOrchestrator(
      orch,
      generation.catalog?.data,
      this.definitions,
      plannerEffort,
      executorEffort,
    )
    if (resolved === undefined) {
      throw llmError('编排模式的 planner/executor 模型不在当前目录', 'INVALID_MODEL')
    }

    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
    const storedState = this.orchestrators.get(sessionId)
    const currentTurnKey = computeTurnKey(options.messages, sessionId)
    const effectiveState = storedState.turnKey !== undefined && currentTurnKey !== undefined && currentTurnKey !== storedState.turnKey
      ? { ...storedState, plansThisTurn: 0 }
      : storedState
    const { goal, evidence } = extractGoalAndEvidence(options.messages)
    const decision = shouldPlan({
      messages: options.messages,
      state: effectiveState,
      goal,
      settings: orch,
      ...(sessionId === undefined ? {} : { sessionId }),
    })

    let activePlan: OrchestratorPlan | undefined = storedState.plan
    let plannerUsage: TokenUsage | undefined
    let emittedShowPlan = false

    if (decision.plan) {
      const result = await this.runPlanner(options, resolved.planner, goal, evidence, storedState.plan, orch, resolved.planner.effort)
      if (signal?.aborted) { yield finishChunk('aborted', 'CANCELLED'); return }
      plannerUsage = result.usage
      if (result.plan !== undefined) {
        activePlan = result.plan
        const nextPlansThisTurn = (decision.reason === 'new-goal' ? 0 : effectiveState.plansThisTurn) + 1
        this.orchestrators.update(sessionId, (prev) => ({
          ...prev,
          plan: result.plan,
          stage: 'executing',
          plansThisTurn: nextPlansThisTurn,
          ...(currentTurnKey === undefined ? {} : { turnKey: currentTurnKey }),
        }))
        if (orch.showPlan) {
          const planText = renderPlanForExecutor(result.plan)
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: planText }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: planText } }
          emittedShowPlan = true
        }
      }
    }

    const executorOptions: AdapterRequestOptions = {
      ...options,
      model: resolved.executor.familyId,
      reasoningEffort: ReasoningEffortId(resolved.executor.effort),
      ...(activePlan === undefined ? {} : { system: buildExecutorSystem(options.system, activePlan) }),
    }

    let mergedUsageEmitted = false
    for await (const rawChunk of this.streamInGeneration(executorOptions, generation)) {
      const chunk = emittedShowPlan ? shiftChunkIndex(rawChunk, 1) : rawChunk
      if (chunk.type === 'usage') {
        const merged = mergeTokenUsage(plannerUsage, chunk.usage)
        if (merged !== undefined) {
          mergedUsageEmitted = true
          yield { type: 'usage', usage: merged }
        }
        continue
      }
      if (chunk.type === 'finish') {
        if (!mergedUsageEmitted && plannerUsage !== undefined && chunk.reason.kind !== 'aborted') {
          mergedUsageEmitted = true
          yield { type: 'usage', usage: plannerUsage }
        }
        if (emittedShowPlan && chunk.replayState !== undefined && Array.isArray(chunk.replayState.blocks)) {
          yield {
            ...chunk,
            replayState: {
              ...chunk.replayState,
              blocks: [{ kind: 'text' }, ...chunk.replayState.blocks],
            },
          }
          continue
        }
        yield chunk
        continue
      }
      yield chunk
    }
  }

  private async runPlanner(
    options: AdapterRequestOptions,
    plannerEndpoint: { readonly familyId: string; readonly wire: string },
    goal: string,
    evidence: readonly string[],
    priorPlan: OrchestratorPlan | undefined,
    orch: OrchestratorSettings,
    plannerEffort = orch.plannerEffort,
  ): Promise<{ plan?: OrchestratorPlan; usage?: TokenUsage }> {
    const signal = options.signal
    const timeoutSignal = AbortSignal.timeout(orch.plannerTimeoutMs)
    const plannerSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

    const baseSystemParts = [
      ...(typeof options.system === 'string' && options.system.trim() ? [options.system] : []),
      ...options.messages.flatMap((message) => message.role === 'system'
        ? message.content.flatMap((block) => block.type === 'text' && block.text.trim() ? [block.text] : [])
        : []),
    ]
    const plannerSystem = baseSystemParts.length > 0
      ? `${baseSystemParts.join('\n\n')}\n\n${PLANNER_SYSTEM_SUFFIX}`
      : PLANNER_SYSTEM_SUFFIX

    const plannerOptions: AdapterRequestOptions = {
      provider: PROXY_PROVIDER_ID,
      model: plannerEndpoint.familyId,
      reasoningEffort: ReasoningEffortId(plannerEffort),
      messages: [...buildPlannerMessages(goal, evidence, priorPlan)],
      system: plannerSystem,
      tools: [],
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    }

    let usage: TokenUsage | undefined
    let refreshed = false
    let refreshNext = false
    try {
      for (;;) {
        const credential = await this.readCredential(plannerSignal, refreshNext)
        refreshNext = false
        if (credential === undefined) throw new LlmError('代理模式需要登录：请在设置页连接代理账户', 'AUTH')
        const payload = await buildProxyGeneratePayload(
          plannerOptions,
          credential,
          this.plannerSessions,
          Date.now(),
          undefined,
          plannerSignal,
          plannerEndpoint.wire,
        )
        const serialized = JSON.stringify({
          ...(payload.project === undefined ? {} : { project: payload.project }),
          requestId: payload.requestId,
          request: payload.request,
          model: payload.model,
          userAgent: payload.userAgent,
          requestType: payload.requestType,
        })
        if (new TextEncoder().encode(serialized).byteLength > 16 * 1024 * 1024) {
          throw llmError('代理模式请求超出传输字节上限', 'REQUEST_LIMIT')
        }
        const response = await this.options.transport.request({
          url: STREAM_ENDPOINT,
          accessToken: credential.accessToken,
          body: serialized,
          signal: plannerSignal,
          ...(this.options.responseHeaderTimeoutMs === undefined ? {} : { responseHeaderTimeoutMs: this.options.responseHeaderTimeoutMs }),
        })
        const statusError = proxyStatusError(response.status)
        if (statusError !== undefined) {
          if (statusError.code === 'authentication' || statusError.code === 'forbidden') {
            const suspended = await suspendedAccountError(response, plannerSignal)
            if (suspended !== undefined) throw suspended
            if (!refreshed && !plannerSignal.aborted) {
              await cancelResponse(response)
              refreshed = true
              refreshNext = true
              continue
            }
          }
          await cancelResponse(response)
          throw toLlmError(statusError)
        }

        let collectedText = ''
        let retryAuth = false
        for await (const sse of iterateProxySse(response, {
          signal: plannerSignal,
          idleTimeoutMs: Math.min(PROXY_IDLE_TIMEOUT_MS, orch.plannerTimeoutMs),
          totalTimeoutMs: orch.plannerTimeoutMs,
          maxBytes: PROXY_STREAM_RESPONSE_BYTES,
          maxFrameBytes: PROXY_FRAME_BYTES,
        })) {
          if (sse.data.trim() === '[DONE]') break
          const event = parseProxyProviderEvent(sse.data)
          if (event.error !== undefined) {
            if ((event.error.status === 401 || isAuthenticationCode(event.error.code) || event.error.status === 403 || event.error.code?.toUpperCase() === 'PERMISSION_DENIED')
              && !refreshed && !plannerSignal.aborted && collectedText.length === 0) {
              refreshed = true
              refreshNext = true
              retryAuth = true
              break
            }
            throw llmError(`编排 planner 上游错误: ${event.error.message ?? event.error.code ?? String(event.error.status ?? 'unknown')}`, 'UPSTREAM')
          }
          if (event.usage !== undefined) usage = event.usage
          for (const part of event.parts) {
            if (part.kind === 'text' && part.text) collectedText += part.text
          }
        }
        if (retryAuth) continue
        if (signal?.aborted) return {}

        const plan = parsePlan(collectedText, priorPlan)
        if (plan === undefined) {
          this.options.log?.warn('antigravity-proxy: 编排 planner 未产出有效计划，降级直接执行')
          return { ...(usage === undefined ? {} : { usage }) }
        }
        return { plan, ...(usage === undefined ? {} : { usage }) }
      }
    } catch (error) {
      if (signal?.aborted) return {}
      this.options.log?.warn('antigravity-proxy: 编排 planner 失败，降级直接执行', error)
      return { ...(usage === undefined ? {} : { usage }) }
    }
  }

  private async *streamInGeneration(options: AdapterRequestOptions, generation: ProxyGeneration): AsyncIterable<StreamChunk> {
    if (options.provider !== PROXY_PROVIDER_ID) throw new LlmError('代理模式 adapter 收到未知路由', 'NO_ADAPTER')
    const signal = options.signal
    const requested = this.definitions[options.model]
    if (!isLiveGeminiFamily(options.model) && (requested === undefined || requested.modalities.output.includes('image'))) {
      throw llmError('该模型不在代理模式审计文本快照内', 'INVALID_MODEL')
    }
    if (signal?.aborted) { yield finishChunk('aborted', 'CANCELLED'); return }
    const wireModel = this.wireModel(options.model, options.reasoningEffort, generation)
    const routedDefinition = modelSettingFor(generation.settings, options.model).target === undefined ? requested : this.definitionForWireModel(wireModel)
    const acceptsImage = this.acceptsImage(wireModel, generation, routedDefinition?.modalities.input.includes('image') === true)
    if (!acceptsImage && options.messages.some(message => message.content.some(block => block.type === 'image' && !block.offloaded))) {
      throw llmError('所选代理模型或档位不支持图片输入，请切换到支持图片的档位或移除图片', 'UNSUPPORTED_MODALITY')
    }
    const attachments = acceptsImage ? generation.attachments : undefined
    const hasEmitted = { value: false }
    let refreshed = false
    let refreshNext = false
    let networkRetries = 0
    let malformedRetries = 0
    for (;;) {
      const credential = await this.readCredential(signal, refreshNext)
      refreshNext = false
      if (credential === undefined) throw new LlmError('代理模式需要登录：请在设置页连接代理账户', 'AUTH')
      if (generation.catalog !== undefined && credentialCatalogKey(credential) !== generation.catalog.key) {
        throw llmError('代理模式账户已切换，请重新选择模型', 'CANCELLED')
      }
      let payload: Awaited<ReturnType<typeof buildProxyGeneratePayload>>
      try {
        payload = await buildProxyGeneratePayload(options, credential, this.sessions, Date.now(), attachments, signal, wireModel)
      } catch (error) {
        if (signal?.aborted) throw llmError('代理模式请求已取消', 'CANCELLED')
        // 图片准入与校验失败在 image.ts / payload.ts 里已经一律是 LlmError，这里
        // 直接透传；非 LlmError 是构包期间的其它异常，不能伪装成附件问题。
        if (error instanceof LlmError) throw error
        throw llmError(
          `代理模式请求构造失败：${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
          'AGY_PAYLOAD_BUILD',
          { cause: error },
        )
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
        throw llmError('代理模式请求超出传输字节上限', 'REQUEST_LIMIT')
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
        if (statusError.code === 'authentication' || statusError.code === 'forbidden') {
          // 先分辨「账号被上游停用」：换发登录态与重试都救不回来，第一次与刷新后的
          // 第二次 403 都要认（magpie 记录这条形态也会出现在流内 error 事件里）。
          const suspended = await suspendedAccountError(response, signal)
          if (suspended !== undefined) throw suspended
          if (!refreshed && !hasEmitted.value && !signal?.aborted) {
            await cancelResponse(response)
            refreshed = true
            refreshNext = true
            continue
          }
        }
        if (statusError.code === 'rate-limited' && !hasEmitted.value) {
          // 只有上游原话说配额/容量耗尽才报额度耗尽；别的 429 就是限流本身。
          const body = await readProxyText(response, { signal }).catch(() => '')
          await cancelResponse(response)
          const lowered = body.toLowerCase()
          const exhausted = lowered.includes('resource has been exhausted') || lowered.includes('exhausted your capacity') || lowered.includes('reached your current quota')
          // 两个分支都附带上游原话（脱敏有界）：配额耗尽时重置时间等关键诊断
          // 信息在上游 message 里，丢掉它用户只看到一句泛化的「稍后重试」（issue #14）。
          const detail = rateLimitDetail(body)
          throw new LlmError(
            !exhausted
              ? `代理模式请求被上游拒绝（429）${detail.length > 0 ? `：${detail}` : ''}；可稍后重试或切换回 ACP 模式`
              : `代理模式账户被上游限流（429，配额或容量已耗尽）${detail.length > 0 ? `：${detail}` : ''}；稍后重试或切换回 ACP 模式`,
            'RATE_LIMIT',
            { status: response.status },
          )
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
        if (transportError?.code === 'malformed-function-call' && !hasEmitted.value && !signal?.aborted) {
          if (malformedRetries < MAX_MALFORMED_RETRIES) {
            malformedRetries += 1
            await waitBackoff(malformedRetries, signal)
            continue
          }
          yield finishChunk('error', 'MALFORMED_FUNCTION_CALL')
          return
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

  private async *streamResponse(response: Response, options: AdapterRequestOptions, hasEmitted: { value: boolean }, wireModel: string): AsyncGenerator<StreamChunk, boolean> {
    const { finish, eventError, states, sawDone } = yield* assembleGeminiStream(response, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      sse: {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        idleTimeoutMs: PROXY_IDLE_TIMEOUT_MS,
        totalTimeoutMs: PROXY_TOTAL_TIMEOUT_MS,
        maxBytes: PROXY_STREAM_RESPONSE_BYTES,
        maxFrameBytes: PROXY_FRAME_BYTES,
      },
      blocks: PROXY_BLOCKS,
      hasEmitted,
      label: '代理模式',
      onAuthError: (error) => {
        if (error.status === 401 || isAuthenticationCode(error.code)) {
          throw new ProxyTransportError('authentication', '代理模式凭据被上游拒绝', { status: error.status ?? 401 })
        }
        if (error.status === 403 || error.code?.toUpperCase() === 'PERMISSION_DENIED') throw new ProxyTransportError('forbidden', '代理模式账户被上游拒绝', { status: 403 })
      },
    })
    if (eventError !== undefined) {
      // 停用也会以流内 error 事件出现（magpie 记录过这条形态）：先认它，再谈别的。
      const suspended = suspendedErrorFor(eventError.message ?? '', eventError.status)
      if (suspended !== undefined) throw suspended
      const code = eventError.contextWindowExceeded === true ? CONTEXT_WINDOW_EXCEEDED_CODE : safeProviderErrorCode(eventError.code, eventError.status)
      // 限流事件附带上游原话（脱敏有界），配额重置时间等诊断不丢（issue #14）。
      const detail = code === 'RATE_LIMIT' ? redactSensitiveText((eventError.message ?? '').trim().slice(0, 300)) : ''
      yield finishChunk(
        'error',
        code,
        eventError.status,
        undefined,
        detail === '' ? undefined : detail,
      )
      return false
    }
    if (options.signal?.aborted) { yield finishChunk('aborted', 'CANCELLED'); return false }
    // 上游模型侧工具参数校验失败（finishReason MALFORMED_FUNCTION_CALL，流里无合法
    // functionCall）：未出块时交外层有界重试一次（镜像 gemini-cli 的内部重试）；已出块
    // 则不能重发（会重复文本），落回下面的普通错误收尾。
    if (finish?.toUpperCase() === 'MALFORMED_FUNCTION_CALL' && !hasEmitted.value && !options.signal?.aborted) {
      throw new ProxyTransportError('malformed-function-call', '代理模式上游工具参数校验失败（MALFORMED_FUNCTION_CALL）')
    }
    if (mapFinishReason(finish) === 'error') { yield finishChunk('error', finish ?? 'UPSTREAM'); return false }
    if (states.length === 0) { yield finishChunk('error', 'EMPTY_RESPONSE'); return false }
    if (finish === undefined && !sawDone) throw new LlmError('代理模式响应流在完成标记之前结束', 'TRANSPORT')
    const replayBlocks: ProxyReplayBlock[] = states.map((state) => ({ kind: state.kind, ...(state.signature === undefined ? {} : { signature: state.signature }) }))
    const reason = mapFinishReason(finish)
    yield finishChunk(reason === 'stop' && states.some(state => state.kind === 'tool-call') ? 'tool-calls' : reason, finish ?? 'STOP', undefined,
      createProxyReplayState(options.model, proxyModelFamily(wireModel), finish, replayBlocks, wireModel))
    return reason !== 'error'
  }

  private pinnedTextModelInfos(generation: ProxyGeneration, catalog: CatalogSnapshot): readonly (LlmModelInfo & ModelCapacity)[] {
    const bound = { ...generation, catalog }
    const rows = Array.from(catalog.data.models.keys(), id => {
      const resolved = this.resolveModelInGeneration(PROXY_PROVIDER_ID, id, bound)
      const wire = this.wireModel(id, undefined, bound)
      const { maxOutputTokens } = this.liveLimits(this.possibleWires(id, wire, bound), bound)
      return { provider: resolved.provider, id: resolved.id, name: resolved.name, inputModalities: resolved.inputModalities,
        contextWindow: resolved.context?.contextWindow, maxOutputTokens }
    })
    const orchestrated = synthesizeProxyOrchestratorModel({
      settings: generation.orchestrator,
      catalog: catalog.data,
      definitions: this.definitions,
      attachmentsAvailable: generation.attachments !== undefined,
      modelSettings: generation.settings,
    })
    return orchestrated === undefined ? rows : [...rows, orchestrated]
  }

  private async readLiveCatalog(signal?: AbortSignal, force = false, revision = this.catalogRevision, onCredentialKey?: (key: string) => void): Promise<CatalogSnapshot> {
    const credential = await this.readCredential(signal, force)
    this.assertCatalogCurrent(revision, signal)
    if (credential === undefined) throw new LlmError('代理模式需要登录后才能读取模型目录', 'AUTH')
    const key = credentialCatalogKey(credential)
    onCredentialKey?.(key)
    if (!force && this.catalogKey === key && Date.now() < this.catalogExpiresAt) {
      if (this.catalogFailureCode !== undefined) throw llmError('代理模式模型目录仍不可用', this.catalogFailureCode)
      if (this.catalogLastGood?.key === key) return this.catalogLastGood
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
        return this.readLiveCatalog(signal, true, revision, onCredentialKey)
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
        maxBytes: PROXY_RESPONSE_BYTES,
      })) as unknown
    } catch (error) {
      const failure = error instanceof ProxyTransportError && error.code === 'response-too-large'
        ? llmError(`读取代理模式模型目录失败：${error.message}`, 'REQUEST_LIMIT', { cause: error })
        : toLlmError(error)
      this.rememberCatalogFailure(key, failure, revision)
      throw failure
    }
    let data: LiveProxyCatalog
    try {
      data = parseLiveProxyCatalog(value, this.definitions)
    } catch (error) {
      const failure = error instanceof LlmError ? error : llmError('代理模式模型目录不符合预期结构', 'PROTOCOL_DRIFT')
      this.rememberCatalogFailure(key, failure, revision)
      throw failure
    }
    this.assertCatalogCurrent(revision, signal)
    this.catalogKey = key
    const catalog = this.catalogLastGood = { key, data }
    this.catalogFailureCode = undefined
    this.catalogExpiresAt = Date.now() + MODEL_CATALOG_TTL_MS
    return catalog
  }

  private assertCatalogCurrent(revision: number, signal?: AbortSignal): void {
    if (revision !== this.catalogRevision || signal?.aborted) throw llmError('代理模式模型目录请求已失效或取消', 'CANCELLED')
  }

  private rememberCatalogFailure(key: string, failure: LlmError, revision: number): void {
    this.assertCatalogCurrent(revision)
    if (failure.code === 'AUTH' || failure.code === 'CANCELLED') return
    this.catalogKey = key
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

function credentialCatalogKey(credential: ProxyCredential): string {
  return createHash('sha256').update(JSON.stringify([credential.email ?? credential.refreshToken ?? credential.accessToken, credential.projectId])).digest('hex')
}

function selectLiveGeminiWire(observed: LiveProxyModel | undefined, setting: ModelSetting, effort: string | undefined): string {
  if (observed?.liveGemini === undefined) throw new LlmError('当前账户的模型目录未提供此模型', 'MODEL_UNSUPPORTED')
  if (setting.target !== undefined) return setting.target
  const { variants } = observed.liveGemini
  if (effort === undefined) return (setting.effort === undefined ? undefined : variants.get(setting.effort)) ?? observed.defaultWire
  const requested = effort.toLowerCase() === 'xhigh' ? 'xhigh' : normalizeReasoningEffort(effort)
  const wire = requested === undefined ? undefined : variants.get(requested)
  if (wire === undefined) throw new LlmError('当前账户的模型目录未提供所选思考档位', 'UNSUPPORTED_REASONING_EFFORT')
  return wire
}

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof LlmError) return ['TRANSPORT', 'TIMEOUT', 'UPSTREAM'].includes(error.code)
  const name = error instanceof Error ? error.name : ''
  return name === 'ProxyTransportError' && ['offline', 'timeout', 'upstream'].includes((error as ProxyTransportError).code)
}

async function waitBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw llmError('代理模式请求已取消', 'CANCELLED')
  const ms = Math.min(1000 * 2 ** (attempt - 1), 4000)
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(llmError('代理模式请求已取消', 'CANCELLED')) }
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
    if (signal?.aborted || error instanceof ProxyTransportError && error.code === 'cancelled') throw llmError('代理模式请求已取消', 'CANCELLED')
    return false
  }
}

/** 会进入 systemInstruction 的消息角色：payload 把它们与 options.system 并成一条指令。 */
/** 上游对「账号被停用」的回答（magpie 记录的 Google 原话）：
 * 403 `This service has been disabled in this account for violation of Terms of
 * Service. Please submit an appeal …`。导出以便单测。
 */
export function isAccountSuspended(body: string): boolean {
  const text = body.toLowerCase()
  return text.includes('violation of terms of service') || text.includes('has been disabled in this account')
}

/** 命中「服务因违反条款被停用」时给出专门错误；否则 undefined。 */
function suspendedErrorFor(body: string, status?: number): LlmError | undefined {
  if (!isAccountSuspended(body)) return undefined
  return llmError(
    '代理模式账户已被上游停用：Antigravity 报告该账号违反了服务条款（violation of Terms of Service）。' +
      '换发登录态或重试都无法恢复，请在 Google 账号侧申诉后再连接；期间可切回 ACP 模式',
    'AGY_ACCOUNT_SUSPENDED',
    { status },
  )
}

/** 读一次有界响应体，判断它是不是「账号被停用」。 */
async function suspendedAccountError(response: Response, signal?: AbortSignal): Promise<LlmError | undefined> {
  const body = await readProxyText(response, { signal }).catch(() => '')
  return suspendedErrorFor(body, response.status)
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
    return llmError(transport.message, code, ...(transport.status === undefined ? [] : [{ status: transport.status }]))
  }
  return new LlmError(error instanceof Error ? error.message : String(error), 'TRANSPORT', { cause: error })
}

/** 429 上游原话提取：优先 Google 错误 JSON 的 error.message，否则原文；脱敏有界。 */
function rateLimitDetail(body: string): string {
  let text = body.trim()
  try {
    const parsed = JSON.parse(text) as unknown
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string') text = parsed.error.message
  } catch { /* 非 JSON  body：用原文 */ }
  return redactSensitiveText(text.slice(0, 300))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shiftChunkIndex(chunk: StreamChunk, offset: number): StreamChunk {
  if (offset === 0) return chunk
  switch (chunk.type) {
    case 'block-start':
    case 'text-delta':
    case 'reasoning-delta':
    case 'tool-call-delta':
    case 'block-end':
      return { ...chunk, index: chunk.index + offset }
    default:
      return chunk
  }
}

export function mergeTokenUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  const inputTokens = a.inputTokens + b.inputTokens
  const outputTokens = a.outputTokens + b.outputTokens
  const cacheReadTokens = sumOptionalCount(a.cacheReadTokens, b.cacheReadTokens)
  const cacheWriteTokens = sumOptionalCount(a.cacheWriteTokens, b.cacheWriteTokens)
  const reasoningTokens = sumOptionalCount(a.reasoningTokens, b.reasoningTokens)
  const knownSum = inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) + (reasoningTokens ?? 0)
  const totalCandidate = a.totalTokens !== undefined || b.totalTokens !== undefined
    ? (a.totalTokens ?? knownUsageTotal(a)) + (b.totalTokens ?? knownUsageTotal(b))
    : undefined
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(totalCandidate === undefined || totalCandidate < knownSum ? {} : { totalTokens: totalCandidate }),
  }
}

function sumOptionalCount(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
}

function knownUsageTotal(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.reasoningTokens ?? 0)
}

export { PROXY_RESPONSE_HEADER_TIMEOUT_MS }
export { normalizeReasoningEffort }
