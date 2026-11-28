import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import type { AdapterRequestOptions } from './request-options.js'
import { llmError } from '../runtime/llm-error.js'
import { containsControl } from '../proxy/gemini-stream.js'
import { buildProxyFunctionDeclarations } from '../proxy/replay.js'

export type GeminiReplayBlockKind = 'text' | 'reasoning' | 'tool-call'
export interface GeminiReplayBlock { readonly kind: GeminiReplayBlockKind; readonly signature?: string; readonly wireCallId?: string }
export const GEMINI_MAX_SIGNATURE_LENGTH = 16 * 1024

interface GeminiPayloadOptions {
  label: string
  /** The provider must establish provenance before giving the serializer any signatures. */
  replayBlocks?: (message: RequestMessage, kinds: readonly GeminiReplayBlockKind[]) => readonly GeminiReplayBlock[] | undefined
}

interface ToolBinding { name: string; wireCallId?: string }
interface GeminiContent { role: 'user' | 'model'; parts: Record<string, unknown>[] }

export function buildGeminiPayload(options: AdapterRequestOptions, config: GeminiPayloadOptions): Record<string, unknown> {
  const toolNames = new Map<string, ToolBinding>()
  const contents: GeminiContent[] = []
  let pendingToolReturns: GeminiContent | undefined
  for (const message of options.messages) {
    if (message.role === 'system' || message.role === 'developer') continue
    const content = mapMessage(message, toolNames, config)
    if (message.role === 'tool') {
      if (pendingToolReturns !== undefined) { pendingToolReturns.parts.push(...content.parts); continue }
      pendingToolReturns = content
    } else pendingToolReturns = undefined
    contents.push(content)
  }
  const request: Record<string, unknown> = { contents }
  const systemParts = [
    ...(typeof options.system === 'string' && options.system.trim() ? [{ text: options.system }] : []),
    ...options.messages.flatMap(message => message.role === 'system' || message.role === 'developer'
      ? message.content.flatMap(block => block.type === 'text' && block.text.trim() ? [{ text: block.text }] : []) : []),
  ]
  if (systemParts.length > 0) request.systemInstruction = { parts: systemParts }
  const generationConfig: Record<string, unknown> = {}
  if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = Math.floor(bounded(options.maxTokens, 1, 1_000_000, 'maxTokens', config.label))
  if (options.temperature !== undefined) generationConfig.temperature = bounded(options.temperature, 0, 2, 'temperature', config.label)
  if (options.stop !== undefined && options.stop.length > 0) generationConfig.stopSequences = options.stop.slice(0, 16).map(item => String(item).slice(0, 256))
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig
  if (options.tools !== undefined && options.tools.length > 0) {
    const declarations = buildProxyFunctionDeclarations(options.tools)
    if (declarations.length > 0) request.tools = [{ functionDeclarations: declarations }]
  }
  return request
}

function mapMessage(message: RequestMessage, toolNames: Map<string, ToolBinding>, config: GeminiPayloadOptions): GeminiContent {
  if (message.role === 'tool' && typeof message.toolCallId === 'string' && message.toolCallId.length > 0) {
    const binding = toolNames.get(message.toolCallId)
    if (binding === undefined) throw llmError(`${config.label} 历史工具结果找不到匹配的调用，请重建会话`, 'PROTOCOL_DRIFT')
    toolNames.delete(message.toolCallId)
    const content = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').slice(0, 64 * 1024)
    return { role: 'user', parts: [{ functionResponse: { ...wireFunction(binding), response: message.isError === true ? { error: content } : { content } } }] }
  }
  const kinds = message.content.flatMap(block => isReplayKind(block.type) ? [block.type] : [])
  const replay = message.role === 'assistant' ? config.replayBlocks?.(message, kinds) : undefined
  const parts: Record<string, unknown>[] = []
  let replayIndex = 0
  for (const block of message.content) {
    const record = isReplayKind(block.type) ? replay?.[replayIndex++] : undefined
    const signature = record?.kind === block.type ? safeGeminiSignature(record.signature) : undefined
    const signed = signature === undefined ? {} : { thoughtSignature: signature }
    if (block.type === 'text') {
      if (block.text.length === 0 && message.content.length > 1 && signature === undefined) continue
      parts.push({ text: block.text, ...signed })
    } else if (block.type === 'reasoning') {
      parts.push({ text: block.text, thought: true, ...signed })
    } else if (block.type === 'tool-call') {
      const wireCallId = record?.kind === block.type ? safeGeminiWireCallId(record.wireCallId) : undefined
      const binding = { name: block.name, ...(wireCallId === undefined ? {} : { wireCallId }) }
      toolNames.set(String(block.id), binding)
      parts.push({ functionCall: { ...wireFunction(binding), args: parseJsonObject(block.arguments, config.label) }, ...signed })
    } else if (block.type === 'image') {
      throw llmError(`${config.label} 首期仅支持文本输入；请移除图片或改用支持图片的模型`, 'UNSUPPORTED_MODALITY')
    }
  }
  return { role: message.role === 'assistant' ? 'model' : 'user', parts }
}

function isReplayKind(kind: string): kind is GeminiReplayBlockKind {
  return kind === 'text' || kind === 'reasoning' || kind === 'tool-call'
}

export function safeGeminiSignature(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= GEMINI_MAX_SIGNATURE_LENGTH && !containsControl(value) ? value : undefined
}

export function safeGeminiWireCallId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !containsControl(value) ? value : undefined
}

function wireFunction(binding: ToolBinding): { name: string; id?: string } {
  return { name: binding.name, ...(binding.wireCallId === undefined ? {} : { id: binding.wireCallId }) }
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // 不回填损坏的工具参数。
  }
  throw llmError(`${label} 历史工具调用参数不是合法 JSON`, 'PROTOCOL_DRIFT')
}

function bounded(value: number, min: number, max: number, field: string, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw llmError(`${field} 超出 ${label} 允许范围`, 'INVALID_ARGS')
  return value
}
