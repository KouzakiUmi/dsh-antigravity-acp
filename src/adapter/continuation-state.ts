import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'

/** Only model-visible values participate; durable message IDs are not prompt content. */
export function messageValue(message: RequestMessage): unknown {
  return message.role === 'tool'
    ? { role: message.role, content: message.content, toolCallId: message.toolCallId, isError: message.isError === true }
    : { role: message.role, content: message.content }
}

/** Deterministic JSON: object keys sorted, so fingerprints survive property order. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
  })
}

function configuration(options: GenerateOptions): string {
  return stable({
    provider: options.provider, model: options.model, effort: options.reasoningEffort?.toString(),
    system: options.system ?? '',
    tools: [...(options.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  })
}

/** Passive context injections (e.g. time-context) may arrive mid-turn without invalidating tool continuation. */
function isMidTurnContextInjection(message: RequestMessage): boolean {
  if (message.role !== 'user') return false
  const source = (message as { readonly source?: { readonly kind?: unknown; readonly form?: unknown } }).source
  const kind = source && typeof source.kind === 'string' ? source.kind : undefined
  if (!kind || kind === 'user' || kind === 'compact-checkpoint' || kind === 'model-selection') return false
  const form = source && typeof source.form === 'string' ? source.form : undefined
  return form !== 'relay'
}

/** A continuation must be the exact request plus the assistant blocks we emitted and new tool results. */
export class ContinuationState {
  readonly #configuration: string
  readonly #history: string[]
  readonly #emitted: ContentBlock[] = []

  constructor(options: GenerateOptions) {
    this.#configuration = configuration(options)
    this.#history = options.messages.map((message) => stable(messageValue(message)))
  }

  emitted(block: ContentBlock): void { this.#emitted.push(structuredClone(block)) }

  accepts(options: GenerateOptions, resultCount: number): boolean {
    if (configuration(options) !== this.#configuration) return false
    const prefix = options.messages.slice(0, -resultCount)
    if (prefix.length < this.#history.length) return false
    if (!this.#history.every((value, index) => value === stable(messageValue(prefix[index]!)))) return false
    const appended = prefix.slice(this.#history.length)
    const assistantBlocks: ContentBlock[] = []
    for (const message of appended) {
      if (message.role === 'assistant') {
        assistantBlocks.push(...message.content)
        continue
      }
      if (isMidTurnContextInjection(message)) continue
      return false
    }
    return stable(assistantBlocks) === stable(this.#emitted)
  }
}
