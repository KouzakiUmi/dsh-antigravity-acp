import { describe, expect, it } from 'vitest'
import { catalogDisplayName, defaultChatModelEnabled, isGemini4Model, isLegacyModel, isNonChatModel } from '../src/adapter/model-catalog-policy.js'

describe('shared chat catalog policy', () => {
  it.each(['gemini-4-flash-image-preview', 'vertex-ai-gemini-4-native-audio', 'aistudio-gemini-embedding-001', 'imagen4-ultra', 'veo3', 'nano-banana-pro-preview', 'publishers/google/models/gemini-4-tts'])('filters dedicated modality %s', id => {
    expect(isNonChatModel(id)).toBe(true)
    expect(defaultChatModelEnabled(id)).toBe(false)
  })

  it.each(['gemini-4-hydrogen', 'gemini-4.1-neon-preview', 'gemini-1.5-pro-vision', 'claude-opus-5-5', 'gemini-4-deliver-preview'])('keeps a recognized or potential chat model %s', id => {
    expect(isNonChatModel(id)).toBe(false)
  })

  it('keeps generation defaults separate from official retirement and aliases', () => {
    expect(isLegacyModel('vertex-ai-gemini-3.5-flash-lite')).toBe(true)
    expect(isLegacyModel('gemini-pro-vision')).toBe(true)
    expect(isLegacyModel('gemini-flash-latest')).toBe(false)
    expect(isGemini4Model('aistudio-gemini-40-test')).toBe(false)
    expect(isGemini4Model('aistudio-gemini-4o-test')).toBe(false)
    expect(defaultChatModelEnabled('aistudio-gemini-4.1-test')).toBe(true)
    expect(defaultChatModelEnabled('vertex-ai-gemini-5-preview')).toBe(false)
    expect(defaultChatModelEnabled('antigravity-gemini-3.8-flash')).toBe(false)
    expect(defaultChatModelEnabled('antigravity-claude-opus-5-5')).toBe(true)
  })

  it('formats raw Gemini IDs and keeps observed brand names intact', () => {
    expect(catalogDisplayName('vertex-ai-gemini-3.5-flash-lite-preview')).toBe('Gemini 3.5 Flash-Lite Preview')
    expect(catalogDisplayName('gemini-4-hydrogen', 'gemini 4 HYDROGEN')).toBe('Gemini 4 Hydrogen')
    expect(catalogDisplayName('gemini-4-neon', 'Gemini Neon Canary')).toBe('Gemini Neon Canary')
    expect(catalogDisplayName('antigravity-claude-opus-5-5', 'Claude Opus 5.5')).toBe('Claude Opus 5.5')
  })
})
