/**
 * 代理模式的请求构造：DSH 消息 → Cloud Code Assist `streamGenerateContent` 线载荷。
 *
 * 口径与 dsh-tool-antigravity 的 llm-adapter 一致，复用 core 的
 * `applyClaudeTransforms` / `applyGeminiTransforms` / `buildAgyAgentRequestMetadata`
 * 等审计变换；本模块只负责消息映射与有界化：
 * - system / developer 文本 → `systemInstruction.parts`；
 * - assistant → role `model`，tool 结果 → `functionResponse`；
 * - thoughtSignature 优先取块自带值，其次取 replay 元数据，functionCall 缺签名时
 *   补官方 sentinel（`skip_thought_signature_validator`），Claude 家族仅首个 call 带签名；
 * - 图片经宿主附件服务有界读取后转 `inlineData`（见 image.ts）；附件服务缺席时
 *   报 `UNSUPPORTED_MODALITY` 而不是静默丢弃；上游返回媒体输出仍按协议漂移拒绝。
 */
import {
  AgyRequestSessionStore,
  CLAUDE_DESCRIPTION_PROMPT,
  CLAUDE_TOOL_SYSTEM_INSTRUCTION,
  SKIP_THOUGHT_SIGNATURE,
  applyAgyNativeGenerationConfig,
  applyClaudeTransforms,
  applyGeminiTransforms,
  buildAgyAgentRequestMetadata,
  fnv1a64Signed,
  getAgyNativeModel,
  isGeminiArgonModel,
  orderAgyRequestPayloadInPlace,
  resolveModelWithTier,
} from '@cortexkit/antigravity-auth-core'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { buildProxyFunctionDeclarations, compatibleProxyReplayState, proxyModelFamily, PROXY_MAX_SIGNATURE_LENGTH } from './replay.js'
import type { ProxyReplayBlock, ReplayBlockKind } from './replay.js'
import { projectProxyOffloadedImages, readProxyImage, requiredProxyImageOffload } from './image.js'
import type { ProxyAttachmentReader } from './image.js'

export interface ProxyCredentialForPayload {
  projectId?: string
}

export interface ProxyGeneratePayload {
  project?: string
  requestId: string
  request: Record<string, unknown>
  model: string
  userAgent: 'antigravity'
  requestType: 'agent'
  /** 本次实际发送的每张附件字节（base64 前）；供 offload 协商计费。 */
  sentImageBytes: Map<string, number>
}

export const PROXY_SESSION_STORE_KEY = 'dsh-antigravity-proxy'

/** 进程内会话上下文（labels / sessionId 的连续性），与参考实现同口径。 */
export function createProxySessionStore(): AgyRequestSessionStore {
  return new AgyRequestSessionStore(PROXY_SESSION_STORE_KEY)
}

export function proxySessionKey(options: GenerateOptions): string {
  return options.sessionId === undefined ? 'default' : `session:${fnv1a64Signed(String(options.sessionId))}`
}

/** 解析线模型：档位后缀 → core 的别名解析。 */
export function resolveProxyWireModel(model: string, reasoningEffort?: string): string {
  const effort = normalizeReasoningEffort(reasoningEffort)
  let routeModel = model
  if (effort !== undefined && !/-(?:minimal|low|medium|high)$/iu.test(model)) {
    if (
      /^(?:antigravity-)?gemini-3\.[58]-flash$/iu.test(model)
      || /^(?:antigravity-)?gemini-4-argon$/iu.test(model)
      || /^(?:antigravity-)?claude-(?:opus|sonnet)-5-5$/iu.test(model)
    ) {
      routeModel = `${model}-${effort}`
    }
  }
  return resolveModelWithTier(routeModel).actualModel
}

export function normalizeReasoningEffort(value: string | undefined): 'low' | 'medium' | 'high' | undefined {
  if (value === undefined) return undefined
  const normalized = String(value).toLowerCase()
  if (normalized === 'minimal' || normalized === 'low') return 'low'
  if (normalized === 'medium') return 'medium'
  if (normalized === 'high') return 'high'
  return undefined
}

