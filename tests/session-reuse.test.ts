import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import { incrementalMessages, outputHash, outputMatches, prefixHash, prefixMatches } from '../src/adapter/session-reuse.js'

function user(text: string): RequestMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
function context(text: string, form: string, kind = 'context'): RequestMessage {
  return { ...user(text), source: { kind, form } } as unknown as RequestMessage
}
function answer(text: string): RequestMessage {
  return createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'test' } })
}
const blocks: ContentBlock[] = [{ type: 'text', text: 'A1' }]

describe('会话历史与实际交付输出一致性', () => {
  it('已交付的回答可被跳过；编辑、缺失或额外回答不可跳过', () => {
    expect(outputMatches([answer('A1'), user('Q2')], outputHash(blocks))).toBe(true)
    expect(outputMatches([answer('EDITED'), user('Q2')], outputHash(blocks))).toBe(false)
    expect(outputMatches([user('Q2')], outputHash(blocks))).toBe(false)
    expect(outputMatches([answer('A1'), user('外部问题'), answer('外部回答'), user('Q3')], outputHash(blocks))).toBe(false)
    expect(outputMatches([answer('A1')], undefined)).toBe(false)
  })
  it('空回复只允许没有新增 assistant 的历史', () => {
    expect(outputMatches([user('重试')], outputHash([]))).toBe(true)
    expect(outputMatches([answer('未知输出'), user('重试')], outputHash([]))).toBe(false)
  })
  it('拒绝非法计数与改写前缀', () => {
    const history = [user('Q1')]
    expect(prefixMatches(history, 1, prefixHash(history))).toBe(true)
    for (const count of [-1, 0.5, Infinity, 2]) expect(prefixMatches(history, count, prefixHash(history))).toBe(false)
    expect(prefixMatches([user('改写')], 1, prefixHash(history))).toBe(false)
  })
})

describe('上下文按内容去重，而非按类别丢弃', () => {
  for (const form of ['snapshot', 'catalog', 'instructions', 'recall']) {
    it(`${form} 首次与变化内容发送，相同内容不重复发送`, () => {
      const initial = context('版本 A', form)
      const messages = [initial, answer('A1'), context('版本 A', form), context('版本 B', form), user('Q2')]
      expect(incrementalMessages(messages, 1)).toEqual([messages[3], messages[4]])
      expect(incrementalMessages([user('Q1'), initial, user('Q2')], 1)).toContainEqual(initial)
    })
  }
  it('快照回滚 A→B→A 必须再次发送 A', () => {
    const a = context('A', 'snapshot'), b = context('B', 'snapshot')
    const q = user('Q')
    expect(incrementalMessages([a, b, a, q], 2)).toEqual([a, q])
  })
  it('指令旧版本重新成为当前版本时不能被永久去重', () => {
    const a = context('规则 A', 'instructions'), b = context('规则 B', 'instructions')
    const q = user('Q')
    expect(incrementalMessages([a, b, a, q], 2)).toEqual([a, q])
  })
  it('不同 producer、notice、relay、未知类别与重复真实用户请求均保留', () => {
    const old = context('状态', 'snapshot', 'one')
    const fresh = [context('状态', 'snapshot', 'two'), context('通知', 'notice'), context('通知', 'notice'), context('消息', 'relay'), context('未知', 'future-form'), user('相同问题'), user('相同问题')]
    expect(incrementalMessages([old, ...fresh], 1)).toEqual(fresh)
  })
  it('保留新注入，把最新用户消息重排到末尾', () => {
    const request = user('当前问题'), notice = context('目标变化', 'notice')
    expect(incrementalMessages([user('Q1'), request, notice], 1)).toEqual([notice, request])
  })
})
