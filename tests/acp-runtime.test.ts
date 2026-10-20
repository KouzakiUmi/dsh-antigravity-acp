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
import { disposeAcpRuntime, recycleAcpRuntime, ensureAcpRuntime as startAcpRuntimeRaw } from '../src/index.js'
import type { ActiveAcpRuntime, AcpRuntimeDeps } from '../src/index.js'
import { AGY_LINK_ERROR } from '../src/protocol/agent-link.js'
import { AGY_BINARY_ERROR } from '../src/runtime/binary.js'
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

/**
 * 启动路径上的假依赖。
 *
 * `ready: false` 保留旧行为（仍会走 authenticate），因此既有的「认证等待」用例语义不变；
 * `probeLowIntegrity` 固定 false，避免假 subprocess 收到一条它不认识的 icacls 进程。
 */
const TEST_DEPS: AcpRuntimeDeps = {
  ensureCredentials: async () => ({
    ready: false,
    status: 'unavailable',
    authType: 'oauth-personal',
    tokenPath: '',
    settingsPath: '',
    settingsWritten: false,
    note: '测试替身：无可用登录态',
  }),
  probeLowIntegrity: async () => false,
}

/** 注入测试依赖的启动入口（调用点保持与生产一致的签名）。 */
function ensureAcpRuntime(
  ctx: Context,
  config: AntigravityHostConfig,
  handlers: AgentLinkHandlers,
  active: ActiveAcpRuntime,
) {
  return startAcpRuntimeRaw(ctx, config, handlers, active, TEST_DEPS)
}

/** 组装「假 ctx.subprocess + 每个 spawn 对应一个假 agent」的运行时。 */
async function createRuntimeHarness(
  configure: (agent: FakeAcpAgent, spawnIndex: number, process: FakeAgentProcess) => void,
): Promise<RuntimeHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'agy-runtime-'))
  const binaryPath = join(dir, 'agy-acp-server.exe')
  await writeFile(binaryPath, 'MZ fake acp server')
  const agents: FakeAcpAgent[] = []
  const subprocess = createFakeSubprocessRuntime((process) => {
    const agent = new FakeAcpAgent(process.stream)
    configure(agent, agents.length, process)
    agents.push(agent)
  })
  const active: ActiveAcpRuntime = {}
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

/** 轮询等待条件成立。启动链路含真实 fs 操作，微任务轮数不足以推进。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 正常应答的假官方 agent（initialize + authenticate + session/new）。 */
function acceptHandshake(agent: FakeAcpAgent): void {
  agent.on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
  agent.on('authenticate', () => ({}))
  agent.on('session/new', () => ({ sessionId: 'acp-session-1', configOptions: [] }))
}

describe('ensureAcpRuntime 失败清理（S2）', () => {
  it('回收当前连接会终止受管进程且不卸载插件，下一次调用创建新进程', async () => {
    const harness = await createRuntimeHarness((agent) => acceptHandshake(agent))
    const first = await ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)
    await recycleAcpRuntime(harness.active, first)
    expect(harness.spawns[0]?.terminated()).toBe(true)
    expect(harness.active.link).toBeUndefined()
    expect(harness.active.handle).toBeUndefined()
    expect(harness.active.disposed).not.toBe(true)
    const second = await ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)
    expect(second).not.toBe(first)
    expect(harness.spawns).toHaveLength(2)
    // 旧回合迟到的清理不能摘掉或终止新连接。
    await recycleAcpRuntime(harness.active, first)
    expect(harness.active.link).toBe(second)
    expect(harness.spawns[1]?.terminated()).toBe(false)
  })

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
      code: AGY_LINK_ERROR.AUTH_TIMEOUT,
      message: expect.stringContaining('400ms'),
    })
    // 超过普通请求超时（20ms）仍在等认证，说明用的确实是 authTimeoutMs。
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
    expect(harness.active.link).toBeUndefined()
    expect(harness.active.handle).toBeUndefined()
    expect(harness.spawns[0]?.terminated()).toBe(true)
  })
})

