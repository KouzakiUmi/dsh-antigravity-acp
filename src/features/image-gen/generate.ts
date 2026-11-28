/**
 * 图像生成工具的执行逻辑：用代理账户凭据直连 Cloud Code Assist 的
 * `generateContent`（非流式），声明 responseModalities 取 inlineData，
 * 落到宿主附件服务后返回工具结果。
 *
 * 协议口径照搬同版本参考实现 dsh-tool-antigravity 0.5.2（auth-core 3.0.14）：
 * - 端点 `cloudcode-pa / v1internal:generateContent`，已在代理线白名单；
 * - 模型经 `resolveModelWithTier` 校验为图像模型（isImageModel）；
 * - 请求体 `{ project?, model, request: { contents, generationConfig.responseModalities } }`；
 * - 响应递归找 `inlineData`/`inline_data` 的 `data`(base64) + `mimeType`。
 *
 * PNG→JPG 压缩坑（宿主 saveImage 会规范化图片）按火山方舟 media-image 的做法规避：
 * - `saveImage` 落会话预览图（宿主规范化后的真值，用于对话渲染与再次引用）；
 * - `saveFile` 落原始字节逐字节保真（供取原图，不受宿主规范化影响）。
 *
 * 本模块只做工具执行；工具注册与生命周期在 index.ts，端点白名单在 wire-identity。
 */
import { Buffer } from 'node:buffer'
import { resolveModelWithTier } from '@cortexkit/antigravity-auth-core'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { FeatureAttachmentStore, FeatureTransport } from '../types.js'

/** 图像生成端点（非流式；streamGenerateContent 的 SSE 帧里 inlineData 形态一致，但非流式更简单稳妥）。 */
export const IMAGE_GEN_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent'
/** 默认图像模型（auth-core 注册为 output modalities 含 image）。 */
export const DEFAULT_IMAGE_MODEL = 'antigravity-gemini-3.1-flash-image'
/** 单次最多生成图片数（与上游 n 上限对齐，避免超量计费）。 */
const MAX_IMAGES = 4
/** 单张结果字节上限（base64 解码前的上游响应有界化）。 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

export interface ImageGenCredential {
  readonly accessToken: string
  readonly projectId?: string
}

export interface ImageGenDeps {
  readonly credential: () => Promise<ImageGenCredential | undefined>
  readonly attachments: () => FeatureAttachmentStore | undefined
  readonly transport: FeatureTransport
}

/** 工具结果里一张图的可序列化表示（output.schema 校验 + render 重建块都从这里取）。 */
export interface ImageResultEntry {
  readonly text: string
  readonly images: ReadonlyArray<{
    readonly attachmentId: string
    readonly mediaType: string
    readonly bytes: number
    readonly width: number
    readonly height: number
    readonly name?: string
  }>
  readonly originals: ReadonlyArray<{
    readonly attachment: { readonly attachmentId: string; readonly name: string; readonly bytes: number }
    readonly mediaType: string
    readonly width: number
    readonly height: number
  }>
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'images'],
  properties: {
    text: { type: 'string' },
    images: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
        properties: {
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          name: { type: 'string' },
        },
      },
    },
    originals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['attachment', 'mediaType', 'width', 'height'],
        properties: {
          attachment: {
            type: 'object',
            additionalProperties: false,
            required: ['attachmentId', 'name', 'bytes'],
            properties: {
              attachmentId: { type: 'string' },
              name: { type: 'string' },
              bytes: { type: 'number' },
            },
          },
          mediaType: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
      },
    },
  },
} as const

/** 工具结果渲染：文本说明 + 预览图 image 块 + 原图 file 块（镜像火山方舟的双呈现）。 */
function renderResult(value: ImageResultEntry): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: value.text }]
  for (const image of value.images) {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: image.attachmentId as ImageAttachmentRef['attachmentId'],
        mediaType: image.mediaType as ImageAttachmentRef['mediaType'],
        bytes: image.bytes,
        width: image.width,
        height: image.height,
        ...(image.name === undefined ? {} : { name: image.name }),
      },
    })
  }
  for (const original of value.originals) {
    blocks.push({
      type: 'file',
      attachment: {
        attachmentId: original.attachment.attachmentId as FileAttachmentRef['attachmentId'],
        name: original.attachment.name,
        bytes: original.attachment.bytes,
      },
    })
  }
  return blocks
}

