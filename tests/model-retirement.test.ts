import { describe, expect, it } from 'vitest'
import {
  isRetiringModel,
  MODEL_RETIREMENTS,
  retirementForModel,
  retirementFamilyKey,
} from '../src/adapter/model-retirement.js'

describe('模型退役表', () => {
  it('家族键归一化：去 antigravity- 前缀与档位后缀', () => {
    expect(retirementFamilyKey('gemini-4-argon-high')).toBe('gemini-4-argon')
    expect(retirementFamilyKey('antigravity-gemini-3.8-flash')).toBe('gemini-3.8-flash')
    expect(retirementFamilyKey(' gpt-oss-120b-medium ')).toBe('gpt-oss-120b')
    expect(retirementFamilyKey('gemini-4-hydrogen')).toBe('gemini-4-hydrogen')
  })

  it('退役家族的任意档位 ID 都命中，普通模型不命中', () => {
    for (const family of MODEL_RETIREMENTS.map((entry) => entry.familyId)) {
      expect(isRetiringModel(family)).toBe(true)
      expect(isRetiringModel(`antigravity-${family}-medium`)).toBe(true)
    }
    expect(isRetiringModel('gemini-4-hydrogen')).toBe(false)
    expect(isRetiringModel('claude-sonnet-5-5')).toBe(false)
  })

  it('每个退役条目带下线日期，迁移建议只在有替代家族时提供', () => {
    for (const entry of MODEL_RETIREMENTS) {
      expect(entry.retireAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(retirementForModel(entry.familyId)?.familyId).toBe(entry.familyId)
    }
    const argon = retirementForModel('gemini-4-argon')
    expect(argon?.migrationFamily).toBe('gemini-4-hydrogen')
    const gptOss = retirementForModel('gpt-oss-120b')
    expect(gptOss?.migrationFamily).toBeUndefined()
  })
})
