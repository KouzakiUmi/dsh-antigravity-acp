/**
 * 功能挂载实现表：id → mount 函数。
 *
 * 与 specs.ts 的 FEATURE_SPECS 双向对齐；缺实现或多余实现都在加载期抛错。
 */
import type { FeatureMount } from './types.js'
import { mountImageGen } from './image-gen/index.js'

export const FEATURE_MOUNTS: Record<string, FeatureMount> = {
  'image-gen': mountImageGen,
}
