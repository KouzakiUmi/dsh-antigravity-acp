/**
 * Cordis 插件入口：向 ctx.llm 注册 antigravity-acp provider 的 LlmAdapter。
 *
 * 注入 'llm'（adapter 注册表）与 'subprocess'（生命周期受管子进程服务）。
 * 子进程一律经 ctx.subprocess 创建，绝不 import child_process。
 *
 * 生命周期闭环：dispose 时按顺序——关闭所有 AgentLink → 终止所有由本插件
 * 经 ctx.subprocess 启动的 ACP 子进程 → 关闭插件进程内的私有 loopback MCP 桥。
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import type { ClientCapabilities } from '@agentclientprotocol/sdk'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { AntigravityAcpAdapter, AGY_PROVIDER_ID } from './adapter/antigravity-adapter.js'
import { AgentLink, agentStreamFromSubprocess, AGY_LINK_ERROR, launchAcpAgent } from './protocol/agent-link.js'
import type { AgentLinkHandlers } from './protocol/agent-link.js'
import { ensureAgentBinary, resolveCacheDir, DEFAULT_ACP_SERVER_VERSION } from './runtime/binary.js'
import { resolveProxy } from './runtime/proxy-env.js'
import type { ResolvedProxy } from './runtime/proxy-env.js'
import { describeAuthWait, redactSensitiveText } from './runtime/redact.js'
import { readCachedCatalog, writeCachedCatalog } from './runtime/catalog-cache.js'
import type { AntigravityHostConfig } from './settings.js'

export { AGY_PROVIDER_ID } from './adapter/antigravity-adapter.js'
export { Config } from './settings.js'
export type { AntigravityHostConfig } from './settings.js'

export const name = 'llm-antigravity-acp'
export const inject = ['llm', 'subprocess']

/**
 * 本插件向 agent 声明的 client 能力：**全部关闭**。
 *
 * 无人值守原则：工具一律经私有 loopback MCP 桥暴露给 agent，agent 不直接
 * 触碰宿主文件系统或终端。因此 fs 读写与 terminal 全部为 false，agent 若仍
 * 发起这些原生请求，会被 adapter 记为「非预期原生活动」并终止回合
 * （见 adapter/prompt-turn.ts）。elicitation 也一并关闭：无人应答可收集。
 */
export const AGY_CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  // elicitation 整体省略：按 ACP d.ts，省略与 null 等价于不声明该能力，
  // 因此 agent 不会发起 session/create_elicitation。
}

/** 本插件持有并需在 dispose 时清理的活动 ACP 资源。 */
export interface ActiveAcpRuntime {
  link?: AgentLink
  handle?: SubprocessHandle
  /**
   * 正在进行的启动流程。`ensureAcpRuntime` 的判重到写入 `link` 之间横跨
   * `ensureAgentBinary` / `mkdir` / spawn 多个 await，仅靠同步的 `active.link`
   * 检查无法阻止并发首轮各自 spawn 一条官方进程（进而孤儿一条 handle、双弹一次
   * OAuth）。这个 promise 让并发调用汇聚到同一次启动。
   */
  inflight?: Promise<AgentLink>
  /** 插件已卸载。置位后不再启动新链路，dispose 会等在途启动收尾再清理。 */
  disposed?: boolean
  /** 插件进程内私有 loopback MCP 桥的关闭钩子（由 adapter 登记）。 */
  bridgeTeardown?: () => Promise<void>
}

/**
 * 清理顺序（apply 的 dispose 与测试共用同一条路径）：
 *
 * 1. 置 `disposed`，让此后进来的 `ensureAcpRuntime` 立刻失败而不是再 spawn；
 * 2. **先切断链路**：`link?.close()` + `handle?.terminate()`。必须在等 in-flight
 *    之前做——否则一个正卡在 `authenticate`（最长 `authTimeoutMs`，默认 5 分钟）
 *    的启动会把卸载拖到用户点完登录为止，而调用方还会拿到一条刚认证成功、
 *    随即被关掉的链接（假成功）；
 * 3. 等在途启动收尾。它此时会因链路断开而失败，错误被吞掉；仍兜住一种极端情况：
 *    in-flight 已经越过 spawn、还没来得及 terminate 自己的 handle。
 * 4. 关闭私有 MCP 桥。
 */
