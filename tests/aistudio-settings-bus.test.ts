import { describe, expect, it, vi } from 'vitest'
import { AISTUDIO_DEFAULT_CREDENTIAL_REF, createAistudioSettingsBus } from '../src/aistudio/settings-bus.js'

function makeBus(initial: { enabled?: boolean; ref?: string } = {}) {
  const state = { enabled: initial.enabled, ref: initial.ref }
  const bus = createAistudioSettingsBus({
    enabled: () => state.enabled,
    credentialRef: () => state.ref,
    modelSettings: () => ({ modelOverrides: { 'aistudio-gemini-2.5-flash': { name: 'Flash' } } }),
    proxySettings: () => ({ url: 'http://127.0.0.1:7890' }),
  })
  return { bus, state }
}

describe('AI Studio 设置总线', () => {
  it('引用名缺省/空白回退默认 AISTUDIO_API_KEY', () => {
    const { bus, state } = makeBus()
    expect(bus.credentialRef()).toBe(AISTUDIO_DEFAULT_CREDENTIAL_REF)
    state.ref = '   '
    expect(bus.credentialRef()).toBe(AISTUDIO_DEFAULT_CREDENTIAL_REF)
    state.ref = ' MY_KEY '
    expect(bus.credentialRef()).toBe('MY_KEY')
  })

  it('enabled 只认真值 true', () => {
    const { bus, state } = makeBus()
    expect(bus.enabled()).toBe(false)
    state.enabled = true
    expect(bus.enabled()).toBe(true)
  })

  it('开关变化通知订阅者', () => {
    const { bus, state } = makeBus()
    const listener = vi.fn()
    bus.subscribe(listener)
    state.enabled = true
    bus.notify()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('引用名变化也通知（换 key 后刷新目录）', () => {
    const { bus, state } = makeBus({ enabled: true })
    const listener = vi.fn()
    bus.subscribe(listener)
    state.ref = 'OTHER_KEY'
    bus.notify()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('无变化不通知', () => {
    const { bus } = makeBus({ enabled: true, ref: 'AISTUDIO_API_KEY' })
    const listener = vi.fn()
    bus.subscribe(listener)
    bus.notify()
    expect(listener).not.toHaveBeenCalled()
  })

  it('退订后不再通知', () => {
    const { bus, state } = makeBus()
    const listener = vi.fn()
    const unsubscribe = bus.subscribe(listener)
    unsubscribe()
    state.enabled = true
    bus.notify()
    expect(listener).not.toHaveBeenCalled()
  })

  it('modelSettings / proxySettings 透传', () => {
    const { bus } = makeBus()
    expect(bus.modelSettings()).toEqual({ modelOverrides: { 'aistudio-gemini-2.5-flash': { name: 'Flash' } } })
    expect(bus.proxySettings()).toEqual({ url: 'http://127.0.0.1:7890' })
  })
})
