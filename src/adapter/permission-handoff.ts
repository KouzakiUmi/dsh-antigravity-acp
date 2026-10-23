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

export function parsePermissionHandoff(
  request: RequestPermissionRequest,
  context: { sessionId: string; serverName: string; tools: readonly ToolSchema[] },
): { name: string; arguments: string } | undefined {
  if (request.sessionId !== context.sessionId || !request.toolCall.toolCallId) return undefined
  const meta = record(request.toolCall._meta)
  const mcp = record(meta?.mcp)
  const input = record(request.toolCall.rawInput) ?? {}
  // eager MCP 工具在官方 1.4.0 的权限请求中没有 _meta.mcp，也没有 name；
  // server.py 从实际工具名生成固定的 "Run <name>?" 标题。会话已关闭内置工具，
  // 因此这里可用当前目录精确匹配该形式，不从任意描述中猜测工具名。
  const wrappedMcp = meta?.is_mcp_tool_call === true
  const tool = wrappedMcp
    ? mcp?.server === context.serverName ? context.tools.find((item) => item.name === mcp?.tool) : undefined
    : context.tools.find((item) => request.toolCall.title === `Run ${item.name}?`
      || request.toolCall.title === `Run ${context.serverName}_${item.name}?`)
  if (!tool) return undefined
  // 明确的原生名称仍拒绝；kind 只是展示分类，不决定是否属于私有桥。
  const name = request.toolCall.name
  if (name != null && name !== 'call_mcp_tool' && name !== tool.name) return undefined
  if (!wrappedMcp) return { name: tool.name, arguments: JSON.stringify(input) }

  // 权限提示里的参数只供诊断，不用于执行，不应因包装差异阻断已识别的桥路由。
  // 实际参数来自后续 tools/call，由桥转交 DSH 校验和审批。
  const properties = record(record(tool.parameters)?.properties)
  const args = properties && Object.hasOwn(properties, 'arguments')
    ? input
    : record(input.arguments) ?? input
  return { name: tool.name, arguments: JSON.stringify(args) }
}
