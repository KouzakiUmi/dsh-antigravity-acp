/**
 * 回归：Cordis Service 的方法经 Proxy 调用，`this` 是代理而非真实实例。
 * AgYQuotaService 以前用 ES 真私有字段（`#cli`），经 `ctx.agyQuota.read()` 调用时抛
 * “Cannot read private member #cli from an object whose class did not declare it”。
 * 这里必须经真实 Cordis Context 调用，直接 `new` 实例复现不出来。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CliRun } from '../src/runtime/agy-cli.js'
import { AgYQuotaService, AGY_QUOTA_SERVICE, AGY_QUOTA_INVOCATIONS, registerAgYQuotaRemote } from '../src/quota/quota-remote.js'

import { SettingsControl } from '../src/quota/control.js'

const CREDITS_JSON = { status: 'SUCCESS', num_turns: 0, command: { name: 'credits', data: { remaining_credits: 200 } } }

const USAGE_JSON = {
  status: 'SUCCESS',
  command: {
    name: 'usage',
    data: {
      groups: [
        { name: 'Gemini', buckets: [{ window: '5h', remaining_fraction: 0.5, reset_time: '2026-10-21T00:00:00Z' }] },
      ],
    },
  },
}

describe('AgYQuotaService 经 Cordis Proxy 调用', () => {
  it('重开宿主离线读取磁盘快照；换账号后不再显示旧额度', async () => {
    const path = mkdtempSync(join(tmpdir(), 'dsh-quota-test-'))
    using directory = { path, [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }) }
    let account = 'account-a'
    const credential = vi.fn(async () => ({ accessToken: 'unsaved-test-token', projectId: 'synthetic-project', source: 'login' as const, updatedAt: 'x' }))
    const request = vi.fn(async ({ url }: { url: string }) => new Response(JSON.stringify(url.includes('loadCodeAssist') ? {} : {
      groups: [{ displayName: 'Gemini', buckets: [{ remainingFraction: 0.7 }] }],
    })))
    async function openHost() {
      const host = new Context()
      const fiber = await host.plugin(AgYQuotaService, { mode: () => 'proxy', snapshotDirectory: directory.path,
        proxyIdentity: async () => account, proxyQuota: { credential: { credential }, transport: { request } } })
      return { service: host.get(AGY_QUOTA_SERVICE) as AgYQuotaService, close: async () => { await fiber.dispose(); await host.fiber.dispose() } }
    }
    const first = await openHost()
    try {
      expect((await first.service.read({ force: true })).error?.code).toBe('not-fetched')
      expect(credential).not.toHaveBeenCalled()
      expect((await first.service.refresh()).groups[0]?.buckets[0]?.remainingPct).toBe(70)
    } finally { await first.close() }
    const stored = readFileSync(join(directory.path, 'quota-proxy.json'), 'utf8')
    expect(stored).not.toMatch(/unsaved-test-token|account-a|synthetic-project/)
    const second = await openHost()
    try {
      expect((await second.service.read()).groups[0]?.buckets[0]?.remainingPct).toBe(70)
      account = 'account-b'
      expect((await second.service.read()).error?.code).toBe('not-fetched')
      expect(credential).toHaveBeenCalledTimes(1)
      expect(request).toHaveBeenCalledTimes(2)
    } finally { await second.close() }
  })

  it('历史裁剪事件只随 read 附带，不写入快照存储（issue #16）', async () => {
    const path = mkdtempSync(join(tmpdir(), 'dsh-quota-test-'))
    using directory = { path, [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }) }
    const credential = vi.fn(async () => ({ accessToken: 'unsaved-test-token', projectId: 'synthetic-project', source: 'login' as const, updatedAt: 'x' }))
    const request = vi.fn(async ({ url }: { url: string }) => new Response(JSON.stringify(url.includes('loadCodeAssist') ? {} : {
      groups: [{ displayName: 'Gemini', buckets: [{ remainingFraction: 0.7 }] }],
    })))
    const notices = [{ at: '2026-11-26T00:00:00.000Z', omittedCount: 3, omittedBytes: 90_000, totalBytes: 170_000 }]
    const ctx = new Context()
    const fiber = await ctx.plugin(AgYQuotaService, { mode: () => 'proxy', snapshotDirectory: directory.path,
      proxyIdentity: async () => 'account-a', proxyQuota: { credential: { credential }, transport: { request } },
      historyNotices: () => notices })
    try {
      const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
      await service.refresh()
      const value = await service.read({ model: 'gemini-flash' })
      expect(value.historyNotices).toEqual(notices)
      expect(value.requestedModel).toBe('gemini-flash')
      // 落盘快照不含裁剪事件：它是内存态，重启即清空。
      expect(readFileSync(join(directory.path, 'quota-proxy.json'), 'utf8')).not.toContain('historyNotices')
    } finally { await fiber.dispose(); await ctx.fiber.dispose() }
  })

  it('不打开界面也由宿主定时拉取，卸载后停止', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const credential = vi.fn(async () => undefined)
    const fiber = ctx.plugin(AgYQuotaService, { mode: () => 'proxy', background: true,
      proxyQuota: { credential: { credential }, transport: { request: vi.fn() } } })
    try {
      await vi.advanceTimersByTimeAsync(10)
      expect(credential).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(300_000)
      expect(credential).toHaveBeenCalledTimes(2)
      await fiber.dispose()
      await vi.advanceTimersByTimeAsync(300_000)
      expect(credential).toHaveBeenCalledTimes(2)
    } finally { await ctx.fiber.dispose(); vi.useRealTimers() }
  })
  it('同一 package-face 只注册一次，同时贡献额度与代理账户两个命名空间', () => {
    const register = vi.fn((_contribution: unknown) => () => {})
    const scope = { get: () => ({ register }), effect: (callback: () => unknown) => callback() }
    const ctx = { inject: (_services: string[], callback: (scope: unknown) => void) => callback(scope) } as unknown as Context
    registerAgYQuotaRemote(ctx)
    expect(register).toHaveBeenCalledOnce()
    const contribution = register.mock.calls[0]![0] as unknown as { package: string; face: string; invocations: { namespace: string; method: string }[] }
    expect(contribution).toMatchObject({ package: 'dsh-bundle-antigravity-host', face: 'host' })
    expect(new Set(contribution.invocations.map(item => item.namespace))).toEqual(new Set(['agyQuota', 'agyProxyAccount']))
    expect(contribution.invocations.filter(item => item.namespace === 'agyProxyAccount').map(item => item.method)).toEqual(['account'])
  })

  it('首次导入提高 revision 后只重取一次，后续读取可命中缓存', async () => {
    const ctx = new Context()
    let revision = 0
    const credential = vi.fn(async () => {
      revision = 1
      return { accessToken: 'synthetic', source: 'login' as const, updatedAt: 'x' }
    })
    let summaries = 0
    const request = vi.fn(async ({ url }: { url: string }) => {
      if (url.includes('loadCodeAssist')) return new Response('{"cloudaicompanionProject":"synthetic-project"}')
      summaries++
      return new Response('{"groups":[{"displayName":"synthetic","buckets":[]}]}')
    })
    const fiber = await ctx.plugin(AgYQuotaService, { mode: () => 'proxy', proxyQuota: {
      credential: { credential, revision: () => revision }, transport: { request } } })
    try {
      const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
      expect((await service.refresh()).status).toBe('ok')
      expect(summaries).toBe(2)
      expect((await service.read()).status).toBe('ok')
      expect(summaries).toBe(2)
    } finally { await fiber.dispose(); await ctx.fiber.dispose() }
  })
  it('同 proxy 模式退出/重登后丢弃旧账户额度与 stale 回退', async () => {
    const ctx = new Context()
    let revision = 1
    let signedIn = true
    const credential = vi.fn(async () => signedIn ? { accessToken: 'synthetic', projectId: 'synthetic-project', source: 'login' as const, updatedAt: 'x' } : undefined)
    const request = vi.fn(async ({ url }: { url: string }) => new Response(JSON.stringify(url.includes('loadCodeAssist')
      ? { cloudaicompanionProject: 'synthetic-project' }
      : { groups: [{ displayName: `account-${revision}`, buckets: [{ remainingFraction: 0.5 }] }] })))
    const fiber = await ctx.plugin(AgYQuotaService, { mode: () => 'proxy',
      proxyQuota: { credential: { credential, revision: () => revision }, transport: { request } } })
    try {
      const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
      expect((await service.refresh()).groups[0]?.name).toBe('account-1')
      signedIn = false; revision++
      expect((await service.read()).groups).toEqual([])
      const signedOut = await service.refresh()
      expect(signedOut).toMatchObject({ status: 'error', groups: [], error: { code: 'token-missing' } })
      expect(signedOut.stale).not.toBe(true)
      signedIn = true; revision++
      expect((await service.refresh()).groups[0]?.name).toBe('account-3')
    } finally { await fiber.dispose(); await ctx.fiber.dispose() }
  })

  it('同模式账户 revision 在途改变时旧结果不返回、不写缓存', async () => {
    const ctx = new Context()
    let revision = 1
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let summaries = 0
    const request = vi.fn(async ({ url }: { url: string }) => {
      if (url.includes('loadCodeAssist')) return new Response(JSON.stringify({ cloudaicompanionProject: 'synthetic-project' }))
      const captured = revision
      if (++summaries === 1) { entered(); await gate }
      return new Response(JSON.stringify({ groups: [{ displayName: `account-${captured}`, buckets: [] }] }))
    })
    const fiber = await ctx.plugin(AgYQuotaService, { mode: () => 'proxy', proxyQuota: {
      credential: { credential: async () => ({ accessToken: 'synthetic', source: 'login', updatedAt: 'x' }), revision: () => revision }, transport: { request } } })
    try {
      const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
      const old = service.refresh()
      await started
      revision++
      const current = service.refresh()
      release()
      for (const result of await Promise.all([old, current])) expect(result.groups[0]?.name).toBe('account-2')
      expect((await service.read()).groups[0]?.name).toBe('account-2')
      expect(summaries).toBe(2)
    } finally { release(); await fiber.dispose(); await ctx.fiber.dispose() }
  })
  it('切换模式后的取数失败不会返回另一账户的旧额度', async () => {
    const ctx = new Context()
    let mode: 'acp' | 'proxy' = 'acp'
    const run: CliRun = async request => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(request.argv.includes('/credits') ? CREDITS_JSON : USAGE_JSON) })
    const fiber = await ctx.plugin(AgYQuotaService, {
      cli: { run, cliPath: '/fake/agy' }, cliQuotaEnabled: () => true, mode: () => mode,
      proxyQuota: { credential: { credential: async () => undefined }, transport: { request: async () => { throw new Error('unexpected network') } } },
    })
    try {
      const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
      expect((await service.refresh()).groups).toHaveLength(1)
      mode = 'proxy'
      expect(await service.refresh()).toMatchObject({ status: 'error', groups: [], error: { code: 'token-missing' } })
    } finally { await fiber.dispose(); await ctx.fiber.dispose() }
  })

  it('切换时仍在途的旧模式读取不会被新模式请求复用，也不会把旧结果交给药丸', async () => {
    const ctx = new Context()
    let mode: 'acp' | 'proxy' = 'acp'
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const run: CliRun = async request => {
      await gate
      return { exitCode: 0, stderr: '', stdout: JSON.stringify(request.argv.includes('/credits') ? CREDITS_JSON : USAGE_JSON) }
    }
    const credential = vi.fn(async () => undefined)
    const fiber = await ctx.plugin(AgYQuotaService, {
      cli: { run, cliPath: '/fake/agy' }, cliQuotaEnabled: () => true, mode: () => mode,
      proxyQuota: { credential: { credential }, transport: { request: async () => { throw new Error('unexpected network') } } },
    })
    try {
      const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
      const old = service.refresh()
      mode = 'proxy'
      const current = service.refresh()
      release()
      for (const result of await Promise.all([old, current])) {
        expect(result).toMatchObject({ status: 'error', groups: [], error: { code: 'token-missing' } })
      }
      expect(credential).toHaveBeenCalled()
    } finally { release(); await fiber.dispose(); await ctx.fiber.dispose() }
  })

  it('额度响应携带公开模型与已保存的官方路由，供药丸匹配实际家族', async () => {
    const ctx = new Context()
    const run: CliRun = async request => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(request.argv.includes('/credits') ? CREDITS_JSON : USAGE_JSON) })
    const fiber = await ctx.plugin(AgYQuotaService, { cli: { run, cliPath: '/fake/agy' }, cliQuotaEnabled: () => true,
      modelTarget: model => model === 'gemini-public' ? 'claude-official' : model })
    try {
      const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
      expect(await service.read({ model: 'gemini-public' })).toMatchObject({ requestedModel: 'gemini-public', routeModel: 'claude-official' })
    } finally { await fiber.dispose(); await ctx.fiber.dispose() }
  })

  it('请求来源与当前模式不一致时拒绝，不把另一模式额度误标给旧模型', async () => {
    const ctx = new Context()
    const run = vi.fn<CliRun>(async request => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(request.argv.includes('/credits') ? CREDITS_JSON : USAGE_JSON) }))
    const fiber = await ctx.plugin(AgYQuotaService, { mode: () => 'proxy', cli: { run, cliPath: '/fake/agy' }, cliQuotaEnabled: () => true,
      proxyQuota: { credential: { credential: async () => undefined }, transport: { request: async () => new Response('{}') } } })
    try {
      const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
      await expect(service.read({ source: 'acp' })).rejects.toThrow('重新选择模型')
      expect(run).not.toHaveBeenCalled()
      expect((await service.read({ source: 'proxy' })).status).toBe('error')
    } finally { await fiber.dispose(); await ctx.fiber.dispose() }
  })

  it('设置控制面可经真实 Cordis 代理调用，非法 action 不能变成登录', async () => {
    let connected = 0
    let warmed = 0
    const control = new SettingsControl({ connect: async () => { connected++ }, warmup: async () => { warmed++ }, models: async () => [{ id: 'gemini-test', name: 'Gemini' }] })
    const ctx = new Context()
    ctx.plugin(AgYQuotaService, { control })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
    expect(service.account().state).toBe('idle')
    expect((await service.models()).models[0]?.id).toBe('gemini-test')
    const account = AGY_QUOTA_INVOCATIONS.find((item) => item.method === 'account')!
    const codec = account.parameters[0]!.codec
    if (codec.mode !== 'strict') throw new Error('Account request must use strict codec')
    const parse = codec.create().parse
    expect(() => parse({ action: 'execute' })).toThrow()
    expect(connected).toBe(0)
    expect(service.account({ action: 'login' }).state).toBe('connecting')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(connected).toBe(1)
    expect(service.account().state).toBe('connected')
    expect(parse({ action: 'warmup' })).toEqual({ action: 'warmup' })
    service.account({ action: 'warmup' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(warmed).toBe(1)
    await control.dispose()
  })

  it('ctx.agyQuota.refresh() 经真实 Cordis 调用并走 CLI 取数', async () => {
    const calls: string[][] = []
    const run: CliRun = async (request) => {
      calls.push([...request.argv])
      return { exitCode: 0, stdout: JSON.stringify(request.argv.includes('/credits') ? CREDITS_JSON : USAGE_JSON), stderr: '' }
    }
    const logs: string[] = []
    const ctx = new Context()
    ctx.plugin(AgYQuotaService, {
      cli: { run, cliPath: '/fake/agy' }, cliQuotaEnabled: () => true,
      log: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(`WARN ${m}`) },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
    expect(service).toBeDefined()
    const snapshot = await service.refresh()

    expect(snapshot.error?.message ?? '').not.toMatch(/private member/)
    expect(snapshot.status).toBe('ok')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(['/fake/agy', '-p', '/usage', '--output-format', 'json'])
    expect(calls[1]).toEqual(['/fake/agy', '-p', '/credits', '--output-format', 'json'])
    expect(logs).toContain('antigravity-acp: 正在刷新额度快照')
  })
  it('过期读取只标记陈旧，不触发上游刷新', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-25T00:00:00Z'))
      const startedAt = Date.now()
      let runs = 0
      const run: CliRun = async (request) => {
        runs += 1
        if (request.argv.includes('/credits')) vi.setSystemTime(startedAt + 10_000)
        return { exitCode: 0, stdout: JSON.stringify(request.argv.includes('/credits') ? CREDITS_JSON : USAGE_JSON), stderr: '' }
      }
      const ctx = new Context()
      ctx.plugin(AgYQuotaService, { cli: { run, cliPath: '/fake/agy' }, cliQuotaEnabled: () => true })
      await vi.advanceTimersByTimeAsync(0)
      const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
      await service.refresh()
      expect(runs).toBe(2)
      vi.setSystemTime(startedAt + 320_000)
      expect((await service.read()).stale).toBe(true)
      expect(runs).toBe(2)

    } finally { vi.useRealTimers() }
  })

  it('一次强制刷新后，新数据立即进入独立缓存', async () => {
    let runs = 0
    const run: CliRun = async (request) => {
      runs += 1
      return { exitCode: 0, stdout: JSON.stringify(request.argv.includes('/credits') ? CREDITS_JSON : USAGE_JSON), stderr: '' }
    }
    const ctx = new Context()
    ctx.plugin(AgYQuotaService, { cli: { run, cliPath: '/fake/agy' }, cliQuotaEnabled: () => true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
    await service.refresh()
    expect(runs).toBe(2)
    await service.read()
    expect(runs).toBe(2)

  })

  it('并发 refresh 合并取数，read 不等待在途刷新', async () => {
    let runs = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run: CliRun = async (request) => {
      runs += 1
      await gate
      return { exitCode: 0, stdout: JSON.stringify(request.argv.includes('/credits') ? CREDITS_JSON : USAGE_JSON), stderr: '' }
    }
    const ctx = new Context()
    ctx.plugin(AgYQuotaService, { cli: { run, cliPath: '/fake/agy' }, cliQuotaEnabled: () => true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
    const first = service.refresh()
    const second = service.refresh()
    expect((await service.read()).error?.code).toBe('not-fetched')
    release?.()
    const results = await Promise.all([first, second])
    expect(runs).toBe(2) // 并发读取合并：/usage 与 /credits 各一次。
    expect(results.map((item) => item.status)).toEqual(['ok', 'ok'])
  })

  it('默认不调用 agy：有 CLI 但开关关闭时走内置直连，Credits 为 unavailable', async () => {
    const run = vi.fn<CliRun>(async () => { throw new Error('不应 spawn agy') })
    const fetchImpl = vi.fn(async () => { throw new Error('ENOENT-token') })
    const ctx = new Context()
    ctx.plugin(AgYQuotaService, {
      cli: { run, cliPath: '/fake/agy' },
      deps: { homedir: () => '/fake/home', readFileImpl: async () => { throw new Error('ENOENT') }, fetchImpl },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
    const snapshot = await service.refresh()
    expect(run).not.toHaveBeenCalled()
    expect(snapshot.credits).toMatchObject({ status: 'unavailable', error: { code: 'cli-disabled' } })
    expect(snapshot.credits?.error?.message).toContain('未开启 agy CLI 取数')
  })

  it('代理模式取数不依赖 agy：默认只走代理账户，打开开关后仅 Credits 调用 CLI', async () => {
    let enabled = false
    const run = vi.fn<CliRun>(async (request) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(request.argv.includes('/credits') ? CREDITS_JSON : USAGE_JSON) }))
    const request = vi.fn(async ({ url }: { url: string }) => new Response(JSON.stringify(url.includes('loadCodeAssist')
      ? { cloudaicompanionProject: 'synthetic-project' }
      : { groups: [{ displayName: 'proxy-account', buckets: [{ remainingFraction: 0.5 }] }] })))
    const ctx = new Context()
    ctx.plugin(AgYQuotaService, {
      cli: { run, cliPath: '/fake/agy' }, cliQuotaEnabled: () => enabled, mode: () => 'proxy',
      proxyQuota: { credential: { credential: async () => ({ accessToken: 'synthetic', projectId: 'synthetic-project', source: 'login' as const, updatedAt: 'x' }), revision: () => 1 }, transport: { request } },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
    // 默认关闭：本机有没有 agy 都不影响，套餐额度来自代理账户，一次都不 spawn。
    const off = await service.refresh()
    expect(off.groups[0]?.name).toBe('proxy-account')
    expect(off.credits).toMatchObject({ status: 'unavailable', error: { code: 'cli-disabled' } })
    expect(run).not.toHaveBeenCalled()
    // 打开开关：只有 AI Credits 走 CLI；套餐额度仍由代理账户提供，不被 CLI 账户顶替。
    enabled = true
    const on = await service.refresh()
    expect(on.groups[0]?.name).toBe('proxy-account')
    expect(on.credits).toMatchObject({ status: 'ok', remainingCredits: 200 })
    expect(run.mock.calls.map(([call]) => call.argv)).toEqual([expect.arrayContaining(['/credits'])])
  })

  it('打开开关后才 spawn agy；关掉后旧 CLI 快照失效且不再 spawn', async () => {
    let enabled = false
    const run = vi.fn<CliRun>(async (request) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(request.argv.includes('/credits') ? CREDITS_JSON : USAGE_JSON) }))
    const ctx = new Context()
    ctx.plugin(AgYQuotaService, { cli: { run, cliPath: '/fake/agy' }, cliQuotaEnabled: () => enabled })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const service = ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
    expect((await service.refresh()).credits?.status).toBe('unavailable')
    expect(run).not.toHaveBeenCalled()
    enabled = true
    const fresh = await service.refresh()
    expect(fresh.status).toBe('ok')
    expect(fresh.credits).toMatchObject({ status: 'ok', remainingCredits: 200 })
    expect(run).toHaveBeenCalledTimes(2)
    enabled = false
    const closed = await service.refresh()
    expect(closed.credits?.status).toBe('unavailable')
    expect(run).toHaveBeenCalledTimes(2)
  })
})
