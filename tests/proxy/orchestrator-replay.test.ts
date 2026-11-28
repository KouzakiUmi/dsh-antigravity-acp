import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Llm, { BlockAssembler, createAssistantMessage, createToolResultMessage, createUserMessage, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ORCHESTRATOR_MODEL_ID } from '../../src/orchestrator/types.js'
import { AntigravityProxyAdapter, PROXY_PROVIDER_ID } from '../../src/proxy/adapter.js'
import { buildProxyGeneratePayload, createProxySessionStore } from '../../src/proxy/payload.js'
import { createProxyReplayState } from '../../src/proxy/replay.js'

const PLANNER_WIRE = 'claude-opus-5-5-medium'
const EXECUTOR_MODEL = 'antigravity-gemini-4-hydrogen'
const EXECUTOR_WIRE = 'gemini-4-hydrogen-medium'
const OTHER_WIRE = 'gemini-4-hydrogen-high'
const TOOL_SIGNATURE = 'synthetic-tool-signature'
const SENTINEL = 'skip_thought_signature_validator'
const source = { provider: PROXY_PROVIDER_ID, model: ORCHESTRATOR_MODEL_ID }
const user = createUserMessage({ content: [{ type: 'text', text: 'synthetic task' }], source: { kind: 'user' } })
const toolCall = { type: 'tool-call' as const, id: ToolCallId('c1'), name: 'lookup', arguments: '{"key":"a"}' }
const result = createToolResultMessage({ callId: toolCall.id, content: [{ type: 'text', text: 'value' }], isError: false })
const callPart = (thoughtSignature: string) => ({ functionCall: { name: 'lookup', args: { key: 'a' } }, thoughtSignature })
const responsePart = { functionResponse: { name: 'lookup', response: { content: 'value' } } }

