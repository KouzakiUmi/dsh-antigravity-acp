import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { ContinuationState } from '../src/adapter/continuation-state.js'

const call: ToolCallBlock = { type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{"path":"a"}' }
function initial(): GenerateOptions {
  return {
    provider: 'antigravity-acp', model: 'gemini', system: 'obey policy',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'read a' }], source: { kind: 'user' } })],
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  }
}
function continuation(base: GenerateOptions): GenerateOptions {
  return { ...base, messages: [
    ...base.messages,
    createAssistantMessage({ content: [call], source: { provider: base.provider, model: base.model } }),
    createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'result' }], isError: false }),
  ] }
}

describe('continuation request integrity', () => {
  it('accepts unchanged context plus exactly the emitted blocks and tool results', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    expect(state.accepts(continuation(base), 1)).toBe(true)
  })
  it.each(['model', 'reasoning', 'system', 'history', 'inserted-system', 'schema', 'assistant'] as const)('rejects changed %s', (kind) => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    const next = continuation(base)
    if (kind === 'model') next.model = 'other'
    if (kind === 'reasoning') next.reasoningEffort = ReasoningEffortId('high')
    if (kind === 'system') next.system = 'new policy'
    if (kind === 'history') next.messages[0] = createUserMessage({ content: [{ type: 'text', text: 'changed' }], source: { kind: 'user' } })
    if (kind === 'inserted-system') next.messages.splice(1, 0, createSystemMessage('new policy'))
    if (kind === 'schema') next.tools = [{ ...next.tools![0]!, parameters: { type: 'object' } }]
    if (kind === 'assistant') next.messages[1] = createAssistantMessage({ content: [{ ...call, arguments: '{"path":"other"}' }], source: { provider: base.provider, model: base.model } })
    expect(state.accepts(next, 1)).toBe(false)
  })
  it('rejects edits to previously delivered tool results during later batches', () => {
    const base = continuation(initial())
    const state = new ContinuationState(base)
    state.emitted(call)
    const next = continuation(base)
    next.messages[2] = createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'rewritten' }], isError: false })
    expect(state.accepts(next, 1)).toBe(false)
  })
  it('accepts mid-turn passive context injections (e.g. time-context) without breaking continuation', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    const injected = { role: 'user', content: [{ type: 'text', text: 'Current time: 10:11' }], source: { kind: 'time-context', form: 'snapshot', sections: [] } } as unknown as GenerateOptions['messages'][number]
    const next: GenerateOptions = {
      ...base,
      messages: [
        ...base.messages,
        createAssistantMessage({ content: [call], source: { provider: base.provider, model: base.model } }),
        injected,
        createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'result' }], isError: false }),
      ],
    }
    expect(state.accepts(next, 1)).toBe(true)
  })
  it('rejects mid-turn real user messages or relay messages', () => {
    const base = initial()
    const state = new ContinuationState(base)
    state.emitted(call)
    const relay = { role: 'user', content: [{ type: 'text', text: 'from peer' }], source: { kind: 'relay', form: 'relay' } } as unknown as GenerateOptions['messages'][number]
    for (const extra of [
      createUserMessage({ content: [{ type: 'text', text: 'new prompt' }], source: { kind: 'user' } }),
      relay,
    ]) {
      const next: GenerateOptions = {
        ...base,
        messages: [
          ...base.messages,
          createAssistantMessage({ content: [call], source: { provider: base.provider, model: base.model } }),
          extra,
          createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'result' }], isError: false }),
        ],
      }
      expect(state.accepts(next, 1)).toBe(false)
    }
  })
})
