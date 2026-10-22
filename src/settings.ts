/**
 * 插件配置接口与 schemastery Schema。
 * schema 写法对准已安装 @deepseek-ai/schemastery 3.18.x 的实际导出。
 */
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_ACP_SERVER_VERSION } from './runtime/binary.js'

export interface AntigravityHostConfig {
  /** Maximum independent ACP workers, started on demand. */
  maxConcurrentSessions?: number
  /** Maximum wait for an available worker. */
  queueTimeoutMs?: number
  /** Explicit official CLI path, re-detected for manual reads. */
  agyCliPath?: string
  /** 插件启用时提前启动 ACP 连接并保留给聊天使用；不发送模型消息。 */
  autoWarmup?: boolean
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
  /** initialize 握手等待上限（毫秒）；官方进程冷启动可达 1 分钟。 */
  handshakeTimeoutMs?: number
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
   * 默认/自定义模型 id：在目录中优先显示，目录外 id 标为用户配置、未验证。
   * 旧会话的 server-default 路由仍映射到此值；留空不指定默认项。
   */
  preferredModel?: string
  /**
   * 官方进程出网代理（如 http://127.0.0.1:7890）。留空继承宿主代理，宿主未配置才直连；
   * 填入后同时注入大小写两套 *_PROXY 与 NO_PROXY。
   */
  proxyUrl?: string
  /**
   * 代理排除列表（逗号分隔）。localhost/127.0.0.1/::1 始终自动排除，
   * 因为私有 MCP 桥与 OAuth 回调都在 loopback 上。
   */
  proxyBypass?: string
  /**
   * 复用同一个 ACP 会话：同一 DSH 对话的后续回合只发送新增消息，不再每轮
   * `session/new` 并重放全部历史。历史被压缩/回退、模型或工具目录变化时
   * 仍会受控重建。关闭后回到「每轮新会话 + 全量重放」的旧行为。
   */
  reuseSessions?: boolean
  /**
   * 跨进程恢复 ACP 会话：插件/宿主重启后，若上次留下会话映射，尝试用
   * `session/load` 恢复该对话而不是从零重建。依赖 agent 的 `loadSession`
   * 能力；agent 侧历史可能与 DSH 当前历史不一致，失败时自动回退重建。
   */
  resumeSessions?: boolean
  /**
   * 用户取消（停止按钮）后是否保留官方进程：默认关闭（立即回收，下一轮冷启动）。
   * 开启后先等 `cancelGraceMs` 让 agent 确认停止；确认了就只丢弃会话、保留进程。
   */
  keepProcessAfterCancel?: boolean
  /** 取消后的确认宽限（毫秒）；0 表示不等待、立即回收。 */
  cancelGraceMs?: number
  /** 保留进程的最长空闲时间（毫秒），超时回收；0 表示不设上限。 */
  idleRecycleMs?: number
}

export const Config = Schema.object({
  maxConcurrentSessions: Schema.natural().min(1).max(4).default(2).description('最大并发 ACP 连接数（1–4），按需启动；不同对话互不占用工具审批回合'),
  queueTimeoutMs: Schema.natural().min(1000).default(120000).description('等待空闲 ACP 连接的最长时间（毫秒），排队期间可取消'),
  agyCliPath: Schema.string().description('官方 agy CLI 路径；留空依次查 AGY_CLI_BIN、PATH 和默认安装目录'),
  autoWarmup: Schema.boolean().default(true).description('插件启用时预热并保留 ACP 连接，减少首次聊天启动等待；复用本机登录态，不发送模型消息'),
  binaryPath: Schema.string().description('官方 agy-acp-server 可执行文件路径；留空则按 AGY_ACP_BIN → 缓存 → 自动下载解析'),
  autoDownload: Schema.boolean().default(true).description('未找到本地二进制时自动从 dl.google.com 下载（仅 https + 官方域名 + 拒绝重定向）'),
  extraArgs: Schema.array(Schema.string()).default([]).description('传给 ACP server 的额外命令行参数'),
  acpVersion: Schema.string().default(DEFAULT_ACP_SERVER_VERSION).description('自动下载的 ACP server 版本'),
  requestTimeoutMs: Schema.natural().default(30_000).description('单个 ACP 请求默认超时（毫秒）'),
  handshakeTimeoutMs: Schema.natural().min(1000).default(120_000).description('initialize 握手等待上限（毫秒）；官方进程冷启动（解压、杀软扫描）可能超过 1 分钟'),
  authTimeoutMs: Schema.natural().default(300_000).description('authenticate（需人工在浏览器完成 OAuth 授权）的等待上限（毫秒）'),
  promptTimeoutMs: Schema.natural().default(1_800_000).description('单轮 session/prompt 的等待上限（毫秒）'),
  bridgeParkSettleMs: Schema.natural().default(50).description('并发 MCP tools/call 的聚合窗口（毫秒）'),
  preferredModel: Schema.string().description('默认/自定义模型 ID，优先列入目录；目录外 ID 未验证。兼容旧 server-default 路由，留空不指定默认项'),
  proxyUrl: Schema.string().description('官方进程出网代理，如 http://127.0.0.1:7890（缺 scheme 按 http 处理）。留空继承宿主代理，宿主也未配置时才直连'),
  proxyBypass: Schema.string().description('代理排除列表，逗号分隔，如 example.internal,*.internal；不支持 CIDR。localhost/127.0.0.1/::1 始终自动排除'),
  reuseSessions: Schema.boolean().default(true).description('复用同一个 ACP 会话，后续回合只发送新增消息；历史被压缩/回退或模型、工具目录变化时自动重建。关闭则每轮新会话并重放全部历史'),
  resumeSessions: Schema.boolean().default(false).description('重启后尝试用 session/load 恢复上次的 ACP 会话；依赖 agent 的 loadSession 能力，恢复失败会自动重建'),
  keepProcessAfterCancel: Schema.boolean().default(false).description('用户取消后保留官方进程：宽限内确认 agent 已停止就只丢弃会话，下一轮不必冷启动；默认关闭'),
  cancelGraceMs: Schema.natural().max(60_000).default(30_000).description('取消后等待 agent 确认停止的上限（毫秒）；0 表示不等待、立即回收'),
  idleRecycleMs: Schema.natural().max(3_600_000).default(300_000).description('保留进程的最长空闲时间（毫秒），超时回收；0 表示不设上限。默认 5 分钟是本插件的资源回收策略，不代表上游缓存 TTL'),
})
