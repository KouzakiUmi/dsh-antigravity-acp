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

describe('ACP 权限描述转为不可信 DSH 工具请求（不是授权）', () => {
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

  it('包装参数有冲突或形状不明时不猜测', () => {
    for (const rawInput of [null, [], 'x', { path: 'a.txt' }, { arguments: { path: 'a' }, path: 'b' }]) {
      const value = request(); value.toolCall.rawInput = rawInput
      expect(parsePermissionHandoff(value, context)).toBeUndefined()
    }
  })

  it('工具自己声明 arguments 字段时保留它', () => {
    const value = request()
    value.toolCall.rawInput = { arguments: { nested: true }, path: 'a.txt' }
    const declared: ToolSchema[] = [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { arguments: { type: 'object' }, path: { type: 'string' } } } }]
    expect(JSON.parse(parsePermissionHandoff(value, { ...context, tools: declared })!.arguments))
      .toEqual(value.toolCall.rawInput)
  })

  it('工具同名 arguments 参数与包装层无法区分时拒绝猜测', () => {
    const value = request()
    const declared: ToolSchema[] = [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { arguments: { type: 'object' }, path: { type: 'string' } } } }]
    expect(parsePermissionHandoff(value, { ...context, tools: declared })).toBeUndefined()
  })

  it('空参数工具保留空对象，不添加官方包装字段', () => {
    const value = request(); value.toolCall.rawInput = { arguments: {} }
    expect(parsePermissionHandoff(value, context)?.arguments).toBe('{}')
  })
})
