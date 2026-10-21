/**
 * DSH 请求历史 → ACP `session/prompt` 内容的序列化（原创实现）。
 *
 * 设计前提（硬约束）：**DSH 是历史权威**。本文件不建任何会话存储、数据库
 * 或文件——每次 `stream` 都把 `GenerateOptions.messages` + `options.system`
 * 完整重放进一条 ACP prompt。
 *
 * 载体格式：ACP 的 `PromptRequest.prompt` 是 `ContentBlock[]`，本实现把每条
 * DSH 消息编码成一个 `TextContent` 信封块：
 *
 *     <dsh-message role="user">{"content":[{"type":"text","text":"hi"}]}</dsh-message>
 *
 * 信封用尖括号标签（与 JSON 字符串正文互不干扰：标签本身不是合法 JSON），
 * role 属性保留了角色边界，正文是该消息 content 块的 JSON 数组。
 * `parsePromptTranscript` 可无损还原 role 与 content，因此映射是**可逆**的；
 * 工具续轮时（见 antigravity-adapter.ts）历史里的 tool-call / tool result
 * 同样以信封进入 prompt，agent 得以看到完整的 DSH 侧工具轨迹。
 *
 * `options.system` 单独编码为一个 `<dsh-system>` 块放在最前。
 */
import type { ContentBlock, TextContent } from '@agentclientprotocol/sdk'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'

/** 消息信封的起始标签前缀（后跟 `role="…"` 与 `>`）。 */
const MESSAGE_OPEN_PREFIX = '<dsh-message role="'
const MESSAGE_OPEN_SUFFIX = '">'
const MESSAGE_CLOSE = '</dsh-message>'
const SYSTEM_OPEN = '<dsh-system>'
const SYSTEM_CLOSE = '</dsh-system>'
/** 工具策略说明块的哨兵（固定文本，不参与消息逆解析）。 */
const POLICY_OPEN = '<dsh-tool-policy>'
const POLICY_CLOSE = '</dsh-tool-policy>'

/**
 * 每次 prompt 都会附带的一段工具策略说明。
 *
 * 为什么必须有：官方 agent 自带一整套原生工具（`read_file` / `write_file` /
 * `edit_file` / `run_command` / `view_file` / `list_dir` / `grep_search` /
 * `find_by_name`…），而本集成**不声明** fs/terminal 客户端能力，这些原生步骤在这里
 * 必然拿不到权限。**只拒绝不告知**时，偏好原生工具的型号会反复索要原生权限——实测
 * 2026-10-17 表现为「默认占位模型能对话，选具体型号就没反应」。明确告诉模型「用随会话
 * 提供的工具」后，它会改用桥过去的 DSH 工具。
 * 同类做法见 `@estebanforge/pi-antigravity-bridge` 的 tool-priority note（MIT）。
 */
export const TOOL_POLICY_TEXT = [
  '本会话运行在 DSH（DeepSeek Harness）集成中，工具与 DSH 对齐：',
  '- 随本会话提供的工具列表就是你的工具入口；读写文件、执行命令、搜索代码请一律使用它们，它们与 DSH 的权限与审计一致。',
  '- agy 的原生工具（read_file / write_file / edit_file / run_command / view_file / list_dir / grep_search / find_by_name 等）在本集成中不可用：客户端未声明 fs/terminal 能力，相关请求会被拒绝。',
  '- 不要反复索要原生能力；直接改用等价的随会话工具完成。',
  '- 集成可能取消官方工具调用并转交给 DSH 执行；重建后的历史中的 tool 结果是权威结果（包括 isError=true 的拒绝/失败），不要仅因官方调用被取消而重复执行。',
  '- ACP 权限拒绝可能发生在插件转交 DSH 之前。仅凭 Denied by user 或 pre-tool hook 文本，不能断言 DSH 全局禁用了工具，也不能建议关闭沙箱或审批。请明确报告拒绝来源尚未核实。',
].join('\n')

/** 解析出的单条消息信封。 */
export interface TranscriptEntry {
  /** DSH 消息角色。 */
  role: string
  /** 该消息的 content 块（JSON 还原，形状与 DSH ContentBlock 一致）。 */
  content: unknown[]
  toolCallId?: string
  isError?: boolean
}

