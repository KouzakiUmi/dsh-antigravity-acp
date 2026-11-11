/** 上游指纹诊断：只统计规则与次数，不回显原文，也不改写请求。 */
import { describe, expect, it } from 'vitest'
import { UPSTREAM_FINGERPRINTS, cloakUpstreamFingerprints, describeFingerprintHits, scanUpstreamFingerprints } from '../src/proxy/prompt-guard.js'

describe('上游指纹诊断', () => {
  it('空值与无命中都返回空数组', () => {
    expect(scanUpstreamFingerprints(undefined)).toEqual([])
    expect(scanUpstreamFingerprints('')).toEqual([])
    expect(scanUpstreamFingerprints('你是一个编码助手。')).toEqual([])
  })

  it('大小写不敏感并按出现次数计数', () => {
    const hits = scanUpstreamFingerprints('CLAUDE CODE ... claude code ... Claude Code')
    expect(hits).toEqual([{ ruleId: 'claude-code', count: 3 }])
  })

  it('计费行与身份句各自成一条规则', () => {
    const hits = scanUpstreamFingerprints('x-anthropic-billing-header: cc_version=1;\nYou are Claude Code, Anthropic\'s official CLI for Claude.')
    const ids = hits.map((hit) => hit.ruleId)
    expect(ids).toContain('anthropic-billing-header')
    expect(ids).toContain('claude-code-identity')
  })

  it('返回值只含规则 id 与次数，不回显命中原文', () => {
    const hits = scanUpstreamFingerprints('RFC 2119 要求……')
    expect(hits).toEqual([{ ruleId: 'rfc-2119', count: 1 }])
    expect(JSON.stringify(hits)).not.toContain('2119 要求')
  })

  it('日志片段只拼接规则 id 与次数', () => {
    expect(describeFingerprintHits([{ ruleId: 'claude-code', count: 2 }])).toBe('claude-code×2')
  })

  it('词表项都有 ruleId 与 phrase', () => {
    for (const rule of UPSTREAM_FINGERPRINTS) {
      expect(rule.ruleId.length).toBeGreaterThan(0)
      expect(rule.phrase.length).toBeGreaterThan(0)
    }
  })
})

describe('上游指纹打散（cloak）', () => {
  it('照 magpie 的实测用例：计费行与身份句逐段插入零宽空格', () => {
    const system = 'x-anthropic-billing-header: cc_version=2.1.316.2e4; cc_entrypoint=sdk-cli;\nYou are a Claude agent, built on Anthropic\'s Claude Agent SDK.\n'
    const { text, hits } = cloakUpstreamFingerprints(system)
    const want = 'x-a\u200bn\u200bthropic-b\u200bi\u200blling-h\u200be\u200bader: cc_version=2.1.316.2e4; cc_entrypoint=sdk-cli;\nYou are a Claude agent, b\u200bu\u200bilt on A\u200bn\u200bthropic\'s C\u200bl\u200baude A\u200bg\u200bent S\u200bD\u200bK.\n'
    expect(text).toBe(want)
    expect(hits.map((hit) => hit.ruleId)).toEqual(['anthropic-billing-header', 'claude-agent-sdk-identity'])
  })

  it('大小写不敏感，且去零宽后能还原原文', () => {
    const { text } = cloakUpstreamFingerprints('YOU ARE CODEX, AN AGENT BASED ON GPT-5')
    expect(text).not.toBe('YOU ARE CODEX, AN AGENT BASED ON GPT-5')
    expect(text.replaceAll('\u200b', '')).toBe('YOU ARE CODEX, AN AGENT BASED ON GPT-5')
  })

  it('没有命中时原文逐字不动', () => {
    const { text, hits } = cloakUpstreamFingerprints('你是一个编码助手。')
    expect(text).toBe('你是一个编码助手。')
    expect(hits).toEqual([])
  })
})

describe('打散在大小写长度变化文本上的位置正确性', () => {
  it('前缀含 toLowerCase 会变长的字符时，命中断仍被正确打散', () => {
    // 'İ'.toLowerCase() 在 JS 里是两个 code unit；用降级串下标切原串会整体错位。
    const prefix = 'İ'.repeat(26)
    const system = `${prefix}x-anthropic-billing-header: cc_version=1;`
    const { text, hits } = cloakUpstreamFingerprints(system)
    expect(hits.map((hit) => hit.ruleId)).toEqual(['anthropic-billing-header'])
    expect(text.startsWith(prefix)).toBe(true)
    expect(text.slice(prefix.length)).toBe('x-a\u200bn\u200bthropic-b\u200bi\u200blling-h\u200be\u200bader: cc_version=1;')
  })

  it('对已打散的文本再跑一次不再产生命中（幂等）', () => {
    const once = cloakUpstreamFingerprints("You are Codex, an agent based on GPT-5.")
    const twice = cloakUpstreamFingerprints(once.text)
    expect(twice.hits).toEqual([])
    expect(twice.text).toBe(once.text)
  })

  it('去零宽后逐字还原原文', () => {
    const original = 'x-anthropic-billing-header: cc_version=2;\nYou are Codex, an agent based on GPT-5.'
    const { text } = cloakUpstreamFingerprints(original)
    expect(text.replaceAll('\u200b', '')).toBe(original)
  })
})