export async function buildProxyGeneratePayload(
  options: GenerateOptions,
  credential: ProxyCredentialForPayload,
  sessions: AgyRequestSessionStore,
  timestamp: number,
  attachments?: ProxyAttachmentReader,
  signal?: AbortSignal,
  wireModelOverride?: string,
): Promise<ProxyGeneratePayload> {
  const wireModel = wireModelOverride ?? resolveProxyWireModel(options.model, options.reasoningEffort)
  const toolNames = new Map<string, ToolCallState>()
  const sentImageBytes = new Map<string, number>()
  // 已 offload 的图片先投影成占位文本：模型看到「未发送像素」的说明而不是静默丢失。
  const history = projectProxyOffloadedImages(options.messages) as readonly RequestMessage[]
  const contents: Record<string, unknown>[] = []
  for (const message of history) {
    if (message.role === 'system' || message.role === 'developer') continue
    contents.push(await mapMessage(message, options.model, toolNames, attachments, signal, sentImageBytes, wireModel))
  }
  const request: Record<string, unknown> = { contents: groupClaudeFunctionResponses(contents, wireModel) }
  const systemParts = [
    ...(typeof options.system === 'string' && options.system.trim() ? [{ text: options.system }] : []),
    ...options.messages.flatMap((message) => message.role === 'system' || message.role === 'developer'
      ? message.content.flatMap((block) => block.type === 'text' && block.text.trim() ? [{ text: block.text }] : [])
      : []),
  ]
  if (systemParts.length > 0) request.systemInstruction = { parts: systemParts }
  const generationConfig: Record<string, unknown> = {}
  if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = boundedInteger(options.maxTokens, 1, 1_000_000, 'maxTokens')
  else if (/^gemini-3\.8-flash-(?:low|medium|high)$/u.test(wireModel)) generationConfig.maxOutputTokens = 65536
  if (options.temperature !== undefined) generationConfig.temperature = boundedNumber(options.temperature, -100, 100, 'temperature')
  if (options.stop !== undefined) generationConfig.stopSequences = options.stop.slice(0, 16).map((item) => String(item).slice(0, 256))
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig
  if (options.tools !== undefined && options.tools.length > 0) {
    const declarations = buildProxyFunctionDeclarations(options.tools)
    if (declarations.length > 0) request.tools = [{ functionDeclarations: declarations }]
  }
  applyFamilyTransforms(request, wireModel, options.reasoningEffort)
  const project = credential.projectId === 'inductive-dreamer-qrkws' || !credential.projectId ? undefined : credential.projectId
  const payload = {
    ...(project === undefined ? {} : { project }),
    requestId: '',
    request,
    model: wireModel,
    userAgent: 'antigravity' as const,
    requestType: 'agent' as const,
  }
  // agy 请求元数据（labels / sessionId / requestId）按 core 的审计口径补齐。
  const sessionKey = proxySessionKey(options)
  const scope = sessions.beginRequest(sessionKey)
  const metadata = buildAgyAgentRequestMetadata(scope.session, request, wireModel, Math.max(timestamp, scope.timestamp))
  request.labels = metadata.labels
  request.sessionId = metadata.sessionId
  orderAgyRequestPayloadInPlace(request)
  return { ...payload, requestId: metadata.requestId, sentImageBytes }
}

/** 请求成功完成后推进会话步数（labels 的 last_step_index 连续性）。 */
export function completeProxyExecution(sessions: AgyRequestSessionStore, options: GenerateOptions): void {
  sessions.completeExecution(proxySessionKey(options))
}

// ---------------------------------------------------------------- internals

