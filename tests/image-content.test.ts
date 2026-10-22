import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { buildPromptWithImages, buildToolResultContent } from '../src/adapter/image-content.js'

const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cCioAAAAASUVORK5CYII=', 'base64')
const ref = { attachmentId: 'sha256:test', mediaType: 'image/png', bytes: data.length, width: 1, height: 1 } as ImageAttachmentRef
const block: ImageBlock = { type: 'image', attachment: ref }

describe('host-owned native image transport', () => {
  it('sends verified image bytes as ACP image content, not a JSON replacement', async () => {
    const readImage = vi.fn(async () => ({ ref, data }))
    const result = await buildPromptWithImages(undefined, [createUserMessage({ content: [block], source: { kind: 'user' } })], [], { readImage, supported: true })
    // 图片仍是原生字节块（跟随消息信封），不是 JSON 文本替换。
    expect(result.filter((item) => item.type === 'image')).toEqual([
      { type: 'image', mimeType: 'image/png', data: data.toString('base64') },
    ])
    // 末尾是当前请求强调块：最新用户消息被明确标出，避免被历史注入块淹没。
    expect(result.at(-1)).toMatchObject({ type: 'text', text: expect.stringContaining('<dsh-current-request>') })
    expect(readImage).toHaveBeenCalledWith(ref, undefined)
    expect(result.filter((item) => item.type === 'text').some((item) => item.text.includes(data.toString('base64')))).toBe(false)
  })
  it('preserves native tool images and adjoining text in MCP results', async () => {
    expect(await buildToolResultContent([{ type: 'text', text: 'screenshot' }, block], { readImage: async () => ({ ref, data }), supported: true })).toEqual([
      { type: 'text', text: 'screenshot' }, { type: 'image', mimeType: 'image/png', data: data.toString('base64') },
    ])
  })
  it('offloaded image remains explicit text and is never read', async () => {
    const readImage = vi.fn()
    const result = await buildToolResultContent([{ ...block, offloaded: true }], { readImage, supported: false })
    expect(result).toEqual([{ type: 'text', text: expect.stringContaining('没有发送图像像素') }])
    expect(readImage).not.toHaveBeenCalled()
  })
  it('rejects unavailable capability and mismatched attachments', async () => {
    await expect(buildToolResultContent([block], { supported: false })).rejects.toMatchObject({ code: 'AGY_IMAGE_UNAVAILABLE' })
    await expect(buildToolResultContent([block], { supported: true, readImage: async () => ({ ref, data: data.subarray(1) }) })).rejects.toMatchObject({ code: 'AGY_INVALID_IMAGE' })
  })
  it('abort terminates waiting for an attachment backend that does not settle', async () => {
    const controller = new AbortController()
    const result = buildToolResultContent([block], { supported: true, readImage: async () => new Promise(() => {}), signal: controller.signal })
    controller.abort()
    await expect(result).rejects.toMatchObject({ code: 'AGY_ABORTED' })
  })
})
