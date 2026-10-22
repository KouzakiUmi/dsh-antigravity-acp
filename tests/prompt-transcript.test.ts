/**
 * prompt 组装：历史重放说明 + 当前请求强调。
 *
 * 回归背景（2026-10-22，session-d7aa3ea4）：新用户回合仍然把整段 DSH 历史
 * （含上一轮大量工具轨迹）重放进同一条 ACP prompt，而用户消息之后还跟着
 * time-context / runtime-context / hindsight 等注入块。不声明边界时官方 agent
 * 会顺着历史里未完成的任务继续跑，表现为「用户后续的话没传过去」。
 */
import { describe, expect, it } from 'vitest'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  buildPromptContent,
  currentRequestBlock,
  HISTORY_OPEN,
  latestUserRequest,
  parsePromptTranscript,
  TOOL_POLICY_TEXT,
} from '../src/adapter/prompt-transcript.js'

function user(text: string): RequestMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** DSH 在用户消息之后追加的注入块：role 仍是 user，但 source.kind 不是 user。 */
function injected(text: string, kind: string): RequestMessage {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind } } as unknown as RequestMessage
}

function textOf(blocks: readonly ContentBlock[]): string[] {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
}

describe('当前请求强调', () => {
  it('取最新真实用户消息，而不是其后追加的时间/运行时注入块', () => {
    const messages = [
      user('把 Google 那个改成 AI Studio'),
      injected('准备第 8 轮、第 1 步时采样的时间：…', 'time-context'),
      injected('Current runtime context. This snapshot supersedes…', 'runtime-context'),
    ]
    expect(latestUserRequest(messages)?.content).toEqual([{ type: 'text', text: '把 Google 那个改成 AI Studio' }])

    const current = textOf(buildPromptContent(undefined, messages)).at(-1)
    expect(current?.startsWith('<dsh-current-request>')).toBe(true)
    expect(current).toContain('把 Google 那个改成 AI Studio')
    expect(current).not.toContain('准备第 8 轮')
    expect(current).not.toContain('Current runtime context')
  })

  it('当前请求块位于最后，历史说明块位于所有消息信封之前', () => {
    const blocks = buildPromptContent(undefined, [user('第一问'), injected('快照', 'time-context')])
    const texts = textOf(blocks)
    const historyIndex = texts.findIndex((text) => text.startsWith(HISTORY_OPEN))
    const currentIndex = texts.findIndex((text) => text.startsWith('<dsh-current-request>'))
    const firstEnvelope = texts.findIndex((text) => text.startsWith('<dsh-message role="'))
    expect(historyIndex).toBeGreaterThanOrEqual(0)
    expect(historyIndex).toBeLessThan(firstEnvelope)
    expect(currentIndex).toBe(texts.length - 1)
  })

  it('两个说明块都不参与消息逆解析，当前请求不会重复计入 entries', () => {
    const messages: RequestMessage[] = [
      user('第一问'),
      createToolResultMessage({ callId: ToolCallId('call-a'), content: [{ type: 'text', text: '结果' }], isError: false }),
      injected('第 2 轮时间快照', 'time-context'),
    ]
    const blocks = buildPromptContent('系统提示', messages)
    const parsed = parsePromptTranscript(blocks)
    expect(parsed.system).toBe('系统提示')
    expect(parsed.entries.map((entry) => entry.role)).toEqual(['user', 'tool', 'user'])
    expect(parsed.entries[0]?.content).toEqual([{ type: 'text', text: '第一问' }])
  })

  it('注入块不会被误判成历史说明或策略块', () => {
    const blocks = buildPromptContent(undefined, [user('问'), injected('时间快照', 'time-context')])
    const texts = textOf(blocks)
    expect(texts.some((text) => text.includes(TOOL_POLICY_TEXT))).toBe(true)
    expect(texts.filter((text) => text.startsWith(HISTORY_OPEN))).toHaveLength(1)
    expect(texts.filter((text) => text.startsWith('<dsh-current-request>'))).toHaveLength(1)
  })
})

describe('取不到用户请求的情形', () => {
  it('只有工具结果时没有当前请求块，也没有历史说明', () => {
    const messages: RequestMessage[] = [
      createToolResultMessage({ callId: ToolCallId('call-a'), content: [{ type: 'text', text: '结果' }], isError: false }),
    ]
    expect(currentRequestBlock(messages)).toBeUndefined()
    const texts = textOf(buildPromptContent(undefined, messages))
    expect(texts.some((text) => text.startsWith(HISTORY_OPEN))).toBe(true)
    expect(texts.some((text) => text.startsWith('<dsh-current-request>'))).toBe(false)
  })

  it('消息为空时不产生历史说明与当前请求块', () => {
    const texts = textOf(buildPromptContent(undefined, []))
    expect(texts.some((text) => text.startsWith(HISTORY_OPEN))).toBe(false)
    expect(texts.some((text) => text.startsWith('<dsh-current-request>'))).toBe(false)
  })

  it('一次性用户输入（无 source）按当前请求处理', () => {
    const oneShot = { role: 'user', content: [{ type: 'text', text: '一次性输入' }] } as unknown as RequestMessage
    expect(latestUserRequest([oneShot])).toBe(oneShot)
    expect(textOf(buildPromptContent(undefined, [oneShot])).at(-1)).toContain('一次性输入')
  })

  it('图片请求在强调块里注明附件位置，不重复发送字节', () => {
    const imageMessage = createUserMessage({
      content: [{ type: 'image', attachment: { attachmentId: 'sha256:x', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } as unknown as ImageAttachmentRef }],
      source: { kind: 'user' },
    })
    const current = currentRequestBlock([imageMessage])
    expect(current?.type).toBe('text')
    expect(current?.type === 'text' ? current.text : '').toContain('附带图片')
  })
})
