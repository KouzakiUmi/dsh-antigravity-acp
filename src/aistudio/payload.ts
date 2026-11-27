import { buildGeminiPayload, safeGeminiSignature } from '../adapter/gemini-payload.js'
import type { AdapterRequestOptions } from '../adapter/request-options.js'
import { compatibleAistudioReplayState } from './replay.js'

/** Gemini REST 生成体；签名只从兼容的 AI Studio 历史回放恢复。 */
export function buildAistudioPayload(options: AdapterRequestOptions, wireModel: string): Record<string, unknown> {
  return buildGeminiPayload(options, {
    label: 'AI Studio',
    replayBlocks(message, kinds) {
      if (message.role !== 'assistant') return undefined
      const replay = compatibleAistudioReplayState(message, options.model, kinds, wireModel)
      if (replay === undefined) return undefined
      let index = 0
      return message.content.flatMap(block => {
        if (block.type !== 'text' && block.type !== 'reasoning' && block.type !== 'tool-call') return []
        const entry = replay.blocks[index++]!
        const inline = block as typeof block & { signature?: unknown; thoughtSignature?: unknown }
        const signature = safeGeminiSignature(inline.signature) ?? safeGeminiSignature(inline.thoughtSignature)
        return [signature === undefined ? entry : { ...entry, signature }]
      })
    },
  })
}
