import { describe, expect, it } from 'vitest'
import { AcpLifecycle } from '../src/runtime/lifecycle.js'

describe('ACP 生命周期计时', () => {
  it('区分启动、会话与模型首块耗时，等待工具期间仍计时', () => {
    let now = 0
    const lifecycle = new AcpLifecycle(() => now)
    lifecycle.starting()
    now = 20; lifecycle.startupPhase('credentials')
    now = 40; lifecycle.startupPhase('spawn'); lifecycle.spawned()
    now = 45; lifecycle.startupPhase('initialize')
    now = 100; lifecycle.ready()
    expect(lifecycle.read()).toMatchObject({ phase: 'ready', processRunning: true, starts: 1,
      startup: { elapsedMs: 100, timings: { binary: 20, credentials: 20, spawn: 5, initialize: 55 } } })
    lifecycle.reused(); lifecycle.beginRound('test-model')
    now = 110; lifecycle.roundPhase('session')
    now = 210; lifecycle.roundPhase('model')
    now = 230; lifecycle.promptSent()
    now = 400; lifecycle.firstOutput()
    now = 500; lifecycle.firstOutput(true); lifecycle.finish('tool-calls')
    now = 900
    expect(lifecycle.read()).toMatchObject({ phase: 'waiting-tools', uptimeMs: 860, reuses: 1,
      round: { elapsedMs: 800, timings: { connection: 10, session: 100, model: 20 }, firstChunkMs: 170, firstToolMs: 270 } })
    lifecycle.continuing()
    now = 1200; lifecycle.finish('stop')
    now = 1500
    expect(lifecycle.read()).toMatchObject({ phase: 'ready',
      round: { elapsedMs: 1100, continuations: 1, lastContinuationMs: 300, finish: 'stop' } })
  })

  it('退出后停止进程计时，失败脱敏，返回快照不会改写内部记录', () => {
    let now = 0
    const lifecycle = new AcpLifecycle(() => now)
    lifecycle.starting(); lifecycle.spawned()
    now = 50; lifecycle.ready(); lifecycle.beginRound('model'); lifecycle.promptSent()
    now = 100; lifecycle.recycling(); lifecycle.stopped()
    expect(lifecycle.read()).toMatchObject({ processRunning: false, recycles: 1 })
    expect(lifecycle.read().uptimeMs).toBeUndefined()
    lifecycle.failed(new Error('access_token=SECRET_VALUE'))
    expect(lifecycle.read().error).not.toContain('SECRET_VALUE')
    const snapshot = lifecycle.read()
    snapshot.startup!.timings.binary = 123456
    now = 1000
    expect(lifecycle.read().startup!.timings.binary).not.toBe(123456)
    expect(lifecycle.read().round!.elapsedMs).toBe(50)
  })
})
