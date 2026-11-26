import { describe, expect, it } from 'vitest'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { fitToolCatalogBudget, TOOL_DESCRIPTION_TRUNCATION_MARKER } from '../src/adapter/tool-catalog.js'

function tool(name: string, description: string): ToolSchema {
  return { name, description, parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } }
}

describe('工具目录字节预算（issue #18）', () => {
  it('预算内与禁用（0）原样返回，不产生裁剪记录', () => {
    const tools = [tool('a', 'short'), tool('b', 'short')]
    expect(fitToolCatalogBudget(tools, 10_000).tools).toBe(tools)
    expect(fitToolCatalogBudget(tools, 0).tools).toBe(tools)
    expect(fitToolCatalogBudget([], 100).truncated).toEqual([])
  })

  it('超预算从最长描述裁剪，落入预算且名称与参数不变', () => {
    const tools = [
      tool('big', 'x'.repeat(10_000)),
      tool('medium', 'y'.repeat(5_000)),
      tool('small', 'z'.repeat(1_000)),
    ]
    const fitted = fitToolCatalogBudget(tools, 8_000)
    expect(Buffer.byteLength(JSON.stringify(fitted.tools), 'utf8')).toBeLessThanOrEqual(8_000)
    expect(fitted.truncated.length).toBeGreaterThan(0)
    expect(fitted.truncated[0]!.name).toBe('big')
    expect(fitted.truncated[0]!.originalBytes).toBe(10_000)
    for (const entry of fitted.tools) {
      const original = tools.find((t) => t.name === entry.name)!
      expect(entry.parameters).toEqual(original.parameters)
    }
    const big = fitted.tools.find((t) => t.name === 'big')!
    expect(big.description.endsWith(TOOL_DESCRIPTION_TRUNCATION_MARKER)).toBe(true)
    // 小描述工具不受影响。
    expect(fitted.tools.find((t) => t.name === 'small')!.description).toBe('z'.repeat(1_000))
  })

  it('中文描述按 UTF-8 字节裁剪，不产生替换字符', () => {
    const tools = [tool('cn', '中文描述'.repeat(3_000))]
    const fitted = fitToolCatalogBudget(tools, 4_000)
    expect(Buffer.byteLength(JSON.stringify(fitted.tools), 'utf8')).toBeLessThanOrEqual(4_000)
    expect(fitted.tools[0]!.description).not.toContain('\uFFFD')
    expect(fitted.tools[0]!.description.endsWith(TOOL_DESCRIPTION_TRUNCATION_MARKER)).toBe(true)
  })

  it('参数单独超预算时尽力而为，不死循环', () => {
    const huge: ToolSchema = { name: 'huge', description: 'd', parameters: { type: 'object', properties: { x: { type: 'string', description: 'p'.repeat(20_000) } } } }
    const fitted = fitToolCatalogBudget([huge], 1_000)
    expect(fitted.tools).toHaveLength(1)
    expect(fitted.tools[0]!.parameters).toEqual(huge.parameters)
  })
})
