/**
 * 官方公告即将下线的模型家族（纯数据 + 纯函数，无 IO）。
 *
 * 口径（2026-11-26 官方 Antigravity 模型菜单与文档截图核实）：
 * - Gemini 4 Argon、Gemini 3.8 Flash 标注 Leaving Soon，2026-11-30 下线，
 *   官方迁移建议为 Gemini 4 Hydrogen；
 * - GPT-OSS 120B 标注 Notice，官方文档下线日 2026-11-18（已过期，菜单仍列出）。
 *
 * 退役家族在选择器中**默认关闭**（见 model-settings.ts 的 modelSettingFor），
 * 但不做硬排除：目录观测、家族折叠与用户显式启用仍然保留，重新上线或用户
 * 手动打开时无需改代码。client 内置同一份表用于设置页徽章，两侧一致性由测试锁定。
 */
export interface ModelRetirement {
  /** 家族 ID（不带 antigravity- 前缀与档位后缀）。 */
  readonly familyId: string
  /** 官方下线日期（YYYY-MM-DD）。 */
  readonly retireAt: string
  /** 官方迁移建议家族；无对应替代时省略。 */
  readonly migrationFamily?: string
}

export const MODEL_RETIREMENTS: readonly ModelRetirement[] = [
  { familyId: 'gemini-4-argon', retireAt: '2026-11-30', migrationFamily: 'gemini-4-hydrogen' },
  { familyId: 'gemini-3.8-flash', retireAt: '2026-11-30', migrationFamily: 'gemini-4-hydrogen' },
  { familyId: 'gpt-oss-120b', retireAt: '2026-11-18' },
]

const RETIREMENT_BY_FAMILY = new Map<string, ModelRetirement>(
  MODEL_RETIREMENTS.map((entry) => [entry.familyId, entry]),
)

// minimal 是防御性后缀（官方 Antigravity 目前没有该档位 ID）：本函数只做家族键
// 归一，不产出档位；与 agy-cli.ts 的 tierForModelId 不同，后者的后缀受 AgyModelTier
// 类型约束并参与路由，不能随意放宽，两处名单刻意不对称。
const TIER_SUFFIX = /-(?:low|medium|high|xhigh|minimal)$/u

/** 归一到家族 ID：去 antigravity- 前缀与档位后缀。 */
export function retirementFamilyKey(id: string): string {
  return id.trim().replace(/^antigravity-/u, '').replace(TIER_SUFFIX, '')
}

/** 该 ID（家族或档位 ID）是否属于退役家族。 */
export function isRetiringModel(id: string): boolean {
  return RETIREMENT_BY_FAMILY.has(retirementFamilyKey(id))
}

/** 取退役信息；非退役家族返回 undefined。 */
export function retirementForModel(id: string): ModelRetirement | undefined {
  return RETIREMENT_BY_FAMILY.get(retirementFamilyKey(id))
}
