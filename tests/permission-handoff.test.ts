import { describe, expect, it } from 'vitest'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { parsePermissionHandoff } from '../src/adapter/permission-handoff.js'

const tools: ToolSchema[] = [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]
const context = { sessionId: 'current', serverName: 'dsh-tools', tools }
function request(): RequestPermissionRequest {
  return {
    sessionId: 'current',
    toolCall: {
      toolCallId: 'official-call', kind: 'other',
      _meta: { is_mcp_tool_call: true, mcp: { server: 'dsh-tools', tool: 'read' } },
      rawInput: { arguments: { path: 'a.txt' }, path: 'a.txt' },
    },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  }
}

describe('ACP 私有 MCP 权限路由解析（依赖会话禁用内置工具）', () => {
  it('识别官方 1.4.0 解包形式，保留参数值', () => {
    expect(parsePermissionHandoff(request(), context)).toEqual({ name: 'read', arguments: '{"path":"a.txt"}' })
  })

  it('不通过标题、名字或 rawInput 信封猜测路由', () => {
    const value = request()
    delete value.toolCall._meta
    value.toolCall.name = 'call_mcp_tool'
    value.toolCall.title = 'dsh-tools_read'
    value.toolCall.rawInput = { ServerName: 'dsh-tools', ToolName: 'read', Arguments: { path: 'a.txt' } }
    expect(parsePermissionHandoff(value, context)).toBeUndefined()
  })

  it('旧会话、未知工具和外部服务器不转交', () => {
    const foreign = request(); foreign.sessionId = 'old'
    const unknown = request(); unknown.toolCall._meta = { is_mcp_tool_call: true, mcp: { server: 'dsh-tools', tool: 'unknown' } }
    const other = request(); other.toolCall._meta = { is_mcp_tool_call: true, mcp: { server: 'other', tool: 'read' } }
    for (const value of [foreign, unknown, other]) expect(parsePermissionHandoff(value, context)).toBeUndefined()
    expect(parsePermissionHandoff(request(), { ...context, tools: [] })).toBeUndefined()
  })

  it('有 MCP 元数据但名称明确指向原生能力时仍拒绝', () => {
    const named = request(); named.toolCall.name = 'run_command'
    expect(parsePermissionHandoff(named, context)).toBeUndefined()
  })

  it.each(['read', 'execute', 'search', 'edit', 'other'] as const)('展示分类 %s 不阻断私有桥路由', (kind) => {
    const value = request(); value.toolCall.kind = kind
    expect(parsePermissionHandoff(value, context)?.name).toBe('read')
  })

  it.each(['Run read?', 'Run dsh-tools_read?'])('官方 eager 工具格式 %s 无 MCP 元数据也能进入桥', (title) => {
    const value = request()
    delete value.toolCall._meta
    value.toolCall.title = title
    value.toolCall.rawInput = { path: 'a.txt' }
    expect(parsePermissionHandoff(value, context)).toEqual({ name: 'read', arguments: '{"path":"a.txt"}' })
  })

  it('eager 标题必须精确命中目录，外部 MCP 元数据不能退回标题匹配', () => {
    const value = request()
    value.toolCall.title = 'Run read?'
    value.toolCall._meta = { is_mcp_tool_call: true, mcp: { server: 'external', tool: 'read' } }
    expect(parsePermissionHandoff(value, context)).toBeUndefined()
    delete value.toolCall._meta
    value.toolCall.title = 'Please Run read? arbitrary text'
    expect(parsePermissionHandoff(value, context)).toBeUndefined()
  })

  it('权限提示参数缺失或包装不同不阻断已识别的桥，实际参数留给 tools/call', () => {
    for (const rawInput of [undefined, null, [], 'x', { path: 'a.txt' }, { arguments: { path: 'a' }, path: 'b' }]) {
      const value = request(); value.toolCall.rawInput = rawInput
      expect(parsePermissionHandoff(value, context)?.name).toBe('read')
    }
  })

  it('工具自己声明 arguments 字段时保留它', () => {
    const value = request()
    value.toolCall.rawInput = { arguments: { nested: true }, path: 'a.txt' }
    const declared: ToolSchema[] = [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { arguments: { type: 'object' }, path: { type: 'string' } } } }]
    expect(JSON.parse(parsePermissionHandoff(value, { ...context, tools: declared })!.arguments))
      .toEqual(value.toolCall.rawInput)
  })

  it('工具声明 arguments 字段且与包装同形时也可进入桥，诊断保留原输入', () => {
    const value = request()
    const declared: ToolSchema[] = [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { arguments: { type: 'object' }, path: { type: 'string' } } } }]
    const handoff = parsePermissionHandoff(value, { ...context, tools: declared })
    expect(handoff?.name).toBe('read')
    expect(JSON.parse(handoff!.arguments)).toEqual(value.toolCall.rawInput)
  })

  it('空参数工具保留空对象，不添加官方包装字段', () => {
    const value = request(); value.toolCall.rawInput = { arguments: {} }
    expect(parsePermissionHandoff(value, context)?.arguments).toBe('{}')
  })
})
