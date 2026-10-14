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

/** 解析出的单条消息信封。 */
export interface TranscriptEntry {
  /** DSH 消息角色。 */
  role: string
  /** 该消息的 content 块（JSON 还原，形状与 DSH ContentBlock 一致）。 */
  content: unknown[]
}

function textBlock(text: string): TextContent & { type: 'text' } {
  return { type: 'text', text }
}

/** 把一条 DSH 请求消息编码成信封文本。 */
export function encodeMessage(message: RequestMessage): string {
  const payload = JSON.stringify(message.content)
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