function applyFamilyTransforms(request: Record<string, unknown>, wireModel: string, reasoningEffort?: string): void {
  const resolved = resolveModelWithTier(wireModel)
  const nativeModel = getAgyNativeModel(wireModel)
  const usesAdaptiveNativeThinking = isGeminiArgonModel(wireModel) || nativeModel?.supportsAdaptiveThinking === true
  const usesNumericGeminiThinkingBudget = !wireModel.toLowerCase().includes('claude') && !usesAdaptiveNativeThinking && typeof resolved.thinkingBudget === 'number'
  const requestedEffort = normalizeReasoningEffort(reasoningEffort)
  const thinkingLevel = requestedEffort ?? resolved.thinkingLevel
  if (wireModel.toLowerCase().includes('claude')) {
    applyClaudeToolHardening(request)
    applyClaudeTransforms(request, {
      model: wireModel,
      ...(resolved.thinkingBudget === undefined || usesAdaptiveNativeThinking ? {} : { tierThinkingBudget: resolved.thinkingBudget }),
      ...(usesAdaptiveNativeThinking || (reasoningEffort === undefined && resolved.thinkingBudget === undefined) ? {} : { normalizedThinking: { includeThoughts: true, ...(resolved.thinkingBudget === undefined ? {} : { thinkingBudget: resolved.thinkingBudget }) } }),
      cleanJSONSchema: (value: unknown) => (isRecord(value) ? value : { type: 'object', properties: {} }),
    })
    if (usesAdaptiveNativeThinking) {
      const config = isRecord(request.generationConfig) ? request.generationConfig : {}
      applyAgyNativeGenerationConfig(wireModel, config)
      request.generationConfig = config
    }
  } else {
    applyGeminiTransforms(request, {
      model: wireModel,
      ...(thinkingLevel === undefined || usesNumericGeminiThinkingBudget || usesAdaptiveNativeThinking ? {} : { tierThinkingLevel: thinkingLevel as 'low' | 'medium' | 'high' }),
      ...(resolved.thinkingBudget === undefined || usesAdaptiveNativeThinking ? {} : { tierThinkingBudget: resolved.thinkingBudget }),
      ...(usesAdaptiveNativeThinking || (reasoningEffort === undefined && resolved.thinkingBudget === undefined) ? {} : { normalizedThinking: { includeThoughts: true, ...(resolved.thinkingBudget === undefined ? {} : { thinkingBudget: resolved.thinkingBudget }) } }),
    })
    if (usesAdaptiveNativeThinking) {
      const config = isRecord(request.generationConfig) ? request.generationConfig : {}
      applyAgyNativeGenerationConfig(wireModel, config)
      request.generationConfig = config
    } else if (usesNumericGeminiThinkingBudget && typeof resolved.thinkingBudget === 'number') {
      const config = isRecord(request.generationConfig) ? request.generationConfig : {}
      config.thinkingConfig = { includeThoughts: true, thinkingBudget: resolved.thinkingBudget }
      request.generationConfig = config
    }
  }
}

function applyClaudeToolHardening(request: Record<string, unknown>): void {
  if (!Array.isArray(request.tools) || request.tools.length === 0) return
  request.tools = request.tools.map((tool) => {
    if (!isRecord(tool) || !Array.isArray(tool.functionDeclarations)) return tool
    return { ...tool, functionDeclarations: tool.functionDeclarations.map((declaration) => hardenClaudeToolDeclaration(declaration)) }
  })
  const instructionPart = { text: CLAUDE_TOOL_SYSTEM_INSTRUCTION }
  const existing = request.systemInstruction
  if (isRecord(existing) && Array.isArray(existing.parts)) {
    if (existing.parts.some((part) => isRecord(part) && typeof part.text === 'string' && part.text.includes('CRITICAL TOOL USAGE INSTRUCTIONS'))) return
    request.systemInstruction = { ...existing, parts: [...existing.parts, instructionPart] }
  } else if (typeof existing === 'string') {
    request.systemInstruction = { role: 'user', parts: [{ text: existing }, instructionPart] }
  } else {
    request.systemInstruction = { role: 'user', parts: [instructionPart] }
  }
}

function hardenClaudeToolDeclaration(value: unknown): unknown {
  if (!isRecord(value)) return value
  const description = typeof value.description === 'string' ? value.description : ''
  if (description.includes('STRICT PARAMETERS:')) return value
  const schema = isRecord(value.parameters) ? value.parameters : undefined
  const properties = schema !== undefined && isRecord(schema.properties) ? schema.properties : undefined
  if (properties === undefined || Object.keys(properties).length === 0) return value
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [])
  const parameters = Object.entries(properties).map(([name, property]) => `${name} (${claudeToolTypeHint(property)}${required.has(name) ? ', REQUIRED' : ''})`)
  return { ...value, description: description + CLAUDE_DESCRIPTION_PROMPT.replace('{params}', parameters.join(', ')) }
}

