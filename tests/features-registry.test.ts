import { describe, expect, it, vi } from 'vitest'
import { createFeatureRegistry, resolveFeatureEntries, validateFeatureEndpoints } from '../src/features/registry.js'
import { FEATURE_MOUNTS } from '../src/features/mounts.js'
import { FEATURE_SPECS } from '../src/features/specs.js'
import type { FeatureContext, FeatureMount, FeatureSpec } from '../src/features/types.js'

function spec(id: string, overrides: Partial<FeatureSpec> = {}): FeatureSpec {
  return { id, name: id, description: id, defaultEnabled: false, compatibleModes: ['proxy', 'acp'], ...overrides }
}

function noopMount(): FeatureMount {
  return () => ({ unmount() {} })
}

function fakeContext(): FeatureContext {
  return {
    log: { info: vi.fn(), warn: vi.fn() },
    fetch: vi.fn() as unknown as typeof fetch,
    mode: () => 'acp',
    catalogChanged: vi.fn(),
    declareEndpoints: () => true,
    ctx: {},
  }
}

describe('功能模块注册表 — 加载期双向校验', () => {
  it('真实规格表与实现表对齐，不抛错（防止漏登记静默失效）', () => {
    expect(() => resolveFeatureEntries(FEATURE_SPECS, FEATURE_MOUNTS)).not.toThrow()
    const entries = resolveFeatureEntries(FEATURE_SPECS, FEATURE_MOUNTS)
    expect(entries.map((e) => e.spec.id)).toEqual(FEATURE_SPECS.map((s) => s.id))
  })

  it('有规格没实现 → 加载期抛错', () => {
    expect(() => resolveFeatureEntries([spec('a')], {})).toThrow(/缺少挂载实现/)
  })

  it('有实现没规格 → 加载期抛错（孤儿实现）', () => {
    expect(() => resolveFeatureEntries([], { a: noopMount() })).toThrow(/规格表之外/)
  })

  it('重复规格 id → 抛错', () => {
    expect(() => resolveFeatureEntries([spec('a'), spec('a')], { a: noopMount() })).toThrow(/重复 id/)
  })

  it('未声明 compatibleModes → 抛错', () => {
    expect(() => resolveFeatureEntries([{ ...spec('a'), compatibleModes: [] }], { a: noopMount() })).toThrow(/compatibleModes/)
  })

  it('端点声明越界（非 https / 非 Google 域）→ 抛错', () => {
    expect(() => resolveFeatureEntries(
      [spec('a', { endpoints: { origins: ['http://evil.example'] } })],
      { a: noopMount() },
    )).toThrow(/端点校验失败/)
    expect(() => resolveFeatureEntries(
      [spec('a', { endpoints: { origins: ['https://daily-cloudcode-pa.googleapis.com'], paths: ['nope'] } })],
      { a: noopMount() },
    )).toThrow(/path 必须以/)
  })

  it('端点声明合规 → 不抛错', () => {
    expect(() => resolveFeatureEntries(
      [spec('a', { endpoints: { origins: ['https://cloudcode-pa.googleapis.com'], paths: ['/v1internal:x'] } })],
      { a: noopMount() },
    )).not.toThrow()
  })
})

