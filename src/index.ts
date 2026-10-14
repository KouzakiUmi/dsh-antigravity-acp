/**
 * Cordis 插件入口：向 ctx.llm 注册 antigravity-acp provider 的 LlmAdapter。
 *
 * 注入 'llm'（adapter 注册表）与 'subprocess'（生命周期受管子进程服务）。
 * 子进程一律经 ctx.subprocess 创建，绝不 import child_process。
 *
 * 生命周期闭环：dispose 时按顺序——关闭所有 AgentLink → 终止所有由本插件
 * 经 ctx.subprocess 启动的 ACP 子进程 → 清理本插件创建的临时文件 →
 * 关闭插件进程内的私有 loopback MCP 桥。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type { ClientCapabilities } from '@agentclientprotocol/sdk'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { AntigravityAcpAdapter, AGY_PROVIDER_ID } from './adapter/antigravity-adapter.js'
import { AgentLink, agentStreamFromSubprocess, launchAcpAgent } from './protocol/agent-link.js'
import type { AgentLinkHandlers } from './protocol/agent-link.js'
import { ensureAgentBinary } from './runtime/binary.js'
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
  /** 本插件为握手/桥接创建的临时文件路径（dispose 时删除）。 */
  tempFiles: string[]
  /** 插件进程内的私有 loopback MCP 桥关闭钩子（由 adapter 登记）。 */
  bridgeTeardown?: () => Promise<void>
}

export type { AgentLinkHandlers }

/**
 * 创建并启动 ACP 运行时（解析二进制 → ctx.subprocess spawn → initialize →
 * authenticate）。幂等：重复调用复用既有链接。adapter 的元数据方法
 * （providerInfo / listModels / resolveModel）不触网，因此 apply 阶段不启动；
 * 只有第一次 `stream` 才会惰性驱动到这里。
 *
 * 失败不留残骸：initialize / authenticate 任一失败（异常或超时）都会关闭旧
 * link、终止旧 handle、把 active 上的 link/handle 清空后再抛出原错误，保证下次
 * 调用能全新重试，而不是复用一条死链。
 */
export async function ensureAcpRuntime(
  ctx: Context,
  config: AntigravityHostConfig,
  handlers: AgentLinkHandlers,
  active: ActiveAcpRuntime,
): Promise<AgentLink> {
  if (active.link) return active.link
  const subprocess: SubprocessRuntime = ctx.subprocess
  const resolution = await ensureAgentBinary({
    binaryPath: config.binaryPath,
    autoDownload: config.autoDownload,
    version: config.acpVersion,
  })
  const handle = launchAcpAgent(subprocess, {
    executable: resolution.executablePath,
    extraArgs: config.extraArgs,
    cwd: process.cwd(),
  })
  active.handle = handle
  const link = new AgentLink({
    stream: agentStreamFromSubprocess(handle),
    handlers,
    requestTimeoutMs: config.requestTimeoutMs,
    // 认证需要人工在浏览器里点授权，走独立的更长超时（默认 5 分钟）。
    authTimeoutMs: config.authTimeoutMs,
  })
  active.link = link
  link.start()
  try {
    // initialize 上报关闭全部本地能力的 clientCapabilities（ACP v1 的
    // ClientCapabilities 属于 initialize 请求，session/new 没有这个字段）。
    await link.initialize({ clientCapabilities: AGY_CLIENT_CAPABILITIES })
    await link.authenticate()
  } catch (error) {
    // 先把 active 上的指向摘掉，再清理资源：即使清理本身出错，也不会留下
    // 「active.link 指向死链」这种永久不可重试的状态。
    if (active.link === link) active.link = undefined
    if (active.handle === handle) active.handle = undefined
    await link.close().catch(() => undefined)
    handle.terminate()
    throw error
  }
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

export function apply(ctx: Context, config: AntigravityHostConfig): void {
  const active: ActiveAcpRuntime = { tempFiles: [] }

  const adapter = new AntigravityAcpAdapter({
    // handler 对象由 adapter 构造时创建且身份稳定：AgentLink 只在构造时取一次
    // handlers，后续回合只更换 adapter 内部的当前回合。
    getLink: (handlers) => ensureAcpRuntime(ctx, config, handlers, active),
    registerBridgeTeardown: (teardown) => {
      active.bridgeTeardown = teardown
    },
    promptTimeoutMs: config.promptTimeoutMs,
    parkSettleMs: config.bridgeParkSettleMs,
  })
  const registration = ctx.llm.registerAdapter([AGY_PROVIDER_ID], adapter)

  // cordis 4.x 的规范 dispose 挂点：generator effect，卸载时逆序执行。
  ctx.effect(function* () {
    yield () => registration()
    yield async () => {
      // 1) 关闭 ACP 链接（拒绝在途请求）。
      await active.link?.close()
      // 2) 终止由本插件经 ctx.subprocess 启动的 ACP 子进程。
      active.handle?.terminate()
      // 3) 清理本插件创建的临时文件。
      for (const file of active.tempFiles) {
        const { rm } = await import('node:fs/promises')
        await rm(file, { force: true }).catch(() => undefined)
      }
      // 4) 关闭插件进程内的私有 loopback MCP 桥（拒绝未回喂的 park）。
      await active.bridgeTeardown?.()
    }
  }, 'antigravity-acp 生命周期清理')
}