describe('ensureAcpRuntime 成功后子进程意外退出（R1）', () => {
  it('子进程 done 后清空 active，下一次调用会全新 spawn 而不是复用死链', async () => {
    const harness = await createRuntimeHarness((agent) => acceptHandshake(agent))
    const first = await ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)
    expect(harness.spawns).toHaveLength(1)
    expect(harness.active.link).toBe(first)

    harness.spawns[0]?.crash()
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.active.link).toBeUndefined()
    expect(harness.active.handle).toBeUndefined()

    const second = await ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)
    expect(harness.spawns).toHaveLength(2)
    expect(second).not.toBe(first)
    expect(harness.active.link).toBe(second)
    expect(harness.agents[1]?.requestsFor('initialize')).toHaveLength(1)
  })
})

describe('ensureAcpRuntime 并发 single-flight', () => {
  it('并发调用只 spawn 一条进程、只握手一次，且不留下被孤儿掉的 handle', async () => {
    const harness = await createRuntimeHarness((agent) => acceptHandshake(agent))

    const [first, second, third] = await Promise.all([
      ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active),
      ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active),
      ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active),
    ])

    // 只有一个子进程：并发不会再造出孤儿 handle（dispose 只能杀 active.handle）。
    expect(harness.spawns).toHaveLength(1)
    expect(harness.spawns[0]?.terminated()).toBe(false)
    // 三方拿到同一条链接；握手只发生一次，不会重复弹 OAuth。
    expect(first).toBe(second)
    expect(second).toBe(third)
    expect(harness.agents[0]?.requestsFor('initialize')).toHaveLength(1)
    expect(harness.agents[0]?.requestsFor('authenticate')).toHaveLength(1)
    // 启动完成后 inflight 已清空（成功路径由 active.link 承担复用）。
    expect(harness.active.inflight).toBeUndefined()
  })

  it('认证窗口内后到的调用汇聚到同一次启动，拿到的是已认证链接而不是中间态', async () => {
    let releaseAuth!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseAuth = resolve
    })
    const harness = await createRuntimeHarness((agent) => {
      agent.on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
      // authenticate 挂起，模拟「官方正在等人工在浏览器点授权」。
      agent.on('authenticate', async () => {
        await gate
        return {}
      })
    })

    const first = ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)
    // 等到 authenticate 真的发出（即 initialize 已完成、认证在等待人工授权）。
    await waitFor(() => (harness.agents[0]?.requestsFor('authenticate').length ?? 0) === 1)
    // 关键不变量：认证未完成前 active.link 不得可复用。
    expect(harness.active.link).toBeUndefined()

    // 认证窗口内到达的调用不会绕过 inflight 拿到未认证的链接。
    const late = ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)
    expect(harness.spawns).toHaveLength(1)
    expect(harness.agents[0]?.requestsFor('authenticate')).toHaveLength(1)

    releaseAuth()
    const [resolvedFirst, resolvedLate] = await Promise.all([first, late])
    expect(resolvedLate).toBe(resolvedFirst)
    expect(harness.spawns).toHaveLength(1)
    expect(harness.active.link).toBe(resolvedFirst)
  })

  it('并发失败时 inflight 被清空，下一次调用能全新重试', async () => {    const harness = await createRuntimeHarness((agent, index) => {
      if (index === 0) {
        agent.on('initialize', () => Promise.reject(new Error('握手失败')))
        return
      }
      acceptHandshake(agent)
    })

    const results = await Promise.allSettled([
      ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active),
      ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active),
    ])
    expect(results.every((entry) => entry.status === 'rejected')).toBe(true)
    expect(harness.spawns).toHaveLength(1)
    expect(harness.spawns[0]?.terminated()).toBe(true)
    // 失败不得把 rejected promise 缓存成永久不可重试的状态。
    expect(harness.active.inflight).toBeUndefined()
    expect(harness.active.link).toBeUndefined()

    const link = await ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)
    expect(harness.spawns).toHaveLength(2)
    expect(link.initialized).toBe(true)
  })
})

