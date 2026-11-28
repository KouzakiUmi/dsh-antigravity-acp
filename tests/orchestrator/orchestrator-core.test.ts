import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_ORCHESTRATOR_SETTINGS,
  ORCHESTRATOR_EXECUTOR_MODEL,
  ORCHESTRATOR_EXECUTOR_MODELS,
  ORCHESTRATOR_MODEL_ID,
  ORCHESTRATOR_PLANNER_MODELS,
  OrchestratorStore,
  PLANNER_SYSTEM_SUFFIX,
  buildExecutorSystem,
  buildPlannerMessages,
  computeTurnKey,
  convergeOrchestratorEffort,
  extractGoalAndEvidence,
  normalizeOrchestratorSettings,
  parsePlan,
  renderPlanForExecutor,
  shouldPlan,
} from '../../src/orchestrator/index.js'

describe('normalizeOrchestratorSettings', () => {
  it('缺省或非对象输入回退默认值，不抛错', () => {
    for (const input of [undefined, null, 'bad', 42, []]) {
      expect(normalizeOrchestratorSettings(input)).toEqual(DEFAULT_ORCHESTRATOR_SETTINGS)
    }
    expect(ORCHESTRATOR_MODEL_ID).toBe('antigravity-orchestrator')
    expect(ORCHESTRATOR_EXECUTOR_MODEL).toBe('gemini-4-hydrogen')
    expect(ORCHESTRATOR_EXECUTOR_MODELS).toEqual(['gemini-4-hydrogen', 'claude-sonnet-5-5'])
    expect(ORCHESTRATOR_PLANNER_MODELS).toEqual(['gemini-4-neon', 'gemini-4-argon', 'claude-opus-5-5'])
    expect(DEFAULT_ORCHESTRATOR_SETTINGS).toEqual({
      enabled: true,
      plannerModel: 'claude-opus-5-5',
      plannerEffort: 'medium',
      executorModel: 'gemini-4-hydrogen',
      executorEffort: 'medium',
      maxPlansPerTurn: 2,
      plannerTimeoutMs: 20_000,
      showPlan: false,
    })
  })

  it('plannerModel 非三选一值回落 claude-opus-5-5；executorModel 两选一、非法值回落 hydrogen；非法 effort 回落 medium', () => {
    const normalized = normalizeOrchestratorSettings({
      enabled: 'no',
      plannerModel: '  gemini-3.8-flash  ',
      plannerEffort: 'xhigh',
      executorModel: 'arbitrary-legacy-model',
      executorEffort: 'invalid',
      maxPlansPerTurn: 99,
      plannerTimeoutMs: 100,
      showPlan: 'yes',
    })
    expect(normalized).toEqual({
      enabled: true,
      plannerModel: 'claude-opus-5-5',
      plannerEffort: 'medium',
      executorModel: 'gemini-4-hydrogen',
      executorEffort: 'medium',
      maxPlansPerTurn: 2,
      plannerTimeoutMs: 20_000,
      showPlan: false,
    })

    const validSonnet = normalizeOrchestratorSettings({
      enabled: false,
      plannerModel: '  gemini-4-neon  ',
      plannerEffort: 'high',
      executorModel: '  claude-sonnet-5-5  ',
      executorEffort: 'low',
      maxPlansPerTurn: 4,
      plannerTimeoutMs: 60_000.8,
      showPlan: true,
    })
    expect(validSonnet).toEqual({
      enabled: false,
      plannerModel: 'gemini-4-neon',
      plannerEffort: 'high',
      executorModel: 'claude-sonnet-5-5',
      executorEffort: 'low',
      maxPlansPerTurn: 4,
      plannerTimeoutMs: 60_000,
      showPlan: true,
    })
    expect(normalizeOrchestratorSettings({ plannerModel: 'gemini-4-argon' }).plannerModel).toBe('gemini-4-argon')
    expect(normalizeOrchestratorSettings({ executorModel: 'claude-sonnet-5-5' }).executorModel).toBe('claude-sonnet-5-5')
  })

  it('convergeOrchestratorEffort 命中返回原值，不在集合内优先 medium 其次最近档', () => {
    expect(convergeOrchestratorEffort('high', ['low', 'medium', 'high'])).toBe('high')
    expect(convergeOrchestratorEffort('xhigh', ['low', 'medium', 'high'])).toBe('medium')
    expect(convergeOrchestratorEffort('xhigh', ['low', 'high'])).toBe('high')
    expect(convergeOrchestratorEffort('low', ['high', 'xhigh'])).toBe('high')
    expect(convergeOrchestratorEffort('medium', [])).toBeUndefined()
  })
})

