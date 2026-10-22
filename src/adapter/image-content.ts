import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock as DshContentBlock, ImageBlock, RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { buildPromptContent, encodeMessage } from './prompt-transcript.js'

export type ImageReader = (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<StoredImageAttachment>
export interface ImageContentOptions {
  readImage?: ImageReader
  supported: boolean
  signal?: AbortSignal
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LlmError('图像读取已取消', 'AGY_ABORTED')
}

async function imageContent(block: ImageBlock, options: ImageContentOptions): Promise<ContentBlock> {
  aborted(options.signal)
  if (block.offloaded) return { type: 'text', text: '[此图像已由 DSH 卸载，本次没有发送图像像素。]' }
  if (!options.supported || !options.readImage) {
    throw new LlmError('当前 ACP 连接或 DSH 附件服务不支持图像读取，无法发送这张图片；请连接支持图像的 ACP 服务后重试', 'AGY_IMAGE_UNAVAILABLE')
  }
  const signal = options.signal
  let cleanup = (): void => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    const cancel = (): void => reject(new LlmError('图像读取已取消', 'AGY_ABORTED'))
    signal?.addEventListener('abort', cancel, { once: true })
    cleanup = () => signal?.removeEventListener('abort', cancel)
    if (signal?.aborted) cancel()
  })
  let stored: StoredImageAttachment
  try {
    stored = await Promise.race([options.readImage(block.attachment, signal), cancelled])
  } finally { cleanup() }
  aborted(signal)
  if (stored.ref.attachmentId !== block.attachment.attachmentId || stored.ref.mediaType !== block.attachment.mediaType
    || !(stored.data instanceof Uint8Array) || stored.data.byteLength !== block.attachment.bytes
    || stored.data.byteLength === 0 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(stored.ref.mediaType)) {
    throw new LlmError('DSH 附件读取结果与图像引用不一致，已停止发送', 'AGY_INVALID_IMAGE')
  }
  return { type: 'image', mimeType: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64') }
}

/** Native image blocks follow the message envelope that owns them; bytes only come from the host attachment service. */
export async function buildPromptWithImages(
  system: string | undefined, messages: readonly RequestMessage[], tools: readonly ToolSchema[], options: ImageContentOptions,
): Promise<ContentBlock[]> {
  const content = buildPromptContent(system, [], tools)
  for (const message of messages) {
    aborted(options.signal)
    content.push({ type: 'text', text: encodeMessage(message) })
    for (const block of message.content) {
      if (block.type === 'image') content.push(await imageContent(block, options))
      else if (block.type === 'file') throw new LlmError('文件引用必须先由 DSH 投影为可读文本', 'AGY_UNSUPPORTED_CONTENT')
    }
  }
  return content
}

export async function buildToolResultContent(
  blocks: readonly DshContentBlock[], options: ImageContentOptions,
): Promise<CallToolResult['content']> {
  const content: CallToolResult['content'] = []
  for (const block of blocks) {
    aborted(options.signal)
    if (block.type === 'image') {
      const image = await imageContent(block, options)
      if (image.type === 'image') content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
      else if (image.type === 'text') content.push({ type: 'text', text: image.text })
    } else if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else throw new LlmError(`工具结果包含尚不支持的内容类型：${block.type}`, 'AGY_UNSUPPORTED_CONTENT')
  }
  return content
}
