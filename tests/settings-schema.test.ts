import { isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { describe, expect, it } from 'vitest'
import { Config, LIVE_SETTING_KEYS, liveHostConfig } from '../src/settings.js'

describe('live settings schema and runtime references', () => {
  it('宿主提交即时引用后可读取下一次操作配置，同时保持已捕获快照不变', () => {
    const parsed = Config({ autoWarmup: false, modelOverrides: { before: { enabled: false } }, proxyUrl: 'http://old:7890' })
    const config = liveHostConfig(parsed)
    const snapshot = { ...config }
    const next = Config({ autoWarmup: false, modelOverrides: { after: { effort: 'high', target: 'gemini-3-pro-high' } }, proxyUrl: '', reuseSessions: false, resumeSessions: true, keepProcessAfterCancel: true, cancelGraceMs: 0, idleRecycleMs: 0, agyCliPath: '/new/agy', proxyBypass: '*.internal' })
    for (const key of LIVE_SETTING_KEYS) {
      const beforeRef = parsed[key]
      const afterRef = next[key]
      expect(isVolatile(beforeRef)).toBe(true)
      expect(isVolatile(afterRef)).toBe(true)
      if (!isVolatile(beforeRef) || !isVolatile(afterRef)) throw new Error('Setting is not volatile: ' + key)
      // Same reference commit primitive used by the host's Loader reconciliation,
      // rather than Fiber.update(), which intentionally restarts a plugin.
      updateVolatile(beforeRef, afterRef)
      expect(parsed[key]).toBe(beforeRef)
    }
    expect(config).toMatchObject({ modelOverrides: { after: { effort: 'high', target: 'gemini-3-pro-high' } }, proxyUrl: '', reuseSessions: false, resumeSessions: true, keepProcessAfterCancel: true, cancelGraceMs: 0, idleRecycleMs: 0, agyCliPath: '/new/agy', proxyBypass: '*.internal' })
    expect(snapshot.modelOverrides).toEqual({ before: { enabled: false } })
    expect(snapshot.proxyUrl).toBe('http://old:7890')
  })

  it('启动、并发等普通配置仍保持普通类型，默认开关和零值正确', () => {
    const config = liveHostConfig(Config({ cancelGraceMs: 0, idleRecycleMs: 0 }))
    expect(config.autoWarmup).toBe(true)
    expect(config.reuseSessions).toBe(true)
    expect(config.resumeSessions).toBe(false)
    expect(config.keepProcessAfterCancel).toBe(false)
    expect(config.cliQuotaEnabled).toBe(false)
    expect(config.proxyMode).toBe(false)
    expect(config.cancelGraceMs).toBe(0)
    expect(config.idleRecycleMs).toBe(0)
    expect(config.maxConcurrentSessions).toBe(2)
    expect(config.handshakeTimeoutMs).toBe(120000)
    expect(config.extraArgs).toEqual([])
    expect(config.modelOverrides).toEqual({})
  })

  it('Vertex 默认关闭并通过即时引用更新项目、区域和模型列表', () => {
    const parsed = Config({})
    const config = liveHostConfig(parsed)
    expect(config).toMatchObject({ vertexEnabled: false, vertexProject: '', vertexLocation: '', vertexModels: [] })
    const next = Config({ vertexEnabled: true, vertexProject: 'test-project', vertexLocation: 'us-central1', vertexModels: ['gemini-4-hydrogen'] })
    for (const key of ['vertexEnabled', 'vertexProject', 'vertexLocation', 'vertexModels'] as const) {
      const beforeRef = parsed[key]
      const afterRef = next[key]
      if (!isVolatile(beforeRef) || !isVolatile(afterRef)) throw new Error(`No live reference for ${key}`)
      updateVolatile(beforeRef, afterRef)
    }
    expect(config).toMatchObject({ vertexEnabled: true, vertexProject: 'test-project', vertexLocation: 'us-central1', vertexModels: ['gemini-4-hydrogen'] })
  })

  it('prompt 字节预算是普通配置：默认 176000，越界在装载期拒绝（issue #16）', () => {
    const config = liveHostConfig(Config({}))
    expect(config.promptByteBudget).toBe(176_000)
    expect(Config({ promptByteBudget: 190_000 }).promptByteBudget).toBe(190_000)
    // 上游硬上限 192001 字节；预算不得达到或超过它，也不得过小失去实用价值。
    expect(() => Config({ promptByteBudget: 192_001 })).toThrow()
    expect(() => Config({ promptByteBudget: 1_000 })).toThrow()
    // 非 volatile：不进设置卡片即时编辑，走普通配置编辑器。
    expect(LIVE_SETTING_KEYS).not.toContain('promptByteBudget')
  })

  it('模型设置保留缺省和显式启用的区别，未知档位由 schema 拒绝', () => {
    expect(Config({ modelOverrides: { 'gemini-3-pro': { name: '自定义' }, 'aistudio-gemini-3-pro': { enabled: true } } }).modelOverrides.get()).toEqual({
      'gemini-3-pro': { name: '自定义' }, 'aistudio-gemini-3-pro': { enabled: true },
    })
    // 配置可能来自手写 JSON，档位拼错必须在装载期失败，不能静默退回默认档位。
    const mistyped = { modelOverrides: { 'gemini-3-pro': { effort: 'max' } } } as unknown as Parameters<typeof Config>[0]
    expect(() => Config(mistyped)).toThrow()
  })
})
