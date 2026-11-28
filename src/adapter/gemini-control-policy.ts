export const GEMINI_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type GeminiLevel = typeof GEMINI_LEVELS[number]

/** Exact public model families; aliases with unknown capabilities do not advertise extra controls. */
export function geminiControlSpec(wireModel: string, surface: 'developer' | 'vertex-v1' = 'developer') {
  const name = wireModel.replace(/^models\//, '').toLowerCase()
  const gemini4 = { contextWindow: 1_048_576, maxOutputTokens: 65_536, temperature: false }
  if (name === 'gemini-4-hydrogen' || name === 'gemini-4-neon') {
    return { ...gemini4, efforts: (surface === 'vertex-v1' ? ['low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh']) as readonly GeminiLevel[], defaultEffort: 'high' as const }
  }
  if (name === 'gemini-4-argon') {
    return { ...gemini4, efforts: ['low', 'medium', 'high'] as readonly GeminiLevel[], defaultEffort: 'medium' as const }
  }
  if (surface === 'vertex-v1' && name === 'gemini-3.5-flash-lite') {
    return { contextWindow: 1_048_576, maxOutputTokens: 65_536,
      efforts: [] as readonly GeminiLevel[], defaultEffort: undefined, temperature: false }
  }
  if (surface === 'developer') {
    const levels = new Map<string, readonly [readonly GeminiLevel[], GeminiLevel]>([
      ['gemini-3.8-flash', [['low', 'medium', 'high'], 'medium']],
      ['gemini-3.6-flash', [['minimal', 'low', 'medium', 'high'], 'medium']],
      ['gemini-3.5-flash-lite', [['minimal', 'low', 'medium', 'high'], 'minimal']],
      ['gemini-3.1-pro-preview', [['low', 'medium', 'high'], 'high']],
      ['gemini-3-flash-preview', [['minimal', 'low', 'medium', 'high'], 'high']],
      ['gemini-3-pro-preview', [['low', 'high'], 'high']],
    ]).get(name)
    if (levels !== undefined) return { contextWindow: undefined, maxOutputTokens: undefined,
      efforts: levels[0], defaultEffort: levels[1], temperature: false }
  }
  return { contextWindow: undefined, maxOutputTokens: undefined,
    efforts: [] as readonly GeminiLevel[], defaultEffort: undefined, temperature: /^gemini-(?:1\.[05]|2\.[05])-/u.test(name) }
}
