import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AdapterRequestOptions } from '../src/adapter/request-options.js'
import { buildAistudioPayload } from '../src/aistudio/payload.js'
import { createAistudioReplayState } from '../src/aistudio/replay.js'
import { AISTUDIO_PROVIDER_ID } from '../src/aistudio/endpoints.js'

const model = 'aistudio-gemini-2.5-flash'
const wire = 'gemini-2.5-flash'
const source = { provider: AISTUDIO_PROVIDER_ID, model }
function options(messages: AdapterRequestOptions['messages'], extra: Partial<AdapterRequestOptions> = {}): AdapterRequestOptions {
  return { provider: AISTUDIO_PROVIDER_ID, model, messages, ...extra }
}
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

describe('AI Studio 请求构造', () => {
  it('用户文本 → user contents，system → systemInstruction', () => {
    const payload = buildAistudioPayload(options([user('hi')], { system: 'be brief' }), wire)
    expect(payload.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
    expect(payload.systemInstruction).toEqual({ parts: [{ text: 'be brief' }] })
  })

  it('assistant 文本/思考/工具调用 → model parts，思考带 thought:true', () => {
    const assistant = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'answer' },
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'weather', arguments: '{"city":"Paris"}' },
      ],
      source,
    })
    const payload = buildAistudioPayload(options([assistant]), wire)
    expect(payload.contents).toEqual([{
      role: 'model',
      parts: [
        { text: 'thinking', thought: true },
        { text: 'answer' },
        { functionCall: { name: 'weather', args: { city: 'Paris' } } },
      ],
    }])
  })

  it('工具结果按 callId 绑定函数名 → user functionResponse', () => {
    const assistant = createAssistantMessage({ content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'weather', arguments: '{}' }], source })
    const result = createToolResultMessage({ callId: ToolCallId('call-1'), content: [{ type: 'text', text: 'sunny' }], isError: false })
    const payload = buildAistudioPayload(options([assistant, result]), wire)
    expect(payload.contents).toEqual([
      { role: 'model', parts: [{ functionCall: { name: 'weather', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'weather', response: { content: 'sunny' } } }] },
    ])
  })

  it('错误工具结果 → response.error', () => {
    const assistant = createAssistantMessage({ content: [{ type: 'tool-call', id: ToolCallId('c'), name: 'read', arguments: '{}' }], source })
    const result = createToolResultMessage({ callId: ToolCallId('c'), content: [{ type: 'text', text: 'denied' }], isError: true })
    const payload = buildAistudioPayload(options([assistant, result]), wire)
    const parts = (payload.contents as { parts: unknown[] }[])[1]!.parts
    expect(parts).toEqual([{ functionResponse: { name: 'read', response: { error: 'denied' } } }])
  })

  it('孤立工具结果（无匹配调用）报 PROTOCOL_DRIFT，不静默改写', () => {
    const orphan = createToolResultMessage({ callId: ToolCallId('ghost'), content: [{ type: 'text', text: 'x' }], isError: false })
    expect(() => buildAistudioPayload(options([orphan]), wire)).toThrowError(/PROTOCOL_DRIFT|找不到匹配/u)
  })

  it('replay 信封里的 thoughtSignature 按块对齐回填到 functionCall', () => {
    const replayState = createAistudioReplayState(model, 'STOP', [{ kind: 'tool-call', signature: 'sig-abc' }], wire)
    const assistant = createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'weather', arguments: '{}' }],
      source: { ...source, replayState },
    })
    const payload = buildAistudioPayload(options([assistant]), wire)
    expect(payload.contents).toEqual([{ role: 'model', parts: [{ functionCall: { name: 'weather', args: {} }, thoughtSignature: 'sig-abc' }] }])
  })

  it('块自身携带的签名优先于 replay', () => {
    const replayState = createAistudioReplayState(model, 'STOP', [{ kind: 'reasoning', signature: 'replay-sig' }], wire)
    const assistant = createAssistantMessage({
      content: [{ type: 'reasoning', text: 't', signature: 'block-sig' } as never],
      source: { ...source, replayState },
    })
    const payload = buildAistudioPayload(options([assistant]), wire)
    expect((payload.contents as { parts: { thoughtSignature?: string }[] }[])[0]!.parts[0]!.thoughtSignature).toBe('block-sig')
  })

  it('generationConfig 映射 maxTokens/temperature/stop', () => {
    const payload = buildAistudioPayload(options([user('x')], { maxTokens: 2048, temperature: 0.7, stop: ['END'] }), wire)
    expect(payload.generationConfig).toEqual({ maxOutputTokens: 2048, temperature: 0.7, stopSequences: ['END'] })
  })

  it('temperature 超 Gemini 范围报 INVALID_ARGS', () => {
    expect(() => buildAistudioPayload(options([], { temperature: 5 }), wire)).toThrowError(/INVALID_ARGS|超出/u)
  })

  it('工具声明净化为 Gemini functionDeclarations', () => {
    const payload = buildAistudioPayload(options([], {
      tools: [{ name: 'weather', description: 'look up weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    }), wire)
    expect(payload.tools).toEqual([{ functionDeclarations: [{ name: 'weather', description: 'look up weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }] }])
  })

  it('图片块报 UNSUPPORTED_MODALITY（首期文本模态）', () => {
    const withImage = createUserMessage({ content: [{ type: 'image', attachment: { id: 'img' } } as never], source: { kind: 'user' } })
    expect(() => buildAistudioPayload(options([withImage]), wire)).toThrowError(/UNSUPPORTED_MODALITY|文本输入/u)
  })
})
