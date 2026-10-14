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
})
