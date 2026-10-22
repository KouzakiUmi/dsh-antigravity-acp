/**
 * 工具参数签名渲染与参数预检（原创实现）。
 *
 * 背景：官方 agy 只把 MCP 工具 schema 写成磁盘文件，模型调用时常常没读，凭原生
 * 工具的习惯猜参数名（`path` 而非 `file_path`）或漏掉看起来只给 UI 用的必填项
 * （`description`）。这里提供签名、保守别名修正和桥内预检：
 * 1. `renderToolSignatures`：把当前目录渲染成紧凑的类 TypeScript 签名，进入 prompt；
 * 2. `inspectToolArguments`：只对照 schema 的 `properties` / `required` 做**保守**
 *    检查（不校验类型），供桥提前给模型可操作的错误、供日志诊断。
 *
 * DSH 工具管线的最终校验仍然是权威；这里的检查绝不能比它更严格。
 */
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** 参数预检结果。 */
export interface ToolArgumentIssues {
  /** schema `required` 里声明、但调用里缺失的键；null 是否合法由 DSH 校验。 */
  missing: string[]
  /** 调用里出现、但 schema `properties` 未声明的键（仅在 schema 声明了 properties 时判定）。 */
  unknown: string[]
}

const MAX_ENUM_VALUES = 6
const MAX_UNION_PARTS = 4

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function requiredKeys(parameters: unknown): string[] {
  const required = record(parameters)?.required
  return Array.isArray(required) ? required.filter((key): key is string => typeof key === 'string') : []
}

/** 把一个属性 schema 渲染成短类型串；无法识别时退化为 `any`。 */
function renderType(schema: unknown, depth = 0): string {
  const node = record(schema)
  if (!node) return 'any'
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = node.enum.slice(0, MAX_ENUM_VALUES).map((value) => JSON.stringify(value))
    return node.enum.length > MAX_ENUM_VALUES ? `${values.join('|')}|…` : values.join('|')
  }
  if (node.const !== undefined) return JSON.stringify(node.const)
  for (const key of ['anyOf', 'oneOf'] as const) {
    const parts = node[key]
    if (Array.isArray(parts) && parts.length > 0 && depth < 2) {
      return parts.slice(0, MAX_UNION_PARTS).map((part) => renderType(part, depth + 1)).join('|')
    }
  }
  const type = node.type
  if (Array.isArray(type)) return type.filter((item): item is string => typeof item === 'string').join('|') || 'any'
  if (type === 'array') return depth < 2 ? `${renderType(node.items, depth + 1)}[]` : 'array'
  if (typeof type === 'string') return type
  return 'any'
}

/** `read(file_path: string, offset?: number, limit?: number)`；必填在前，可选带 `?`。 */
export function renderToolSignature(tool: ToolSchema): string {
  const parameters = record(tool.parameters)
  const properties = record(parameters?.properties) ?? {}
  const required = new Set(requiredKeys(parameters))
  const names = Object.keys(properties)
  // 必填项按 `required` 声明顺序在前（DSH 工具常要求特定的参数出现顺序），可选项按声明顺序在后。
  const ordered = [
    ...requiredKeys(parameters).filter((name, index, all) => all.indexOf(name) === index),
    ...names.filter((name) => !required.has(name)),
  ]
  const parts = ordered.map((name) => `${name}${required.has(name) ? '' : '?'}: ${renderType(properties[name])}`)
  return `${tool.name}(${parts.join(', ')})`
}

/** 整个目录的签名块正文；空目录返回 undefined（不产生块）。 */
export function renderToolSignatures(tools: readonly ToolSchema[]): string | undefined {
  if (tools.length === 0) return undefined
  return [
    '随会话工具的参数签名（调用时参数名必须与此逐字一致）：',
    '- 不带 ? 的参数是必填项，不得省略；带 ? 的是可选项。',
    '- 不要沿用 agy 原生工具的参数名（如 path / AbsolutePath / CommandLine），也不要自造别名。',
    '- 调用前先对照签名补齐全部必填参数；说明类必填参数（如 description）也必须提供。',
    ...tools.map((tool) => `- ${renderToolSignature(tool)}`),
  ].join('\n')
}

/**
 * 对照 schema 检查一次调用的参数键。只看 `required` 与 `properties`，不检查类型、
 * 取值或 `additionalProperties`，因此不会拒绝 DSH 自己会接受的调用。
 */
export function inspectToolArguments(tool: Pick<ToolSchema, 'parameters'>, args: unknown): ToolArgumentIssues {
  const input = record(args) ?? {}
  const properties = record(record(tool.parameters)?.properties)
  const missing = requiredKeys(tool.parameters).filter((key) => !Object.hasOwn(input, key) || input[key] === undefined)
  const unknown = properties
    ? Object.keys(input).filter((key) => !Object.hasOwn(properties, key))
    : []
  return { missing: [...new Set(missing)], unknown }
}

// 不换算单位、不猜测字段内容；例如 timeout 和 timeoutMs 绝不能按别名处理。
const ARGUMENT_ALIASES = [
  ['file_path', 'path', 'absolute_path', 'AbsolutePath', 'target_file', 'TargetFile'],
  ['command', 'command_line', 'CommandLine'],
  ['cwd', 'working_directory', 'working_dir', 'Cwd'],
  ['description', 'Description'],
] as const

/** 仅当 schema 中目标唯一、输入中来源唯一且目标缺失时，修正常见的字符串参数名。 */
export function normalizeToolArguments(
  tool: Pick<ToolSchema, 'parameters'>,
  args: unknown,
): { arguments: Record<string, unknown>; renamed: Array<{ from: string; to: string }> } {
  const input = { ...record(args) }
  const properties = record(record(tool.parameters)?.properties) ?? {}
  const renamed: Array<{ from: string; to: string }> = []
  for (const group of ARGUMENT_ALIASES) {
    const targets = group.filter((key) => Object.hasOwn(properties, key))
    if (targets.length !== 1) continue
    const target = targets[0]!
    if (Object.hasOwn(input, target)) continue
    const sources = group.filter((key) => !Object.hasOwn(properties, key) && Object.hasOwn(input, key))
    if (sources.length !== 1) continue
    const source = sources[0]!
    // 这些别名只对字符串字段有确定含义，其他 schema 形状交给原校验路径。
    if (record(properties[target])?.type !== 'string' || typeof input[source] !== 'string') continue
    input[target] = input[source]
    delete input[source]
    renamed.push({ from: source, to: target })
  }
  return { arguments: input, renamed }
}

/** 键名只有形如标识符且不过长时才可进日志/错误文案（模型可控字符串不原样回显）。 */
export function safeKeyNames(keys: readonly string[], limit = 8): string[] {
  return keys.filter((key) => /^[A-Za-z_][\w.-]{0,39}$/.test(key)).slice(0, limit)
}