function claudeToolTypeHint(value: unknown): string {
  if (!isRecord(value)) return 'unknown'
  if (Array.isArray(value.enum)) {
    return value.enum.length <= 5
      ? `string ENUM[${value.enum.map((item) => JSON.stringify(item)).join(', ')}]`
      : `string ENUM[${value.enum.length} options]`
  }
  const type = typeof value.type === 'string' ? value.type : 'unknown'
  if (type === 'array') {
    if (!isRecord(value.items)) return 'ARRAY'
    const itemType = typeof value.items.type === 'string' ? value.items.type : 'unknown'
    if (itemType !== 'object') return `ARRAY_OF_${itemType.toUpperCase()}`
    if (!isRecord(value.items.properties)) return 'ARRAY_OF_OBJECTS'
    const nestedRequired = new Set(Array.isArray(value.items.required) ? value.items.required.filter((item): item is string => typeof item === 'string') : [])
    const nested = Object.entries(value.items.properties).map(([name, property]) => `${name}: ${isRecord(property) && typeof property.type === 'string' ? property.type : 'unknown'}${nestedRequired.has(name) ? ' REQUIRED' : ''}`)
    return `ARRAY_OF_OBJECTS[${nested.join(', ')}]`
  }
  if (type === 'object' && isRecord(value.properties)) {
    const nestedRequired = new Set(Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === 'string') : [])
    const nested = Object.entries(value.properties).map(([name, property]) => `${name}: ${isRecord(property) && typeof property.type === 'string' ? property.type : 'unknown'}${nestedRequired.has(name) ? ' REQUIRED' : ''}`)
    return `object{${nested.join(', ')}}`
  }
  return type
}

function groupClaudeFunctionResponses(contents: readonly Record<string, unknown>[], model: string): readonly Record<string, unknown>[] {
  if (proxyModelFamily(model) !== 'claude') return contents
  const grouped: Record<string, unknown>[] = []
  let pending: Record<string, unknown>[] = []
  const flush = (): void => {
    if (pending.length === 0) return
    grouped.push({ role: 'user', parts: pending })
    pending = []
  }
  for (const content of contents) {
    const rawParts = Array.isArray(content.parts) ? content.parts : []
    const responseParts = rawParts.filter((part) => isRecord(part) && isRecord(part.functionResponse)) as Record<string, unknown>[]
    const responseOnly = content.role === 'user' && rawParts.length > 0 && responseParts.length === rawParts.length
    if (responseOnly) {
      pending.push(...responseParts)
      continue
    }
    flush()
    grouped.push(content)
  }
  flush()
  return grouped
}

interface ToolCallBinding { readonly id: string; readonly name: string }
interface ToolCallState { last: ToolCallBinding; pending: ToolCallBinding[] }

function rememberToolName(toolNames: Map<string, ToolCallState>, callId: unknown, name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 256 || containsControl(name)) throw new LlmError('代理模式工具调用名无效', 'INVALID_ARGS')
  const id = requireToolCallId(callId)
  const state = toolNames.get(id)
  const assigned = state === undefined ? id : state.last.name === name ? state.last.id : `${id}#${name}`
  const binding = { id: assigned, name }
  toolNames.set(id, { last: binding, pending: [...(state?.pending ?? []), binding] })
  return assigned
}

function consumeToolBinding(toolNames: Map<string, ToolCallState>, callId: unknown): ToolCallBinding {
  const state = toolNames.get(requireToolCallId(callId))
  if (state === undefined) throw new LlmError('代理模式工具结果没有匹配的调用', 'INVALID_ARGS')
  const next = state.pending.shift()
  return next ?? state.last
}

function expirePendingToolCalls(toolNames: Map<string, ToolCallState>): void {
  for (const state of toolNames.values()) if (state.pending.length > 0) state.pending = []
}

function requireToolCallId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || containsControl(value)) throw new LlmError('代理模式工具调用 id 无效', 'INVALID_ARGS')
  return value
}