export function createImageGenTool(deps: ImageGenDeps): ToolDefinition {
  return {
    name: 'agy_image_generate',
    description: [
      '用当前代理账户的 Gemini 图像模型生成图片（Cloud Code Assist 端点）。',
      '生成结果落到会话附件：预览图用于对话展示，原始文件保留生成时的字节格式。',
      '需要已开启代理模式并登录代理账户；附件服务缺席时会报错。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 16_384, description: '图片生成提示词。' },
        n: { type: 'integer', minimum: 1, maximum: MAX_IMAGES, description: `生成图片数量，1-${MAX_IMAGES}，默认 1。` },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA as never,
      render: (_args, value) => renderResult(value as unknown as ImageResultEntry),
      presentationMeta: (_args, value) => value,
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: `agy_image_generate：${promptOf(args)}`,
      kind: 'other',
    }),
    presentResult: (args, result) => {
      const meta = (result.meta ?? null) as unknown
      const value: ImageResultEntry | null = meta !== null && typeof meta === 'object' && !Array.isArray(meta)
        ? (meta as ImageResultEntry)
        : null
      return {
        card: 'generic',
        title: `agy_image_generate：${promptOf(args)}`,
        ...(value === null || !Array.isArray(value.images) ? {} : { content: renderResult(value) }),
      }
    },
    async execute(args, exec): Promise<ImageResultEntry> {
      const prompt = readPrompt(args)
      const n = readCount(args)
      exec.signal?.throwIfAborted()

      const credential = await deps.credential()
      if (credential === undefined) {
        throw new Error('agy_image_generate 需要代理模式账户已登录：请在设置页开启代理模式并连接账户')
      }
      const attachments = deps.attachments()
      if (attachments === undefined) {
        throw new Error('agy_image_generate 需要宿主附件服务保存生成结果，但当前附件服务不可用')
      }

      const resolved = resolveModelWithTier(DEFAULT_IMAGE_MODEL)
      if (resolved.isImageModel !== true) {
        throw new Error(`agy_image_generate：模型 ${DEFAULT_IMAGE_MODEL} 未被识别为图像模型`)
      }
      const project = credential.projectId === undefined || credential.projectId === 'inductive-dreamer-qrkws'
        ? undefined
        : credential.projectId
      const body: Record<string, unknown> = {
        ...(project === undefined ? {} : { project }),
        model: resolved.actualModel,
        request: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        },
      }

      const images: Array<ImageResultEntry['images'][number]> = []
      const originals: Array<ImageResultEntry['originals'][number]> = []
      let firstFailure: Error | undefined
      for (let index = 0; index < n; index += 1) {
        exec.signal?.throwIfAborted()
        try {
          const response = await deps.transport.request({
            url: IMAGE_GEN_ENDPOINT,
            accessToken: credential.accessToken,
            body: JSON.stringify(body),
            signal: exec.signal,
          })
          if (!response.ok) {
            const detail = await boundedText(response, exec.signal)
            throw new Error(`上游拒绝生成（HTTP ${String(response.status)}）${detail.length === 0 ? '' : `：${detail}`}`)
          }
          const envelope = JSON.parse(await boundedText(response, exec.signal)) as unknown
          const candidate = collectInlineData(envelope)[0]
          if (candidate === undefined) {
            throw new Error('上游未返回图片数据（inlineData 为空）')
          }
          const bytes = decodeBase64(candidate.data)
          const mediaType = sniffImageMediaType(bytes) ?? normalizeMime(candidate.mediaType) ?? 'image/png'
          exec.signal?.throwIfAborted()
          const name = `agy-image-${Date.now()}-${String(index + 1)}.${extensionFor(mediaType)}`
          // 双保存：预览图（宿主规范化，渲染真值）+ 原图文件（逐字节保真，规避 PNG→JPG 压缩坑）。
          const preview = await attachments.saveImage({ data: bytes, mediaType, name })
          const original = await attachments.saveFile({ data: bytes, name })
          images.push({
            attachmentId: String(preview.attachmentId),
            mediaType: preview.mediaType,
            bytes: preview.bytes,
            width: preview.width,
            height: preview.height,
            ...(preview.name === undefined ? {} : { name: preview.name }),
          })
          originals.push({
            attachment: {
              attachmentId: String(original.attachmentId),
              name: String(original.name ?? name),
              bytes: Number(original.bytes ?? bytes.byteLength),
            },
            mediaType,
            width: preview.width,
            height: preview.height,
          })
        } catch (error) {
          if (exec.signal?.aborted === true) throw new Error('agy_image_generate 已取消')
          firstFailure ??= toError(error)
        }
      }
      if (images.length === 0) {
        throw firstFailure ?? new Error('agy_image_generate：没有生成出可保存的图片')
      }
      const lines = [
        `Generated ${String(images.length)} image(s) with Gemini image model via 代理账户。`,
        ...images.map((image, index) => `会话图片 ${String(index + 1)}：attachment=${JSON.stringify(safeImageRef(image))}`),
        ...originals.map((original, index) => `Original ${original.mediaType} file ${String(index + 1)}（取原图字节用，不作为会话图片参考）：attachment=${JSON.stringify(original.attachment)}`),
        '会话预览可能经宿主规范化（PNG 可能压缩为 JPG）；原始文件保持上游返回格式。',
      ]
      return { text: lines.join(' '), images, originals }
    },
  }
}

