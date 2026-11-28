import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AdapterPreparedCall, AdapterRequestOptions } from '../adapter/request-options.js'
import { buildGeminiPayload } from '../adapter/gemini-payload.js'
import { assembleGeminiStream, createGeminiBlockAssembler } from '../proxy/gemini-stream.js'
import { reportsContextWindowExceeded } from '../proxy/payload.js'
import { ProxyTransportError, readProxyText } from '../proxy/transport.js'
import { llmError } from '../runtime/llm-error.js'
import { ProxyConfigError } from '../runtime/proxy-env.js'
import { listConfiguredVertexModels } from './catalog.js'
import { discoverVertexModels } from './discovery.js'
import { resolveVertexScope } from './environment.js'
import { validVertexScope, vertexStreamUrl, VERTEX_LABEL, VERTEX_PROVIDER_ID } from './endpoints.js'
import type { VertexTarget } from './endpoints.js'
import { vertexReplayBlocks, vertexReplayState } from './replay.js'
import type { VertexSettingsBus } from './settings-bus.js'

const BLOCKS = createGeminiBlockAssembler({ label: VERTEX_LABEL, idPrefix: VERTEX_PROVIDER_ID })
const { finishChunk, mapFinishReason, safeProviderErrorCode } = BLOCKS
const HEADER_TIMEOUT_MS = 60_000

interface VertexAdapterOptions {
  settings: VertexSettingsBus
  token(signal: AbortSignal): Promise<string>
  fetch: typeof fetch
}

type VertexModel = ReturnType<typeof listConfiguredVertexModels>[number]
interface Selection { target: VertexTarget; model: LlmResolvedModelInfo; controls: VertexModel['controls']; generation: AbortSignal }

export class VertexAdapter extends LlmAdapter {
  private identity = ''
  private generation = new AbortController()
  private disposed = false

  constructor(private readonly options: VertexAdapterOptions) { super() }

  /** A scope transition invalidates prior selections, even if settings later return to the original scope. */
  syncScope(scope = this.scope()): void {
    const settings = this.options.settings
    const key = JSON.stringify([settings.enabled(), scope.project, scope.location])
    if (key === this.identity || this.disposed) return
    this.generation.abort()
    this.generation = new AbortController()
    this.identity = key
  }

  dispose(): void { this.disposed = true; this.generation.abort() }

  override providerInfo(provider: string): LlmProviderInfo {
    if (provider !== VERTEX_PROVIDER_ID) throw llmError('未知的 Vertex AI 路由', 'NO_ADAPTER')
    return { id: VERTEX_PROVIDER_ID, name: 'Google Vertex AI' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.providerInfo(provider)
    const { settings } = this.options
    if (this.disposed || !settings.enabled() || !validVertexScope(this.scope())) return []
    return this.catalog().filter(entry => entry.enabled).map(({ controls, resolvedContextWindow, ...entry }) => entry)
  }

  /** Explicit refresh only; Model Garden candidates never auto-register in the model selector. */
  async discoverModels(): Promise<readonly string[]> {
    const { scope, generation } = this.activeScope()
    const checkScope = () => {
      this.syncScope()
      if (generation.aborted) throw llmError('Vertex AI 配置已变更，模型目录请求已取消', 'CANCELLED')
    }
    try {
      const token = await this.options.token(generation)
      checkScope()
      const models = await discoverVertexModels({ project: scope.project, token, signal: generation, fetch: this.options.fetch, checkScope })
      checkScope()
      return models
    } catch (error) {
      checkScope()
      throw vertexError(error)
    }
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return this.select(provider, model).model
  }

  override async prepareCall(provider: string, model: string): Promise<AdapterPreparedCall> {
    const selection = this.select(provider, model)
    return { model: selection.model, stream: options => this.streamSelection(options, selection) }
  }

  override async *stream(options: AdapterRequestOptions): AsyncIterable<StreamChunk> {
    yield* this.streamSelection(options, this.select(options.provider, options.model))
  }

  private scope() {
    const { settings } = this.options
    return resolveVertexScope(settings.project(), settings.location())
  }

  private activeScope() {
    const scope = this.scope()
    this.syncScope(scope)
    if (this.disposed || !this.options.settings.enabled()) throw llmError('Vertex AI 路由未启用', 'NO_ADAPTER')
    if (!validVertexScope(scope)) throw llmError('请配置有效的 Vertex AI 项目和区域', 'INVALID_ARGS')
    return { scope, generation: this.generation.signal }
  }

  private catalog() {
    const { settings } = this.options
    return listConfiguredVertexModels(settings.models(), settings.modelSettings().modelOverrides)
  }

  private select(provider: string, id: string): Selection {
    this.providerInfo(provider)
    const { scope, generation } = this.activeScope()
    const entry = this.catalog().find(item => item.id === id)
    if (entry === undefined) throw llmError('Vertex AI 模型未配置或映射的文本对话模型 ID 无效', 'INVALID_MODEL')
    const model: LlmResolvedModelInfo = {
      provider, id, name: entry.name, inputModalities: ['text'],
      ...(entry.resolvedContextWindow === undefined ? {} : { context: { contextWindow: entry.resolvedContextWindow } }),
      ...(entry.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: entry.defaultMaxTokens }),
      ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
    }
    return { target: { ...scope, model: id, wireModel: entry.upstreamId }, model, controls: entry.controls, generation }
  }

