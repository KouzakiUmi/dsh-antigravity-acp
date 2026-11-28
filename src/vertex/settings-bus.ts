import type { ModelOverride } from '../settings.js'

export interface VertexSettingsBus {
  enabled(): boolean
  project(): string
  location(): string
  models(): readonly string[]
  modelSettings(): { modelOverrides?: Record<string, ModelOverride> }
  proxySettings(): { proxyUrl?: string; proxyBypass?: string }
  subscribe(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    antigravityVertexSettings: VertexSettingsBus
  }
}
