/**
 * DSH 请求历史 → ACP `session/prompt` 内容的序列化（原创实现）。
 *
 * 设计前提（硬约束）：**DSH 是历史权威**。本文件不建任何会话存储、数据库
 * 或文件——新轮把 `GenerateOptions.messages` + `options.system` 完整编码进
 * ACP prompt，工具续轮则直接通过 MCP 返回结果，不重复发送历史。
 *
 * 载体格式：ACP 的 `PromptRequest.prompt` 是 `ContentBlock[]`，本实现把每条
 * DSH 消息编码成一个 `TextContent` 信封块：
 *
 *     <dsh-message role="user">{"content":[{"type":"text","text":"hi"}]}</dsh-message>
 *
 * 信封用尖括号标签（与 JSON 字符串正文互不干扰：标签本身不是合法 JSON），
 * role 属性保留了角色边界，正文是该消息 content 块的 JSON 数组。
 * `parsePromptTranscript` 可无损还原 role 与 content，因此映射是**可逆**的；
 * 需要建立新轮时，历史里的 tool-call / tool result 同样以信封进入 prompt，
 * agent 得以看到完整的 DSH 侧工具轨迹。
 *
 * `options.system` 单独编码为一个 `<dsh-system>` 块放在最前。
 */
import type { ContentBlock, TextContent } from '@agentclientprotocol/sdk'
import type { RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { renderToolSignatures } from './tool-args.js'

/** 消息信封的起始标签前缀（后跟 `role="…"` 与 `>`）。 */
const MESSAGE_OPEN_PREFIX = '<dsh-message role="'
const MESSAGE_OPEN_SUFFIX = '">'
const MESSAGE_CLOSE = '</dsh-message>'
const SYSTEM_OPEN = '<dsh-system>'
const SYSTEM_CLOSE = '</dsh-system>'
/** 工具策略说明块的哨兵（固定文本，不参与消息逆解析）。 */
const POLICY_OPEN = '<dsh-tool-policy>'
const POLICY_CLOSE = '</dsh-tool-policy>'
/** 工具参数签名块的哨兵（固定文本，不参与消息逆解析）。 */
const SIGNATURES_OPEN = '<dsh-tool-signatures>'
const SIGNATURES_CLOSE = '</dsh-tool-signatures>'
/** 历史重放说明块的哨兵（固定文本，不参与消息逆解析）。 */
export const HISTORY_OPEN = '<dsh-conversation-history>'
export const HISTORY_CLOSE = '</dsh-conversation-history>'
/** 当前请求强调块的哨兵（纯文本，不参与消息逆解析）。 */
export const CURRENT_REQUEST_OPEN = '<dsh-current-request>'
export const CURRENT_REQUEST_CLOSE = '</dsh-current-request>'

/**
 * 每次 prompt 都会附带的一段工具策略说明。
 *
 * 会话同时关闭 AGY 内置工具和 ACP fs/terminal，并加载 DSH 的 MCP schema。
 * 此处说明工具入口与结果语义，避免模型沿用原生工具习惯或误解 DSH 的拒绝。
 */
export const TOOL_POLICY_TEXT = [
  '本会话运行在 DSH（DeepSeek Harness）集成中，工具与 DSH 对齐：',
  '- 随本会话提供的工具列表就是你的工具入口；读写文件、执行命令、搜索代码请一律使用它们，它们与 DSH 的权限与审计一致。',
  '- agy 的原生工具（read_file / write_file / edit_file / run_command / view_file / list_dir / grep_search / find_by_name 等）在本集成中不可用：会话已关闭内置工具与客户端 fs/terminal 能力。',
  '- 不要反复索要原生能力；直接改用等价的随会话工具完成。',
  '- 随会话 MCP 工具由 DSH 审批和执行，结果会在当前 ACP prompt 内返回；isError=true 的拒绝/失败是权威结果，不要绕过审批或重复执行。',
  '- ACP 权限拒绝可能发生在插件转交 DSH 之前。仅凭 Denied by user 或 pre-tool hook 文本，不能断言 DSH 全局禁用了工具，也不能建议关闭沙箱或审批。请明确报告拒绝来源尚未核实。',
].join('\n')

/**
 * 历史重放说明。新轮会把整段 DSH 历史（含大量工具轨迹）编码进同一条 ACP
 * prompt；官方 agent 每轮新建会话、没有原生对话历史，只能靠这段文字判断
 * 「现在要做什么」。不声明边界时它会顺着历史里未完成的任务继续跑，表现为
 * 「用户后续的话没传过去」。
 */
export const HISTORY_NOTICE_TEXT = [
  '下面是本次请求之前已经发生的对话与工具轨迹，作为背景资料重放；它们不是新的任务请求。',
  '不要因为历史里还有未完成的步骤就继续它。',
].join('\n')

/** 当前请求说明：把最新一条真实用户消息从历史里单独强调出来。 */
export const CURRENT_REQUEST_NOTICE_TEXT = [
  '当前需要回应的最新用户消息如下（以此为准，优先级高于上面的历史）。',
  '请直接回应它；只有它明确要求继续时，才续做历史里未完成的工作。',
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
 * 构造一次 ACP prompt 的 content 块序列：system（若给出）在前，随后工具策略、
 * 历史重放说明、每条 DSH 消息一个信封块，最后是最新用户请求的强调块。
 * 空 system 文本不产生块（ACP 的 TextContent.text 为空串没有语义价值）。
 */
export function buildPromptContent(
  system: string | undefined,
  messages: readonly RequestMessage[],
  tools: readonly ToolSchema[] = [],
): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (system !== undefined && system !== '') blocks.push(textBlock(`${SYSTEM_OPEN}${system}${SYSTEM_CLOSE}`))
  // 工具策略紧随 system：告诉模型原生 fs/terminal 在这里拿不到权限，请用随会话工具。
  blocks.push(textBlock(`${POLICY_OPEN}${TOOL_POLICY_TEXT}${POLICY_CLOSE}`))
  // 官方只把 MCP 工具 schema 落成磁盘文件，模型常常不读就猜参数；把紧凑签名直接放进
  // prompt，让必填项与参数名在调用时就可见。
  const signatures = renderToolSignatures(tools)
  if (signatures !== undefined) blocks.push(textBlock(`${SIGNATURES_OPEN}${signatures}${SIGNATURES_CLOSE}`))
  // 声明历史只是背景，避免模型把上一轮未完成的工具循环当成当前任务。
  if (messages.length > 0) blocks.push(historyNoticeBlock())
  for (const message of messages) blocks.push(textBlock(encodeMessage(message)))
  // 最新用户请求放到最后：它前面可能还跟着 time-context / hindsight 等注入块，
  // 不强调时模型会把注意力停在旧任务上。
  const current = currentRequestBlock(messages)
  if (current) blocks.push(current)
  return blocks
}

/** 历史重放说明块；不参与消息逆解析。 */
export function historyNoticeBlock(): ContentBlock {
  return textBlock(`${HISTORY_OPEN}${HISTORY_NOTICE_TEXT}${HISTORY_CLOSE}`)
}

/**
 * 最新的真实用户请求。
 *
 * DSH 会在用户消息之后继续追加 `user` 角色的注入块（time-context /
 * runtime-context / hindsight / 技能目录…），它们带自己的 `source.kind`；
 * 只看 role 会把最后一条注入块误当请求。一次性请求（RequestUserInput）没有
 * source，按用户输入处理。
 */
export function latestUserRequest(messages: readonly RequestMessage[]): RequestMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    const source = (message as { readonly source?: { readonly kind?: unknown } }).source
    if (source === undefined || source.kind === 'user') return message
  }
  return undefined
}

