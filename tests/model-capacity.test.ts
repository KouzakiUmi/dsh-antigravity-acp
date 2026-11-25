import { describe, expect, it } from 'vitest'
import { auditedAcpContextWindow } from '../src/adapter/model-capacity.js'

describe('ACP 上下文容量审计回退（issue #17）', () => {
  it('Neon / Hydrogen 用登记的上游实测值，家族与档位 ID 都命中', () => {
    expect(auditedAcpContextWindow('gemini-4-neon')).toBe(1_048_576)
    expect(auditedAcpContextWindow('gemini-4-neon-high')).toBe(1_048_576)
    expect(auditedAcpContextWindow('gemini-4-hydrogen')).toBe(1_048_576)
    expect(auditedAcpContextWindow('gemini-4-hydrogen-xhigh')).toBe(1_048_576)
  })

  it('auth-core 快照覆盖的家族取原生审计值', () => {
    expect(auditedAcpContextWindow('gemini-4-argon')).toBe(1_048_576)
    expect(auditedAcpContextWindow('gemini-4-argon-high')).toBe(1_048_576)
    expect(auditedAcpContextWindow('claude-opus-5-5')).toBe(1_000_000)
    expect(auditedAcpContextWindow('claude-opus-5-5-high')).toBe(1_000_000)
    expect(auditedAcpContextWindow('claude-sonnet-5-5')).toBe(1_000_000)
    expect(auditedAcpContextWindow('gpt-oss-120b-medium')).toBe(131_072)
    expect(auditedAcpContextWindow('gemini-3.8-flash')).toBe(1_048_576)
  })

  it('未知家族返回 undefined，绝不填猜测值', () => {
    expect(auditedAcpContextWindow('gemini-3-pro')).toBeUndefined()
    expect(auditedAcpContextWindow('some-future-model')).toBeUndefined()
    expect(auditedAcpContextWindow('')).toBeUndefined()
  })
})
