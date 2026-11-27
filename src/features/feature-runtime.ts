/**
 * 功能模块的运行时装配：把 {@link FeatureRegistry} 接进宿主生命周期。
 *
 * 职责（与 proxyMode 的动态切换同机制）：
 * - 加载期 resolveFeatureEntries 做规格/实现双向校验（不一致直接抛错，阻断装载）；
 * - 按 Config.features 开关 + 当前生成模式差量 mount/unmount；
 * - 订阅 modeBus（模式变化）与 loader/volatile-update 的 features（开关变化）即时同步；
 * - 宿主 dispose 时卸载全部功能。
 *
 * 本模块只做装配，不碰核心生成链路；每个功能经注入的 FeatureContext 拿到宿主能力。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createFeatureRegistry, resolveFeatureEntries, validateFeatureEndpoints } from './registry.js'
import type { FeatureRegistry } from './registry.js'
import type { FeatureAttachmentStore, FeatureContext, FeatureMode, FeatureSpec, FeatureTransport } from './types.js'
import { FEATURE_MOUNTS } from './mounts.js'
import { FEATURE_SPECS } from './specs.js'
import type { ProxyModeBus } from '../proxy/mode-bus.js'

export interface FeatureRuntimeOptions {
  readonly ctx: Context
  /** 读取当前 features 开关字典（live config 的 getter）。 */
  readonly readFeatures: () => Record<string, boolean> | undefined
  /** 模式总线。 */
  readonly modeBus: Pick<ProxyModeBus, 'current' | 'subscribe'>
  /** 代理感知 fetch。 */
  readonly fetch: typeof fetch
  /** 通知宿主刷新模型选择器目录。 */
  readonly catalogChanged: () => void
  /** 取代理账户凭据（仅代理模式）。 */
  readonly proxyCredential?: () => Promise<{ accessToken: string; projectId?: string } | undefined>
  /** 宿主附件服务的写入面（惰性 getter，服务后到或卸载都不需要重建）。 */
  readonly attachments?: () => FeatureAttachmentStore | undefined
  /** 宿主 tools 服务的工具注册（在场时可用）。 */
  readonly registerTool?: (definition: ToolDefinition) => (() => void) | undefined
  /** 代理线传输（仅代理模式在场）。 */
  readonly proxyTransport?: FeatureTransport
  /** 宿主附件服务读引用（可选）。 */
  readonly readImage?: (ref: unknown, signal?: AbortSignal) => Promise<unknown>
}

/**
 * 装配功能注册表。返回 dispose 与 resync；内部已订阅模式与开关变化。
 * 加载期若规格/实现不一致会抛错（调用方应让其阻断插件装载）。
 */
export function mountFeatureRuntime(options: FeatureRuntimeOptions): {
  dispose(): Promise<void>
  /** 手动触发一次差量同步；force 时先卸载再重挂（用于宿主能力后到补挂）。 */
  resync(force?: boolean): void
} {
  const { ctx, readFeatures, modeBus } = options
  // 加载期双向校验：这里抛错会阻断宿主行 apply，符合「加载期暴露而非静默失效」。
  const entries = resolveFeatureEntries(FEATURE_SPECS, FEATURE_MOUNTS)

  const buildContext = (_spec: FeatureSpec): FeatureContext => ({
    log: {
      info: (message) => ctx.logger?.info?.(message),
      warn: (message, error) => ctx.logger?.warn?.(`${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ''}`),
    },
    fetch: options.fetch,
    mode: () => (modeBus.current() ? 'proxy' : 'acp') as FeatureMode,
    catalogChanged: options.catalogChanged,
    declareEndpoints: (endpoints) => {
      // 复用 registry 的纯校验；端点白名单的实际消费在代理传输层（wire-identity）。
      return validateFeatureEndpoints(endpoints).length === 0
    },
    proxyCredential: options.proxyCredential,
    registerTool: options.registerTool,
    attachments: options.attachments,
    proxyTransport: options.proxyTransport,
    readImage: options.readImage,
    ctx,
  })

  const registry: FeatureRegistry = createFeatureRegistry({ entries, buildContext })

  const enabledSet = (): Set<string> => {
    const configured = readFeatures() ?? {}
    const want = new Set<string>()
    for (const spec of FEATURE_SPECS) {
      const value = configured[spec.id]
      const on = typeof value === 'boolean' ? value : spec.defaultEnabled
      if (on) want.add(spec.id)
    }
    return want
  }

  const resync = (force = false): void => {
    const mode: FeatureMode = modeBus.current() ? 'proxy' : 'acp'
    const result = registry.sync(enabledSet(), mode, force)
    if (result.mounted.length || result.unmounted.length) {
      ctx.logger?.info?.(
        `antigravity-features: 挂载 [${result.mounted.join(',') || '-'}]，卸载 [${result.unmounted.join(',') || '-'}]，当前模式 ${mode}`,
      )
      options.catalogChanged()
    }
  }

  resync()
  const offMode = modeBus.subscribe(() => resync())
  const offSettings = ctx.on('loader/volatile-update', (paths: string[][]) => {
    if (paths.some(([key]) => key === 'features')) resync()
  })

  return {
    resync,
    dispose: async () => {
      offMode()
      offSettings()
      await registry.dispose()
    },
  }
}
