/**
 * 功能模块注册表：规格表 + 实现表 + 加载期双向校验 + 动态挂载。
 *
 * 单一真源规则（与 dsh-unified-router pack-registry 同口径）：
 * - {@link FEATURE_SPECS} 登记「有哪些功能、默认开不开、兼容什么模式」；
 * - {@link FEATURE_MOUNTS} 登记「每个功能怎么挂载」；
 * - 两者不一致在加载期直接抛错，不让用户点开关时才发现静默失效。
 *
 * 本文件只放纯逻辑（不 import cordis / dsh-llm），可独立单测；运行时装配见
 * `feature-runtime.ts`。
 */
import type { FeatureContext, FeatureEndpoints, FeatureEntry, FeatureMode, FeatureMount, FeatureSpec } from './types.js'

/** 允许功能模块声明端点的安全域：只接受 https 且 host 属于已知 Google 域。 */
const ALLOWED_ENDPOINT_HOST_SUFFIXES = ['.googleapis.com', '.google.com']

/**
 * 校验功能声明的端点是否在安全域内。
 * 只允许 https；host 必须以已知 Google 后缀结尾。骨架阶段 wire-identity 暂不消费，
 * 但校验在挂载时执行，拒绝越界声明。
 */
export function validateFeatureEndpoints(endpoints: FeatureEndpoints | undefined): string[] {
  const errors: string[] = []
  if (!endpoints) return errors
  for (const origin of endpoints.origins ?? []) {
    let parsed: URL
    try { parsed = new URL(origin) } catch { errors.push(`无效 origin：${origin}`); continue }
    if (parsed.protocol !== 'https:') errors.push(`origin 必须为 https：${origin}`)
    else if (!ALLOWED_ENDPOINT_HOST_SUFFIXES.some((suffix) => parsed.hostname === suffix.slice(1) || parsed.hostname.endsWith(suffix))) {
      errors.push(`origin 不在允许的 Google 域内：${origin}`)
    }
  }
  for (const path of endpoints.paths ?? []) {
    if (!path.startsWith('/')) errors.push(`path 必须以 / 开头：${path}`)
  }
  return errors
}

/**
 * 加载期双向校验：把规格表与实现表对齐成已登记条目。
 * - 规格里有、实现表里没有 → 抛错（「有规格没实现」）；
 * - 实现表里有、规格里没有 → 抛错（「有实现没规格」）；
 * - 重复 id → 抛错。
 * experimental 或未就绪的规格仍需一个 mount（至少是空壳），以保证开关联动可验证。
 */
export function resolveFeatureEntries(
  specs: readonly FeatureSpec[],
  mounts: Record<string, FeatureMount>,
): readonly FeatureEntry[] {
  const seen = new Set<string>()
  for (const spec of specs) {
    if (seen.has(spec.id)) throw new Error(`功能规格重复 id：${spec.id}`)
    seen.add(spec.id)
    if (!spec.compatibleModes.length) throw new Error(`功能 ${spec.id} 未声明 compatibleModes`)
    const endpointErrors = validateFeatureEndpoints(spec.endpoints)
    if (endpointErrors.length) throw new Error(`功能 ${spec.id} 端点校验失败：${endpointErrors.join('；')}`)
  }
  const specIds = new Set(specs.map((s) => s.id))
  const mountIds = Object.keys(mounts)
  const missingMounts = specs.filter((s) => !(s.id in mounts)).map((s) => s.id)
  if (missingMounts.length) throw new Error(`功能规格登记了但缺少挂载实现：${missingMounts.join('、')}`)
  const orphanMounts = mountIds.filter((id) => !specIds.has(id))
  if (orphanMounts.length) throw new Error(`挂载实现登记了规格表之外的功能：${orphanMounts.join('、')}`)
  // 上面 missingMounts 已保证每个 spec.id 都在 mounts 里，此处非空。
  return specs.map((spec) => ({ spec, mount: mounts[spec.id] as FeatureMount }))
}

/**
 * 运行时注册表实例：按开关与当前模式决定哪些功能挂载，幂等同步。
 *
 * 与宿主解耦：不直接读配置，调用方（feature-runtime）传入「当前应启用的功能 id 集合」
 * 与「当前生成模式」，registry 只负责 mount/unmount 的差量同步。
 */
export interface FeatureRegistry {
  /** 当前已挂载的功能 id（只读视图）。 */
  mounted(): readonly string[]
  /**
   * 差量同步：want 是应启用的 id 集合；mode 过滤掉不兼容的功能。返回本轮变化。
   * `force` 为 true 时先卸载所有已挂载功能再按 desired 重新挂载，用于宿主能力
   * （tools / attachments）后到导致首次挂载降级、能力就绪后需要补挂的场景。
   */
  sync(want: ReadonlySet<string>, mode: FeatureMode, force?: boolean): { mounted: string[]; unmounted: string[] }
  /** 卸载全部功能（宿主 dispose 时调用）。 */
  dispose(): Promise<void>
}

export interface FeatureRegistryOptions {
  readonly entries: readonly FeatureEntry[]
  readonly buildContext: (spec: FeatureSpec) => FeatureContext
}

export function createFeatureRegistry(options: FeatureRegistryOptions): FeatureRegistry {
  const handles = new Map<string, ReturnType<FeatureMount>>()
  const entriesById = new Map(options.entries.map((entry) => [entry.spec.id, entry]))
  const mounted = (): string[] => [...handles.keys()]

  const sync = (want: ReadonlySet<string>, mode: FeatureMode, force = false): { mounted: string[]; unmounted: string[] } => {
    const mountedNow: string[] = []
    const unmountedNow: string[] = []
    const desired = new Set<string>()
    for (const entry of options.entries) {
      if (want.has(entry.spec.id) && entry.spec.compatibleModes.includes(mode)) desired.add(entry.spec.id)
    }
    // 卸载不再需要的；force 时全部先卸载（能力就绪后补挂）。
    for (const [id, handle] of [...handles]) {
      if (!desired.has(id) || force) {
        try { void Promise.resolve(handle?.unmount?.()).catch(() => {}) } catch { /* unmount 不能阻断注册表同步 */ }
        handles.delete(id)
        unmountedNow.push(id)
      }
    }
    // 挂载新启用的（force 卸载后这些会重新进入）。
    for (const id of desired) {
      if (handles.has(id)) continue
      const entry = entriesById.get(id)
      if (!entry) continue
      let handle: ReturnType<FeatureMount>
      try {
        handle = entry.mount(options.buildContext(entry.spec))
      } catch {
        // mount 抛错不影响其他功能与宿主装载；失败在 log 里留痕，不进 handles。
        continue
      }
      handles.set(id, handle)
      mountedNow.push(id)
    }
    return { mounted: mountedNow, unmounted: unmountedNow }
  }

  const dispose = async (): Promise<void> => {
    const pending: (void | Promise<void>)[] = []
    for (const handle of handles.values()) pending.push(handle?.unmount?.())
    handles.clear()
    await Promise.all(pending)
  }

  return { mounted, sync, dispose }
}