export async function disposeAcpRuntime(active: ActiveAcpRuntime): Promise<void> {
  active.disposed = true
  await active.link?.close().catch(() => undefined)
  active.handle?.terminate()
  await active.inflight?.catch(() => undefined)
  await active.bridgeTeardown?.()
}

export type { AgentLinkHandlers }

/**
 * 创建并启动 ACP 运行时（解析二进制 → ctx.subprocess spawn → initialize →
 * authenticate）。
 *
 * **single-flight**：并发调用共享同一个启动 promise，只 spawn 一条官方进程、
 * 只 authenticate 一次。
 *
 * 三条判定的顺序是有讲究的，**不可交换**：
 * 1. `disposed` 优先——插件卸载后不接受任何启动；
 * 2. `inflight` 必须在 `link` 之前：`authenticate` 可能要等人工在浏览器完成授权
 *    （默认 5 分钟），期间到达的调用必须汇聚到同一次启动，而**不能**拿到一条尚未
 *    认证的链接去 `session/new`；
 * 3. `link` 只在 initialize + authenticate **都成功后**才被写入（见
 *    `startAcpRuntime`），因此它可复用即代表链路已认证。
 *
 * 失败不留残骸：initialize / authenticate 任一失败（异常或超时）都会关闭旧
 * link、终止旧 handle、清掉 inflight 后再抛出原错误，保证下次调用能全新重试，
 * 而不是复用一条死链或缓存一个 rejected promise。
 */
export async function ensureAcpRuntime(
  ctx: Context,
  config: AntigravityHostConfig,
  handlers: AgentLinkHandlers,
  active: ActiveAcpRuntime,
): Promise<AgentLink> {
  if (active.disposed) {
    throw new LlmError('Antigravity ACP 插件已卸载，无法启动 ACP 链路', AGY_LINK_ERROR.LINK_CLOSED)
  }
  if (active.inflight) return active.inflight
  if (active.link) return active.link
  // 同步赋值：startAcpRuntime 内部第一个 await 之前不会有别的调用者插进来。
  const inflight = startAcpRuntime(ctx, config, handlers, active)
  active.inflight = inflight
  try {
    return await inflight
  } finally {
    // 成功路径下 link 已就位；失败路径下这里清掉 inflight，让下次能全新重试。
    // 只有仍是本次这一个 promise 时才清，避免误删后来者的。
    if (active.inflight === inflight) active.inflight = undefined
  }
}

/** 真正执行一次启动的内部实现；调用方负责 single-flight 汇聚。 */
async function startAcpRuntime(
  ctx: Context,
  config: AntigravityHostConfig,
  handlers: AgentLinkHandlers,
  active: ActiveAcpRuntime,
): Promise<AgentLink> {
  const subprocess: SubprocessRuntime = ctx.subprocess
  const resolution = await ensureAgentBinary({
    binaryPath: config.binaryPath,
    autoDownload: config.autoDownload,
    version: config.acpVersion,
  })
  // 下载可能耗时数分钟，期间插件可能被卸载：这时不再 spawn，避免出现一个
  // dispose 之后才出生、无人终止的进程。
  if (active.disposed) {
    throw new LlmError('Antigravity ACP 插件已卸载，取消启动 ACP 链路', AGY_LINK_ERROR.LINK_CLOSED)
  }
  const tmpDir = join(resolveCacheDir(), 'pyi-tmp')
  await mkdir(tmpDir, { recursive: true })
  // mkdir 之后、spawn 之前再查一次：上面两次 await 期间插件可能已被卸载。
  if (active.disposed) {
    throw new LlmError('Antigravity ACP 插件已卸载，取消启动 ACP 链路', AGY_LINK_ERROR.LINK_CLOSED)
  }
  // 代理在 spawn 前解析：地址非法就当场失败，不要等到官方进程出网才报连接错误。
  let proxy: ResolvedProxy | undefined
  try {
    proxy = resolveProxy({ url: config.proxyUrl, bypass: config.proxyBypass })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new LlmError(`Antigravity ACP 代理配置无效：${message}`, 'AGY_INVALID_PROXY', { cause: error })
  }
  const handle = launchAcpAgent(subprocess, {
    executable: resolution.executablePath,
    extraArgs: config.extraArgs,
    tmpDir,
    proxy,
  })
  active.handle = handle
  const link = new AgentLink({
    stream: agentStreamFromSubprocess(handle),
    handlers,
    requestTimeoutMs: config.requestTimeoutMs,
    // 认证需要人工在浏览器里点授权，走独立的更长超时（默认 5 分钟）。
    authTimeoutMs: config.authTimeoutMs,
  })
  link.start()
  try {
    // initialize 上报关闭全部本地能力的 clientCapabilities（ACP v1 的
    // ClientCapabilities 属于 initialize 请求，session/new 没有这个字段）。
    await link.initialize({ clientCapabilities: AGY_CLIENT_CAPABILITIES })
    await link.authenticate()
  } catch (error) {
    // active.link 尚未被写入（只有认证成功才写），这里只需摘掉 handle 指向。
    if (active.handle === handle) active.handle = undefined
    await link.close().catch(() => undefined)
    handle.terminate()
    throw toLaunchError(error, readStderr(handle))
  }
  // 认证成功后才登记链接：`active.link` 可复用就等于「链路已认证」，因此复用它
  // 的调用方不需要、也不应该看到认证窗口内的中间状态。
  active.link = link
  // 子进程意外退出：清掉 active 上的指向，否则下次 ensureAcpRuntime 会因
  // `if (active.link) return active.link` 永久复用死链（S2 的姊妹场景）。
  void handle.done
    .catch(() => undefined)
    .then(async () => {
      if (active.link === link) active.link = undefined
      if (active.handle === handle) active.handle = undefined
      await link.close().catch(() => undefined)
    })
  return link
}

