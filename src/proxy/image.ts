/**
 * 代理模式的图片准入：把 DSH 附件引用读成上游 `inlineData` part。
 *
 * 口径与 dsh-tool-antigravity 0.5.2 的私有路由一致：
 * - 单图请求版本上限 4MP / 1MB（`readImageRequest` 由宿主附件服务投影与压缩）；
 * - 整请求内联图片预算 12MB（base64 表示字节），超预算按「最旧优先」协商
 *   `IMAGE_OFFLOAD_REQUIRED`，由宿主 offload 后重试；
 * - 已被宿主 offload 的图片投影成占位文本（`offloadedImageText`），不谎称发送了像素；
 * - 附件服务缺席时图片输入报 `UNSUPPORTED_MODALITY`，文本能力不受影响。
 */
import { Buffer } from 'node:buffer'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { LlmError, offloadedImageText, projectOffloadedImages, requiredImageOffload } from '@deepseek-ai/dsh-llm'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'

export const PROXY_REQUEST_IMAGE_MAX_PIXELS = 4 * 1024 * 1024
export const PROXY_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
/** 内联图片预算：base64 表示字节；超出即协商 offload。 */
export const PROXY_INLINE_IMAGE_BYTES = 12 * 1024 * 1024

export type ProxyAttachmentReader = Pick<AttachmentStore, 'readImage'> & {
  readImageRequest?(ref: ImageAttachmentRef, bounds: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array; mediaType: string }>
}

export interface ProxyImageRead {
  mediaType: string
  encoded: string
  bytes: number
}

export function proxyImageRequestTarget(ref: ImageAttachmentRef): ImageRequestTarget {
  return { ...requestImageDimensions(ref.width, ref.height, PROXY_REQUEST_IMAGE_MAX_PIXELS), maxBytes: PROXY_REQUEST_IMAGE_MAX_BYTES }
}

/** 把已 offload 的图片投影成占位文本；未 offload 的保持原样。 */
export function projectProxyOffloadedImages(messages: readonly RequestMessage[]): readonly RequestMessage[] {
  return projectOffloadedImages(messages, (ref: ImageAttachmentRef) => offloadedImageText(ref))
}

/** 读取一张请求版本图片；优先 `readImageRequest`（带尺寸与字节上限）。 */
export async function readProxyImage(
  attachments: ProxyAttachmentReader,
  ref: ImageAttachmentRef,
  signal: AbortSignal | undefined,
): Promise<ProxyImageRead> {
  if (signal?.aborted) throw new LlmError('代理模式请求已取消', 'CANCELLED')
  if (typeof attachments.readImageRequest === 'function') {
    const stored = await withImageAbort(attachments.readImageRequest(ref, proxyImageRequestTarget(ref), signal), signal)
    validateImageBytes(stored.data, stored.mediaType)
    return { mediaType: stored.mediaType, encoded: Buffer.from(stored.data).toString('base64'), bytes: stored.data.byteLength }
  }
  if (ref.width * ref.height > PROXY_REQUEST_IMAGE_MAX_PIXELS) throw new LlmError('宿主附件服务未提供请求图片缩放，图片超出像素上限', 'UNSUPPORTED_MODALITY')
  const stored = await withImageAbort(attachments.readImage(ref as never, signal), signal)
  validateImageBytes(stored.data, stored.ref.mediaType)
  return { mediaType: stored.ref.mediaType, encoded: Buffer.from(stored.data).toString('base64'), bytes: stored.data.byteLength }
}

function validateImageBytes(data: Uint8Array, mediaType: string): void {
  if (data.byteLength === 0 || data.byteLength > PROXY_REQUEST_IMAGE_MAX_BYTES || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
    throw new LlmError('代理模式请求图片超出字节上限或媒体类型不受支持', 'UNSUPPORTED_MODALITY')
  }
}

async function withImageAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      onAbort = () => reject(new LlmError('代理模式请求已取消', 'CANCELLED'))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })])
  } finally { if (onAbort !== undefined) signal.removeEventListener('abort', onAbort) }
}

/**
 * 还需 offload 多少张最旧的保留图片才能让内联预算成立；0 表示当前请求放得下。
 * `sentBytes` 是本次实际发送的每张附件字节（base64 前），缺省时按引用上的 bytes 估。
 */
export function requiredProxyImageOffload(
  messages: readonly RequestMessage[],
  sentBytes: ReadonlyMap<string, number> | undefined,
): number {
  return requiredImageOffload(messages, { representation: 'base64', maxBytes: PROXY_INLINE_IMAGE_BYTES }, (block) => {
    const attachment = isRecord(block) && isRecord((block as Record<string, unknown>).attachment)
      ? (block as Record<string, unknown>).attachment as Record<string, unknown>
      : undefined
    const attachmentId = attachment && typeof attachment.attachmentId === 'string' ? attachment.attachmentId : undefined
    const sent = attachmentId === undefined ? undefined : sentBytes?.get(attachmentId)
    if (typeof sent === 'number') return sent
    return attachment && typeof attachment.bytes === 'number' ? attachment.bytes : 0
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