describe('parsePlan & renderPlanForExecutor', () => {
  it('解析正常 <plan>{json}</plan>、带代码围栏及前后解释文字', () => {
    const raw = [
      '我先分析一下需求。',
      '<plan>',
      '```json',
      JSON.stringify({
        goal: '实现编排模块',
        steps: [
          { id: 'p1', title: '定义类型', verification: 'typecheck 通过' },
          { title: '补全测试' },
        ],
        handback: ['发现 API 不兼容时停下来问用户'],
      }),
      '```',
      '</plan>',
      '请继续执行。',
    ].join('\n')

    const first = parsePlan(raw)
    expect(first).toBeDefined()
    expect(first).toMatchObject({
      goal: '实现编排模块',
      steps: [
        { id: 'p1', title: '定义类型', verification: 'typecheck 通过' },
        { id: 'p2', title: '补全测试' },
      ],
      handback: ['发现 API 不兼容时停下来问用户'],
      revision: 1,
    })

    const second = parsePlan(raw, first)
    expect(second).toBe(first)
    expect(parsePlan('<plan>{"goal":"new","steps":[{"title":"different"}]}</plan>', first)?.revision).toBe(2)
  })

  it('损坏 JSON、缺失 goal/steps 或空字符串返回 undefined；多块时取最后一个合法块', () => {
    expect(parsePlan('')).toBeUndefined()
    expect(parsePlan('no tags here')).toBeUndefined()
    expect(parsePlan('<plan>{bad json}</plan>')).toBeUndefined()
    expect(parsePlan('<plan>{"goal":"x","steps":[]}</plan>')).toBeUndefined()
    expect(parsePlan('<plan>{"steps":[{"title":"a"}]}</plan>')).toBeUndefined()

    const mixed = [
      '<plan>{"goal":"first","steps":[{"title":"step1"}]}</plan>',
      '<plan>{broken</plan>',
    ].join('\n')
    expect(parsePlan(mixed)?.goal).toBe('first')
  })

  it('renderPlanForExecutor 对同一 plan 渲染逐字节稳定', () => {
    const plan = parsePlan('<plan>{"goal":"Fix bug","steps":[{"id":"p1","title":"Reproduce","verification":"test fails"}],"handback":["Needs DB access"]}</plan>')!
    const a = renderPlanForExecutor(plan)
    const b = renderPlanForExecutor({ ...plan })
    expect(a).toBe(b)
    expect(a).toContain('[Orchestrator Plan rev=1]')
    expect(a).toContain('Goal: Fix bug')
    expect(a).toContain('1. [p1] Reproduce | verify: test fails')
    expect(a).toContain('- Needs DB access')
  })
})

