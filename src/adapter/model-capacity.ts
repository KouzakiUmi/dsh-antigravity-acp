/**
 * ACP 模型上下文容量的审计回退（issue #17）。
 *
 * 宿主压缩引擎（dsh-compaction-basic）在路由没有 context 容量时，模型切换与
 * 溢出恢复路径直接报错；而 ACP 容量只来自 `usage_update.size` 实测，首次观测
 * 前（或官方进程不报告 size 时）路由没有容量。这里提供**有明确来源**的审计
 * 参考值，让压缩引擎在实测之前也能量化上下文：
 *
 * - auth-core 原生模型快照（`AGY_NATIVE_MODEL_DEFINITIONS`，与代理模式审计
 *   同源）覆盖的家族，取其 maxTokens；
 * - 快照未覆盖的 Neon / Hydrogen，用本包登记的上游实测记录（2026-11-19 真实
 *   账户目录，八档均 maxTokens=1048576，见 docs/development.md「图片和上下文
 *   端到端」）。这是这两个家族自己的观测值，不是借用其他家族的容量。
 *
 * 边界：实测值（usage_update.size / 磁盘缓存）永远优先于审计值；审计值不落盘、
 * 不参与目录观测，也不进入磁盘缓存。未知家族仍返回 undefined，绝不填猜测值。
 */
import { AGY_NATIVE_MODEL_DEFINITIONS } from '@cortexkit/antigravity-auth-core'
import { modelFamilyId } from '../runtime/agy-cli.js'

/** auth-core 快照未覆盖的家族；值是上游目录实测记录，不是猜测。 */
const REGISTERED_AUDIT_CONTEXT: Readonly<Record<string, number>> = {
  'gemini-4-neon': 1_048_576,
  'gemini-4-hydrogen': 1_048_576,
}

function buildFamilyContext(): ReadonlyMap<string, number> {
  const map = new Map<string, number>()
  for (const [id, definition] of Object.entries(AGY_NATIVE_MODEL_DEFINITIONS)) {
    const size = definition.maxTokens
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) continue
    const family = modelFamilyId(id)
    if (!map.has(family)) map.set(family, size)
  }
  for (const [family, size] of Object.entries(REGISTERED_AUDIT_CONTEXT)) map.set(family, size)
  return map
}

const FAMILY_CONTEXT = buildFamilyContext()

/** 该路由键（家族或档位 ID）的审计参考容量；未知家族返回 undefined。 */
export function auditedAcpContextWindow(modelId: string): number | undefined {
  return FAMILY_CONTEXT.get(modelFamilyId(modelId))
}
