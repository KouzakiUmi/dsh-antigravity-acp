import { describe, expect, it } from 'vitest'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { describePermissionRequest } from '../src/adapter/permission-diagnostic.js'

const context = { sessionId: 'current-session', serverName: 'dsh-tools', toolNames: ['read'] }
function request(): RequestPermissionRequest {
  return {
    sessionId: context.sessionId,
    toolCall: {
      toolCallId: 'SECRET_CALL_ID', name: 'call_mcp_tool', kind: 'other',
      title: 'SECRET_TITLE',
      rawInput: {
        ServerName: 'dsh-tools', ToolName: 'read',
        Arguments: { file_path: 'SECRET_PATH', token: 'SECRET_TOKEN' },
        SECRET_UNKNOWN_KEY: 'SECRET_UNKNOWN_VALUE',
      },
      rawOutput: 'SECRET_OUTPUT', _meta: { sensitive: 'SECRET_CALL_META' },
    },
    options: [
      { kind: 'allow_once', optionId: 'SECRET_ALLOW_ID', name: 'SECRET_ALLOW_NAME' },
      { kind: 'reject_once', optionId: 'SECRET_REJECT_ID', name: 'SECRET_REJECT_NAME' },
    ],
    _meta: { sensitive: 'SECRET_REQUEST_META' },
  }
}

describe('权限请求诊断不参与授权', () => {
  it('仅输出固定词表和当前目录关系，不复制敏感字段、值或任意键名', () => {
    const diagnostic = describePermissionRequest(request(), context)
    expect(diagnostic).toEqual({
      sessionMatches: true, programmaticName: 'mcp-wrapper', kind: 'other',
      titlePresent: true, metaPresent: true,
      mcpMeta: { marked: false, serverMatches: false, toolAdvertised: false },
      input: { shape: 'object', fields: ['ServerName', 'ToolName', 'Arguments'], serverMatches: true, toolAdvertised: true },
      nested: [], options: ['allow_once', 'reject_once'],
    })
    expect(JSON.stringify(diagnostic)).not.toContain('SECRET_')
  })

  it('包装层只检查固定键名，不输出下层任意正文', () => {
    const value = request()
    value.toolCall.rawInput = { input: value.toolCall.rawInput }
    const diagnostic = describePermissionRequest(value, context)
    expect(diagnostic.input.serverMatches).toBe(false)
    expect(diagnostic.nested).toEqual([{
      field: 'input', shape: 'object', fields: ['ServerName', 'ToolName', 'Arguments'], serverMatches: true, toolAdvertised: true,
    }])
    expect(JSON.stringify(diagnostic)).not.toContain('SECRET_')
  })

  it('不从可伪造标题和参数推导程序化工具名', () => {
    const value = request()
    delete value.toolCall.name
    value.toolCall.title = 'call_mcp_tool dsh-tools.read'
    const diagnostic = describePermissionRequest(value, context)
    expect(diagnostic.programmaticName).toBe('absent')
    expect(diagnostic.input.serverMatches).toBe(true)
    expect(diagnostic.input.toolAdvertised).toBe(true)
  })

  it('跨会话、其他 server 与未发布工具仅记录不匹配，不回显值', () => {
    const value = request()
    value.sessionId = 'SECRET_FOREIGN_SESSION'
    value.toolCall.name = 'SECRET_UNKNOWN_TOOL'
    value.toolCall.rawInput = { ServerName: 'SECRET_SERVER', ToolName: 'SECRET_TOOL' }
    const diagnostic = describePermissionRequest(value, context)
    expect(diagnostic.sessionMatches).toBe(false)
    expect(diagnostic.programmaticName).toBe('other')
    expect(diagnostic.input.serverMatches).toBe(false)
    expect(diagnostic.input.toolAdvertised).toBe(false)
    expect(JSON.stringify(diagnostic)).not.toContain('SECRET_')
  })

  it('缺省、字符串、数组和非标准输入不导致诊断抛错或复制正文', () => {
    for (const input of [undefined, null, 'SECRET_STRING', ['SECRET_ARRAY'], 42, false]) {
      const value = request()
      value.toolCall.rawInput = input
      const diagnostic = describePermissionRequest(value, context)
      expect(diagnostic.input.serverMatches).toBe(false)
      expect(diagnostic.input.fields).toEqual([])
      expect(JSON.stringify(diagnostic)).not.toContain('SECRET_')
    }
  })
})

describe('官方 MCP 元数据仅用于诊断', () => {
  it('识别已解包参数的 MCP 元数据关系，不复制任何原值', () => {
    const value = request()
    delete value.toolCall.name
    value.toolCall.rawInput = { arguments: { secret: 'SECRET_INPUT' } }
    value.toolCall._meta = { is_mcp_tool_call: true, mcp: { server: 'dsh-tools', tool: 'read' }, prompt: 'SECRET_PROMPT' }
    const diagnostic = describePermissionRequest(value, context)
    expect(diagnostic.mcpMeta).toEqual({ marked: true, serverMatches: true, toolAdvertised: true })
    expect(diagnostic.programmaticName).toBe('absent')
    expect(JSON.stringify(diagnostic)).not.toContain('SECRET_')
  })

  it('任意其他 metadata 形状不能伪造目录匹配', () => {
    for (const mcp of [null, [], 'SECRET_META', { server: 'other', tool: 'other' }]) {
      const value = request()
      value.toolCall._meta = { mcp }
      const diagnostic = describePermissionRequest(value, context)
      expect(diagnostic.mcpMeta).toEqual({ marked: false, serverMatches: false, toolAdvertised: false })
      expect(JSON.stringify(diagnostic)).not.toContain('SECRET_')
    }
  })
})