function safeImageRef(image: ImageResultEntry['images'][number]): Record<string, unknown> {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
  }
}

function promptOf(args: unknown): string {
  const value = isRecord(args) ? args.prompt : undefined
  return typeof value === 'string' ? (value.length > 60 ? `${value.slice(0, 60)}…` : value) : ''
}

function readPrompt(args: unknown): string {
  const value = isRecord(args) ? args.prompt : undefined
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 16_384) {
    throw new Error('agy_image_generate：prompt 必须是非空且不超过 16384 字符的字符串')
  }
  return value.trim().slice(0, 16_384)
}

function readCount(args: unknown): number {
  const value = isRecord(args) ? args.n : undefined
  if (value === undefined) return 1
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_IMAGES) {
    throw new Error(`agy_image_generate：n 必须是 1-${String(MAX_IMAGES)} 的整数`)
  }
  return value as number
}

/** 递归遍历响应，收集所有 inlineData/inline_data 的 base64 图片数据（镜像参考实现）。 */
function collectInlineData(value: unknown): ReadonlyArray<{ data: string; mediaType?: string }> {
  const output: Array<{ data: string; mediaType?: string }> = []
  const visit = (item: unknown, depth: number): void => {
    if (output.length >= MAX_IMAGES || depth > 32) return
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1)
      return
    }
    if (!isRecord(item)) return
    const inline = isRecord(item.inlineData) ? item.inlineData : isRecord(item.inline_data) ? item.inline_data : undefined
    if (inline !== undefined && typeof inline.data === 'string') {
      const mediaType = inline.mimeType ?? inline.mime_type
      output.push({ data: inline.data, ...(typeof mediaType === 'string' ? { mediaType } : {}) })
      return
    }
    for (const child of Object.values(item)) visit(child, depth + 1)
  }
  visit(value, 0)
  return output
}

async function boundedText(response: Response, signal: AbortSignal | undefined): Promise<string> {
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new Error('上游响应超出字节上限')
      chunks.push(value)
    }
    signal?.throwIfAborted()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(merged)
}

function decodeBase64(value: string): Uint8Array {
  const buffer = Buffer.from(value, 'base64')
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff])
const GIF87 = new TextEncoder().encode('GIF87a')
const GIF89 = new TextEncoder().encode('GIF89a')

function sniffImageMediaType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, PNG)) return 'image/png'
  if (startsWith(bytes, JPEG)) return 'image/jpeg'
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return 'image/gif'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return undefined
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i += 1) if (bytes[i] !== prefix[i]) return false
  return true
}

function normalizeMime(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  return normalized === 'image/png' || normalized === 'image/jpeg' || normalized === 'image/webp' || normalized === 'image/gif'
    ? normalized
    : undefined
}

function extensionFor(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg': return 'jpg'
    case 'image/png': return 'png'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}