async function mapMessage(
  message: RequestMessage,
  model: string,
  toolNames: Map<string, ToolCallState>,
  attachments: ProxyAttachmentReader | undefined,
  signal: AbortSignal | undefined,
  sentImageBytes: Map<string, number>,
  wireModel: string,
): Promise<Record<string, unknown>> {
  if (message.role === 'assistant') expirePendingToolCalls(toolNames)
  const parts: Record<string, unknown>[] = []
  const kinds = contentKinds(message.content)
  const replay = message.role === 'assistant' ? compatibleProxyReplayState(message, model, kinds, wireModel) : undefined
  const replayBlocks = replay?.blocks ?? []
  const isClaude = proxyModelFamily(wireModel) === 'claude'
  let replayIndex = 0
  let emittedToolResponse = false
  if (message.role === 'tool' && typeof message.toolCallId === 'string' && message.toolCallId.length > 0) {
    const binding = toolNames.has(message.toolCallId) ? consumeToolBinding(toolNames, message.toolCallId) : undefined
    if (binding !== undefined) {
      emittedToolResponse = true
      parts.push({
        functionResponse: {
          ...(isClaude ? { id: binding.id } : {}),
          name: binding.name,
          response: toolResponsePayload(blocksToText(message.content), message.isError === true),
        },
      })
    }
  }
  let sawClaudeFunctionCall = false
  for (const block of message.content) {
    const replayKind: ReplayBlockKind | undefined = block.type === 'text' || block.type === 'reasoning' || block.type === 'tool-call' ? block.type : undefined
    const replayBlock = replayKind === undefined ? undefined : replayBlocks[replayIndex++]
    const replaySignature = replayBlock !== undefined && replayBlock.kind === replayKind ? replayBlock.signature : undefined
    const blockSignature = (block as unknown as { signature?: string; thoughtSignature?: string }).signature
      ?? (block as unknown as { signature?: string; thoughtSignature?: string }).thoughtSignature
      ?? replaySignature
    if (block.type === 'text') {
      if (emittedToolResponse) continue
      if (block.text.length === 0 && message.content.length > 1) continue
      parts.push({ text: block.text, ...(blockSignature === undefined ? {} : { thoughtSignature: blockSignature }) })
    } else if (block.type === 'reasoning') {
      if (isClaude && blockSignature === undefined) continue
      parts.push({ text: block.text, thought: true, ...(blockSignature === undefined ? {} : { thoughtSignature: blockSignature }) })
    } else if (block.type === 'tool-call') {
      const callId = rememberToolName(toolNames, block.id, block.name)
      const signature = isClaude && sawClaudeFunctionCall ? undefined : (blockSignature ?? SKIP_THOUGHT_SIGNATURE)
      sawClaudeFunctionCall ||= isClaude
      parts.push({
        functionCall: { ...(isClaude ? { id: callId } : {}), name: block.name, args: parseJsonObject(block.arguments) },
        ...(signature === undefined ? {} : { thoughtSignature: signature }),
      })
    } else if (block.type === 'image') {
      if (attachments === undefined) {
        throw new LlmError('代理模式图片输入需要宿主附件服务；当前宿主未提供，请移除图片或改用文本', 'UNSUPPORTED_MODALITY')
      }
      const ref = block.attachment as ImageAttachmentRef
      const read = await readProxyImage(attachments, ref, signal)
      sentImageBytes.set(ref.attachmentId, read.bytes)
      parts.push({ inlineData: { mimeType: read.mediaType, data: read.encoded } })
    }
    // file / tool-addition / tool-removal 块不进入本路由的线载荷。
  }
  return { role: message.role === 'assistant' ? 'model' : 'user', parts }
}

function contentKinds(content: readonly ContentBlock[]): ReplayBlockKind[] {
  return content.flatMap((block) => block.type === 'text' || block.type === 'reasoning' || block.type === 'tool-call' ? [block.type] : [])
}

function toolResponsePayload(content: unknown, isError: boolean): Record<string, unknown> {
  return isError ? { error: content } : { content }
}

function blocksToText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n').slice(0, 64 * 1024)
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (isRecord(parsed)) return parsed
  } catch {
    // 历史工具调用不能被静默改写：报错而不是发送损坏参数。
  }
  throw new LlmError('代理模式历史工具调用参数不是合法 JSON', 'PROTOCOL_DRIFT')
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new LlmError(`${label} 超出代理模式允许范围`, 'INVALID_ARGS')
  return Math.floor(value)
}