describe('shouldPlan 六分支与优先级', () => {
  const samplePlan = {
    goal: 'task',
    steps: [{ id: 'p1', title: 'step' }],
    handback: [],
    revision: 1,
    createdAt: 1,
  }
  const userMsg = (text: string): RequestMessage => createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  const contextMsg = (text: string): RequestMessage => createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'time-context' } as never,
  })
  const assistantCalls = (...calls: Array<{ id: string; name: string }>): RequestMessage => createAssistantMessage({
    content: calls.map((c) => ({ type: 'tool-call', id: ToolCallId(c.id), name: c.name, arguments: '{}' })),
    source: { provider: 'antigravity-proxy', model: 'antigravity-gemini-4-hydrogen' },
  })
  const toolResult = (id: string, isError: boolean): RequestMessage => createToolResultMessage({
    callId: ToolCallId(id),
    content: [{ type: 'text', text: isError ? 'err' : 'ok' }],
    isError,
  })

  it('覆盖 disabled / budget / no-plan / new-goal / tool-error / repeat-failure / continue', () => {
    const u1 = userMsg('do A')
    const turnKey1 = computeTurnKey([u1], 's1')

    expect(shouldPlan({
      messages: [u1],
      state: { stage: 'idle', plansThisTurn: 0 },
      goal: 'do A',
      settings: { ...DEFAULT_ORCHESTRATOR_SETTINGS, enabled: false },
      sessionId: 's1',
    })).toEqual({ plan: false, reason: 'disabled' })

    expect(shouldPlan({
      messages: [u1],
      state: { stage: 'executing', plansThisTurn: 2, plan: samplePlan, turnKey: turnKey1 },
      goal: 'do A',
      settings: { ...DEFAULT_ORCHESTRATOR_SETTINGS, maxPlansPerTurn: 2 },
      sessionId: 's1',
    })).toEqual({ plan: false, reason: 'budget' })

    expect(shouldPlan({
      messages: [u1],
      state: { stage: 'idle', plansThisTurn: 0 },
      goal: 'do A',
      settings: DEFAULT_ORCHESTRATOR_SETTINGS,
      sessionId: 's1',
    })).toEqual({ plan: true, reason: 'no-plan' })

    const u2 = userMsg('do B')
    expect(shouldPlan({
      messages: [u1, contextMsg('now=12:00'), u2],
      state: { stage: 'executing', plansThisTurn: 1, plan: samplePlan, turnKey: turnKey1 },
      goal: 'do B',
      settings: DEFAULT_ORCHESTRATOR_SETTINGS,
      sessionId: 's1',
    })).toEqual({ plan: true, reason: 'new-goal' })

    expect(shouldPlan({
      messages: [u1, contextMsg('now=12:00')],
      state: { stage: 'executing', plansThisTurn: 1, plan: samplePlan, turnKey: turnKey1 },
      goal: 'do A',
      settings: DEFAULT_ORCHESTRATOR_SETTINGS,
      sessionId: 's1',
    })).toEqual({ plan: false, reason: 'continue' })

    expect(shouldPlan({
      messages: [
        u1,
        assistantCalls({ id: 'c1', name: 'bash' }),
        toolResult('c1', true),
      ],
      state: { stage: 'executing', plansThisTurn: 1, plan: samplePlan, turnKey: turnKey1 },
      goal: 'do A',
      settings: DEFAULT_ORCHESTRATOR_SETTINGS,
      sessionId: 's1',
    })).toEqual({ plan: true, reason: 'tool-error' })

    expect(shouldPlan({
      messages: [
        u1,
        assistantCalls({ id: 'c1', name: 'read' }, { id: 'c2', name: 'read' }, { id: 'c3', name: 'bash' }),
        toolResult('c1', true),
        toolResult('c2', true),
        toolResult('c3', false),
      ],
      state: { stage: 'executing', plansThisTurn: 1, plan: samplePlan, turnKey: turnKey1 },
      goal: 'do A',
      settings: DEFAULT_ORCHESTRATOR_SETTINGS,
      sessionId: 's1',
    })).toEqual({ plan: true, reason: 'repeat-failure' })

    expect(shouldPlan({
      messages: [
        u1,
        assistantCalls({ id: 'c1', name: 'read' }, { id: 'c2', name: 'bash' }, { id: 'c3', name: 'read' }, { id: 'c4', name: 'bash' }),
        toolResult('c1', true),
        toolResult('c2', false),
        toolResult('c3', false),
        toolResult('c4', false),
      ],
      state: { stage: 'executing', plansThisTurn: 1, plan: samplePlan, turnKey: turnKey1 },
      goal: 'do A',
      settings: DEFAULT_ORCHESTRATOR_SETTINGS,
      sessionId: 's1',
    })).toEqual({ plan: false, reason: 'continue' })
  })
})

describe('turn identity and attempt accounting', () => {
  it('并行结果里的失败可触发一次，不会在追加成功结果后重复触发', () => {
    const user = createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } })
    const result = (id: string, isError: boolean) => createToolResultMessage({ callId: ToolCallId(id), content: [], isError })
    const plan = parsePlan('<plan>{"goal":"work","steps":[{"title":"Do"}]}</plan>')!
    const messages = [user, result('fail', true), result('success', false)]
    const state = { plan, turnKey: computeTurnKey(messages), stage: 'executing' as const, plansThisTurn: 1, lastPlannedToolResult: null }
    const input = { messages, goal: 'work', settings: { ...DEFAULT_ORCHESTRATOR_SETTINGS, maxPlansPerTurn: 4 }, state }
    expect(shouldPlan(input)).toEqual({ plan: true, reason: 'tool-error' })
    expect(shouldPlan({ ...input, messages: [...messages, result('another-success', false)],
      state: { ...state, lastPlannedToolResult: messages.at(-1)!.id } })).toEqual({ plan: false, reason: 'continue' })
  })

  it('相同文字的独立发送是新轮；仅看当前轮工具结果', () => {
    const first = createUserMessage({ content: [{ type: 'text', text: 'same' }], source: { kind: 'user' } })
    const second = createUserMessage({ content: first.content, source: { kind: 'user' } })
    const result = createToolResultMessage({ callId: ToolCallId('old'), content: [], isError: true })
    const history = [first, result, second]
    const currentKey = computeTurnKey(history, 's1')
    expect(currentKey).not.toBe(computeTurnKey([first], 's1'))
    const plan = parsePlan('<plan>{"goal":"same","steps":[{"title":"Do"}]}</plan>')!
    expect(shouldPlan({ messages: history, state: { plan, turnKey: currentKey, stage: 'executing', plansThisTurn: 1 },
      goal: 'same', settings: DEFAULT_ORCHESTRATOR_SETTINGS, sessionId: 's1' })).toEqual({ plan: false, reason: 'continue' })
  })

  it('失败消耗预算，新轮清掉旧计划，迟到回包不覆盖新轮', () => {
    const store = new OrchestratorStore()
    const plan = parsePlan('<plan>{"goal":"first","steps":[{"title":"Do"}]}</plan>')!
    store.forTurn('s1', 'first')
    const first = store.reservePlan('s1')
    store.finishPlan('s1', first, plan)
    const second = store.reservePlan('s1')
    store.finishPlan('s1', second)
    expect(store.forTurn('s1', 'first')).toMatchObject({ plansThisTurn: 2, plan })
    const stale = store.reservePlan('s1')
    expect(store.forTurn('s1', 'second')).toEqual({ plansThisTurn: 0, turnKey: 'second', stage: 'idle' })
    store.finishPlan('s1', stale, plan)
    expect(store.get('s1').plan).toBeUndefined()
  })
})

