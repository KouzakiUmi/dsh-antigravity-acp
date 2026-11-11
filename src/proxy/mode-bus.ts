/**
 * 代理模式控制总线：宿主行创建并 provide，代理行与额度监控消费。
 *
 * 单一事实源：`proxyMode` 的当前值只从宿主配置的 volatile 引用读取；
 * 订阅者（代理行注册、宿主行注销、额度源切换）各自幂等反应。
 * 请求代理模式就立即停用 ACP；代理路由是否就绪只影响代理自身，不得回退启动 ACP。
 */
export interface ProxyModeBus {
  /** 当前生成模式；与代理路由就绪状态无关。 */
  current(): boolean
  requested(): boolean
  routerReady(): boolean
  setRouterReady(ready: boolean): void
  /** 订阅模式变化；返回退订函数。 */
  subscribe(listener: (mode: boolean) => void): () => void
  /** 代理链路的出网代理设置（与官方进程同一套 proxyUrl / proxyBypass）。 */
  proxySettings(): { url?: string; bypass?: string }
  modelSettings?(): { modelOverrides?: import('../settings.js').AntigravityHostConfig['modelOverrides']; cloakSensitiveWords?: boolean }
}

export type GenerationMode = 'acp' | 'proxy'

export interface ModeRegistrationPlan {
  /** 官方 ACP 路由是否应在册。 */
  acp: boolean
  /** 代理路由是否应在册。 */
  proxy: boolean
}

/**
 * 模式 → 注册计划：只表达「理想计划」，**没有生产调用点**（宿主行与代理行各自
 * 用幂等的 sync 逻辑同步路由，见 `src/index.ts` 的 syncModeRoutes 与
 * `src/proxy/index.ts` 的 syncRegistration）。它供测试表达模式语义，改动两处
 * 同步逻辑时不要以它为准。
 */
export function registrationPlan(mode: GenerationMode): ModeRegistrationPlan {
  return mode === 'proxy' ? { acp: false, proxy: true } : { acp: true, proxy: false }
}

export function modeFromFlag(proxyMode: boolean | undefined): GenerationMode {
  return proxyMode === true ? 'proxy' : 'acp'
}

/** 创建一个进程内总线实现（宿主行与测试共用）。 */
export function createProxyModeBus(read: {
  mode(): boolean | undefined
  proxySettings(): { url?: string; bypass?: string }
  modelSettings?(): { modelOverrides?: import('../settings.js').AntigravityHostConfig['modelOverrides']; cloakSensitiveWords?: boolean }
}): ProxyModeBus & { notify(): void } {
  const listeners = new Set<(mode: boolean) => void>()
  let ready = false
  // 初值必须来自当前配置：宿主行挂载时按 current() 直接同步路由（不经过
  // notify），代理行缺席时也没人调用 setRouterReady 把 last 推上去。若 last
  // 恒为 false，「加载时就是代理模式」的配置下第一次关闭 proxyMode 会被判成
  // 「没有变化」而吞掉广播，ACP 路由永远不恢复。
  let last = read.mode() === true
  const notify = (): void => {
    const next = read.mode() === true
    if (next === last) return
    last = next
    for (const listener of [...listeners]) listener(next)
  }
  return {
    current: () => read.mode() === true,
    requested: () => read.mode() === true,
    routerReady: () => ready,
    setRouterReady(value) { ready = value; notify() },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    proxySettings: () => read.proxySettings(),
    modelSettings: () => read.modelSettings?.() ?? {},
    notify,
  }
}
