/**
 * 插件配置接口与 schemastery Schema。
 * schema 写法对准已安装 @deepseek-ai/schemastery 3.18.x 的实际导出。
 */
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_ACP_SERVER_VERSION } from './runtime/binary.js'

export interface AntigravityHostConfig {
  /** 官方 agy-acp-server 可执行文件路径；优先级高于 AGY_ACP_BIN 与自动下载。 */
  binaryPath?: string
  /** 未找到本地二进制时是否自动从 dl.google.com 下载（默认 true）。 */
  autoDownload?: boolean
  /** 传给 ACP server 的额外命令行参数。 */
  extraArgs?: string[]
  /** 自动下载的目标版本（默认 1.4.0）。 */
  acpVersion?: string
  /** 单个 ACP 请求默认超时（毫秒）。 */
  requestTimeoutMs?: number
  /**
   * authenticate（oauth-personal，需人工在浏览器完成授权）的等待上限（毫秒）。
   * 独立于 requestTimeoutMs，默认 5 分钟。
   */
  authTimeoutMs?: number
  /** 单轮 session/prompt 的等待上限（毫秒）；ACP 回合可能很长，默认 30 分钟。 */
  promptTimeoutMs?: number
  /** 并发 MCP tools/call 的聚合窗口（毫秒），决定同一轮携带多少 tool-call block。 */
  bridgeParkSettleMs?: number
  /**
   * 首选官方模型 id。选择器里的 server-default 占位会映射到此值；
   * 留空则沿用官方会话默认模型。
   */
  preferredModel?: string
  /**
   * 官方进程出网代理（如 http://127.0.0.1:7890）。留空表示直连；
   * 填入后同时注入大小写两套 *_PROXY 与 NO_PROXY。
   */
  proxyUrl?: string
  /**
   * 代理排除列表（逗号分隔）。localhost/127.0.0.1/::1 始终自动排除，
   * 因为私有 MCP 桥与 OAuth 回调都在 loopback 上。
   */
  proxyBypass?: string
}

export const Config = Schema.object({
  binaryPath: Schema.string().description('官方 agy-acp-server 可执行文件路径；留空则按 AGY_ACP_BIN → 缓存 → 自动下载解析'),
  autoDownload: Schema.boolean().default(true).description('未找到本地二进制时自动从 dl.google.com 下载（仅 https + 官方域名 + 拒绝重定向）'),
  extraArgs: Schema.array(Schema.string()).default([]).description('传给 ACP server 的额外命令行参数'),
  acpVersion: Schema.string().default(DEFAULT_ACP_SERVER_VERSION).description('自动下载的 ACP server 版本'),
  requestTimeoutMs: Schema.natural().default(30_000).description('单个 ACP 请求默认超时（毫秒）'),
  authTimeoutMs: Schema.natural().default(300_000).description('authenticate（需人工在浏览器完成 OAuth 授权）的等待上限（毫秒）'),
  promptTimeoutMs: Schema.natural().default(1_800_000).description('单轮 session/prompt 的等待上限（毫秒）'),
  bridgeParkSettleMs: Schema.natural().default(50).description('并发 MCP tools/call 的聚合窗口（毫秒）'),
  preferredModel: Schema.string().description('首选官方模型 id（如 gemini-3.8-flash-high）。选择器占位 server-default 会映射到此值；留空则用官方默认'),
  proxyUrl: Schema.string().description('官方进程出网代理，如 http://127.0.0.1:7890（缺 scheme 按 http 处理）。留空则直连'),
  proxyBypass: Schema.string().description('代理排除列表，逗号分隔，如 10.0.0.0/8,*.internal。localhost/127.0.0.1/::1 始终自动排除'),
})