function boundedNumber(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new LlmError(`${label} 超出代理模式允许范围`, 'INVALID_ARGS')
  return value
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ------------------------------------------------------------- 响应解析

export interface ProxyProviderPart {
  kind: 'text' | 'reasoning' | 'tool-call'
  text?: string
  name?: string
  id?: string
  arguments?: string
  /** 对象参数代表一条完整调用；字符串参数仍可分片追加。 */
  argumentsComplete?: boolean
  signature?: string
  /** A trailing signature without a new content part belongs to the open block. */
  signatureOnly?: boolean
}

export interface ProxyProviderEvent {
  parts: readonly ProxyProviderPart[]
  usage?: TokenUsage
  finish?: string
  error?: { status?: number; code?: string; contextWindowExceeded?: boolean }
}

const MAX_PROVIDER_PARTS = 4096

/** 解析一条 SSE data（兼容 `)]}'` 前缀与多种响应包裹形态）。 */
export function parseProxyProviderEvent(data: string): ProxyProviderEvent {
  const normalized = data.trim().replace(/^\)\]\}'(?:\r?\n)?/u, '')
  let value: unknown
  try { value = JSON.parse(normalized) as unknown } catch {
    throw new LlmError('代理模式响应包含非法 JSON', 'PROTOCOL_DRIFT')
  }
  if (!isRecord(value)) throw new LlmError('代理模式响应事件不是对象', 'PROTOCOL_DRIFT')
  if (isRecord(value.error)) return { parts: [], error: errorDetails(value.error) }
  const root = isRecord(value.response) ? value.response : value
  if (isRecord(root.error)) return { parts: [], error: errorDetails(root.error) }
  const parts: ProxyProviderPart[] = []
  for (const part of findParts(root)) {
    const parsed = parsePart(part)
    if (parsed !== undefined) parts.push(parsed)
  }
  const usage = parseUsage(root.usageMetadata ?? value.usageMetadata)
  const finish = findFinish(root)
  return { parts, ...(usage === undefined ? {} : { usage }), ...(finish === undefined ? {} : { finish }) }
}

export function parseProxyUsage(value: unknown): TokenUsage | undefined {
  return parseUsage(value)
}

export function parseProxyReplayBlocks(event: ProxyProviderEvent): ProxyReplayBlock[] {
  return event.parts.map((part) => ({ kind: part.kind, ...(part.signature === undefined ? {} : { signature: part.signature }) }))
}

function findParts(value: Record<string, unknown>): unknown[] {
  if (Array.isArray(value.parts)) return boundedParts(value.parts)
  if (isRecord(value.content) && Array.isArray(value.content.parts)) return boundedParts(value.content.parts)
  if (isRecord(value.modelTurn) && Array.isArray(value.modelTurn.parts)) return boundedParts(value.modelTurn.parts)
  if (Array.isArray(value.candidates)) {
    const output: unknown[] = []
    for (const candidate of value.candidates) {
      if (!isRecord(candidate)) continue
      const content = isRecord(candidate.content) ? candidate.content : candidate
      if (Array.isArray(content.parts)) {
        if (output.length + content.parts.length > MAX_PROVIDER_PARTS) throw new LlmError('代理模式响应 part 过多', 'PROTOCOL_DRIFT')
        output.push(...content.parts)
      }
    }
    return output
  }
  if (isRecord(value.serverContent) && isRecord(value.serverContent.modelTurn) && Array.isArray(value.serverContent.modelTurn.parts)) {
    return boundedParts(value.serverContent.modelTurn.parts)
  }
  return []
}

function boundedParts(value: unknown[]): unknown[] {
  if (value.length > MAX_PROVIDER_PARTS) throw new LlmError('代理模式响应 part 过多', 'PROTOCOL_DRIFT')
  return value
}

