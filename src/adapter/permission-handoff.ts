/**
 * 识别官方 ACP 权限提示中的私有 MCP 路由。元数据不是独立身份证明：
 * 调用方必须同时通过 session/new 禁用 AGY 内置工具和 ACP fs/terminal 能力。
 * 此处只允许进入私有桥，最终参数校验、审批、沙箱与执行仍由 DSH 负责。
 */
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** CLI 重复注册服务器时可能在工具命名空间中附加 8 位小写十六进制。 */
function resolveCliToolName(name: string, serverName: string, tools: readonly ToolSchema[]): string | undefined {
  const prefix = `mcp_${serverName}_`
  if (!name.startsWith(prefix)) return undefined
  const qualified = name.slice(prefix.length)
  const suffix = /^[0-9a-f]{8}_/.exec(qualified)?.[0]
  const exact = tools.find((tool) => tool.name === qualified)?.name
  const disambiguated = suffix === undefined
    ? undefined
    : tools.find((tool) => tool.name === qualified.slice(suffix.length))?.name
  // 同一线名称可能对应两个目录条目，不按目录顺序猜测。
  if (exact !== undefined && disambiguated !== undefined) return undefined
  return exact ?? disambiguated
}

export function parsePermissionHandoff(
  request: RequestPermissionRequest,
  context: { sessionId: string; serverName: string; tools: readonly ToolSchema[] },
): { name: string; arguments?: string } | undefined {
  if (request.sessionId !== context.sessionId || !request.toolCall.toolCallId) return undefined
  const meta = record(request.toolCall._meta)
  const mcp = record(meta?.mcp)
  const { name, title, rawInput } = request.toolCall
  const wrappedMcp = meta?.is_mcp_tool_call === true
  // CLI 1.5.15+ 的命名空间提示没有 MCP 包装元数据，rawInput 是展示摘要。
  // 不伪造空参数做预检；参数只从后续已鉴权的 tools/call 读取。
  if (!wrappedMcp && meta?.mcp == null && typeof name === 'string' && title === `Run ${name}`) {
    const toolName = resolveCliToolName(name, context.serverName, context.tools)
    if (toolName !== undefined) return { name: toolName }
  }

  // eager MCP 工具在官方 1.4.0 的权限请求中没有 _meta.mcp，也没有 name；
  // server.py 从实际工具名生成固定的 "Run <name>?" 标题。会话已关闭内置工具，
  // 因此这里可用当前目录精确匹配该形式，不从任意描述中猜测工具名。
  const tool = wrappedMcp
    ? mcp?.server === context.serverName ? context.tools.find((item) => item.name === mcp?.tool) : undefined
    : context.tools.find((item) => title === `Run ${item.name}?`
      || title === `Run ${context.serverName}_${item.name}?`)
  if (!tool) return undefined
  // 明确的原生名称仍拒绝；kind 只是展示分类，不决定是否属于私有桥。
  if (name != null && name !== 'call_mcp_tool' && name !== tool.name) return undefined
  const input = record(rawInput) ?? {}
  if (!wrappedMcp) return { name: tool.name, arguments: JSON.stringify(input) }

  // 权限提示里的参数只供诊断，不用于执行，不应因包装差异阻断已识别的桥路由。
  // 实际参数来自后续 tools/call，由桥转交 DSH 校验和审批。
  const properties = record(record(tool.parameters)?.properties)
  const args = properties && Object.hasOwn(properties, 'arguments')
    ? input
    : record(input.arguments) ?? input
  return { name: tool.name, arguments: JSON.stringify(args) }
}
