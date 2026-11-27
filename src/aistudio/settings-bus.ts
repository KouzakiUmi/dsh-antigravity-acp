/**
 * AI Studio 设置总线：宿主行创建并 provide，AI Studio 行消费。
 *
 * 与代理模式总线不同，AI Studio 是独立 provider（不参与 ACP / 代理互斥仲裁），
 * 总线只承载本路由的即时设置：开关、凭据引用名、模型设置与出网代理。
 * 开关或引用名变化都通知订阅者（前者决定注册，后者决定换 key 后刷新目录）。
 */
import type { AntigravityHostConfig } from '../settings.js'

export const AISTUDIO_DEFAULT_CREDENTIAL_REF = 'AISTUDIO_API_KEY'

export interface AistudioSettingsBus {
  enabled(): boolean
  credentialRef(): string
  modelSettings(): Pick<AntigravityHostConfig, 'modelOverrides'>
  proxySettings(): { url?: string; bypass?: string }
  /** 订阅开关或引用名变化；返回退订函数。 */
  subscribe(listener: () => void): () => void
}

/** 创建一个进程内总线实现（宿主行与测试共用）。 */
export function createAistudioSettingsBus(read: {
  enabled(): boolean | undefined
  credentialRef(): string | undefined
  modelSettings(): Pick<AntigravityHostConfig, 'modelOverrides'>
  proxySettings(): { url?: string; bypass?: string }
}): AistudioSettingsBus & { notify(): void } {
  const listeners = new Set<() => void>()
  const ref = (): string => {
    const value = read.credentialRef()?.trim()
    return value !== undefined && value.length > 0 ? value : AISTUDIO_DEFAULT_CREDENTIAL_REF
  }
  let lastEnabled = read.enabled() === true
  let lastRef = ref()
  const notify = (): void => {
    const nextEnabled = read.enabled() === true
    const nextRef = ref()
    if (nextEnabled === lastEnabled && nextRef === lastRef) return
    lastEnabled = nextEnabled
    lastRef = nextRef
    for (const listener of [...listeners]) listener()
  }
  return {
    enabled: () => read.enabled() === true,
    credentialRef: ref,
    modelSettings: () => read.modelSettings(),
    proxySettings: () => read.proxySettings(),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notify,
  }
}
