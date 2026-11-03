import { describe, expect, it, vi } from 'vitest'
import { SettingsControl } from '../src/quota/control.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('设置页账户与目录控制', () => {
  it('切换目录来源后失败不显示旧模式的目录，在途旧结果也不会覆盖新模式', async () => {
    let source = 'acp'
    let release!: (value: Array<{ id: string; name: string }>) => void
    const gate = new Promise<Array<{ id: string; name: string }>>(resolve => { release = resolve })
    let pending = false
    const control = new SettingsControl({
      connect: async () => {}, modelSource: () => source,
      models: async () => {
        if (source === 'proxy') throw new Error('proxy unavailable')
        return pending ? gate : [{ id: 'acp', name: 'ACP' }]
      },
    })
    expect((await control.models()).models).toHaveLength(1)
    pending = true
    const old = control.models()
    source = 'proxy'
    expect(await control.models()).toMatchObject({ status: 'error', models: [] })
    release([{ id: 'old', name: 'Old' }])
    expect(await old).toMatchObject({ status: 'error', models: [] })
    await control.dispose()
  })
  it('代理账户代际变化后清空旧目录，刷新失败也不回退到前账户', async () => {
    let revision = 1
    const control = new SettingsControl({
      connect: async () => {}, modelSource: () => `proxy:${revision}`,
      models: async () => {
        if (revision !== 1) throw new Error('signed out')
        return [{ id: 'account-a', name: 'Account A' }]
      },
    })
    expect((await control.models()).models[0]?.id).toBe('account-a')
    revision = 2
    expect(await control.models(true)).toMatchObject({ status: 'error', models: [] })
    await control.dispose()
  })

  it('预热调用共享连接入口，状态读取可带实时快照且不会重新启动', async () => {
    const gate = deferred()
    const warmup = vi.fn(async () => gate.promise)
    const connect = vi.fn(async () => {})
    const control = new SettingsControl({ warmup, connect, models: async () => [],
      runtime: () => ({ phase: 'ready', phaseElapsedMs: 20, processRunning: true, starts: 1, reuses: 0, recycles: 0 }) })
    expect(control.account().runtime?.starts).toBe(1)
    expect(warmup).not.toHaveBeenCalled()
    expect(control.account('warmup').state).toBe('connecting')
    control.account('warmup')
    await Promise.resolve()
    expect(warmup).toHaveBeenCalledTimes(1)
    expect(connect).not.toHaveBeenCalled()
    gate.resolve()
    await vi.waitFor(() => expect(control.account().message).toContain('保留'))
    await control.dispose()
  })
  it('状态读取不登录；显式连接 single-flight，完成前不报告成功', async () => {
    const gate = deferred()
    const connect = vi.fn(async () => gate.promise)
    const control = new SettingsControl({ connect, models: async () => [] })
    expect(control.account().state).toBe('idle')
    expect(connect).not.toHaveBeenCalled()
    expect(control.account('login').state).toBe('connecting')
    control.account('login')
    await Promise.resolve()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(control.account().state).toBe('connecting')
    gate.resolve()
    await vi.waitFor(() => expect(control.account().state).toBe('connected'))
    await control.dispose()
  })

  it('取消等待真实清理完成；卸载时中止连接并拒绝后续操作', async () => {
    let stopped = false
    const control = new SettingsControl({
      connect: async (signal) => new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { stopped = true; resolve() }, { once: true })
      }), models: async () => [],
    })
    control.account('login')
    await Promise.resolve()
    expect(control.account('cancel').state).toBe('cancelling')
    expect(stopped).toBe(true)
    await vi.waitFor(() => expect(control.account().state).toBe('cancelled'))
    control.account('login')
    await Promise.resolve()
    await control.dispose()
    expect(() => control.account()).toThrow('已卸载')
    await expect(control.models()).rejects.toThrow('已卸载')
  })

  it('登录失败保留可读错误而不回传凭据，允许重试', async () => {
    let calls = 0
    const secret = ['test', 'secret', 'value'].join('-')
    const control = new SettingsControl({
      connect: async () => { if (++calls === 1) throw new Error('access_token=' + secret) }, models: async () => [],
    })
    control.account('login')
    await vi.waitFor(() => expect(control.account().state).toBe('error'))
    expect(JSON.stringify(control.account())).not.toContain(secret)
    control.account('login')
    await vi.waitFor(() => expect(control.account().state).toBe('connected'))
    await control.dispose()
  })

  it('连接还未开始就取消时，不调用官方启动函数', async () => {
    const connect = vi.fn(async () => {})
    const control = new SettingsControl({ connect, models: async () => [] })
    control.account('login')
    control.account('cancel')
    await vi.waitFor(() => expect(control.account().state).toBe('cancelled'))
    expect(connect).not.toHaveBeenCalled()
    await control.dispose()
  })

  it('代理模式从控制层拒绝 ACP 登录与预热', async () => {
    const connect = vi.fn(async () => {})
    const warmup = vi.fn(async () => {})
    const control = new SettingsControl({ connect, warmup, acpEnabled: () => false, models: async () => [] })
    expect(() => control.account('login')).toThrow('ACP 连接与预热功能已停用')
    expect(() => control.account('warmup')).toThrow('ACP 连接与预热功能已停用')
    expect(connect).not.toHaveBeenCalled()
    expect(warmup).not.toHaveBeenCalled()
    await control.dispose()
  })

  it('模型显式刷新传 force；失败保留上次目录', async () => {
    const forced: boolean[] = []
    const control = new SettingsControl({ connect: async () => {}, models: async (force) => {
      forced.push(force)
      if (force) throw new Error('catalog unavailable')
      return [{ id: 'gemini-test', name: 'Test Gemini' }]
    } })
    expect((await control.models()).models).toHaveLength(1)
    const failed = await control.models(true)
    expect(failed).toMatchObject({ status: 'error', models: [{ id: 'gemini-test' }], message: 'catalog unavailable' })
    expect(forced).toEqual([false, true])
    await control.dispose()
  })
})
