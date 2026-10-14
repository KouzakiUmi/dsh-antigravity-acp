/**
 * ensureAcpRuntime 生命周期回归测试（原创）。
 *
 * S2：initialize / authenticate 失败（异常或超时）后，active 上不得残留半残的
 * link/handle——否则下一次调用会因 `if (active.link) return active.link` 复用
 * 死链、永久不可重试；且 authenticate 必须走独立的更长超时，不被普通请求超时
 * （约 30s 量级）掐断。
 *
 * 子进程一律由注入的假 ctx.subprocess 提供（tests/helpers/fake-subprocess.ts），
 * 不启动真实官方二进制、不触碰 child_process。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ensureAcpRuntime } from '../src/index.js'
import type { ActiveAcpRuntime } from '../src/index.js'
import { AGY_LINK_ERROR } from '../src/protocol/agent-link.js'
import type { AgentLinkHandlers } from '../src/protocol/agent-link.js'
import type { AntigravityHostConfig } from '../src/settings.js'
import { FakeAcpAgent } from './helpers/fake-acp-agent.js'
import { createFakeSubprocessRuntime } from './helpers/fake-subprocess.js'
import type { FakeAgentProcess } from './helpers/fake-subprocess.js'

/** 基础配置：binaryPath 指向一个真实存在的临时文件，避免任何下载路径。 */
function baseConfig(binaryPath: string): AntigravityHostConfig {
  return { binaryPath, autoDownload: false, acpVersion: '1.4.0' }
}

const handlers: AgentLinkHandlers = {}

interface RuntimeHarness {
  ctx: Context
  active: ActiveAcpRuntime
  agents: FakeAcpAgent[]
  spawns: FakeAgentProcess[]
  config: AntigravityHostConfig
  dispose: () => Promise<void>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/** 组装「假 ctx.subprocess + 每个 spawn 对应一个假 agent」的运行时。 */
async function createRuntimeHarness(configure: (agent: FakeAcpAgent, spawnIndex: number) => void): Promise<RuntimeHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'agy-runtime-'))
  const binaryPath = join(dir, 'agy-acp-server.exe')
  await writeFile(binaryPath, 'MZ fake acp server')
  const agents: FakeAcpAgent[] = []
  const subprocess = createFakeSubprocessRuntime((process) => {
    const agent = new FakeAcpAgent(process.stream)
    configure(agent, agents.length)
    agents.push(agent)
  })
  const active: ActiveAcpRuntime = { tempFiles: [] }
  const harness: RuntimeHarness = {
    ctx: { subprocess: subprocess.runtime } as unknown as Context,
    active,
    agents,
    spawns: subprocess.spawns,
    config: baseConfig(binaryPath),
    dispose: async () => {
      await active.link?.close().catch(() => undefined)
      active.handle?.terminate()
      await rm(dir, { recursive: true, force: true })
    },
  }
  cleanups.push(harness.dispose)
  return harness
}

/** 正常应答的假官方 agent（initialize + authenticate + session/new）。 */
function acceptHandshake(agent: FakeAcpAgent): void {
  agent.on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
  agent.on('authenticate', () => ({}))
  agent.on('session/new', () => ({ sessionId: 'acp-session-1', configOptions: [] }))
}

describe('ensureAcpRuntime 失败清理（S2）', () => {
  it('initialize 失败后 active 无残留 link/handle，旧进程被终止，第二次调用全新重试', async () => {
    const harness = await createRuntimeHarness((agent, index) => {
      if (index === 0) {
        // 第一条进程握手失败（以 JSON-RPC error 应答，等价于子进程报错）。
        agent.on('initialize', () => Promise.reject(new Error('握手失败')))
        return
      }
      acceptHandshake(agent)
    })

    await expect(ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active))
      .rejects.toMatchObject({
        code: AGY_LINK_ERROR.AGENT_REFUSED,
        message: expect.stringContaining('握手失败'),
      })

    // 关键不变量：不留半残状态，否则下一次调用会复用死链。
    expect(harness.active.link).toBeUndefined()
    expect(harness.active.handle).toBeUndefined()
    expect(harness.spawns).toHaveLength(1)
    expect(harness.spawns[0]?.terminated()).toBe(true)

    // 第二次调用用**新的** spawn 重新握手并成功。
    const link = await ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)
    expect(harness.spawns).toHaveLength(2)
    expect(harness.spawns[1]?.terminated()).toBe(false)
    expect(harness.active.link).toBe(link)
    expect(harness.active.handle).toBe(harness.spawns[1]?.handle as never)
    expect(link.initialized).toBe(true)
    // 每个进程各收过一次 initialize；第二次没有复用第一条死链。
    expect(harness.agents[0]?.requestsFor('initialize')).toHaveLength(1)
    expect(harness.agents[1]?.requestsFor('initialize')).toHaveLength(1)
    expect(harness.agents[1]?.requestsFor('authenticate')).toHaveLength(1)
    // 复用路径：已有活跃链接时不再 spawn。
    expect(await ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)).toBe(link)
    expect(harness.spawns).toHaveLength(2)
  })

  it('authenticate 失败后同样清空 active，且可再次全新重试', async () => {
    const harness = await createRuntimeHarness((agent, index) => {
      acceptHandshake(agent)
      if (index === 0) agent.on('authenticate', () => Promise.reject(new Error('认证失败')))
    })

    await expect(ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active))
      .rejects.toMatchObject({
        code: AGY_LINK_ERROR.AGENT_REFUSED,
        message: expect.stringContaining('认证失败'),
      })
    expect(harness.active.link).toBeUndefined()
    expect(harness.active.handle).toBeUndefined()
    expect(harness.spawns[0]?.terminated()).toBe(true)

    const link = await ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)
    expect(harness.spawns).toHaveLength(2)
    expect(link.initialized).toBe(true)
    expect(harness.active.link).toBe(link)
  })

  it('authenticate 超时用独立的 authTimeoutMs，不被普通请求短超时掐断', async () => {
    const harness = await createRuntimeHarness((agent) => {
      agent.on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
      // authenticate 故意装聋：只有 authTimeoutMs 会到点。
    })
    const config: AntigravityHostConfig = { ...harness.config, requestTimeoutMs: 20, authTimeoutMs: 400 }

    const started = Date.now()
    await expect(ensureAcpRuntime(harness.ctx, config, handlers, harness.active)).rejects.toMatchObject({
      code: AGY_LINK_ERROR.REQUEST_TIMEOUT,
      message: expect.stringContaining('400ms'),
    })
    // 超过普通请求超时（20ms）仍在等认证，说明用的确实是 authTimeoutMs。
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
    expect(harness.active.link).toBeUndefined()
    expect(harness.active.handle).toBeUndefined()
    expect(harness.spawns[0]?.terminated()).toBe(true)
  })
})
