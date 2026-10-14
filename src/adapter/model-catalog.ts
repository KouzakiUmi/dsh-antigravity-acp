/**
 * ACP 会话配置 → DSH 模型目录的映射（原创实现）。
 *
 * ACP v1 把「选模型」表达为 `session/new` / `session/set_config_option`
 * 响应里的 `SessionConfigOption`（`@agentclientprotocol/sdk` 1.4.0 的
 * `dist/schema/types.gen.d.ts`），并提供 `category: "model"` 语义标签。
 * 注意：`InitializeResponse` **没有** configOptions 字段——目录只能在会话
 * 建立后才观测到（见 antigravity-adapter.ts 中 listModels 的说明）。
 *
 * 本模块只做纯函数：输入 configOptions 数组，输出 LlmModelInfo[] 与可选的
 * model 選択肢。没有任何 IO，便于在假 ACP agent 测试里直接断言。
 */
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { SessionConfigOption, SessionConfigSelect, SessionConfigSelectGroup, SessionConfigSelectOption } from '@agentclientprotocol/sdk'

/** 一个被识别为「模型选择器」的 select 配置项。 */
export interface ModelSelector {
  /** 设置该选项用的 configId（`session/set_config_option` 的 configId）。 */
  configId: string
  /** 选项的可选值，按 agent 声明顺序。 */
  options: readonly SessionConfigSelectOption[]
  /** 当前值（agent 声明的默认值），选项列表为空时可能为 undefined。 */
  currentValue?: string
}

function isSelect(option: SessionConfigOption): option is SessionConfigOption & SessionConfigSelect & { type: 'select' } {
  return option.type === 'select'
}

/**
 * 展平 ACP 的两层 options：既有扁平的 SessionConfigSelectOption[]，也有
 * 带分组的 SessionConfigSelectGroup[]；分组按声明顺序展开为值序列。
 */
export function flattenSelectOptions(
  options: SessionConfigSelect['options'],
): readonly SessionConfigSelectOption[] {
  if (!Array.isArray(options) || options.length === 0) return []
  const first = options[0] as SessionConfigSelectOption | SessionConfigSelectGroup | undefined
  if (!first) return []
  if ('group' in first) {
    const flattened: SessionConfigSelectOption[] = []
    for (const group of options as SessionConfigSelectGroup[]) {
      for (const option of group.options) flattened.push(option)
    }
    return flattened
  }
  return [...(options as SessionConfigSelectOption[])]
}

/**
 * 从 configOptions 中找出模型选择器。
 *
 * 判定顺序：显式 `category === "model"` 优先（ACP 规范为此保留了语义标签）；
 * 没有标签时退回「select 且 id/name 含 model」的启发式。都不匹配则返回
 * undefined——调用方据此走「无可选模型」的显式失败，而不是随便挑一个 select。
 */
export function findModelSelector(configOptions: readonly SessionConfigOption[] | null | undefined): ModelSelector | undefined {
  if (!configOptions?.length) return undefined
  const selects = configOptions.filter(isSelect)
  const tagged = selects.find((option) => option.category === 'model')
  const picked = tagged ?? selects.find((option) => /model/i.test(option.id) || /model/i.test(option.name))
  if (!picked) return undefined
  const selector: ModelSelector = {
    configId: picked.id,
    options: flattenSelectOptions(picked.options),
  }
  return picked.currentValue === undefined ? selector : { ...selector, currentValue: picked.currentValue }
}

/**
 * 把模型选择器的可选值映射为 DSH 模型目录。
 *
 * id 取 ACP 的 option value（随后作为 `GenerateOptions.model` 原样送回，
 * 并在 `session/set_config_option` 中作为该 configId 的取值），name 取
 * ACP 的 label；ACP 未提供描述时不编造描述。
 */
export function toModelCatalog(provider: string, selector: ModelSelector | undefined): LlmModelInfo[] {
  if (!selector) return []
  return selector.options.map((option) => {
    const description = option.description ?? undefined
    const entry: LlmModelInfo = {
      provider,
      id: option.value,
      name: option.name,
      inputModalities: ['text'],
    }
    return description === undefined ? entry : { ...entry, description }
  })
}