describe('功能模块注册表 — 动态挂载', () => {
  it('按开关差量挂载/卸载，幂等', () => {
    const aUnmount = vi.fn()
    const bUnmount = vi.fn()
    const entries = resolveFeatureEntries(
      [spec('a'), spec('b')],
      { a: () => ({ unmount: aUnmount }), b: () => ({ unmount: bUnmount }) },
    )
    const registry = createFeatureRegistry({ entries, buildContext: () => fakeContext() })

    const r1 = registry.sync(new Set(['a']), 'acp')
    expect(r1.mounted).toEqual(['a'])
    expect(r1.unmounted).toEqual([])
    expect(registry.mounted()).toEqual(['a'])

    // 重复 sync 同一集合 → 无变化。
    const r2 = registry.sync(new Set(['a']), 'acp')
    expect(r2.mounted).toEqual([])
    expect(r2.unmounted).toEqual([])
    expect(aUnmount).not.toHaveBeenCalled()

    // 切到 b。
    const r3 = registry.sync(new Set(['b']), 'acp')
    expect(r3.mounted).toEqual(['b'])
    expect(r3.unmounted).toEqual(['a'])
    expect(aUnmount).toHaveBeenCalledTimes(1)
    expect(registry.mounted()).toEqual(['b'])
  })

  it('当前模式不在 compatibleModes → 即使开关打开也不挂载', () => {
    const entries = resolveFeatureEntries(
      [spec('proxy-only', { compatibleModes: ['proxy'] })],
      { 'proxy-only': noopMount() },
    )
    const registry = createFeatureRegistry({ entries, buildContext: () => fakeContext() })
    const r = registry.sync(new Set(['proxy-only']), 'acp')
    expect(r.mounted).toEqual([])
    expect(registry.mounted()).toEqual([])
    // 切到 proxy 后才挂载。
    const r2 = registry.sync(new Set(['proxy-only']), 'proxy')
    expect(r2.mounted).toEqual(['proxy-only'])
  })

  it('未登记的 id 出现在开关里 → 忽略，不崩溃', () => {
    const entries = resolveFeatureEntries([spec('a')], { a: noopMount() })
    const registry = createFeatureRegistry({ entries, buildContext: () => fakeContext() })
    expect(() => registry.sync(new Set(['a', 'unknown']), 'acp')).not.toThrow()
    expect(registry.mounted()).toEqual(['a'])
  })

  it('mount 抛错不阻断其他功能与宿主装载', () => {
    const entries = resolveFeatureEntries(
      [spec('a'), spec('b')],
      {
        a: () => { throw new Error('boom') },
        b: noopMount(),
      },
    )
    const registry = createFeatureRegistry({ entries, buildContext: () => fakeContext() })
    const r = registry.sync(new Set(['a', 'b']), 'acp')
    expect(r.mounted).toEqual(['b'])
    expect(registry.mounted()).toEqual(['b'])
  })

  it('dispose 卸载全部已挂载功能', async () => {
    const unmount = vi.fn()
    const entries = resolveFeatureEntries([spec('a')], { a: () => ({ unmount }) })
    const registry = createFeatureRegistry({ entries, buildContext: () => fakeContext() })
    registry.sync(new Set(['a']), 'acp')
    await registry.dispose()
    expect(unmount).toHaveBeenCalledTimes(1)
    expect(registry.mounted()).toEqual([])
  })

  it('sync(force) 先卸载已挂载再按 desired 重新挂载（宿主能力后到补挂）', () => {
    let mountCount = 0
    const unmount = vi.fn()
    const entries = resolveFeatureEntries(
      [spec('a')],
      { a: () => { mountCount += 1; return { unmount } } },
    )
    const registry = createFeatureRegistry({ entries, buildContext: () => fakeContext() })

    const r1 = registry.sync(new Set(['a']), 'acp')
    expect(r1.mounted).toEqual(['a'])
    expect(mountCount).toBe(1)
    expect(unmount).not.toHaveBeenCalled()

    // 同一集合普通 sync → 幂等无变化。
    const r2 = registry.sync(new Set(['a']), 'acp')
    expect(r2.mounted).toEqual([])
    expect(r2.unmounted).toEqual([])
    expect(mountCount).toBe(1)

    // force → 先卸载再重挂同一功能。
    const r3 = registry.sync(new Set(['a']), 'acp', true)
    expect(r3.mounted).toEqual(['a'])
    expect(r3.unmounted).toEqual(['a'])
    expect(mountCount).toBe(2)
    expect(unmount).toHaveBeenCalledTimes(1)
    expect(registry.mounted()).toEqual(['a'])
  })
})

describe('端点安全校验', () => {
  it('只放行 https + Google 已知域', () => {
    expect(validateFeatureEndpoints({ origins: ['https://oauth2.googleapis.com'] })).toEqual([])
    expect(validateFeatureEndpoints({ origins: ['https://accounts.google.com'] })).toEqual([])
    expect(validateFeatureEndpoints({ origins: ['ftp://x.googleapis.com'] })).not.toEqual([])
    expect(validateFeatureEndpoints({ origins: ['https://evil.com'] })).not.toEqual([])
    expect(validateFeatureEndpoints({ origins: ['not-a-url'] })).not.toEqual([])
  })
})
