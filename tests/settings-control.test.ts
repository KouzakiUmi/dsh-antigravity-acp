import { describe, expect, it, vi } from 'vitest'
import { SettingsControl } from '../src/quota/control.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('设置页账户与目录控制', () => {
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
