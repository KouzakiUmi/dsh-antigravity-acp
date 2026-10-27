import { describe, expect, it } from 'vitest'
import { applyModelSettings, modelSettingFor, modelVisible, normalizeModelSettings, resolveModelTarget } from '../src/adapter/model-settings.js'

describe('模型目录用户设置', () => {
  it('收敛非法配置：丢掉空键、非对象条目与未声明的档位', () => {
    const settings = normalizeModelSettings({
      '': { enabled: false },
      'gemini-3-pro': 'nope',
      'claude-opus-5-5': { effort: 'max', name: '  ', target: '  ', enabled: 'yes' },
      'gemini-4-argon': { effort: 'high', name: ' Argon ', target: ' gemini-4-argon-preview ' },
    })
    expect([...settings.keys()]).toEqual(['claude-opus-5-5', 'gemini-4-argon'])
    expect(settings.get('claude-opus-5-5')).toEqual({ enabled: true })
    expect(settings.get('gemini-4-argon')).toEqual({ enabled: true, effort: 'high', name: 'Argon', target: 'gemini-4-argon-preview' })
  })

  it('非对象配置整体降级为空设置，不让一份坏配置击穿目录', () => {
    for (const value of [undefined, null, 'x', 3, [] as unknown]) {
      expect(normalizeModelSettings(value).size).toBe(0)
    }
  })

  it('未配置的模型默认启用，停用项不列入选择器但设置仍可读', () => {
    const settings = normalizeModelSettings({ hidden: { enabled: false, name: '隐藏' } })
    expect(modelVisible(settings, 'unknown-model')).toBe(true)
    expect(modelVisible(settings, 'hidden')).toBe(false)
    expect(modelSettingFor(settings, 'hidden')).toMatchObject({ enabled: false, name: '隐藏' })
  })

  it('列表套用显示名覆盖并跳过停用项，不新增条目', () => {
    const settings = normalizeModelSettings({ 'gemini-3-pro': { name: '改名' }, 'gemini-3-flash': { enabled: false } })
    const rows = applyModelSettings(settings, [
      { id: 'gemini-3-pro', name: 'Gemini 3 Pro', description: '质量优先' },
      { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
    ])
    expect(rows).toEqual([{ id: 'gemini-3-pro', name: '改名', description: '质量优先' }])
  })

  it('映射优先于档位路由，其次才是默认档位与官方默认', () => {
    const settings = normalizeModelSettings({ mapped: { target: 'official-x', effort: 'high' }, preferring: { effort: 'low' } })
    const route = (tier: string | undefined) => `auto:${tier ?? 'none'}`
    expect(resolveModelTarget({ settings, model: 'mapped', effort: 'low', route })).toBe('official-x')
    expect(resolveModelTarget({ settings, model: 'preferring', route })).toBe('auto:low')
    // 显式选择优先于默认档位。
    expect(resolveModelTarget({ settings, model: 'preferring', effort: 'high', route })).toBe('auto:high')
    expect(resolveModelTarget({ settings, model: 'plain', route })).toBe('auto:none')
  })
})
