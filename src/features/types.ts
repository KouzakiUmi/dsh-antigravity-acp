/**
 * 可插拔附属功能模块的契约。
 *
 * Google One / Google AI Pro 的附属能力（图像生成、视频、AI Studio 等）不走
 * 核心 ACP / 代理两条生成链路，而是作为独立的「功能模块」注册在 {@link FeatureRegistry}
 * 里，由用户在设置页逐项手动开关。开关走 volatile 配置即时生效，不重载宿主。
 *
 * 设计参考 dsh-subusage 的 provider 注册表 + dsh-unified-router 的 pack-registry：
 * - 规格表（FEATURE_SPECS）与实现表（MOUNTS）分离；
 * - 加载期双向校验：有规格无实现 / 有实现无规格都直接抛错，不等用户开关才发现静默失效；
 * - 模块只经注入的 {@link FeatureContext} 与宿主通信，不直引核心生成链路的内部类。
 *
 * 模块拿宿主能力的两条路径：
 * - 经 {@link FeatureContext} 上显式声明的钩子（工具注册、附件写入、代理线传输等），
 *   由 feature-runtime 装配时从宿主行注入；缺席对应能力的模块自行降级（如附件服务
 *   不在场时图像生成报可读错误，不影响文本生成）。
 * - 经 {@link FeatureContext.ctx} 拿真实 cordis Context 做 provide / inject / emit，
 *   仅在确需与宿主生命周期联动时使用，类型由调用方自行断言。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** 功能模块兼容的生成模式。 */
export type FeatureMode = 'acp' | 'proxy'

/** 功能模块需要的上游端点（用于白名单扩展校验；骨架阶段只登记不消费）。 */
export interface FeatureEndpoints {
  /** 允许的 origin（必须 https）。 */
  readonly origins?: readonly string[]
  /** 允许的 pathname（精确匹配）。 */
  readonly paths?: readonly string[]
}

/** 一个功能模块的规格声明（唯一真源：能开什么、默认开不开、兼容哪种模式）。 */
export interface FeatureSpec {
  /** 稳定 id；同时是 Config.features 字典的键与设置页开关的标识。 */
  readonly id: string
  /** 设置页显示名。 */
  readonly name: string
  /** 设置页一行说明；只写可验证事实，不写免责语气。 */
  readonly description: string
  /** 默认是否启用；附属功能一律默认关闭。 */
  readonly defaultEnabled: boolean
  /** 兼容的生成模式；当前模式不在此列时该功能不挂载（即使开关打开）。 */
  readonly compatibleModes: readonly FeatureMode[]
  /** 需要的上游端点；加载期校验只允许 https + 已知 Google 域。 */
  readonly endpoints?: FeatureEndpoints
  /** 标记实验性 / 待探针验证（如 video-gen）：设置页展示徽章但仍可开关。 */
  readonly experimental?: boolean
}

/** 模块挂载后的清理句柄；unmount 必须幂等。 */
export interface FeatureMountHandle {
  unmount?: () => void | Promise<void>
}

/** 注入给每个功能模块的宿主能力面。模块只经此对象与宿主交互。 */
export interface FeatureContext {
  /** 宿主日志；敏感信息由调用方先脱敏。 */
  readonly log: {
    info(message: string): void
    warn(message: string, error?: unknown): void
  }
  /** 代理感知 fetch（与官方进程 / 代理链路同一套出网设置）。 */
  readonly fetch: typeof fetch
  /** 当前生成模式。 */
  readonly mode: () => FeatureMode
  /** 通知宿主刷新模型选择器目录（功能挂载/卸载可能改变可见模型）。 */
  readonly catalogChanged: () => void
  /**
   * 声明本功能需要的上游端点。加载期校验端点在允许域内（仅 https + 已知 Google 域），
   * 返回 false 表示端点被拒绝、功能应降级。端点白名单的实际消费在代理传输层。
   */
  readonly declareEndpoints: (endpoints: FeatureEndpoints) => boolean
  /** 取代理账户凭据（仅代理模式在场）；ACP 模式返回 undefined。 */
  readonly proxyCredential?: () => Promise<{ accessToken: string; projectId?: string } | undefined>
  /**
   * 注册一个 DSH 工具（宿主 tools 服务在场时可用）。返回 dispose 句柄；
   * 工具服务缺席时返回 undefined，模块应降级不报致命错误（文本生成不受影响）。
   * 工具结果经 `output.render` 返回的 image 块是宿主已上线验证的渲染路径
   * （参考 grok / codex-connect / 火山方舟），优先于让助手原生输出 image 块。
   */
  readonly registerTool?: (definition: ToolDefinition) => (() => void) | undefined
  /**
   * 宿主附件服务的写入面（在场时可用）。图像生成把上游 inlineData 落进：
   * - `saveImage`：会话预览图（宿主会规范化，PNG 可能被压缩成 JPG，返回的 ref 字段才是真值）；
   * - `saveFile`：原始字节逐字节保真（规避 PNG→JPG 压缩坑，供取原图）。
   * 附件服务缺席时图像生成报可读错误，不影响文本生成。
   */
  readonly attachments?: () => FeatureAttachmentStore | undefined
  /**
   * 代理线传输（agy 线身份，端点白名单已含 Cloud Code Assist 生成方法）。
   * 仅代理模式在场；图像生成工具用它直发 `generateContent`，不走核心 SSE 解析链路。
   */
  readonly proxyTransport?: FeatureTransport
  /** 宿主附件服务读引用（在场时可用）。 */
  readonly readImage?: (ref: unknown, signal?: AbortSignal) => Promise<unknown>
  /** 宿主 cordis 上下文（用于 provide / inject / emit 宿主服务）。 */
  readonly ctx: unknown
}

/** 功能模块需要的附件写入面（AttachmentStore 的最小子集，避免直引宿主类型细节）。 */
export interface FeatureAttachmentStore {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRef>
  saveFile(input: { data: Uint8Array; name: string }): Promise<FileAttachmentRef>
}

/** 功能模块需要的代理线传输（ProxyTransport 的最小子集）。 */
export interface FeatureTransport {
  request(input: {
    url: string
    accessToken?: string
    body: string | Uint8Array
    signal?: AbortSignal
  }): Promise<Response>
}

/** 功能模块的挂载实现。 */
export type FeatureMount = (context: FeatureContext) => FeatureMountHandle | void

/** 一个已登记的功能条目：规格 + 实现。 */
export interface FeatureEntry {
  readonly spec: FeatureSpec
  readonly mount: FeatureMount
}
