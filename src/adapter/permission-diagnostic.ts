/**
 * ACP 权限请求的固定词表诊断，不参与授权决策。
 * 不输出 title、调用 id、元数据、参数正文、任意字段名或未知工具名。
 */
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'

const INPUT_FIELDS = [
  'ServerName', 'ToolName', 'Arguments', 'name', 'tool_name', 'toolName',
  'server_name', 'serverName', 'args', 'input', 'arguments', 'parameters',
  'tool_input', 'toolInput',
] as const
const TOOL_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'])
const OPTION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function shape(value: unknown): string {
  if (value === null || value === undefined) return 'absent'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function inputSummary(value: unknown, serverName: string, toolNames: readonly string[]) {
  const input = record(value)
  return {
    shape: shape(value),
    fields: INPUT_FIELDS.filter((key) => input && Object.hasOwn(input, key)),
    // 仅陈述与当前目录的关系，不输出参数值，更不把这些模型可控参数当作可信身份。
    serverMatches: input?.ServerName === serverName || input?.server_name === serverName || input?.serverName === serverName,
    toolAdvertised: [input?.ToolName, input?.tool_name, input?.toolName].some(
      (name) => typeof name === 'string' && toolNames.includes(name),
    ),
  }
}

export function describePermissionRequest(
  request: RequestPermissionRequest,
  context: { sessionId: string; serverName: string; toolNames: readonly string[] },
) {
  const call = request.toolCall
  const input = record(call.rawInput)
  return {
    sessionMatches: request.sessionId === context.sessionId,
    programmaticName: call.name === 'call_mcp_tool' ? 'mcp-wrapper' : call.name == null ? 'absent' : 'other',
    kind: call.kind == null ? 'absent' : TOOL_KINDS.has(call.kind) ? call.kind : 'unrecognized',
    titlePresent: typeof call.title === 'string',
    metaPresent: request._meta != null || call._meta != null,
    input: inputSummary(call.rawInput, context.serverName, context.toolNames),
    // 有界检查固定包装层，避免依赖尚未实测的 rawInput 结构，也不遍历任意正文。
    nested: ['args', 'input', 'arguments', 'parameters', 'tool_input', 'toolInput']
      .filter((key) => input && Object.hasOwn(input, key))
      .map((key) => ({ field: key, ...inputSummary(input?.[key], context.serverName, context.toolNames) })),
    options: OPTION_KINDS.filter((kind) => request.options.some((option) => option.kind === kind)),
  }
}

export type PermissionDiagnostic = ReturnType<typeof describePermissionRequest>

/**
 * 判定是否为发往本插件私有 MCP 桥的工具调用授权请求。
 * 桥只暴露 DSH 自己的工具（DSH 侧仍有工具策略），因此放行它是安全的；
 * 原生 shell/文件类请求（kind 为 execute/edit/delete/move 等）或未命中桥目录的请求一律不放行。
 */
export function isBridgeToolRequest(diagnostic: PermissionDiagnostic): boolean {
  if (!diagnostic.sessionMatches) return false
  if (diagnostic.kind !== 'absent' && diagnostic.kind !== 'other' && diagnostic.kind !== 'fetch') return false
  if (diagnostic.programmaticName === 'other') return false
  const hit = (s: { serverMatches: boolean; toolAdvertised: boolean }) => s.serverMatches && s.toolAdvertised
  return hit(diagnostic.input) || diagnostic.nested.some(hit)
}