function parsePart(value: unknown): ProxyProviderPart | undefined {
  if (!isRecord(value)) throw new LlmError('代理模式响应 part 格式错误', 'PROTOCOL_DRIFT')
  const functionCall = isRecord(value.functionCall) ? value.functionCall : isRecord(value.function_call) ? value.function_call : undefined
  if (functionCall !== undefined) {
    const name = stringValue(functionCall.name)
    const id = stringValue(functionCall.id)
    const signature = signatureOf(value) ?? signatureOf(functionCall)
    const args = typeof functionCall.args === 'string' ? functionCall.args : functionCall.args === undefined ? '' : JSON.stringify(functionCall.args)
    return {
      kind: 'tool-call',
      ...(name === undefined ? {} : { name }),
      ...(id === undefined ? {} : { id }),
      arguments: args,
      argumentsComplete: typeof functionCall.args !== 'string',
      ...(signature === undefined ? {} : { signature }),
    }
  }
  if (typeof value.text === 'string' || signatureOf(value) !== undefined) {
    const kind = value.thought === true || value.reasoning === true || value.thinking === true ? 'reasoning' as const : 'text' as const
    const signature = signatureOf(value)
    return {
      kind, text: typeof value.text === 'string' ? value.text : '',
      ...(signature === undefined ? {} : { signature }),
      ...(signature !== undefined && !value.text && value.thought === undefined && value.reasoning === undefined && value.thinking === undefined ? { signatureOnly: true } : {}),
    }
  }
  if (value.inlineData !== undefined || value.inline_data !== undefined) {
    throw new LlmError('代理模式收到了媒体输出（本路由只请求文本模型）', 'PROTOCOL_DRIFT')
  }
  throw new LlmError('代理模式响应包含未知 part 类型', 'PROTOCOL_DRIFT')
}

function errorDetails(value: Record<string, unknown>): NonNullable<ProxyProviderEvent['error']> {
  const status = numberValue(value.status) ?? numberValue(value.code)
  const code = stringValue(value.status) ?? stringValue(value.code)
  const contextWindowExceeded = reportsContextWindowExceeded(value)
  return {
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
    ...(contextWindowExceeded ? { contextWindowExceeded: true } : {}),
  }
}

export function reportsContextWindowExceeded(value: Record<string, unknown>, depth = 0): boolean {
  if (depth > 4) return false
  const message = stringValue(value.message) ?? ''
  const status = stringValue(value.status) ?? ''
  const combined = `${message} ${status}`.toLowerCase()
  if (combined.includes('context window') || combined.includes('token limit') || combined.includes('too many tokens') || combined.includes('prompt is too long')) return true
  for (const key of ['error', 'details', 'cause']) {
    const nested = value[key]
    if (isRecord(nested) && reportsContextWindowExceeded(nested, depth + 1)) return true
  }
  if (Array.isArray(value.details)) {
    for (const item of value.details) if (isRecord(item) && reportsContextWindowExceeded(item, depth + 1)) return true
  }
  return false
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = numberValue(value.promptTokenCount ?? value.inputTokenCount)
  const output = numberValue(value.candidatesTokenCount ?? value.outputTokenCount)
  const reasoning = numberValue(value.thoughtsTokenCount ?? value.reasoningTokenCount)
  const cached = numberValue(value.cachedContentTokenCount ?? value.cacheReadTokens)
  if (input === undefined && output === undefined && reasoning === undefined && cached === undefined) return undefined
  return {
    inputTokens: Math.max(0, (input ?? 0) - (cached ?? 0)),
    outputTokens: output ?? 0,
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

function findFinish(value: Record<string, unknown>): string | undefined {
  const candidate = value.finishReason ?? value.finish_reason
  if (typeof candidate === 'string') return candidate
  if (isRecord(value.serverContent) && typeof value.serverContent.finishReason === 'string') return value.serverContent.finishReason
  if (Array.isArray(value.candidates)) {
    for (const item of value.candidates) if (isRecord(item) && typeof item.finishReason === 'string') return item.finishReason
  }
  return undefined
}

function signatureOf(value: Record<string, unknown>): string | undefined {
  const signature = value.thoughtSignature ?? value.thought_signature ?? value.signature
  return typeof signature === 'string' && signature.length > 0 && signature.length <= PROXY_MAX_SIGNATURE_LENGTH && !containsControl(signature) ? signature : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}
