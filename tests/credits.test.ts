import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { fetchAgyCredits, parseAgyCredits } from '../src/runtime/credits.js'
import type { CliRun } from '../src/runtime/agy-cli.js'
import { AgYQuotaService, AGY_QUOTA_SERVICE } from '../src/quota/quota-remote.js'

// 字段形态来自实际只读探针；所有测试金额均为虚构，无用户账户信息。
const envelope = (remaining: unknown = 123) => ({ status: 'SUCCESS', num_turns: 0,
  usage: { total_tokens: 0 }, command: { name: 'credits', data: { remaining_credits: remaining } } })
const success = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })
const usage = () => success({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [{ name: '5h', window: '5h', remaining_fraction: .7 }] }] } } })

async function service(run?: CliRun) {
  const ctx = new Context()
  ctx.plugin(AgYQuotaService, run ? { cli: { run, cliPath: '/fake/agy' } } : {
    deps: { homedir: () => '/fake/home', readFileImpl: async () => { throw new Error('ENOENT') }, fetchImpl: async () => { throw new Error('unexpected network') } },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return ctx.get(AGY_QUOTA_SERVICE) as AgYQuotaService
}

describe('官方 AI Credits 契约', () => {
  it('读取已核验的 command.data；真实零保留，忽略升级链接和未知字段', () => {
    expect(parseAgyCredits(envelope(0))).toEqual({ remainingCredits: 0 })
    const payload = envelope(123)
    Object.assign(payload.command.data, { plan_name: 'Example plan', upgrade_uri: 'javascript:bad', unrelated: 'ignored' })
    expect(parseAgyCredits(payload)).toEqual({ remainingCredits: 123, planName: 'Example plan' })
  })

  it.each([undefined, null, -1, 1.25, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '42'])('拒绝缺失或非法金额 %s，不转成零', (value) => {
    const payload = envelope(1)
    payload.command.data.remaining_credits = value
    expect(() => parseAgyCredits(payload)).toThrow('remaining_credits')
  })

  it('拒绝错误信封和其它命令', () => {
    expect(() => parseAgyCredits({ ...envelope(), status: 'ERROR' })).toThrow()
    expect(() => parseAgyCredits({ ...envelope(), command: { name: 'usage', data: { remaining_credits: 5 } } })).toThrow()
  })

  it.each([undefined, 0, 1])('余额有效时不因无关回合计数 %s 拒绝报告', (turns) => {
    const { num_turns: _turns, ...payload } = envelope(123)
    expect(parseAgyCredits(turns === undefined ? payload : { ...payload, num_turns: turns }))
      .toEqual({ remainingCredits: 123 })
  })

  it('只调用 /credits；读取有界，错误已脱敏', async () => {
    const run = vi.fn<CliRun>(async () => success(envelope()))
    expect(await fetchAgyCredits(run, '/fake/agy')).toMatchObject({ status: 'ok', remainingCredits: 123 })
    expect(run).toHaveBeenCalledWith({ argv: ['/fake/agy', '-p', '/credits', '--output-format', 'json'], timeoutMs: 45000 })
    const failed = await fetchAgyCredits(async () => ({ exitCode: 1, stdout: '', stderr: 'access_token=fake-sensitive-value' }), 'fake')
    expect(failed.status).toBe('error')
    expect(JSON.stringify(failed)).not.toContain('fake-sensitive-value')
  })

  it.each(['no credits info found', 'no credit information is available for this account', 'unsupported command /credits'])('缺失或旧 CLI 不冒充零余额：%s', async (stderr) => {
    const snapshot = await fetchAgyCredits(async () => ({ exitCode: 1, stdout: '', stderr }), 'fake')
    expect(snapshot.status).toBe('unavailable')
    expect(snapshot.remainingCredits).toBeUndefined()
  })

  it('JSON 损坏、字段缺失和超时均为失败，不能变为零', async () => {
    for (const run of [
      async () => ({ exitCode: 0, stdout: 'not JSON', stderr: '' }),
      async () => success({ status: 'SUCCESS', num_turns: 0, command: { name: 'credits', data: {} } }),
      async () => { throw new Error('query timeout') },
    ]) {
      const snapshot = await fetchAgyCredits(run, 'fake')
      expect(snapshot.status).toBe('error')
      expect(snapshot.remainingCredits).toBeUndefined()
    }
  })
})

describe('套餐额度与余额独立状态/缓存', () => {
  it('余额失败保留上次值和时间，下一次只重试余额，不重取正常额度', async () => {
    let quotaCalls = 0, creditCalls = 0, failing = false
    const api = await service(async ({ argv }) => {
      if (argv.includes('/usage')) { quotaCalls++; return usage() }
      creditCalls++
      return failing ? { exitCode: 1, stdout: '', stderr: 'network down' } : success(envelope(42))
    })
    const first = await api.read()
    failing = true
    const second = await api.read({ force: true })
    expect(second.stale).not.toBe(true)
    expect(second.credits).toMatchObject({ status: 'ok', remainingCredits: 42, stale: true, updatedAt: first.credits!.updatedAt })
    expect(second.credits!.staleReason).toContain('network down')
    failing = false
    expect((await api.read()).credits?.stale).toBeUndefined()
    expect([quotaCalls, creditCalls]).toEqual([2, 3])
    await api.read()
    expect([quotaCalls, creditCalls]).toEqual([2, 3])
  })

  it('额度失败不掩盖有效零余额；重试额度复用余额缓存', async () => {
    let quotaCalls = 0, creditCalls = 0
    const api = await service(async ({ argv }) => {
      if (argv.includes('/credits')) { creditCalls++; return success(envelope(0)) }
      quotaCalls++
      return { exitCode: 1, stdout: '', stderr: 'usage unavailable' }
    })
    expect(await api.read()).toMatchObject({ status: 'error', credits: { status: 'ok', remainingCredits: 0 } })
    await api.read()
    expect([quotaCalls, creditCalls]).toEqual([2, 1])
  })

  it('明确不再提供余额时撤下旧余额，不把其它账户信息标为新值', async () => {
    let missing = false
    const api = await service(async ({ argv }) => argv.includes('/usage') ? usage() : missing
      ? { exitCode: 1, stdout: '', stderr: 'no credits info found' } : success(envelope(42)))
    await api.read()
    missing = true
    const result = await api.read({ force: true })
    expect(result.credits?.status).toBe('unavailable')
    expect(result.credits?.remainingCredits).toBeUndefined()
  })

  it('force 不并入只有余额在刷新的请求，仍重取两路', async () => {
    let quotaCalls = 0, creditCalls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const api = await service(async ({ argv }) => {
      if (argv.includes('/usage')) { quotaCalls++; return usage() }
      const n = ++creditCalls
      if (n === 2) return { exitCode: 1, stdout: '', stderr: 'network down' }
      if (n === 3) await gate
      return success(envelope(42))
    })
    await api.read()
    await api.read({ force: true })
    const partial = api.read()
    const forced = api.read({ force: true })
    expect([quotaCalls, creditCalls]).toEqual([2, 3])
    release()
    await Promise.all([partial, forced])
    expect([quotaCalls, creditCalls]).toEqual([3, 4])
  })

  it('CLI 缺失时余额明确 unavailable，不从 HTTP 配额推算', async () => {
    const result = await (await service()).read()
    expect(result.credits).toMatchObject({ status: 'unavailable', error: { code: 'cli-unavailable' } })
    expect(result.credits?.remainingCredits).toBeUndefined()
  })
})