describe('prompts & OrchestratorStore', () => {
  it('extractGoalAndEvidence 截取最近 6 条工具结果且每条 <= 1200 字符', () => {
    const messages: RequestMessage[] = [
      createUserMessage({ content: [{ type: 'text', text: '完成任务' }], source: { kind: 'user' } }),
      createUserMessage({ content: [{ type: 'text', text: '上下文注入' }], source: { kind: 'time-context' } as never }),
    ]
    for (let i = 1; i <= 8; i += 1) {
      const id = ToolCallId(`call-${i}`)
      messages.push(createAssistantMessage({
        content: [{ type: 'tool-call', id, name: `tool_${i}`, arguments: '{}' }],
        source: { provider: 'antigravity-proxy', model: 'm' },
      }))
      messages.push(createToolResultMessage({
        callId: id,
        content: [{ type: 'text', text: i === 8 ? 'x'.repeat(2000) : `out-${i}` }],
        isError: i === 7,
      }))
    }

    const { goal, evidence } = extractGoalAndEvidence(messages)
    expect(goal).toBe('完成任务')
    expect(evidence).toHaveLength(6)
    expect(evidence[0]).toContain('[tool_3 | OK] out-3')
    expect(evidence[4]).toContain('[tool_7 | ERROR] out-7')
    expect(evidence[5]!.length).toBeLessThanOrEqual(1200)

    const plannerMessages = buildPlannerMessages(goal, evidence)
    expect(plannerMessages).toHaveLength(1)
    expect(plannerMessages[0]!.role).toBe('user')
    expect(PLANNER_SYSTEM_SUFFIX).toContain('<plan>')

    const plan = parsePlan('<plan>{"goal":"完成任务","steps":[{"id":"p1","title":"Do"}]}</plan>')!
    expect(buildExecutorSystem('Base sys', plan)).toBe(`Base sys\n\n${renderPlanForExecutor(plan)}`)
    expect(buildExecutorSystem(undefined, plan)).toBe(renderPlanForExecutor(plan))
  })

  it('OrchestratorStore 按 sessionId 隔离并按 LRU 上限淘汰', () => {
    const store = new OrchestratorStore(3)
    store.update('s1', { stage: 'executing', plansThisTurn: 1 })
    store.update('s2', { stage: 'planning', plansThisTurn: 2 })
    store.update('s3', { stage: 'executing', plansThisTurn: 1 })
    // 读一次 s1，刷新 LRU，使 s2 成为最旧
    expect(store.get('s1').plansThisTurn).toBe(1)
    store.update('s4', { stage: 'executing', plansThisTurn: 1 })

    expect(store.size).toBe(3)
    expect(store.get('s2')).toEqual({ stage: 'idle', plansThisTurn: 0 })
    expect(store.get('s1').plansThisTurn).toBe(1)
    store.resetTurn('s1', 's1:abc')
    expect(store.get('s1')).toMatchObject({ plansThisTurn: 0, turnKey: 's1:abc' })
    expect(store.get(undefined)).toEqual({ stage: 'idle', plansThisTurn: 0 })
    store.dispose()
    expect(store.size).toBe(0)
  })

  it('无会话 ID 的请求不写入会话计划，也不借用同名会话', () => {
    const store = new OrchestratorStore()
    store.update('anonymous', { stage: 'executing', plansThisTurn: 2 })
    store.update(undefined, { stage: 'planning', plansThisTurn: 1 })
    store.update('', { stage: 'executing', plansThisTurn: 3 })
    expect(store.get(undefined)).toEqual({ stage: 'idle', plansThisTurn: 0 })
    expect(store.get('anonymous').plansThisTurn).toBe(2)
    expect(store.size).toBe(1)
  })
})