/**
 * 读取并脱敏官方进程的 stderr 尾部。官方会把完整 OAuth 授权 URL（含 state、
 * code_challenge）打进 stderr，未脱敏的原文不能进入错误消息。
 */
function readStderr(handle: SubprocessHandle): string {
  const raw = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
  return redactSensitiveText(raw).slice(-1500)
}

/**
 * 把启动/握手失败包成 `LlmError`。
 *
 * 两处特例：
 * - 认证等待超时：官方会打印 `Launching browser login flow...`，此时用户需要的是
 *   「去浏览器完成授权」这条指引，而不是一串带凭据片段的 URL；
 * - 其余情况：附上脱敏后的 stderr 尾部作为诊断线索。
 */
function toLaunchError(error: unknown, stderr: string): LlmError {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'AGY_LINK_CLOSED'
  const message = error instanceof Error ? error.message : String(error)
  const waitingForLogin = describeAuthWait(stderr) !== undefined
  const detail = waitingForLogin ? describeAuthWait(stderr) : stderr || undefined
  return new LlmError(
    detail ? `${message}（官方进程诊断：${detail}）` : message,
    code,
    { cause: error },
  )
}

export function apply(ctx: Context, config: AntigravityHostConfig): void {
  const active: ActiveAcpRuntime = {}
  const cacheDir = resolveCacheDir()
  const acpVersion = config.acpVersion ?? DEFAULT_ACP_SERVER_VERSION

  const adapter = new AntigravityAcpAdapter({
    // handler 对象由 adapter 构造时创建且身份稳定：AgentLink 只在构造时取一次
    // handlers，后续回合只更换 adapter 内部的当前回合。
    getLink: (handlers) => ensureAcpRuntime(ctx, config, handlers, active),
    registerBridgeTeardown: (teardown) => {
      active.bridgeTeardown = teardown
    },
    promptTimeoutMs: config.promptTimeoutMs,
    parkSettleMs: config.bridgeParkSettleMs,
    preferredModel: config.preferredModel,
    // 冷启动目录：真实目录只能观测到之后才有，先用磁盘缓存兜住模型选择器。
    loadCachedCatalog: () => readCachedCatalog({ cacheDir, acpVersion }),
    saveCatalog: (models) => writeCachedCatalog({ cacheDir, acpVersion, models }),
  })
  const registration = ctx.llm.registerAdapter([AGY_PROVIDER_ID], adapter)

  // 把 Config schema 投到设置表单（插件页）。弱依赖 settings，无 Web 的 profile 仍能加载。
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings') as {
      configure: (opts: { auto: boolean }, fiber: unknown) => () => void
    }
    settingsCtx.effect(
      () => settings.configure({ auto: true }, settingsCtx.fiber),
      'antigravity-acp: schema settings form',
    )
  })

  // cordis 4.x 的规范 dispose 挂点：generator effect，卸载时逆序执行。
  ctx.effect(function* () {
    yield () => registration()
    yield async () => disposeAcpRuntime(active)
  }, 'antigravity-acp 生命周期清理')
}