describe('dispose 与在途启动交错', () => {
  it('二进制解析/下载窗口内卸载：直接取消启动，不产生子进程', async () => {
    const harness = await createRuntimeHarness((agent) => acceptHandshake(agent))

    const inflight = ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)
    // 不等解析/握手完成就卸载：这正是会孤儿进程的时序。
    await disposeAcpRuntime(harness.active)

    await expect(inflight).rejects.toMatchObject({ code: AGY_LINK_ERROR.LINK_CLOSED })
    expect(harness.spawns).toHaveLength(0)
    expect(harness.active.disposed).toBe(true)
    await expect(ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active))
      .rejects.toMatchObject({ code: AGY_LINK_ERROR.LINK_CLOSED })
  })

  it('已 spawn、认证挂起时卸载：立即终止进程，不等人工点完登录', async () => {
    const harness = await createRuntimeHarness((agent) => {
      agent.on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
      // authenticate 永不应答：模拟用户还没在浏览器点授权。
    })

    const inflight = ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)
    await waitFor(() => (harness.agents[0]?.requestsFor('authenticate').length ?? 0) === 1)
    expect(harness.spawns).toHaveLength(1)
    expect(harness.spawns[0]?.terminated()).toBe(false)

    const started = Date.now()
    await disposeAcpRuntime(harness.active)
    // 关键：卸载不等 authTimeoutMs（默认 5 分钟），而是直接切断链路。
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(harness.spawns).toHaveLength(1)
    expect(harness.spawns[0]?.terminated()).toBe(true)
    await expect(inflight).rejects.toMatchObject({ code: AGY_LINK_ERROR.LINK_CLOSED })
  })

  it('dispose 后不再接受新的启动请求', async () => {
    const harness = await createRuntimeHarness((agent) => acceptHandshake(agent))
    await ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)
    await disposeAcpRuntime(harness.active)

    expect(harness.spawns[0]?.terminated()).toBe(true)
    await expect(ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active))
      .rejects.toMatchObject({ code: AGY_LINK_ERROR.LINK_CLOSED })
    expect(harness.spawns).toHaveLength(1)
  })
})

describe('启动失败的诊断文本脱敏', () => {
  const OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=SECRETSTATE'
    + '&code_challenge=SECRETCHALLENGE&code_challenge_method=S256&scope=email'
  const LOGIN_LINE = 'I1015 credential_manager.py:561] Credentials missing or invalid. Launching browser login flow...'

  it('握手失败时错误消息不含 state / code_challenge 原值', async () => {
    const harness = await createRuntimeHarness((agent, index, process) => {
      if (index === 0) {
        agent.on('initialize', () => {
          process.writeStderr(`Open the following link to authenticate the ACP server: ${OAUTH_URL}\n`)
          return Promise.reject(new Error('握手失败'))
        })
        return
      }
      acceptHandshake(agent)
    })

    const failure = await ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)
      .then(() => undefined, (error: unknown) => error)

    const message = failure instanceof Error ? failure.message : String(failure)
    expect(message).toContain('握手失败')
    expect(message).not.toContain('SECRETSTATE')
    expect(message).not.toContain('SECRETCHALLENGE')
    // 非凭据上下文仍然保留，诊断信息不至于被清空。
    expect(message).toContain('client_id=abc')
  })

  it('登录等待超时改用可行动提示，不回显授权 URL', async () => {
    const harness = await createRuntimeHarness((agent, _index, process) => {
      agent.on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
      process.writeStderr(`${LOGIN_LINE}\nOpen the following link: ${OAUTH_URL}\n`)
      // authenticate 不应答 → 走 authTimeoutMs。
    })
    const config: AntigravityHostConfig = { ...harness.config, requestTimeoutMs: 20, authTimeoutMs: 300 }

    const failure = await ensureAcpRuntime(harness.ctx, config, handlers, harness.active)
      .then(() => undefined, (error: unknown) => error)

    const message = failure instanceof Error ? failure.message : String(failure)
    expect(message).toContain('请在浏览器里完成授权')
    expect(message).not.toContain('SECRETSTATE')
    expect(message).not.toContain('SECRETCHALLENGE')
    expect(message).not.toContain('accounts.google.com')
  })

  it('stderr 里的代理 userinfo 密码不回显到错误消息', async () => {
    const harness = await createRuntimeHarness((agent, index, process) => {
      if (index === 0) {
        agent.on('initialize', () => {
          process.writeStderr('proxy dial failed via http://alice:hunter2@127.0.0.1:7890\n')
          return Promise.reject(new Error('握手失败'))
        })
        return
      }
      acceptHandshake(agent)
    })
    const config: AntigravityHostConfig = { ...harness.config, proxyUrl: 'http://alice:hunter2@127.0.0.1:7890' }

    const failure = await ensureAcpRuntime(harness.ctx, config, handlers, harness.active)
      .then(() => undefined, (error: unknown) => error)

    const message = failure instanceof Error ? failure.message : String(failure)
    expect(message).toContain('握手失败')
    expect(message).toContain('proxy dial failed')
    expect(message).not.toContain('hunter2')
  })
})