  private async *streamSelection(options: AdapterRequestOptions, { target, controls, generation }: Selection): AsyncGenerator<StreamChunk> {
    if (options.provider !== VERTEX_PROVIDER_ID || options.model !== target.model) throw llmError('Vertex AI 请求与已准备模型不匹配', 'INVALID_MODEL')
    this.syncScope()
    const signal = options.signal === undefined ? generation : AbortSignal.any([generation, options.signal])
    const transport = new AbortController()
    const requestSignal = AbortSignal.any([signal, transport.signal])
    try {
      if (signal.aborted) { yield finishChunk('aborted', 'CANCELLED'); return }
      const request = buildGeminiPayload(options, { label: VERTEX_LABEL, controls, replayBlocks: (message, kinds) => vertexReplayBlocks(message, kinds, target) })
      const token = await this.options.token(signal)
      this.syncScope()
      if (signal.aborted) { yield finishChunk('aborted', 'CANCELLED'); return }
      const response = await this.post(vertexStreamUrl(target), token, request, transport, requestSignal)
      if (requestSignal.aborted) {
        void response.body?.cancel().catch(() => undefined)
        signal.throwIfAborted()
        throw llmError('等待 Vertex AI 响应超时', 'TIMEOUT')
      }
      if (!response.ok) throw await statusError(response, requestSignal)
      yield* streamResponse(response, requestSignal, target)
    } catch (error) {
      if (signal.aborted) { yield finishChunk('aborted', 'CANCELLED'); return }
      throw vertexError(error)
    } finally {
      transport.abort()
    }
  }

  private async post(url: string, token: string, payload: Record<string, unknown>, transport: AbortController, signal: AbortSignal): Promise<Response> {
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; transport.abort() }, HEADER_TIMEOUT_MS)
    try {
      return await this.options.fetch(url, {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(payload),
      })
    } catch (error) {
      if (timedOut) throw llmError('等待 Vertex AI 响应超时', 'TIMEOUT')
      throw error
    } finally { clearTimeout(timer) }
  }
}

async function* streamResponse(response: Response, signal: AbortSignal, target: VertexTarget): AsyncGenerator<StreamChunk> {
  const { finish, eventError, states, sawDone } = yield* assembleGeminiStream(response, {
    signal, sse: { signal, idleTimeoutMs: 240_000, totalTimeoutMs: 600_000, maxBytes: 64 * 1024 * 1024, maxFrameBytes: 2 * 1024 * 1024 },
    blocks: BLOCKS, hasEmitted: { value: false }, label: VERTEX_LABEL,
  })
  if (signal.aborted) { yield finishChunk('aborted', 'CANCELLED'); return }
  if (eventError !== undefined) {
    const code = eventError.contextWindowExceeded === true ? CONTEXT_WINDOW_EXCEEDED_CODE : safeProviderErrorCode(eventError.code, eventError.status)
    yield finishChunk('error', code, eventError.status)
    return
  }
  const reason = mapFinishReason(finish)
  if (reason === 'error') {
    const known = new Set(['SAFETY', 'BLOCKLIST', 'ERROR', 'RECITATION', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'OTHER'])
    yield finishChunk('error', finish !== undefined && known.has(finish) ? finish : 'UPSTREAM')
    return
  }
  if (states.length === 0) { yield finishChunk('error', 'EMPTY_RESPONSE'); return }
  if (finish === undefined && !sawDone) throw llmError('Vertex AI 响应流在完成标记之前结束', 'TRANSPORT')
  yield finishChunk(reason === 'stop' && states.some(state => state.kind === 'tool-call') ? 'tool-calls' : reason,
    'STOP', undefined, vertexReplayState(target, states))
}

async function statusError(response: Response, signal: AbortSignal): Promise<LlmError> {
  const status = response.status
  if (status === 400) {
    try {
      const text = await readProxyText(response, { signal, maxBytes: 32 * 1024, totalTimeoutMs: 5_000 })
      const raw: unknown = JSON.parse(text)
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && reportsContextWindowExceeded(raw as Record<string, unknown>)) {
        return llmError('上下文超出 Vertex AI 模型容量', CONTEXT_WINDOW_EXCEEDED_CODE, { status })
      }
    } catch { /* Use HTTP status if the error body is unavailable, oversized or not JSON. */ }
  }
  const detail = status === 401 ? '；请检查应用默认凭据' : status === 403 ? '；请检查项目 IAM 权限与 Vertex AI API'
    : status === 404 ? '；请检查模型 ID 与项目所选区域' : ''
  return llmError(`Vertex AI 上游错误（${status}）${detail}`, status === 404 ? 'INVALID_MODEL' : safeProviderErrorCode(undefined, status), { status })
}

function vertexError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof ProxyConfigError) return llmError('Vertex AI 代理配置或传输初始化失败', 'AGY_INVALID_PROXY')
  if (error instanceof ProxyTransportError) {
    if (error.code === 'timeout') return llmError('Vertex AI 响应流超时', 'TIMEOUT')
    if (error.code === 'response-too-large' || error.code === 'frame-too-large') return llmError('Vertex AI 响应超出读取预算', 'REQUEST_LIMIT')
    if (error.code === 'invalid-response' || error.code === 'protocol-drift') return llmError('Vertex AI 响应流格式无效', 'PROTOCOL_DRIFT')
  }
  return llmError('Vertex AI 网络请求失败', 'TRANSPORT')
}
