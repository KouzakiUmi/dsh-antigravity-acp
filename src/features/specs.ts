/**
 * 功能规格表：登记全部附属功能，按声明顺序出现在设置页。
 *
 * 新增功能 = 在这里加一条 {@link FeatureSpec} + 在 mounts.ts 登记 mount 实现。
 * 两处不一致会在加载期抛错（resolveFeatureEntries 双向校验）。
 *
 * 实验性 / 待探针验证的功能（如 video-gen）也应在此登记，但 mount 可以是空壳，
 * 设置页展示「实验性」徽章，用户仍可提前开关而不会因缺实现而崩溃。
 */
import type { FeatureSpec } from './types.js'
import { IMAGE_GEN_SPEC } from './image-gen/index.js'

export const FEATURE_SPECS: readonly FeatureSpec[] = [
  IMAGE_GEN_SPEC,
] as const

/** 全部功能 id；供设置页渲染开关与 Config 默认值派生。 */
export const FEATURE_IDS: readonly string[] = FEATURE_SPECS.map((spec) => spec.id)
