/**
 * 把官方 ACP 权限提示中的 MCP 描述解析为新的 DSH 工具请求。
 * 这些字段全部不可信：这里只做请求转换，绝不据此授予 ACP 执行权限。
 * 最终参数校验、审批、沙箱与执行仍由 DSH 工具管线负责。
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
  if (meta?.is_mcp_tool_call !== true || mcp?.server !== context.serverName || typeof mcp?.tool !== 'string') return undefined
  const tool = context.tools.find((item) => item.name === mcp.tool)
  const input = record(request.toolCall.rawInput)
  if (!tool || !input) return undefined

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
