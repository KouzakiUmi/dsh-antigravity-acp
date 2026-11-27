/**
 * AI Studio 的 replay 元数据：块对齐的 thoughtSignature 保留。
 *
 * Gemini 思考模型在多轮工具调用里要求把上一轮 functionCall / thought 部分的
 * thoughtSignature 原样带回，否则上游校验失败。签名经 finish 块的 replayState
 * 存进历史消息的 `source.replayState`，下一轮构包时按块对齐取回。
 *
 * provider 标识为 `aistudio`，与代理线（`antigravity-proxy`）的信封互不误用。
 * 纯 Gemini 家族，无代理线的 Claude/GPT 家族分支。
 */
import type { Message, ReplayEnvelope } from '@deepseek-ai/dsh-llm'
import { AISTUDIO_PROVIDER_ID } from './endpoints.js'

export const AISTUDIO_REPLAY_VERSION = 1 as const
export const AISTUDIO_MAX_SIGNATURE_LENGTH = 16 * 1024
const MAX_BLOCKS = 128

export type AistudioReplayBlockKind = 'text' | 'reasoning' | 'tool-call'

export interface AistudioReplayBlock {
  readonly kind: AistudioReplayBlockKind
  readonly signature?: string
}

export interface AistudioReplayState extends ReplayEnvelope {
  readonly response: {
    readonly version: typeof AISTUDIO_REPLAY_VERSION
    readonly provider: typeof AISTUDIO_PROVIDER_ID
    readonly model: string
    readonly wireModel?: string
    readonly finish?: string
  }
  readonly blocks: readonly AistudioReplayBlock[]
}

export function createAistudioReplayState(
  model: string,
  finish: string | undefined,
  blocks: readonly AistudioReplayBlock[],
  wireModel?: string,
): AistudioReplayState {
  const boundedBlocks = blocks.slice(0, MAX_BLOCKS).map((block) => {
    const signature = safeSignature(block.signature)
    return { kind: block.kind, ...(signature === undefined ? {} : { signature }) }
  })
  const boundedFinish = safeFinish(finish)
  return {
    response: {
      version: AISTUDIO_REPLAY_VERSION,
      provider: AISTUDIO_PROVIDER_ID,
      model: model.slice(0, 256),
      ...(wireModel === undefined ? {} : { wireModel }),
      ...(boundedFinish === undefined ? {} : { finish: boundedFinish }),
    },
    blocks: boundedBlocks,
  }
}

/** 校验历史消息上的 replay 元数据；不兼容返回 undefined（按无签名重放）。 */
export function compatibleAistudioReplayState(
  message: Message,
  model: string,
  blockKinds?: readonly AistudioReplayBlockKind[],
  wireModel?: string,
): AistudioReplayState | undefined {
  if (message.role !== 'assistant') return undefined
  const provenance = isRecord(message.source) ? (message.source as Record<string, unknown>) : undefined
  if (provenance !== undefined && provenance.kind === 'model' && (provenance.provider !== AISTUDIO_PROVIDER_ID || provenance.model !== model)) return undefined
  const value = isRecord(provenance?.replayState)
    ? provenance.replayState
    : isRecord((message as unknown as Record<string, unknown>).replayState)
      ? (message as unknown as Record<string, unknown>).replayState
      : undefined
  if (!isRecord(value) || !isRecord(value.response) || !Array.isArray(value.blocks)) return undefined
  if (value.response.version !== AISTUDIO_REPLAY_VERSION
    || value.response.provider !== AISTUDIO_PROVIDER_ID
    || value.response.model !== model
    || (wireModel !== undefined && value.response.wireModel !== undefined && value.response.wireModel !== wireModel)
    || value.blocks.length > MAX_BLOCKS) return undefined
  const blocks: AistudioReplayBlock[] = []
  for (const item of value.blocks) {
    if (!isRecord(item) || typeof item.kind !== 'string') continue
    const kind = item.kind as AistudioReplayBlockKind
    if (kind !== 'text' && kind !== 'reasoning' && kind !== 'tool-call') continue
    const signature = typeof item.signature === 'string' && item.signature.length > 0 && item.signature.length <= AISTUDIO_MAX_SIGNATURE_LENGTH && !hasControl(item.signature)
      ? item.signature
      : undefined
    blocks.push({ kind, ...(signature === undefined ? {} : { signature }) })
  }
  if (blockKinds !== undefined && (blocks.length !== blockKinds.length || blocks.some((block, index) => block.kind !== blockKinds[index]))) return undefined
  const finish = safeFinish(typeof value.response.finish === 'string' ? value.response.finish : undefined)
  const responseWireModel = typeof value.response.wireModel === 'string' && value.response.wireModel.length > 0 && value.response.wireModel.length <= 256 && !hasControl(value.response.wireModel)
    ? value.response.wireModel
    : undefined
  return {
    response: {
      version: AISTUDIO_REPLAY_VERSION,
      provider: AISTUDIO_PROVIDER_ID,
      model,
      ...(responseWireModel === undefined ? {} : { wireModel: responseWireModel }),
      ...(finish === undefined ? {} : { finish }),
    },
    blocks,
  }
}

function safeSignature(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > AISTUDIO_MAX_SIGNATURE_LENGTH || hasControl(value)) return undefined
  return value
}

function safeFinish(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > 64 || hasControl(value)) return undefined
  return value
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
