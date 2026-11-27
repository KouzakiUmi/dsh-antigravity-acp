import type { ReplayEnvelope, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { GeminiReplayBlock, GeminiReplayBlockKind } from '../adapter/gemini-payload.js'
import { safeGeminiSignature, safeGeminiWireCallId } from '../adapter/gemini-payload.js'
import { VERTEX_PROVIDER_ID } from './endpoints.js'
import type { VertexTarget } from './endpoints.js'

const VERSION = 1
const MAX_BLOCKS = 128

export function vertexReplayState(target: VertexTarget, blocks: readonly GeminiReplayBlock[]): ReplayEnvelope {
  return {
    response: { ...target, version: VERSION, provider: VERTEX_PROVIDER_ID },
    blocks: blocks.slice(0, MAX_BLOCKS).map(block => signedBlock(block.kind, block.signature, block.wireCallId)),
  }
}

export function vertexReplayBlocks(message: RequestMessage, kinds: readonly GeminiReplayBlockKind[], target: VertexTarget): readonly GeminiReplayBlock[] | undefined {
  if (message.role !== 'assistant') return undefined
  const source = record(message.source)
  // Both host model provenance and the Vertex envelope must agree.
  if (source?.kind !== 'model' || source.provider !== VERTEX_PROVIDER_ID || source.model !== target.model) return undefined
  const replay = record(source.replayState)
  const response = record(replay?.response)
  if (response?.version !== VERSION || response.provider !== VERTEX_PROVIDER_ID || response.model !== target.model
      || response.wireModel !== target.wireModel || response.project !== target.project || response.location !== target.location) return undefined
  if (!Array.isArray(replay?.blocks) || replay.blocks.length !== kinds.length || kinds.length > MAX_BLOCKS) return undefined
  const blocks: GeminiReplayBlock[] = []
  for (const [index, kind] of kinds.entries()) {
    const block = record(replay.blocks[index])
    if (block?.kind !== kind) return undefined
    blocks.push(signedBlock(kind, block.signature, block.wireCallId))
  }
  return blocks
}

function signedBlock(kind: GeminiReplayBlockKind, raw: unknown, rawCallId: unknown): GeminiReplayBlock {
  const signature = safeGeminiSignature(raw)
  const wireCallId = kind === 'tool-call' ? safeGeminiWireCallId(rawCallId) : undefined
  return { kind, ...(signature === undefined ? {} : { signature }), ...(wireCallId === undefined ? {} : { wireCallId }) }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
