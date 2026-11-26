/**
 * MCP 工具目录的字节预算收敛（issue #18）。
 *
 * 实测（scripts/probe-tool-budget.mjs，官方 1.5.2）：工具目录 JSON 约 60KB 时
 * 全部可见，约 100KB 时官方 agent 丢弃 4 个 12KB 描述的工具——丢弃发生在官方
 * agent / 上游侧，插件桥全量交付。为保住「全部工具可见」，超预算时从最长描述
 * 开始裁剪描述总量，名称与参数 schema 不变（调用契约不受影响）。
 *
 * 纯函数，无 IO；预算 <= 0 表示禁用，原样返回。
 */
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** 裁剪标记：让模型知道描述不完整，可按需试探或询问。 */
export const TOOL_DESCRIPTION_TRUNCATION_MARKER = '…[description truncated]'

export interface ToolCatalogFit {
  tools: readonly ToolSchema[]
  truncated: Array<{ name: string; originalBytes: number; keptBytes: number }>
}

function catalogBytes(tools: readonly ToolSchema[]): number {
  return Buffer.byteLength(JSON.stringify(tools), 'utf8')
}

/** 按字节截断 UTF-8 文本，回退到字符边界，不产生替换字符。 */
function sliceUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let end = Math.max(0, maxBytes)
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString('utf8')
}

/**
 * 目录 JSON 总字节超过预算时，迭代裁剪最长描述（每次至少裁掉超出量或 25%），
 * 直到落入预算或描述无可再裁。参数 schema 单独超预算时尽力而为返回。
 */
export function fitToolCatalogBudget(tools: readonly ToolSchema[], budgetBytes: number): ToolCatalogFit {
  if (budgetBytes <= 0 || tools.length === 0 || catalogBytes(tools) <= budgetBytes) {
    return { tools, truncated: [] }
  }
  const result: ToolSchema[] = tools.map((tool) => ({ ...tool }))
  const truncated = new Map<string, { name: string; originalBytes: number; keptBytes: number }>()
  const markerBytes = Buffer.byteLength(TOOL_DESCRIPTION_TRUNCATION_MARKER, 'utf8')
  while (catalogBytes(result) > budgetBytes) {
    let index = -1
    let largest = markerBytes
    result.forEach((tool, i) => {
      const bytes = Buffer.byteLength(tool.description ?? '', 'utf8')
      if (bytes > largest) { largest = bytes; index = i }
    })
    if (index < 0) break
    const tool = result[index]!
    const description = tool.description ?? ''
    const currentBytes = Buffer.byteLength(description, 'utf8')
    if (!truncated.has(tool.name)) truncated.set(tool.name, { name: tool.name, originalBytes: currentBytes, keptBytes: currentBytes })
    const overshoot = catalogBytes(result) - budgetBytes
    const keepBytes = Math.max(0, currentBytes - Math.max(overshoot, Math.ceil(currentBytes / 4)) - markerBytes)
    const kept = sliceUtf8(description, keepBytes)
    result[index] = { ...tool, description: kept + TOOL_DESCRIPTION_TRUNCATION_MARKER }
    truncated.get(tool.name)!.keptBytes = Buffer.byteLength(kept, 'utf8')
  }
  return { tools: result, truncated: [...truncated.values()] }
}
