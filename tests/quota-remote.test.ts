/**
 * 回归：Cordis Service 的方法经 Proxy 调用，`this` 是代理而非真实实例。
 * AgYQuotaService 以前用 ES 真私有字段（`#cli`），经 `ctx.agyQuota.read()` 调用时抛
 * “Cannot read private member #cli from an object whose class did not declare it”。
 * 这里必须经真实 Cordis Context 调用，直接 `new` 实例复现不出来。
 */
import { Context } from '@deepseek-ai/cordis'
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
      expect((await service.read()).status).toBe('ok')
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
      expect((await service.read()).groups[0]?.name).toBe('account-1')
      signedIn = false; revision++
      const signedOut = await service.read()
      expect(signedOut).toMatchObject({ status: 'error', groups: [], error: { code: 'token-missing' } })
      expect(signedOut.stale).not.toBe(true)
      signedIn = true; revision++
      expect((await service.read()).groups[0]?.name).toBe('account-3')
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
      const old = service.read()
      await started
      revision++
      const current = service.read()
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
      expect((await service.read()).groups).toHaveLength(1)
      mode = 'proxy'
      expect(await service.read()).toMatchObject({ status: 'error', groups: [], error: { code: 'token-missing' } })
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
      const old = service.read()
      mode = 'proxy'
      const current = service.read()
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

  it('ctx.agyQuota.read() 不因私有字段品牌检查失败，且走 CLI 取数', async () => {
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

    const service = (ctx as unknown as Record<string, { read(r?: { force?: boolean }): Promise<{ status: string; error?: { message: string } }> }>)[AGY_QUOTA_SERVICE]!
    expect(service).toBeDefined()
    const snapshot = await service.read({ force: true })

    expect(snapshot.error?.message ?? '').not.toMatch(/private member/)
    expect(snapshot.status).toBe('ok')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(['/fake/agy', '-p', '/usage', '--output-format', 'json'])
    expect(calls[1]).toEqual(['/fake/agy', '-p', '/credits', '--output-format', 'json'])
    expect(logs.join('\n')).toContain('cli=/fake/agy')
  })
  it('同一轮双路刷新不会把后完成的缓存时间戳回退', async () => {
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
      await service.read()
      expect(runs).toBe(2)
      vi.setSystemTime(startedAt + 290_000)
      await service.read()
      // 两路缓存都只有 5 分钟寿命；usage 的时间戳不能比本轮开始还早。
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
    await service.read({ force: true })
    expect(runs).toBe(2)
    await service.read()
    expect(runs).toBe(2)

  })

  it('并发 read 合并为一次 CLI 取数，而不是各起一个进程', async () => {
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
    const service = (ctx as unknown as Record<string, { read(r?: { force?: boolean }): Promise<{ status: string }> }>)[AGY_QUOTA_SERVICE]!
    const first = service.read({ force: true })
    const second = service.read({ force: true })
    const third = service.read()
    release?.()
    const results = await Promise.all([first, second, third])
    expect(runs).toBe(2) // 并发读取合并：/usage 与 /credits 各一次。
    expect(results.map((item) => item.status)).toEqual(['ok', 'ok', 'ok'])
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
    const snapshot = await service.read()
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
    const off = await service.read()
    expect(off.groups[0]?.name).toBe('proxy-account')
    expect(off.credits).toMatchObject({ status: 'unavailable', error: { code: 'cli-disabled' } })
    expect(run).not.toHaveBeenCalled()
    // 打开开关：只有 AI Credits 走 CLI；套餐额度仍由代理账户提供，不被 CLI 账户顶替。
    enabled = true
    const on = await service.read()
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
    expect((await service.read()).credits?.status).toBe('unavailable')
    expect(run).not.toHaveBeenCalled()
    enabled = true
    const fresh = await service.read()
    expect(fresh.status).toBe('ok')
    expect(fresh.credits).toMatchObject({ status: 'ok', remainingCredits: 200 })
    expect(run).toHaveBeenCalledTimes(2)
    enabled = false
    const closed = await service.read()
    expect(closed.credits?.status).toBe('unavailable')
    expect(run).toHaveBeenCalledTimes(2)
  })
})
