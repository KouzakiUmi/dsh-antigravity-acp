/**
 * 图像生成功能模块：注册 `agy_image_generate` DSH 工具，让文本模型在对话中
 * 调用它生成图片，结果落到会话附件。
 *
 * 实现路径（参考 grok / codex-connect / 火山方舟，以及同 auth-core 版本的
 * dsh-tool-antigravity 0.5.2）：
 * - 工具自己用代理账户凭据直连 Cloud Code Assist 的 generateContent，
 *   声明 responseModalities 取 inlineData，不经过核心 SSE 解析链路；
 *   因此不需要改代理适配器里那 5 处 image 输出过滤，也不把图像模型塞进 DSH
 *   模型选择器（避免 text-only 路由拒绝它）。
 * - 工具结果经 output.render 返回 image 块——这是宿主已上线验证的渲染路径
 *   （助手原生输出 image 块是 forward compatibility，有不渲染风险，故不走）。
 * - PNG→JPG 压缩坑按火山方舟做法规避：saveImage（预览，宿主规范化真值）
 *   + saveFile（原图逐字节保真）双保存。
 *
 * 仅代理模式（compatibleModes: ['proxy']）：工具需要代理账户凭据与代理线传输；
 * ACP 模式下官方 agent 自己的图像生成链路另议，不在本模块范围。
 */
import type { FeatureContext, FeatureMountHandle, FeatureSpec } from '../types.js'
import { createImageGenTool } from './generate.js'

export const IMAGE_GEN_SPEC: FeatureSpec = {
  id: 'image-gen',
  name: '图像生成',
  description: '在代理模式下注册 agy_image_generate 工具：模型调用后用代理账户的 Gemini 图像模型生成图片，预览图落到对话、原始文件保留生成格式。需开启代理模式并登录代理账户。',
  defaultEnabled: false,
  // 图像生成复用 Cloud Code Assist 的 generateContent，代理模式直连可达；
  // ACP 模式需官方 agent 透传 inlineData，待实机验证后再加入 compatibleModes。
  compatibleModes: ['proxy'],
  endpoints: {
    // 图像生成复用核心生成端点，不新增目的地；端点已在代理线白名单（wire-identity）。
    origins: ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'],
    paths: ['/v1internal:generateContent'],
  },
}

export function mountImageGen(context: FeatureContext): FeatureMountHandle {
  const declared = context.declareEndpoints(IMAGE_GEN_SPEC.endpoints ?? {})
  if (!declared) {
    context.log.warn('antigravity-features: image-gen 端点声明被拒绝，功能未实际生效')
    return { unmount() { /* 已被端点校验拒绝，无资源需清理 */ } }
  }

  // 运行时能力门控：工具服务 / 附件服务 / 代理传输 / 代理凭据缺一不可，
  // 缺席时不静默注册一个必然失败的工具，而是记日志让用户知道为什么不可用。
  if (context.registerTool === undefined) {
    context.log.warn('antigravity-features: image-gen 未注册工具（宿主 tools 服务不可用）')
    return { unmount() {} }
  }
  if (context.attachments === undefined) {
    context.log.warn('antigravity-features: image-gen 未注册工具（宿主附件服务不可用）')
    return { unmount() {} }
  }
  if (context.proxyTransport === undefined || context.proxyCredential === undefined) {
    context.log.warn('antigravity-features: image-gen 未注册工具（代理模式传输或凭据不可用，请确认已开启代理模式并登录账户）')
    return { unmount() {} }
  }

  const dispose = context.registerTool(createImageGenTool({
    credential: context.proxyCredential,
    attachments: context.attachments,
    transport: context.proxyTransport,
  }))
  if (dispose === undefined) {
    context.log.warn('antigravity-features: image-gen 工具注册被宿主拒绝')
    return { unmount() {} }
  }

  context.log.info('antigravity-features: 图像生成模块已挂载（已注册 agy_image_generate 工具）')
  return {
    unmount() {
      dispose()
      context.log.info('antigravity-features: 图像生成模块已卸载（已注销 agy_image_generate 工具）')
    },
  }
}
