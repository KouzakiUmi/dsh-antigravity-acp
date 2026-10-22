import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { AGY_BRIDGE_ERROR, McpToolBridge } from '../src/bridge/mcp-bridge.js'
import { buildPromptContent } from '../src/adapter/prompt-transcript.js'
import {
  inspectToolArguments,
  normalizeToolArguments,
  renderToolSignature,
  renderToolSignatures,
  safeKeyNames,
} from '../src/adapter/tool-args.js'

const BASH: ToolSchema = {
  name: 'bash',
  description: 'run',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string' },
      timeoutMs: { type: 'number' },
      sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'] },
    },
    // 声明顺序与 properties 顺序不同：签名必须按 required 的顺序列必填项。
    required: ['description', 'command'],
  },
}
const READ: ToolSchema = {
  name: 'read',
  description: 'read',
  parameters: { type: 'object', properties: { file_path: { type: 'string' }, limit: { type: 'number' } }, required: ['file_path'] },
}

describe('工具参数签名', () => {
  it('必填在前（按 required 顺序），可选带 ?，枚举与数组被渲染', () => {
    expect(renderToolSignature(BASH)).toBe(
      'bash(description: string, command: string, timeoutMs?: number, sandbox_permissions?: "workspace-write"|"danger-full-access")',
    )
    expect(renderToolSignature({
      name: 'web_search', description: '',
      parameters: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } }, required: ['queries'] },
    })).toBe('web_search(queries: string[])')
  })

  it('无参数或畸形 schema 不抛错', () => {
    expect(renderToolSignature({ name: 'tool_list', description: '', parameters: {} })).toBe('tool_list()')
    expect(renderToolSignature({ name: 'x', description: '', parameters: { properties: { a: null }, required: [1, 'a'] } })).toBe('x(a: any)')
  })

  it('空目录不产生签名块；有目录时 prompt 带签名块且不影响消息逆解析', () => {
    expect(renderToolSignatures([])).toBeUndefined()
    const none = buildPromptContent(undefined, [])
    expect(none.some((block) => block.type === 'text' && block.text.startsWith('<dsh-tool-signatures>'))).toBe(false)
    const blocks = buildPromptContent(undefined, [], [BASH, READ])
    const text = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).find((item) => item.startsWith('<dsh-tool-signatures>'))
    expect(text).toContain('不带 ? 的参数是必填项')
    expect(text).toContain('- read(file_path: string, limit?: number)')
  })
})

describe('参数预检', () => {
  it('找出缺失的必填项与未声明键；null 留给 DSH 类型校验', () => {
    expect(inspectToolArguments(BASH, { command: 'git status' })).toEqual({ missing: ['description'], unknown: [] })
    expect(inspectToolArguments(READ, { path: 'package.json' })).toEqual({ missing: ['file_path'], unknown: ['path'] })
    expect(inspectToolArguments(READ, { file_path: null })).toEqual({ missing: [], unknown: [] })
    expect(inspectToolArguments(READ, { file_path: 'a', limit: 1 })).toEqual({ missing: [], unknown: [] })
  })

  it('不比 DSH 更严格：不检查类型，未声明 properties 时不判定未知键，非对象参数按空处理', () => {
    expect(inspectToolArguments(READ, { file_path: 123 })).toEqual({ missing: [], unknown: [] })
    expect(inspectToolArguments({ parameters: { type: 'object' } }, { anything: 1 })).toEqual({ missing: [], unknown: [] })
    expect(inspectToolArguments(READ, 'oops')).toEqual({ missing: ['file_path'], unknown: [] })
  })

  it('模型可控的键名只有形如标识符时才允许回显', () => {
    expect(safeKeyNames(['path', 'a b', 'x'.repeat(80), 'SECRET=token\nnext', 'ok.key-1'])).toEqual(['path', 'ok.key-1'])
  })
})

describe('保守参数别名修正', () => {
  it.each(['path', 'AbsolutePath', 'absolute_path', 'TargetFile'])('唯一别名 %s 改为 schema 中的 file_path，不修改原对象', (key) => {
    const input = { [key]: 'a.txt', limit: 3 }
    expect(normalizeToolArguments(READ, input)).toEqual({
      arguments: { file_path: 'a.txt', limit: 3 }, renamed: [{ from: key, to: 'file_path' }],
    })
    expect(input).toEqual({ [key]: 'a.txt', limit: 3 })
  })

  it('不覆盖已有目标，不处理多来源、非字符串或未声明字段', () => {
    for (const input of [
      { file_path: 'a', path: 'b' }, { file_path: null, path: 'b' },
      { path: 'a', AbsolutePath: 'b' }, { path: 123 }, { unknown: 'a' },
    ]) expect(normalizeToolArguments(READ, input)).toEqual({ arguments: input, renamed: [] })
  })

  it('schema 同时声明两个相近字段时不猜目标', () => {
    const tool = { parameters: { properties: { path: { type: 'string' }, file_path: { type: 'string' } } } }
    expect(normalizeToolArguments(tool, { AbsolutePath: 'a' }).renamed).toEqual([])
  })

  it('修正 CommandLine，但不猜缺失说明、不换算 timeout 单位', () => {
    expect(normalizeToolArguments(BASH, { CommandLine: 'pwd', timeout: 1 })).toEqual({
      arguments: { command: 'pwd', timeout: 1 }, renamed: [{ from: 'CommandLine', to: 'command' }],
    })
  })
})

describe('MCP 桥对缺必填参数的调用', () => {
  const bridges: McpToolBridge[] = []
  const clients: Client[] = []
  afterEach(async () => {
    while (clients.length > 0) await clients.pop()?.close().catch(() => undefined)
    while (bridges.length > 0) await bridges.pop()?.close()
  })

  it('立即返回带正确签名的错误，不进入 park 队列；参数齐全时照常 park', async () => {
    const bridge = new McpToolBridge()
    bridges.push(bridge)
    bridge.publishTools([BASH])
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    await bridge.attach(serverSide)
    const client = new Client({ name: 'agent', version: '0.0.0' })
    clients.push(client)
    await client.connect(clientSide)
    const parked = vi.fn()
    bridge.onParked(parked)

    const rejected = await client.callTool({ name: 'bash', arguments: { command: 'git status' } }, undefined, { timeout: 1000 })
    expect(rejected.isError).toBe(true)
    const text = (rejected.content as Array<{ text?: string }>)[0]?.text ?? ''
    expect(text).toContain(AGY_BRIDGE_ERROR.INVALID_ARGUMENTS)
    expect(text).toContain('description')
    expect(text).toContain('bash(description: string, command: string')
    expect(parked).not.toHaveBeenCalled()
    expect(bridge.pendingCallIds()).toEqual([])

    const accepted = client.callTool({ name: 'bash', arguments: { command: 'git status', description: 'Show status' } }, undefined, { timeout: 5000 })
    await vi.waitFor(() => expect(parked).toHaveBeenCalledTimes(1))
    await bridge.deliverResults([{ callId: bridge.pendingCallIds()[0]!, text: 'ok', isError: false }])
    expect((await accepted).isError).toBe(false)
  })
})
