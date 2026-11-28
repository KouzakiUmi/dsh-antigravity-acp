import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import type { AdapterRequestOptions } from './request-options.js'
import type { ModelCapacity, ModelSetting } from './model-settings.js'
import { llmError } from '../runtime/llm-error.js'
import { geminiControlSpec } from './gemini-control-policy.js'
import type { GeminiLevel as Level } from './gemini-control-policy.js'

const labels: Record<Level, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High' }

export interface GeminiModelCompat {
  readonly protocol: 'google-generate-content'
  readonly wireModel: string
  readonly inputModalities: readonly ['text']
  readonly tools: true
  readonly temperature: boolean
  readonly stopSequences: true
  readonly maxStopSequences: 5
  readonly reasoningEfforts: readonly Level[]
  readonly upstreamReasoningEffort?: Level
  readonly protocolMaxOutputTokens?: number
  readonly upstreamContextWindow?: number
}

export interface GeminiControls {
  readonly setting: ModelSetting
  readonly compat: GeminiModelCompat
  readonly defaultMaxTokens?: number
  readonly contextWindow?: number
  readonly reasoning?: LlmModelReasoningInfo
}

export function resolveGeminiControls(wireModel: string, setting: ModelSetting, capacity: ModelCapacity = {}, surface?: 'developer' | 'vertex-v1') {
  const spec = geminiControlSpec(wireModel, surface)
  const upstreamContextWindow = capacity.contextWindow ?? spec.contextWindow
  const protocolMaxOutputTokens = capacity.maxOutputTokens === undefined ? spec.maxOutputTokens
    : Math.min(capacity.maxOutputTokens, spec.maxOutputTokens ?? capacity.maxOutputTokens)
  const contextWindow = setting.contextWindow === undefined ? upstreamContextWindow
    : Math.min(setting.contextWindow, upstreamContextWindow ?? setting.contextWindow)
  const max = Math.min(protocolMaxOutputTokens ?? 1_000_000, contextWindow === undefined ? 1_000_000 : Math.max(1, contextWindow - 1))
  const defaultMaxTokens = setting.maxTokens === undefined && protocolMaxOutputTokens === undefined && setting.contextWindow === undefined ? undefined
    : Math.min(setting.maxTokens ?? max, max)
  const compat: GeminiModelCompat = {
    protocol: 'google-generate-content', wireModel, inputModalities: ['text'], tools: true, temperature: spec.temperature,
    stopSequences: true, maxStopSequences: 5, reasoningEfforts: spec.efforts,
    ...(spec.defaultEffort === undefined ? {} : { upstreamReasoningEffort: spec.defaultEffort }),
    ...(protocolMaxOutputTokens === undefined ? {} : { protocolMaxOutputTokens }),
    ...(upstreamContextWindow === undefined ? {} : { upstreamContextWindow }),
  }
  const configuredEffort = spec.efforts.find(effort => effort === setting.reasoningEffort)
  const defaultEffort = configuredEffort ?? spec.defaultEffort
  const reasoning: LlmModelReasoningInfo | undefined = spec.efforts.length === 0 ? undefined : {
    efforts: spec.efforts.map(effort => ({ id: ReasoningEffortId(effort), name: labels[effort] })),
    ...(defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) }),
  }
  const controls: GeminiControls = { setting, compat, ...(contextWindow === undefined ? {} : { contextWindow }), ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }), ...(reasoning === undefined ? {} : { reasoning }) }
  return { contextWindow, defaultMaxTokens, compat, reasoning, controls }
}

export function geminiGenerationConfig(options: AdapterRequestOptions, controls: GeminiControls, label: string): Record<string, unknown> {
  const { setting, compat, defaultMaxTokens, reasoning } = controls
  const config: Record<string, unknown> = {}
  const maxTokens = options.maxTokens ?? defaultMaxTokens
  if (maxTokens !== undefined) {
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > (compat.protocolMaxOutputTokens ?? 1_000_000)
      || (controls.contextWindow !== undefined && maxTokens >= controls.contextWindow)) {
      throw llmError(`maxTokens 超出 ${label} 允许范围`, 'INVALID_ARGS')
    }
    config.maxOutputTokens = maxTokens
  }
  const temperature = options.temperature ?? setting.temperature
  if (temperature !== undefined && compat.temperature) {
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw llmError(`temperature 超出 ${label} 允许范围`, 'INVALID_ARGS')
    config.temperature = temperature
  }
  const stop = options.stop ?? setting.stop
  if (stop?.length) {
    if (stop.length > compat.maxStopSequences || stop.some(item => typeof item !== 'string' || !item.trim() || item.length > 256)) {
      throw llmError(`stop 超出 ${label} 允许范围`, 'INVALID_ARGS')
    }
    config.stopSequences = stop
  }
  const effort = options.reasoningEffort ?? reasoning?.defaultEffort
  if (effort !== undefined) {
    if (!compat.reasoningEfforts.some(level => level === effort)) throw llmError(`${label} 不支持所选思考档位`, 'UNSUPPORTED_REASONING_EFFORT')
    config.thinkingConfig = { thinkingLevel: String(effort).toUpperCase(), includeThoughts: true }
  }
  return config
}
