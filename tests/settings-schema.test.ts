import { isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { describe, expect, it } from 'vitest'
import { Config, LIVE_SETTING_KEYS, liveHostConfig } from '../src/settings.js'

describe('live settings schema and runtime references', () => {
  it('宿主提交即时引用后可读取下一次操作配置，同时保持已捕获快照不变', () => {
    const parsed = Config({ autoWarmup: false, preferredModel: 'before', proxyUrl: 'http://old:7890' })
    const config = liveHostConfig(parsed)
    const snapshot = { ...config }
    const next = Config({ autoWarmup: false, preferredModel: 'after', proxyUrl: '', reuseSessions: false, resumeSessions: true, keepProcessAfterCancel: true, cancelGraceMs: 0, idleRecycleMs: 0, agyCliPath: '/new/agy', proxyBypass: '*.internal' })
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
    expect(config).toMatchObject({ preferredModel: 'after', proxyUrl: '', reuseSessions: false, resumeSessions: true, keepProcessAfterCancel: true, cancelGraceMs: 0, idleRecycleMs: 0, agyCliPath: '/new/agy', proxyBypass: '*.internal' })
    expect(snapshot.preferredModel).toBe('before')
    expect(snapshot.proxyUrl).toBe('http://old:7890')
  })

  it('启动、并发等普通配置仍保持普通类型，默认开关和零值正确', () => {
    const config = liveHostConfig(Config({ cancelGraceMs: 0, idleRecycleMs: 0 }))
    expect(config.autoWarmup).toBe(true)
    expect(config.reuseSessions).toBe(true)
    expect(config.resumeSessions).toBe(false)
    expect(config.keepProcessAfterCancel).toBe(false)
    expect(config.cancelGraceMs).toBe(0)
    expect(config.idleRecycleMs).toBe(0)
    expect(config.maxConcurrentSessions).toBe(2)
    expect(config.handshakeTimeoutMs).toBe(120000)
    expect(config.extraArgs).toEqual([])
  })
})
