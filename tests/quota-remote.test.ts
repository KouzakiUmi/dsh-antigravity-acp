/**
 * 回归：Cordis Service 的方法经 Proxy 调用，`this` 是代理而非真实实例。
 * AgYQuotaService 以前用 ES 真私有字段（`#cli`），经 `ctx.agyQuota.read()` 调用时抛
 * “Cannot read private member #cli from an object whose class did not declare it”。
 * 这里必须经真实 Cordis Context 调用，直接 `new` 实例复现不出来。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { CliRun } from '../src/runtime/agy-cli.js'
import { AgYQuotaService, AGY_QUOTA_SERVICE } from '../src/quota/quota-remote.js'

const USAGE_JSON = {
  command: {
    data: {
      groups: [
        { name: 'Gemini', models: ['gemini-x'], usage: { remainingFraction: 0.5, resetTime: '2026-10-21T00:00:00Z' } },
      ],
    },
  },
}

describe('AgYQuotaService 经 Cordis Proxy 调用', () => {
  it('ctx.agyQuota.read() 不因私有字段品牌检查失败，且走 CLI 取数', async () => {
    const calls: string[][] = []
    const run: CliRun = async (request) => {
      calls.push([...request.argv])
      return { exitCode: 0, stdout: JSON.stringify(USAGE_JSON), stderr: '' }
    }
    const logs: string[] = []
    const ctx = new Context()
    ctx.plugin(AgYQuotaService, {
      cli: { run, cliPath: '/fake/agy' },
      log: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(`WARN ${m}`) },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const service = (ctx as unknown as Record<string, { read(r?: { force?: boolean }): Promise<{ status: string; error?: { message: string } }> }>)[AGY_QUOTA_SERVICE]!
    expect(service).toBeDefined()
    const snapshot = await service.read({ force: true })

    expect(snapshot.error?.message ?? '').not.toMatch(/private member/)
    expect(snapshot.status).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['/fake/agy', '-p', '/usage', '--output-format', 'json'])
    expect(logs.join('\n')).toContain('cli=/fake/agy')
  })
  it('并发 read 合并为一次 CLI 取数，而不是各起一个进程', async () => {
    let runs = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run: CliRun = async () => {
      runs += 1
      await gate
      return { exitCode: 0, stdout: JSON.stringify(USAGE_JSON), stderr: '' }
    }
    const ctx = new Context()
    ctx.plugin(AgYQuotaService, { cli: { run, cliPath: '/fake/agy' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const service = (ctx as unknown as Record<string, { read(r?: { force?: boolean }): Promise<{ status: string }> }>)[AGY_QUOTA_SERVICE]!
    const first = service.read({ force: true })
    const second = service.read({ force: true })
    const third = service.read()
    release?.()
    const results = await Promise.all([first, second, third])
    expect(runs).toBe(1)
    expect(results.map((item) => item.status)).toEqual(['ok', 'ok', 'ok'])
  })
})
