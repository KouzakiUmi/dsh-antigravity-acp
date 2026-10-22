/**
 * 识别官方 ACP 权限提示中的私有 MCP 路由。元数据不是独立身份证明：
 * 调用方必须同时通过 session/new 禁用 AGY 内置工具和 ACP fs/terminal 能力。
 * 此处只允许进入私有桥，最终参数校验、审批、沙箱与执行仍由 DSH 负责。
 */
import { isDeepStrictEqual } from 'node:util'
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
  const input = record(request.toolCall.rawInput)
  if (!input) return undefined
  // eager MCP 工具在官方 1.4.0 的权限请求中没有 _meta.mcp，也没有 name；
  // server.py 从实际工具名生成固定的 "Run <name>?" 标题。会话已关闭内置工具，
  // 因此这里可用当前目录精确匹配该形式，不从任意描述中猜测工具名。
  const wrappedMcp = meta?.is_mcp_tool_call === true
  const tool = wrappedMcp
    ? mcp?.server === context.serverName ? context.tools.find((item) => item.name === mcp?.tool) : undefined
    : context.tools.find((item) => request.toolCall.title === `Run ${item.name}?`
      || request.toolCall.title === `Run ${context.serverName}_${item.name}?`)
  if (!tool) return undefined
  // 明确的原生名称/种类不能仅凭伪造的 MCP 参数信封获得授权。
  const name = request.toolCall.name
  if ((name != null && name !== 'call_mcp_tool' && name !== tool.name)
    || (request.toolCall.kind != null && request.toolCall.kind !== 'other')) return undefined
  if (!wrappedMcp) return { name: tool.name, arguments: JSON.stringify(input) }

  // server 1.4.0：rawInput = { arguments: 原参数, ...原参数 }。
  // 工具自己声明 arguments 时该字段属于工具，不能把它误当包装层剥掉。
  const properties = record(record(tool.parameters)?.properties)
  const nested = record(input.arguments)
  const { arguments: _wrapper, ...flat } = input
  const wrapped = nested !== undefined && isDeepStrictEqual(nested, flat)
  let args: Record<string, unknown>
  if (properties && Object.hasOwn(properties, 'arguments')) {
    // 可选同名参数与官方包装层完全同形时不可判别，宁可拒绝，不改变调用语义。
    if (wrapped) return undefined
    args = input
  } else {
    if (!nested || !wrapped) return undefined
    args = nested
  }
  return { name: tool.name, arguments: JSON.stringify(args) }
}
