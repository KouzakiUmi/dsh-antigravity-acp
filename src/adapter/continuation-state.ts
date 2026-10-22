import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'

/** Only model-visible values participate; durable message IDs are not prompt content. */
function messageValue(message: RequestMessage): unknown {
  return message.role === 'tool'
    ? { role: message.role, content: message.content, toolCallId: message.toolCallId, isError: message.isError === true }
    : { role: message.role, content: message.content }
}

function stable(value: unknown): string {
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
    if (appended.some((message) => message.role !== 'assistant')) return false
    return stable(appended.flatMap((message) => [...message.content])) === stable(this.#emitted)
  }
}