function textBlock(text: string): TextContent & { type: 'text' } {
  return { type: 'text', text }
}

/** 把一条 DSH 请求消息编码成信封文本。 */
export function encodeMessage(message: RequestMessage): string {
  const payload = JSON.stringify(message.role === 'tool'
    ? { content: message.content, toolCallId: message.toolCallId, isError: message.isError === true }
    : message.content).replaceAll('<', '\\u003c')
  return `${MESSAGE_OPEN_PREFIX}${message.role}${MESSAGE_OPEN_SUFFIX}${payload}${MESSAGE_CLOSE}`
}

/**
 * 构造一次 ACP prompt 的 content 块序列：system（若给出）在前，随后每条
 * DSH 消息一个信封块。空 system 文本不产生块（ACP 的 TextContent.text 为空串
 * 没有语义价值）。
 */
export function buildPromptContent(system: string | undefined, messages: readonly RequestMessage[]): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (system !== undefined && system !== '') blocks.push(textBlock(`${SYSTEM_OPEN}${system}${SYSTEM_CLOSE}`))
  // 工具策略紧随 system：告诉模型原生 fs/terminal 在这里拿不到权限，请用随会话工具。
  blocks.push(textBlock(`${POLICY_OPEN}${TOOL_POLICY_TEXT}${POLICY_CLOSE}`))
  for (const message of messages) blocks.push(textBlock(encodeMessage(message)))
  return blocks
}

/**
 * 逆解析：从一组 ACP TextContent 文本中还原 system 文本与消息信封序列。
 * 供测试断言 prompt 重建结果；生产路径不依赖它。
 */
export function parsePromptTranscript(blocks: readonly ContentBlock[]): { system?: string; entries: TranscriptEntry[] } {
  const texts = blocks
    .filter((block): block is TextContent & { type: 'text' } => block.type === 'text')
    .map((block) => block.text)
  let system: string | undefined
  const entries: TranscriptEntry[] = []
  for (const text of texts) {
    if (text.startsWith(SYSTEM_OPEN) && text.endsWith(SYSTEM_CLOSE)) {
      system = text.slice(SYSTEM_OPEN.length, text.length - SYSTEM_CLOSE.length)
      continue
    }
    entries.push(...parseMessageEnvelopes(text))
  }
  return system === undefined ? { entries } : { system, entries }
}

function parseMessageEnvelopes(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  let cursor = 0
  for (;;) {
    const open = text.indexOf(MESSAGE_OPEN_PREFIX, cursor)
    if (open < 0) break
    const roleStart = open + MESSAGE_OPEN_PREFIX.length
    const roleEnd = text.indexOf(MESSAGE_OPEN_SUFFIX, roleStart)
    if (roleEnd < 0) break
    const bodyStart = roleEnd + MESSAGE_OPEN_SUFFIX.length
    const bodyEnd = text.indexOf(MESSAGE_CLOSE, bodyStart)
    if (bodyEnd < 0) break
    const role = text.slice(roleStart, roleEnd)
    const body = text.slice(bodyStart, bodyEnd)
    try {
      const content = JSON.parse(body) as unknown
      if (Array.isArray(content)) {
        entries.push({ role, content: content as unknown[] })
      } else if (role === 'tool' && content !== null && typeof content === 'object') {
        const payload = content as Record<string, unknown>
        if (Array.isArray(payload.content) && typeof payload.toolCallId === 'string' && typeof payload.isError === 'boolean') {
          entries.push({ role, content: payload.content, toolCallId: payload.toolCallId, isError: payload.isError })
        }
      }
    } catch {
      // 不是本模块产生的信封（非本 adapter 生成的内容）——按原文跳过，
      // 不猜测其结构。
    }
    cursor = bodyEnd + MESSAGE_CLOSE.length
  }
  return entries
}

/** 把一条 DSH tool 结果消息的内容块渲染成回喂给 MCP tools/call 的文本。 */
export function renderToolResultText(blocks: readonly { type: string; [key: string]: unknown }[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    // 非文本块（image/file 等）不进入 MCP 文本通道：DSH 侧对本 provider 只
    // 声明 text 输入模态，这里按 JSON 原样保留形状而不是丢弃信息。
    parts.push(JSON.stringify(block))
  }
  return parts.join('\n')
}