describe('启动路径的新增前置检查', () => {
  it('登录态已就绪时跳过 authenticate（无交互浏览器时会白等 5 分钟）', async () => {
    const harness = await createRuntimeHarness((agent) => {
      agent.on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
      // 刻意注册 authenticate 处理器：若被调用就会留下记录。
      agent.on('authenticate', () => ({}))
    })
    try {
      const link = await startAcpRuntimeRaw(harness.ctx, harness.config, handlers, harness.active, {
        ensureCredentials: async () => ({
          ready: true,
          status: 'imported',
          authType: 'oauth-personal',
          tokenPath: '',
          settingsPath: '',
          settingsWritten: true,
        }),
        probeLowIntegrity: async () => false,
      })
      expect(link).toBeDefined()
      expect(harness.agents[0]!.requestsFor('authenticate')).toHaveLength(0)
      expect(harness.agents[0]!.requestsFor('initialize')).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })

  it('二进制落在低完整性目录时立刻报错，不 spawn（否则表现为无解释的挂死）', async () => {
    const harness = await createRuntimeHarness(() => undefined)
    try {
      await expect(
        startAcpRuntimeRaw(harness.ctx, harness.config, handlers, harness.active, {
          ensureCredentials: async () => ({
            ready: true,
            status: 'existing',
            authType: 'oauth-personal',
            tokenPath: '',
            settingsPath: '',
            settingsWritten: false,
          }),
          probeLowIntegrity: async () => true,
        }),
      ).rejects.toMatchObject({ code: AGY_BINARY_ERROR.LOW_INTEGRITY })
      expect(harness.spawns).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('已关闭的死链不会被复用：下次调用终止旧进程并全新启动', async () => {
    // 协议违规 / 流读取失败会让 AgentLink 自行关闭，但子进程仍活着、handle.done 不触发，
    // 以前 `if (active.link) return active.link` 会把这条死链永久交给调用方。
    const harness = await createRuntimeHarness((agent) => acceptHandshake(agent))
    const first = await ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)
    await first.close()
    expect(first.closed).toBe(true)
    expect(harness.spawns[0]?.terminated()).toBe(false)
    const second = await ensureAcpRuntime(harness.ctx, harness.config, handlers, harness.active)
    expect(second).not.toBe(first)
    expect(second.closed).toBe(false)
    expect(harness.spawns).toHaveLength(2)
    expect(harness.spawns[0]?.terminated()).toBe(true)
    expect(harness.active.link).toBe(second)
  })

  it('登录态不就绪时仍走 authenticate，并把原因带进错误消息', async () => {
    // 官方 authenticate 在没有交互式浏览器时不会应答：用极短 authTimeoutMs 复现该等待。
    const harness = await createRuntimeHarness((agent) => {
      agent.on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }))
    })
    const config: AntigravityHostConfig = { ...harness.config, authTimeoutMs: 30 }
    try {
      await expect(
        startAcpRuntimeRaw(harness.ctx, config, handlers, harness.active, {
          ensureCredentials: async () => ({
            ready: false,
            status: 'unavailable',
            authType: 'oauth-personal',
            tokenPath: '',
            settingsPath: '',
            settingsWritten: false,
            note: '未找到可导入的官方登录态',
          }),
          probeLowIntegrity: async () => false,
        }),
      ).rejects.toThrow(/未找到可导入的官方登录态/)
      expect(harness.agents[0]!.requestsFor('authenticate')).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })
})