/**
 * 当前请求强调块：纯文本复制最新用户消息的可见内容。
 *
 * 刻意不复制 `<dsh-message>` 信封——否则 `parsePromptTranscript` 会把同一条
 * 消息解析两次；这里只需要给模型一个明确的「现在回这条」信号。
 */
export function currentRequestBlock(messages: readonly RequestMessage[]): ContentBlock | undefined {
  const latest = latestUserRequest(messages)
  if (!latest) return undefined
  const parts: string[] = []
  for (const block of latest.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push('[本条消息附带图片，见上文对应的消息块]')
    else parts.push(`[本条消息附带 ${block.type} 内容，见上文对应的消息块]`)
  }
  const body = parts.join('\n').trim()
  return textBlock([
    CURRENT_REQUEST_OPEN,
    CURRENT_REQUEST_NOTICE_TEXT,
    body === '' ? '（本条消息没有文本内容）' : body,
    CURRENT_REQUEST_CLOSE,
  ].join('\n'))
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
    // 历史说明与当前请求强调块只为引导模型，不是消息本身：跳过它们，
    // 否则当前请求的纯文本副本会被重复计入逆解析结果。
    if (text.startsWith(HISTORY_OPEN) || text.startsWith(CURRENT_REQUEST_OPEN)) continue
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

/** Legacy text-only helper; native image results use buildToolResultContent. */
export function renderToolResultText(blocks: readonly { type: string; [key: string]: unknown }[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    throw new LlmError('非文本工具结果必须使用原生内容通道，不能序列化为 JSON 文本', 'AGY_UNSUPPORTED_CONTENT')
  }
  return parts.join('\n')
}