function sse(parts: readonly object[]): Response {
  return new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts }, finishReason: 'STOP' }] } })}\n\n`)
}

async function assemble(stream: AsyncIterable<StreamChunk>): Promise<BlockAssembler> {
  const assembler = new BlockAssembler()
  for await (const chunk of stream) assembler.push(chunk)
  return assembler
}

function fixture(showPlan: boolean, executorPrefixBlocks = 0, soleExecutor?: string) {
  const orchestrator = { showPlan, enabled: true, executorEffort: 'medium' as 'medium' | 'high' }
  const requests: Array<{ model: string; request: { contents: Array<{ role: string; parts: object[] }> } }> = []
  let generatedCall = false
  const adapter = new AntigravityProxyAdapter({
    readSettings: () => ({ orchestrator }),
    credential: { credential: async () => ({ accessToken: 'synthetic', source: 'login', updatedAt: 'x' }) },
    transport: {
      request: async ({ url, body }) => {
        if (url.includes('fetchAvailableModels')) {
          return Response.json({ models: {
            [PLANNER_WIRE]: { maxTokens: 1_000_000 },
            ...(soleExecutor ? { [soleExecutor]: { maxTokens: 32000 } } : {
              [EXECUTOR_WIRE]: { maxTokens: 524_288 }, [OTHER_WIRE]: { maxTokens: 524_288 },
            }),
          } })
        }
        const request = JSON.parse(String(body)) as typeof requests[number]
        requests.push(request)
        if (request.model === PLANNER_WIRE) return sse([{ text: '<plan>{"goal":"synthetic task","steps":[{"id":"a","title":"lookup"}]}</plan>' }])
        if (!generatedCall) {
          generatedCall = true
          return sse([
            ...Array.from({ length: executorPrefixBlocks }, (_, index) => ({ text: `block ${index}`, thought: index % 2 === 0 })),
            { functionCall: { id: 'c1', name: 'lookup', args: { key: 'a' } }, thoughtSignature: TOOL_SIGNATURE },
          ])
        }
        return sse([{ text: 'complete' }])
      },
    },
  })
  return { adapter, orchestrator, requests }
}

describe('代理编排 replay', () => {
  it.each([false, true])('公开模型署名能续轮，切换真实 wire 后不沿用签名（showPlan=%s）', async (showPlan) => {
    const { adapter, orchestrator, requests } = fixture(showPlan)
    const ctx = new Context()
    const fiber = ctx.plugin(Llm)
    try {
      await fiber.inertia
      ctx.llm.registerAdapter([PROXY_PROVIDER_ID], adapter)
      const options = { ...source, sessionId: 'synthetic-replay' as never, messages: [user] }
      const assembled = await assemble(ctx.llm.stream(options))
      expect(assembled.finish.kind).toBe('tool-calls')
      expect(assembled.replayState).toMatchObject({
        response: { ...source, wireModel: EXECUTOR_WIRE },
        blocks: [...(showPlan ? [{ kind: 'text' }] : []), { kind: 'tool-call', signature: TOOL_SIGNATURE }],
      })
      // 宿主按用户所选路由署名，并把对齐后的 terminal replay 写进 source。
      const assistant = assembled.message({ ...source, replayState: assembled.replayState })
      expect(assistant.source).toMatchObject({ kind: 'model', ...source })
      expect(assistant.content.at(-1)).toEqual(toolCall)
      const continuation = { ...options, messages: [user, assistant, result] }
      expect((await assemble(ctx.llm.stream(continuation))).finish.kind).toBe('stop')
      expect(requests.map(body => body.model)).toEqual([PLANNER_WIRE, EXECUTOR_WIRE, EXECUTOR_WIRE])
      expect(requests[2]!.request.contents.slice(-2)).toEqual([
        { role: 'model', parts: [...(showPlan ? [{ text: expect.stringContaining('[Orchestrator Plan rev=1]') }] : []), callPart(TOOL_SIGNATURE)] },
        { role: 'user', parts: [responsePart] },
      ])

      orchestrator.executorEffort = 'high'
      expect((await assemble(ctx.llm.stream(continuation))).finish.kind).toBe('stop')
      expect(requests.map(body => body.model)).toEqual([PLANNER_WIRE, EXECUTOR_WIRE, EXECUTOR_WIRE, OTHER_WIRE])
      expect(requests[3]!.request.contents.at(-2)?.parts.at(-1)).toEqual(callPart(SENTINEL))
    } finally {
      await fiber.dispose()
      adapter.dispose()
    }
  })

  it('关闭编排后直通仍按公开模型署名和续轮', async () => {
    const { adapter, orchestrator, requests } = fixture(false)
    const ctx = new Context()
    const fiber = ctx.plugin(Llm)
    try {
      await fiber.inertia
      ctx.llm.registerAdapter([PROXY_PROVIDER_ID], adapter)
      orchestrator.enabled = false
      const first = await assemble(ctx.llm.stream({ ...source, messages: [user] }))
      expect(first.replayState?.response).toMatchObject({ ...source, wireModel: EXECUTOR_WIRE })
      const assistant = first.message({ ...source, replayState: first.replayState })
      const second = await assemble(ctx.llm.stream({ ...source, messages: [user, assistant, result] }))
      expect(second.finish.kind).toBe('stop')
      expect(requests.map(body => body.model)).toEqual([EXECUTOR_WIRE, EXECUTOR_WIRE])
      expect(requests[1]!.request.contents.at(-2)?.parts).toEqual([callPart(TOOL_SIGNATURE)])
    } finally {
      await fiber.dispose()
      adapter.dispose()
    }
  })

  it.each(['high', 'xhigh'])('关闭编排后继续使用账户唯一的 %s 档与历史工具签名', async tier => {
    const wire = `gemini-4-hydrogen-${tier}`
    const { adapter, orchestrator, requests } = fixture(false, 0, wire)
    const ctx = new Context()
    const fiber = ctx.plugin(Llm)
    try {
      await fiber.inertia
      ctx.llm.registerAdapter([PROXY_PROVIDER_ID], adapter)
      const options = { ...source, messages: [user], reasoningEffort: ReasoningEffortId('medium') }
      const first = await assemble(ctx.llm.stream(options))
      const assistant = first.message({ ...source, replayState: first.replayState })
      orchestrator.enabled = false
      expect((await adapter.prepareCall(PROXY_PROVIDER_ID, ORCHESTRATOR_MODEL_ID)).model.context?.contextWindow).toBe(32000)
      expect((await assemble(ctx.llm.stream({ ...options, messages: [user, assistant, result] }))).finish.kind).toBe('stop')
      expect(requests.map(body => body.model)).toEqual([PLANNER_WIRE, wire, wire])
      expect(requests.at(-1)?.request.contents.at(-2)?.parts).toEqual([callPart(TOOL_SIGNATURE)])
    } finally {
      await fiber.dispose()
      adapter.dispose()
    }
  })

  it('计划文本额外占一个 replay 块时仍能续轮 128 块 executor 响应', async () => {
    const { adapter, requests } = fixture(true, 127)
    const ctx = new Context()
    const fiber = ctx.plugin(Llm)
    try {
      await fiber.inertia
      ctx.llm.registerAdapter([PROXY_PROVIDER_ID], adapter)
      const options = { ...source, sessionId: 'synthetic-replay-limit' as never, messages: [user] }
      const first = await assemble(ctx.llm.stream(options))
      expect(first.replayState?.blocks).toHaveLength(129)
      const assistant = first.message({ ...source, replayState: first.replayState })
      expect((await assemble(ctx.llm.stream({ ...options, messages: [user, assistant, result] }))).finish.kind).toBe('stop')
      expect(requests[2]!.request.contents.at(-2)?.parts.at(-1)).toEqual(callPart(TOOL_SIGNATURE))
    } finally {
      await fiber.dispose()
      adapter.dispose()
    }
  })

  const legacyReplay = createProxyReplayState(EXECUTOR_MODEL, 'gemini', 'STOP', [{ kind: 'tool-call', signature: TOOL_SIGNATURE }], EXECUTOR_WIRE)

  it.each([
    { reason: '旧信封的 executor ID 与确切 wire 匹配', signature: TOOL_SIGNATURE },
    { reason: '来源 provider 不符', assistantSource: { ...source, provider: 'other-provider' } },
    { reason: '历史是 executor 直选而非公开编排', assistantSource: { ...source, model: EXECUTOR_MODEL } },
    { reason: '信封 provider 不符', response: { ...legacyReplay.response, provider: 'other-provider' } },
    { reason: '旧 executor ID 不符', response: { ...legacyReplay.response, model: 'antigravity-claude-sonnet-5-5' } },
    { reason: '旧信封缺少 wire', response: { ...legacyReplay.response, wireModel: undefined } },
    { reason: '新信封也必须有 wire', response: { ...legacyReplay.response, model: ORCHESTRATOR_MODEL_ID, wireModel: undefined } },
    { reason: 'wire 家族不符', response: { ...legacyReplay.response, family: 'claude' } },
    { reason: '块类型错位', blocks: [{ kind: 'reasoning', signature: TOOL_SIGNATURE }] },
    { reason: '无效条目不能被过滤掉来满足对齐', blocks: [null, ...legacyReplay.blocks] },
    { reason: '只有旧顶层字段，缺宿主嵌套信封', useTopLevel: true },
  ])('$reason', async ({ signature, assistantSource, response, blocks, useTopLevel }) => {
    const replayState = { response: response ?? legacyReplay.response, blocks: blocks ?? legacyReplay.blocks }
    const unvalidatedBlock = { ...toolCall, thoughtSignature: 'unvalidated-block-signature' }
    const assistant = createAssistantMessage({
      content: [unvalidatedBlock],
      source: { ...(assistantSource ?? source), ...(useTopLevel ? {} : { replayState }) },
    })
    const options = {
      ...source,
      model: EXECUTOR_MODEL,
      messages: [user, useTopLevel ? { ...assistant, replayState } : assistant, result],
    }
    const payload = await buildProxyGeneratePayload(options, {}, createProxySessionStore(), 1, undefined, undefined, EXECUTOR_WIRE, ORCHESTRATOR_MODEL_ID)
    expect(payload.request.contents).toContainEqual({ role: 'model', parts: [callPart(signature ?? SENTINEL)] })
  })
})
