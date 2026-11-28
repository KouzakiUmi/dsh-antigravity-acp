/** Pure catalog rules, also bundled into the standalone settings client. */
function bareModelId(id: string): string {
  return id.trim().toLowerCase().replace(/^(?:(?:publishers\/[^/]+\/)?models\/)?(?:aistudio-|vertex-ai-|antigravity-)?/u, '')
}

const NON_CHAT_FAMILY = /^(?:imagen|veo|lyria|chirp)(?=[\d.-]|$)|^(?:nano-banana|aqa)(?=[.-]|$)/u
const NON_CHAT_PART = /(?:^|[-.])(?:embed|embeddings?|image|images|imagegen|tts|speech|audio|music|video|live|realtime|robotics|computer-use|vision-generation)(?:[-.]|$)/u

/** Match known dedicated modalities, not words in display names or multimodal text input. */
export function isNonChatModel(id: string): boolean {
  const model = bareModelId(id)
  return NON_CHAT_FAMILY.test(model) || NON_CHAT_PART.test(model)
}

function geminiMajor(id: string): number | undefined {
  const match = /^gemini-(\d+)(?=[.-]|$)/u.exec(bareModelId(id))
  return match === null ? undefined : Number(match[1])
}

export function isGemini4Model(id: string): boolean {
  return geminiMajor(id) === 4
}

/** UI version marker; official shutdowns are tracked separately per route. */
export function isLegacyModel(id: string): boolean {
  const major = geminiMajor(id)
  const model = bareModelId(id)
  return (major !== undefined && major >= 1 && major < 4)
    || /^gemini-(?:pro(?:-vision)?|ultra)(?:-00\d)?$/u.test(model)
    || /(?:^|[-.])(?:legacy|deprecated)(?:[-.]|$)/u.test(model)
}

export function defaultChatModelEnabled(id: string): boolean {
  if (isNonChatModel(id) || isLegacyModel(id)) return false
  return !/^(?:aistudio|vertex-ai)-/u.test(id) || isGemini4Model(id)
}

/** Keep real upstream labels, but replace raw Gemini IDs and normalize obvious formatting. */
export function catalogDisplayName(id: string, fallback?: string): string {
  const label = fallback?.trim()
  const model = bareModelId(id)
  if (!/^gemini-[a-z\d]/u.test(model)) return label || id
  const words = model.slice('gemini-'.length).replace(/^(\d+)-(\d)(?=-[a-z]|$)/u, '$1.$2').split('-')
  const pretty = `Gemini ${words.map(word => word.length === 0 ? word : word === 'exp' ? 'Experimental' : word[0]!.toUpperCase() + word.slice(1)).join(' ').replace(/Flash Lite/u, 'Flash-Lite')}`
  if (!label || bareModelId(label) === model) return pretty
  // Do not infer model versions or rename explicit branded labels.
  return label.replace(/^gemini(?=\s)/iu, 'Gemini').replace(/\bflash[ -]lite\b/iu, 'Flash-Lite')
    .replace(/\b(hydrogen|neon|argon)\b/giu, word => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
}
