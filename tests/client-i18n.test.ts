import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { buildClientSource } from '../scripts/client-bundle.mjs'

const source = buildClientSource()
const CJK = /[\u4e00-\u9fff]/

/** 抽出非注释行里含中文的单引号字面量：它们都是要翻译的界面文案。 */
function literals(text: string): string[] {
  const found = new Set<string>()
  for (const line of text.split('\n')) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
    for (const match of line.replace(/\/\*.*?\*\//g, '').matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
      if (CJK.test(match[1]!)) found.add(match[1]!)
    }
  }
  return [...found]
}

/** 只跑 i18n 内核：以给定语言环境求值，返回 t 与字典。 */
function kernel(navigator?: { language: string }, document?: { documentElement: { lang: string } }) {
  const start = source.indexOf('const EN_UI')
  const end = source.indexOf('function t(')
  const tail = source.indexOf('\n}\n', end) + 3
  return runInNewContext(`${source.slice(start, tail)}\n({ t, EN_MESSAGES })`, { navigator, document }) as {
    t: (source: unknown, params?: Record<string, unknown>) => unknown
    EN_MESSAGES: Record<string, string>
  }
}

describe('client i18n', () => {
  const { EN_MESSAGES } = kernel()
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()

  it('每条中文界面文案都有英文翻译（console 日志除外）', () => {
    const missing = literals(source.slice(source.indexOf('/* @include'))).filter((text) => !(text in EN_MESSAGES) && !text.startsWith('[dsh-bundle'))
    expect(missing).toEqual([])
  })

  it('译文与原文的占位符一致', () => {
    for (const [key, value] of Object.entries(EN_MESSAGES)) expect(placeholders(value), key).toEqual(placeholders(key))
  })

  it('中文环境与无语言信息时原样输出，英文环境翻译并代入参数，未登记文本透传', () => {
    expect(kernel().t('保存')).toBe('保存')
    expect(kernel({ language: 'zh-TW' }).t('保存')).toBe('保存')
    const en = kernel({ language: 'en-US' })
    expect(en.t('保存')).toBe('Save')
    expect(en.t('{count} 项', { count: 3 })).toBe('3 items')
    expect(en.t('字典里没有的 Host 文本')).toBe('字典里没有的 Host 文本')
    expect(kernel({ language: 'zh-CN' }).t('{count} 项', { count: 3 })).toBe('3 项')
    expect(kernel({ language: 'en-US' }, { documentElement: { lang: 'zh-CN' } }).t('保存')).toBe('保存')
  })
})
