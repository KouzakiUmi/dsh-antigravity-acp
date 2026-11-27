import { describe, expect, it } from 'vitest'
import { parseAistudioModels } from '../src/aistudio/discovery.js'
import { aistudioCatalogId, aistudioDefaultEnabled, aistudioModelSegment, aistudioStreamUrl, aistudioWireModel } from '../src/aistudio/endpoints.js'

describe('AI Studio 模型发现', () => {
  it('过滤 generateContent，取容量，剥 models/ 前缀并加 aistudio- 目录键', () => {
    const page = parseAistudioModels({
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] },
      ],
    })
    expect(page.models).toHaveLength(1)
    expect(page.models[0]!).toMatchObject({
      wireModel: 'gemini-2.5-flash',
      catalogId: 'aistudio-gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      contextWindow: 1048576,
      maxOutputTokens: 65536,
    })
  })

  it('过滤 TTS / 音乐 / 视频 / 实时音频等非聊天模态（即使声明 generateContent）', () => {
    const page = parseAistudioModels({
      models: [
        { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/lyria-realtime-exp', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/veo-3.0-generate-001', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-native-audio', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.0-flash-live-001', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3-pro-preview', supportedGenerationMethods: ['generateContent'] },
      ],
    })
    expect(page.models.map(model => model.wireModel)).toEqual(['gemini-3-pro-preview'])
  })

  it('缺 displayName 时格式化线模型名，缺容量省略字段', () => {
    const page = parseAistudioModels({ models: [{ name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] }] })
    expect(page.models[0]!).toMatchObject({ wireModel: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' })
    expect(page.models[0]!.contextWindow).toBeUndefined()
    expect(page.models[0]!.maxOutputTokens).toBeUndefined()
  })

  it('按线模型去重，非法形状返回空页', () => {
    const page = parseAistudioModels({
      models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { supportedGenerationMethods: ['generateContent'] },
        null,
      ],
    })
    expect(page.models).toHaveLength(1)
    expect(parseAistudioModels(null).models).toEqual([])
    expect(parseAistudioModels({ models: 'nope' }).models).toEqual([])
  })

  it('允许带图片输入的文本模型，剔除明确无文本输出的模型', () => {
    const methods = ['generateContent']
    const page = parseAistudioModels({ models: [
      { name: 'models/gemini-4-fixture', supportedGenerationMethods: methods, inputModalities: ['IMAGE', 'TEXT'], outputModalities: ['TEXT'] },
      { name: 'models/gemini-4-special', supportedGenerationMethods: methods, outputModalities: ['IMAGE'] },
    ] })
    expect(page.models.map(row => row.wireModel)).toEqual(['gemini-4-fixture'])
    expect(page.nonChatIds).toEqual(['gemini-4-special'])
  })

  it('保留 nextPageToken 供翻页', () => {
    const page = parseAistudioModels({ models: [], nextPageToken: 'abc' })
    expect(page.nextPageToken).toBe('abc')
    expect(parseAistudioModels({ models: [] }).nextPageToken).toBeUndefined()
  })
})

describe('AI Studio 端点与 ID 约定', () => {
  it('目录键与线模型互转', () => {
    expect(aistudioCatalogId('gemini-2.5-flash')).toBe('aistudio-gemini-2.5-flash')
    expect(aistudioWireModel('aistudio-gemini-2.5-flash')).toBe('gemini-2.5-flash')
    expect(aistudioWireModel('gemini-2.5-flash')).toBe('gemini-2.5-flash')
  })

  it('默认启用仅 Gemini 4 系（只开 4，其他默认关闭）', () => {
    expect(aistudioDefaultEnabled('aistudio-gemini-4-argon')).toBe(true)
    expect(aistudioDefaultEnabled('aistudio-gemini-4.5-flash')).toBe(true)
    expect(aistudioDefaultEnabled('gemini-4-hydrogen')).toBe(true)
    expect(aistudioDefaultEnabled('gemini-4-live')).toBe(false)
    expect(aistudioDefaultEnabled('aistudio-gemini-5-pro')).toBe(false)
    expect(aistudioDefaultEnabled('aistudio-gemini-3.8-flash')).toBe(false)
    expect(aistudioDefaultEnabled('aistudio-gemini-2.5-flash')).toBe(false)
    expect(aistudioDefaultEnabled('aistudio-gemini-1.5-pro')).toBe(false)
    expect(aistudioDefaultEnabled('aistudio-gemma-3-27b-it')).toBe(false)
  })

  it('模型段剥 models/ 前缀并逐段编码', () => {
    expect(aistudioModelSegment('models/gemini-2.5-flash')).toBe('gemini-2.5-flash')
    expect(aistudioModelSegment('gemini-2.5-flash')).toBe('gemini-2.5-flash')
    expect(aistudioModelSegment('tunedModels/my model')).toBe('tunedModels/my%20model')
  })

  it('流式 URL 不含 key（鉴权经请求头）', () => {
    const url = aistudioStreamUrl('gemini-2.5-flash')
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
    expect(url).not.toContain('key=')
  })
})
