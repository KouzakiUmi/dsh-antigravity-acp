import { buildClientSource } from '../scripts/client-bundle.mjs'
import { runInNewContext } from 'node:vm'
import React from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, LIVE_SETTING_KEYS, liveHostConfig } from '../src/settings.js'

type SettingsDocument = { writable: boolean; namespaces: Array<{ ns: string; revision: number; value: Record<string, unknown> }> }

function document(value: Record<string, unknown> = {}, revision = 1, writable = true): SettingsDocument {
  return { writable, namespaces: [{ ns: 'llm-antigravity-acp', revision, value }] }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const renderers: ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount() })
  vi.useRealTimers()
})

/** Real React hooks and rerenders; only the DSH loader/transport and browser timers are substituted. */
type SharedQuotaReader = ((force: boolean, source?: string) => Promise<unknown>) & {
  observeProxyAccount(snapshot: { phase: string; revision: number }): void
  observeMode(source: string): void
}
function loadCard(quotaRead?: () => Promise<unknown>) {
  let registration: { factory(require: (id: string) => unknown): { apply(ctx: unknown): void } } | undefined
  const components = new Map<string, React.ComponentType<Record<string, unknown>>>()
  const injections = new Map<string, () => Record<string, unknown>>()
  const intervals = new Map<number, { callback: () => void; delay: number }>()
  let timerId = 0
  runInNewContext(buildClientSource(), {
    window: { __ModuleLoader__: { load: (value: typeof registration) => { registration = value } }, innerHeight: 800, addEventListener: () => {}, removeEventListener: () => {} },
    document: { documentElement: { clientWidth: 1200 }, addEventListener: () => {}, removeEventListener: () => {} },
    setInterval: (callback: () => void, delay: number) => { intervals.set(++timerId, { callback, delay }); return timerId },
    clearInterval: (id: number) => intervals.delete(id),
    setTimeout, clearTimeout,
    // 沿用测试进程的 Date：vi.setSystemTime 才能固定 client 的退役判定（vm 上下文默认有自己的内建 Date）。
    Date,
  })
  const slots = {
    inject: (_name: string, callback: () => void) => { callback(); return () => {} },
    register: (row: { id: string; inject?: () => Record<string, unknown> }, component: React.ComponentType<Record<string, unknown>>) => {
      components.set(row.id, component)
      if (row.inject) injections.set(row.id, row.inject)
      return () => {}
    },
  }
  const ctx = {
    slots,
    remote: { $mount: () => () => {} },
    get: (name: string) => name === 'remote.agyQuota' ? { read: quotaRead, refresh: quotaRead } : undefined,
    effect: (callback: () => unknown) => callback(),
    inject: (_names: string[], callback: (scope: unknown) => void) => callback(ctx),
  }
  registration!.factory(() => React).apply(ctx)
  return { Card: components.get('antigravity-acp')!, Pill: components.get('antigravity-quota')!, intervals,
    reader: injections.get('antigravity-acp')!().readQuota as SharedQuotaReader }
}

function transport(initial = document()) {
  let current = initial
  let listener: ((namespace: string) => void) | undefined
  const describe = vi.fn(async () => current)
  const mutate = vi.fn(async (_namespace: string, _ops: unknown[], _revision: number) => ({ ok: true, value: undefined }))
  return {
    describe, mutate,
    remote: {
      settings: { describe, mutate },
      llm: { listProviders: async () => [{ id: 'antigravity-acp' }] },
      $on: (_event: string, callback: (namespace: string) => void) => { listener = callback; return () => { listener = undefined } },
    },
    change(next: SettingsDocument) { current = next; listener?.('llm-antigravity-acp') },
    set(next: SettingsDocument) { current = next },
    notify() { listener?.('llm-antigravity-acp') },
  }
}

async function mount(remote: unknown, control?: unknown, proxyControl?: unknown, readQuota?: unknown, aistudioControl?: unknown) {
  const { Card, intervals } = loadCard()
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(React.createElement(Card, { remote, control, proxyControl, readQuota, aistudioControl })) })
  renderers.push(renderer)
  return { renderer, intervals }
}

async function mountPill(readQuota: unknown) {
  const { Pill } = loadCard()
  const modelSnapshot = { current: { provider: 'antigravity-acp', model: 'gemini-flash' } }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => modelSnapshot,
  }
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(React.createElement(Pill, { store, readQuota })) })
  renderers.push(renderer)
  return renderer
}

/** 带真实几何的药丸挂载：按钮 ref 注入 getBoundingClientRect，驱动 useLayoutEffect 定位。
 *  快照必须是稳定引用：useSyncExternalStore 每次返回新对象会触发无限重渲染。 */
async function mountPillWithRect(rect: { left: number; right: number; top: number; bottom: number }) {
  const { Pill } = loadCard()
  const snapshot = { current: { provider: 'antigravity-acp', model: 'gemini-flash' } }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot }
  const readQuota = async () => ({ status: 'ok', groups: [{ name: 'Gemini', buckets: [{ window: '5h', remainingPct: 95 }] }] })
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(React.createElement(Pill, { store, readQuota }), {
      createNodeMock: (element) =>
        element.type === 'button' && (element.props as Record<string, unknown>)['aria-haspopup'] === 'dialog'
          ? { getBoundingClientRect: () => rect, focus: () => {} }
          : null,
    })
  })
  renderers.push(renderer)
  await act(async () => { await renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props.onClick() })
  return renderer
}

function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.findAllByType('button').find((node) => node.children.join('') === label || node.props['aria-label'] === label)!
}
function fieldInput(renderer: ReactTestRenderer, name: string): ReactTestInstance {
  return renderer.root.findByProps({ name })
}
/** 逐模型列表里某一行的控件。 */
function modelControl(renderer: ReactTestRenderer, kind: 'enabled' | 'effort' | 'target' | 'name', id: string): ReactTestInstance {
  return renderer.root.findByProps({ name: `model-${kind}-${id}` })
}
function renderedText(renderer: ReactTestRenderer): string { return JSON.stringify(renderer.toJSON()) }

describe('quota pill with real React state and effects', () => {
  it('设置页关闭时，实际共享读取器仍随代理退出和换账户清空并更新药丸', async () => {
    let snapshot = { phase: 'signed-in', revision: 1 }
    const quotaRead = vi.fn(async () => snapshot.phase === 'signed-in'
      ? { status: 'ok', groups: [{ name: 'Gemini', buckets: [{ window: '5h', remainingPct: snapshot.revision === 1 ? 81 : 34 }] }] }
      : { status: 'error', groups: [], error: { message: '代理账户未登录' } })
    const { Pill, intervals, reader } = loadCard(quotaRead)
    const proxyControl = async () => ({ snapshot })
    const store = { subscribe: () => () => {}, getSnapshot: () => state }
    const state = { current: { provider: 'antigravity-proxy', model: 'antigravity-gemini-3.8-flash' } }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Pill, { store, readQuota: reader, proxyControl })) })
    renderers.push(renderer)
    expect(renderer.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(81)
    snapshot = { phase: 'signed-out', revision: 2 }
    await act(async () => { for (const timer of intervals.values()) if (timer.delay === 3000) timer.callback() })
    expect(renderer.root.findAllByProps({ role: 'progressbar' })).toHaveLength(0)
    snapshot = { phase: 'signed-in', revision: 3 }
    await act(async () => { for (const timer of intervals.values()) if (timer.delay === 3000) timer.callback() })
    expect(renderer.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(34)
    expect(quotaRead).toHaveBeenCalledTimes(3)
  })
  it('共享额度读取器通知自身时也结束刷新，可再次手动刷新', async () => {
    const listeners = new Set<(value: unknown, source: unknown) => void>()
    const snapshot = { status: 'ok', groups: [{ name: 'Gemini', buckets: [{ window: '5h', remainingPct: 82 }] }] }
    const readQuota = Object.assign(vi.fn(async (_force: boolean, source: unknown) => {
      for (const listener of listeners) listener(snapshot, source)
      return snapshot
    }), { subscribe: (listener: (value: unknown, source: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener) } })
    const renderer = await mountPill(readQuota)
    await act(async () => { await renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props.onClick() })
    expect(button(renderer, '刷新额度').props.disabled).toBe(false)
    await act(async () => { await button(renderer, '刷新额度').props.onClick() })
    expect(readQuota).toHaveBeenCalledTimes(2)
    expect(button(renderer, '刷新额度').props.disabled).toBe(false)
    await act(async () => { renderer.root.findByProps({ 'aria-label': '关闭额度详情' }).props.onClick() })
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
  })
  it('ACP 与代理切换时清除旧额度并立即取新数据，代理模型可匹配额度组', async () => {
    const { Pill } = loadCard()
    const pending = deferred<unknown>()
    let snapshot = { current: { provider: 'antigravity-acp', model: 'gemini-flash' } }
    const listeners = new Set<() => void>()
    const store = { subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, getSnapshot: () => snapshot }
    const readQuota = vi.fn(async () => ({ status: 'ok', groups: [{ name: 'Gemini', buckets: [{ window: '5h', remainingPct: 82 }] }] }) as unknown)
    readQuota.mockImplementationOnce(async () => ({ status: 'ok', groups: [{ name: 'Gemini', buckets: [{ window: '5h', remainingPct: 82 }] }] }))
    readQuota.mockImplementationOnce(() => pending.promise)
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Pill, { store, readQuota })) })
    renderers.push(renderer)
    expect(renderer.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(82)
    await act(async () => {
      snapshot = { current: { provider: 'antigravity-proxy', model: 'antigravity-gemini-3.8-flash' } }
      for (const listener of listeners) listener()
    })
    expect(readQuota).toHaveBeenCalledTimes(2)
    expect(renderer.root.findAllByProps({ role: 'progressbar' })).toHaveLength(0)
    await act(async () => { pending.resolve({ status: 'ok', groups: [{ name: 'Gemini', buckets: [{ window: '5h', remainingPct: 42 }] }] }) })
    expect(renderer.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(42)
  })

  it('跨家族官方映射使用实际路由模型的额度组', async () => {
    const renderer = await mountPill(async () => ({
      status: 'ok', requestedModel: 'gemini-flash', routeModel: 'claude-opus-5-5-low',
      groups: [
        { name: 'Gemini', buckets: [{ window: '5h', remainingPct: 81 }] },
        { name: 'Claude and GPT models', buckets: [{ window: '5h', remainingPct: 42 }] },
      ],
    }))
    expect(renderer.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(42)
  })

  it('近期历史裁剪在药丸警示并可在详情查看，过期事件不提示（issue #16）', async () => {
    const fresh = { at: new Date().toISOString(), omittedCount: 3, omittedBytes: 90_000, totalBytes: 170_000 }
    const renderer = await mountPill(async () => ({
      status: 'ok', groups: [{ name: 'Gemini', buckets: [{ window: '5h', remainingPct: 82 }] }],
      historyNotices: [fresh],
    }))
    expect(renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props['aria-label']).toContain('历史已裁剪')
    await act(async () => { await renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props.onClick() })
    expect(renderedText(renderer)).toContain('省略 3 条消息')
    expect(renderedText(renderer)).toContain('DSH 上下文条不反映被裁剪部分')
  })

  it('超过展示窗口的裁剪事件不再警示（issue #16）', async () => {
    const stale = { at: new Date(Date.now() - 60 * 60_000).toISOString(), omittedCount: 3, omittedBytes: 90_000, totalBytes: 170_000 }
    const renderer = await mountPill(async () => ({
      status: 'ok', groups: [{ name: 'Gemini', buckets: [{ window: '5h', remainingPct: 82 }] }],
      historyNotices: [stale],
    }))
    expect(renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props['aria-label']).not.toContain('历史已裁剪')
  })

  it('失败信封转成可读错误，不把异常抛出组件', async () => {
    const renderer = await mountPill(async () => ({ ok: false, error: { message: 'remote denied' } }))
    expect(renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props['aria-label']).toContain('额度读取失败')
    await act(async () => { await renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props.onClick() })
    expect(renderedText(renderer)).toContain('remote denied')
  })

  it('展开的弹层 absolute 锚在药丸上：右缘对齐、向上展开，不做视口坐标钳位（0.1.51 遮挡回归）', async () => {
    // loadCard 视口 1200×800；按钮位于底部输入栏（top 744）。右对齐左端 660 ≥ 12 无溢出。
    const renderer = await mountPillWithRect({ left: 900, right: 1000, top: 744, bottom: 770 })
    const popover = renderer.root.findByProps({ role: 'dialog' })
    expect(popover.props.style).toMatchObject({
      position: 'absolute', right: 0, left: 'auto',
      bottom: 'calc(100% + 8px)', top: 'auto', width: 340,
    })
    // 关闭后重开不叠加坐标状态，仍是同一锚定。
    await act(async () => { await renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props.onClick() })
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
    await act(async () => { await renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props.onClick() })
    expect(renderer.root.findByProps({ role: 'dialog' }).props.style).toMatchObject({ position: 'absolute', right: 0 })
  })

  it('右缘对齐越过视口左缘且左对齐更放得下时翻转 left:0', async () => {
    // 按钮 left:10 right:110：右对齐左端 -230（溢出 242），左对齐右端 350（无溢出）→ left:0。
    const renderer = await mountPillWithRect({ left: 10, right: 110, top: 744, bottom: 770 })
    expect(renderer.root.findByProps({ role: 'dialog' }).props.style).toMatchObject({
      position: 'absolute', left: 0, right: 'auto', bottom: 'calc(100% + 8px)',
    })
  })

  it('顶部药丸下方空间更宽裕时向下展开', async () => {
    const renderer = await mountPillWithRect({ left: 900, right: 1000, top: 30, bottom: 56 })
    expect(renderer.root.findByProps({ role: 'dialog' }).props.style).toMatchObject({
      position: 'absolute', right: 0, top: 'calc(100% + 8px)', bottom: 'auto',
    })
  })

  it('刷新异常保留成功快照并标缓存，后续成功清除缓存标记', async () => {
    let fail = false
    const snapshot = { status: 'ok', updatedAt: '2026-10-25T00:00:00Z', groups: [
      { name: 'Gemini Models', buckets: [{ window: '5h', remainingPct: 82 }] },
    ] }
    const readQuota = vi.fn(async () => {
      if (fail) throw new Error('refresh timeout')
      return snapshot
    })
    const renderer = await mountPill(readQuota)
    await act(async () => { await renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props.onClick() })
    expect(renderedText(renderer)).toContain('82')
    fail = true
    await act(async () => { await button(renderer, '刷新额度').props.onClick() })
    expect(renderedText(renderer)).toContain('缓存数据 · Error: refresh timeout')
    expect(renderedText(renderer)).toContain('82')
    fail = false
    await act(async () => { await button(renderer, '刷新额度').props.onClick() })
    expect(renderedText(renderer)).not.toContain('缓存数据')
    expect(renderedText(renderer)).toContain('82')
  })
})

describe('settings card with real React state and effects', () => {
  it('实际共享读取器丢弃旧账户的迟到广播，不覆盖新账户已成功额度', async () => {
    const pending = deferred<unknown>()
    const quotaRead = vi.fn(async () => ({ status: 'ok', groups: [{ name: 'CURRENT-B', buckets: [{ remainingPct: 34 }] }] }) as unknown)
    quotaRead.mockImplementationOnce(() => pending.promise)
    const { reader } = loadCard(quotaRead)
    const service = transport(document({ proxyMode: true }))
    let snapshot = { phase: 'signed-in', revision: 1, message: 'A' }
    const proxyControl = async () => ({ snapshot })
    const { renderer, intervals } = await mount(service.remote, undefined, proxyControl, reader)
    let first: Promise<void> | undefined
    await act(async () => { first = button(renderer, '拉取额度').props.onClick() })
    snapshot = { phase: 'signed-in', revision: 3, message: 'B' }
    await act(async () => { for (const timer of intervals.values()) if (timer.delay === 3000) timer.callback() })
    await act(async () => { await button(renderer, '拉取额度').props.onClick() })
    expect(renderedText(renderer)).toContain('CURRENT-B')
    await act(async () => { pending.resolve({ status: 'error', groups: [], error: { message: 'STALE-A-ACCOUNT-CHANGED' } }); await first })
    expect(renderedText(renderer)).toContain('CURRENT-B')
    expect(renderedText(renderer)).not.toContain('STALE-A-ACCOUNT-CHANGED')
  })
  it('保存栏常驻顶部，只提供一个保存入口，编辑和撤销更新未保存计数', async () => {
    const service = transport(document())
    const { renderer } = await mount(service.remote)
    const bar = renderer.root.findByProps({ 'aria-label': '设置保存操作' })
    expect(bar.props.style).toMatchObject({ position: 'sticky', top: 0, display: 'none' })
    expect(bar.findAllByType('button').filter(node => node.children.join('') === '保存')).toHaveLength(1)
    expect(button(renderer, '保存').props.disabled).toBe(true)
    await act(async () => { fieldInput(renderer, 'proxyUrl').props.onChange({ target: { value: 'http://127.0.0.1:7890' } }) })
    expect(renderedText(renderer)).toContain('1 项未保存')
    expect(bar.props.style.display).toBe('grid')
    expect(button(renderer, '保存').props.disabled).toBe(false)
    await act(async () => { button(renderer, '撤销').props.onClick() })
    expect(renderedText(renderer)).not.toContain('项未保存')
    expect(button(renderer, '保存').props.disabled).toBe(true)
  })

  it('未保存网络设置阻止使用旧设置连接，但取消登录仍可用', async () => {
    const service = transport(document({ proxyMode: true }))
    const proxyControl = vi.fn(async () => ({ snapshot: { phase: 'pending-login', connectionStage: 'authorizing', revision: 0, message: '等待授权' } }))
    const { renderer } = await mount(service.remote, undefined, proxyControl)
    await act(async () => { fieldInput(renderer, 'proxyUrl').props.onChange({ target: { value: 'http://127.0.0.1:7890' } }) })
    expect(renderedText(renderer)).toContain('请先保存网络设置')
    expect(button(renderer, '取消登录').props.disabled).toBe(false)
    await act(async () => { await button(renderer, '取消登录').props.onClick() })
    expect(proxyControl).toHaveBeenCalledWith('account', { action: 'cancel' })
  })

  it('授权等待与回调完成阶段清晰可见，阶段轮询不重复拉取目录', async () => {
    const service = transport(document({ proxyMode: true }))
    let snapshot = { phase: 'signed-out', connectionStage: '', message: '未登录', revision: 0 }
    const proxyControl = vi.fn(async (_method: string, request: { action: string }) => {
      if (request.action === 'login') snapshot = { phase: 'pending-login', connectionStage: 'authorizing', message: '请在浏览器授权', revision: 0 }
      return { snapshot, message: snapshot.message, ...(request.action === 'login' ? { authorizationUrl: 'https://accounts.google.com/synthetic' } : {}) }
    })
    const { renderer, intervals } = await mount(service.remote, controlWith(), proxyControl)
    expect(renderedText(renderer)).toContain('无需 agy CLI')
    await act(async () => { await button(renderer, '连接代理账户').props.onClick() })
    const link = renderer.root.findByType('a')
    expect(link.children.join('')).toBe('打开 Google 授权页')
    expect(link.props.rel).toContain('noopener')
    const calls = proxyControl.mock.calls.length
    snapshot = { phase: 'pending-login', connectionStage: 'finishing', message: '授权已收到，正在检测项目', revision: 0 }
    await act(async () => { for (const timer of intervals.values()) if (timer.delay === 3000) timer.callback() })
    expect(proxyControl.mock.calls.length).toBeGreaterThan(calls)
    expect(renderedText(renderer)).toContain('正在完成登录')
    expect(renderedText(renderer)).toContain('授权已收到，正在检测项目')
    expect(renderer.root.findAllByType('a')).toHaveLength(0)
    expect(button(renderer, '取消登录').props.disabled).toBe(false)
  })

  it('设置页自动读快照，只在点击时请求刷新', async () => {
    const service = transport(document({ proxyMode: true }))
    const readQuota = vi.fn(async (_force: boolean, _source?: string, _model?: string) => ({ status: 'ok', groups: [{ name: 'Gemini', buckets: [{ window: '5h', remainingPct: 73 }] }] }) as unknown)
    const { renderer, intervals } = await mount(service.remote, undefined, undefined, readQuota)
    expect(readQuota).toHaveBeenCalledWith(false, 'antigravity-proxy', undefined)
    expect(renderedText(renderer)).toContain('73')
    await act(async () => { for (const timer of intervals.values()) timer.callback() })
    expect(readQuota.mock.calls.every(([force]) => force === false)).toBe(true)
    await act(async () => { await button(renderer, '拉取额度').props.onClick() })
    expect(readQuota).toHaveBeenCalledWith(true, 'antigravity-proxy', undefined)
    expect(renderedText(renderer)).toContain('73')
    readQuota.mockRejectedValueOnce(new Error('额度网络超时'))
    await act(async () => { await button(renderer, '拉取额度').props.onClick() })
    expect(renderedText(renderer)).toContain('73')
    expect(renderedText(renderer)).toContain('缓存数据 · Error: 额度网络超时')
    expect(button(renderer, '拉取额度').props.disabled).toBe(false)
  })

  it('设置页切换额度来源时清空旧结果，不接纳旧模式的迟到请求', async () => {
    const service = transport(document({ proxyMode: true }))
    const pending = deferred<unknown>()
    const readQuota = vi.fn((force: boolean) => force ? pending.promise : Promise.resolve({ status: 'error', groups: [], error: { code: 'not-fetched' } }))
    const { renderer } = await mount(service.remote, undefined, undefined, readQuota)
    let request: Promise<void> | undefined
    await act(async () => { request = button(renderer, '拉取额度').props.onClick() })
    await act(async () => { service.change(document({ proxyMode: false }, 2)) })
    await act(async () => { pending.resolve({ status: 'ok', groups: [{ name: 'former-account', buckets: [{ remainingPct: 99 }] }] }); await request })
    expect(renderedText(renderer)).not.toContain('former-account')
    expect(renderedText(renderer)).toContain('暂无额度快照')
    expect(button(renderer, '拉取额度').props.disabled).toBe(false)
  })
  it('模式草稿不冒充已生效模式，代理模式保存后显示对应连接控件', async () => {
    const service = transport(document())
    const control = vi.fn(async (method: string) => method === 'account'
      ? { state: 'idle', message: 'ready' }
      : { status: 'ok', models: [] })
    const { renderer } = await mount(service.remote, control)
    await act(async () => { fieldInput(renderer, 'proxyMode').props.onChange({ target: { checked: true } }) })
    expect(service.mutate).not.toHaveBeenCalled()
    expect(renderedText(renderer)).toContain('保存后切换到代理模式')
    expect(renderedText(renderer)).not.toContain('生成与套餐额度使用此账户')
    expect(button(renderer, '连接 / 登录 ACP')).toBeDefined()
    await act(async () => { service.change(document({ proxyMode: true }, 2)) })
    expect(button(renderer, '连接 / 登录 ACP')).toBeUndefined()
    expect(button(renderer, '立即预热')).toBeUndefined()
    expect(renderedText(renderer)).toContain('生成与套餐额度使用此账户')
  })

  it('代理组件缺席时仍停用 ACP，不提供任何 ACP 连接操作', async () => {
    const service = transport(document({ proxyMode: true }))
    const control = vi.fn(async (method: string) => method === 'account'
      ? { state: 'idle', message: 'ready', generationMode: { requested: 'proxy', active: 'acp', proxyRouterReady: false } }
      : { status: 'ok', models: [] })
    const { renderer } = await mount(service.remote, control)
    expect(renderedText(renderer)).toContain('代理路由未就绪，ACP 保持停用')
    expect(renderedText(renderer)).toContain('未注册')
    expect(renderedText(renderer)).toContain('生成与套餐额度使用此账户')
    expect(button(renderer, '连接 / 登录 ACP')).toBeUndefined()
    expect(renderer.root.findAllByProps({ name: 'agyCliPath' })).toHaveLength(1)
    expect(renderer.root.findAllByProps({ name: 'binaryPath' })).toHaveLength(0)
  })

  it('代理 OAuth 完成和退出后自动更新目录，终态移除旧授权提示与链接', async () => {
    const service = transport(document({ proxyMode: true }))
    let snapshot = { phase: 'signed-out', message: '请连接代理账户', revision: 0 }
    const proxyControl = vi.fn(async (_method: string, request: { action: string }) => {
      if (request.action === 'login') {
        snapshot = { phase: 'pending-login', message: '等待浏览器授权', revision: 1 }
        return { snapshot, message: snapshot.message, authorizationUrl: 'https://accounts.google.com/synthetic' }
      }
      if (request.action === 'logout') snapshot = { phase: 'signed-out', message: '已退出登录', revision: 3 }
      return { snapshot, message: snapshot.message }
    })
    const control = vi.fn(async (method: string) => method === 'account'
      ? { state: 'idle', message: 'ready' }
      : snapshot.phase === 'signed-in'
        ? { status: 'ok', models: [{ id: 'antigravity-gemini-4-neon', name: 'Gemini Neon' }] }
        : { status: 'error', models: [], message: '代理账户尚未连接' })
    const { renderer, intervals } = await mount(service.remote, control, proxyControl)
    await act(async () => { await button(renderer, '连接代理账户').props.onClick() })
    expect(renderer.root.findAllByType('a')).toHaveLength(1)
    const pulls = control.mock.calls.filter(([method]) => method === 'models').length
    snapshot = { phase: 'signed-in', message: '代理账户已就绪', revision: 2 }
    await act(async () => { for (const timer of intervals.values()) if (timer.delay === 3000) timer.callback() })
    expect(control.mock.calls.filter(([method]) => method === 'models').length).toBeGreaterThan(pulls)
    expect(renderedText(renderer)).toContain('Gemini Neon')
    expect(renderedText(renderer)).not.toContain('等待浏览器授权')
    expect(renderer.root.findAllByType('a')).toHaveLength(0)
    await act(async () => { await button(renderer, '退出登录').props.onClick() })
    expect(renderedText(renderer)).not.toContain('Gemini Neon')
    expect(renderedText(renderer)).toContain('代理账户尚未连接')
  })

  it('代理授权失败显示轮询得到的具体原因，并清理旧授权链接', async () => {
    const service = transport(document({ proxyMode: true }))
    let snapshot = { phase: 'signed-out', message: '未连接', revision: 0 }
    const proxyControl = vi.fn(async (_method: string, request: { action: string }) => {
      if (request.action === 'login') snapshot = { phase: 'pending-login', message: '等待浏览器授权', revision: 1 }
      return { snapshot, message: snapshot.message, ...(snapshot.phase === 'pending-login' ? { authorizationUrl: 'https://accounts.google.com/synthetic' } : {}) }
    })
    const { renderer, intervals } = await mount(service.remote, undefined, proxyControl)
    await act(async () => { await button(renderer, '连接代理账户').props.onClick() })
    snapshot = { phase: 'login-failed', message: '上游项目初始化失败，请重新连接', revision: 2 }
    await act(async () => { for (const timer of intervals.values()) if (timer.delay === 3000) timer.callback() })
    expect(renderedText(renderer)).toContain('上游项目初始化失败，请重新连接')
    expect(renderedText(renderer)).not.toContain('等待浏览器授权')
    expect(renderer.root.findAllByType('a')).toHaveLength(0)
  })

  it('连接请求尚未返回时可以取消，迟到授权结果不恢复登录界面', async () => {
    const service = transport(document({ proxyMode: true }))
    const pending = deferred<unknown>()
    const proxyControl = vi.fn(async (_method: string, request: { action: string }) => request.action === 'login'
      ? pending.promise
      : { snapshot: { phase: 'signed-out', message: '代理模式登录已取消', revision: 1 }, message: '代理模式登录已取消' })
    const { renderer } = await mount(service.remote, undefined, proxyControl)
    let login: Promise<void> | undefined
    await act(async () => { login = button(renderer, '连接代理账户').props.onClick() })
    expect(button(renderer, '取消登录').props.disabled).toBe(false)
    await act(async () => { await button(renderer, '取消登录').props.onClick() })
    expect(proxyControl).toHaveBeenCalledWith('account', { action: 'cancel' })
    await act(async () => {
      pending.resolve({ snapshot: { phase: 'pending-login', message: '等待授权', revision: 0 }, authorizationUrl: 'https://accounts.google.com/stale' })
      await login
    })
    expect(renderer.root.findAllByType('a')).toHaveLength(0)
    expect(button(renderer, '连接代理账户').props.disabled).toBe(false)
    expect(renderedText(renderer)).not.toContain('等待授权')
  })

  /** 目录桩：两个模型，供逐模型设置渲染。 */
  const catalog = () => ({ status: 'ok' as const, models: [
    { id: 'gemini-3-pro', name: 'Gemini 3 Pro', inputModalities: ['text', 'image'] },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet' },
  ] })
  const controlWith = (models: unknown = catalog(), account: Record<string, unknown> = { state: 'idle', message: 'ready' }) =>
    vi.fn(async (method: string) => method === 'account' ? account : models)
  /** 退役判定的固定时钟：GPT-OSS 120B（11-18）已过下线日，Argon / 3.8 Flash（11-30）尚未。 */
  const NOW = new Date(2026, 10, 26, 12, 0, 0)

  it('设置卡片只提交即时字段，普通配置以重载指引呈现', async () => {
    const liveKeys: readonly string[] = [...LIVE_SETTING_KEYS]
    // 复合字典字段（modelOverrides / orchestrator / features）由专属控件渲染，不计入普通即时输入框统计。
    const fields = liveKeys.filter(key => key !== 'modelOverrides' && key !== 'proxyBypass' && key !== 'orchestrator' && key !== 'features')
    // 普通（非 volatile）配置：宿主既不投影也不接受写入，不能出现在可编辑控件里。
    const plainFields = Object.keys(Config.dict ?? {}).filter(key => !liveKeys.includes(key))
    expect(plainFields).toEqual(expect.arrayContaining(['binaryPath', 'autoDownload', 'acpVersion', 'extraArgs', 'maxConcurrentSessions', 'queueTimeoutMs', 'requestTimeoutMs', 'handshakeTimeoutMs', 'authTimeoutMs', 'promptTimeoutMs', 'bridgeParkSettleMs']))
    expect(fields).not.toContain('proxyBypass')
    const values = liveHostConfig(Config({ autoWarmup: false }))
    const projected: Record<string, unknown> = Object.fromEntries(fields.map(key => [key, Reflect.get(values, key)]))
    const service = transport(document(projected))
    service.mutate.mockImplementation(async (_ns, ops, revision) => {
      expect(revision).toBe(1)
      for (const value of ops) {
        const op = value as { path: string[]; value: unknown }
        expect([...fields, 'modelOverrides', 'orchestrator', 'features']).toContain(op.path[0])
        projected[op.path[0]!] = op.value
      }
      service.change(document(projected, 2))
      return { ok: true, value: undefined }
    })
    const { renderer } = await mount(service.remote, controlWith())
    // modelOverrides 由逐模型行渲染，不是普通输入框。
    const renderable = fields
    const inputs = [...renderer.root.findAllByType('input'), ...renderer.root.findAllByType('textarea')]
      .filter(input => fields.includes(input.props.name))
    expect(inputs).toHaveLength(renderable.length)
    expect(inputs.every(input => input.props.disabled === false)).toBe(true)
    // 普通配置一个都不该变成输入框（否则保存必然被宿主拒绝）。
    for (const key of plainFields) expect(renderer.root.findAllByProps({ name: key })).toHaveLength(0)
    expect(renderedText(renderer)).toContain('普通配置（并发 / 二进制 / 超时）')
    expect(renderedText(renderer)).toContain('maxConcurrentSessions')
    await act(async () => {
      for (const input of inputs) input.props.onChange({ target: input.props.type === 'checkbox'
        ? { checked: !input.props.checked }
        : { value: input.props.type === 'number' ? String(input.props.min ?? 0) : 'test-value' } })
      modelControl(renderer, 'enabled', 'gemini-3-pro').props.onChange({ target: { checked: false } })
      modelControl(renderer, 'effort', 'claude-sonnet-5-5').props.onChange({ target: { value: 'high' } })
    })
    expect(button(renderer, '保存').props.disabled).toBe(false)
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledTimes(1)
    const ops = service.mutate.mock.calls[0]![1] as Array<{ path: string[]; value: unknown }>
    expect(ops.map(op => op.path[0]).sort()).toEqual([...renderable, 'modelOverrides'].sort())
    expect(ops.find(op => op.path[0] === 'modelOverrides')!.value).toEqual({
      'claude-sonnet-5-5': { effort: 'high' },
      'gemini-3-pro': { enabled: false },
    })
    expect(button(renderer, '保存').props.disabled, renderedText(renderer)).toBe(true)
    expect(fieldInput(renderer, 'proxyUrl').props.value).toBe('test-value')
    expect(fieldInput(renderer, 'cliQuotaEnabled').props.type).toBe('checkbox')
    expect(renderedText(renderer)).toContain('已保存并切换模式')
  })

  it('逐模型设置只提交有意义的字段，清空的项从配置里移除', async () => {
    const service = transport(document({
      modelOverrides: { 'gemini-3-pro': { enabled: false, effort: 'low', name: '旧名', target: 'gemini-3-pro-high' } },
    }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(modelControl(renderer, 'enabled', 'gemini-3-pro').props.checked).toBe(false)
    expect(modelControl(renderer, 'effort', 'gemini-3-pro').props.value).toBe('low')
    expect(modelControl(renderer, 'name', 'gemini-3-pro').props.value).toBe('旧名')
    await act(async () => {
      modelControl(renderer, 'enabled', 'gemini-3-pro').props.onChange({ target: { checked: true } })
      modelControl(renderer, 'effort', 'gemini-3-pro').props.onChange({ target: { value: '' } })
      modelControl(renderer, 'name', 'gemini-3-pro').props.onChange({ target: { value: '  ' } })
      modelControl(renderer, 'target', 'gemini-3-pro').props.onChange({ target: { value: '' } })
    })
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [{ op: 'set', path: ['modelOverrides'], value: {} }], 1)
  })

  it('设置页显示已观测的上下文和输出上限，不把容量当成草稿字段', async () => {
    const service = transport(document())
    const models = catalog()
    const control = controlWith({ ...models, models: models.models.map((row, i) => i === 0
      ? { ...row, contextWindow: 1048576, maxOutputTokens: 262144 } : row) })
    const { renderer } = await mount(service.remote, control)
    const text = renderedText(renderer)
    expect(text).toContain(`上下文窗口 ${(1048576).toLocaleString()} tokens`)
    expect(text).toContain(`输出上限 ${(262144).toLocaleString()} tokens`)
    expect(text).toContain('上下文窗口：尚未观测')
    expect(service.mutate).not.toHaveBeenCalled()
  })

  it('审计参考容量在设置页标注来源，不与实测容量混淆（issue #17）', async () => {
    const service = transport(document())
    const models = catalog()
    const control = controlWith({ ...models, models: models.models.map((row, i) => i === 0
      ? { ...row, contextWindow: 1048576, contextWindowSource: 'audited' } : row) })
    const { renderer } = await mount(service.remote, control)
    const text = renderedText(renderer)
    expect(text).toContain('审计参考，实测后更新')
    expect(text).not.toContain('（上游容量）')
    expect(service.mutate).not.toHaveBeenCalled()
  })

  it('全部模型被隐藏时提示 provider 会从选择器消失，重新启用后提示消失', async () => {
    vi.setSystemTime(NOW)
    const service = transport(document({ modelOverrides: { 'gemini-3-pro': { enabled: false }, 'claude-sonnet-5-5': { enabled: false } } }))
    const { renderer } = await mount(service.remote, controlWith())
    // 两个观测模型显式隐藏 + 两个尚未下线的退役家族默认隐藏（GPT-OSS 120B 已过下线日，不补行）。
    expect(renderedText(renderer)).toContain('全部隐藏后')
    expect(renderedText(renderer)).toContain('全部 4')
    await act(async () => { modelControl(renderer, 'enabled', 'gemini-3-pro').props.onChange({ target: { checked: true } }) })
    expect(renderedText(renderer)).not.toContain('全部隐藏后')
    expect(renderedText(renderer)).toContain('已隐藏 3')
  })

  it('已经保存但当前目录没有的模型 ID 仍可编辑，并标注不在目录', async () => {
    vi.setSystemTime(NOW)
    const service = transport(document({ modelOverrides: { 'retired-model': { target: 'retired-model-high' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(modelControl(renderer, 'target', 'retired-model').props.value).toBe('retired-model-high')
    expect(renderedText(renderer)).toContain('不在当前目录')
    // 两个观测模型 + 两个尚未下线的退役表内置家族 + 一个已保存但不在目录的 ID = 5 行。
    expect(renderedText(renderer)).toContain('全部 5')
    // 退役家族默认隐藏，观测模型与已保存 ID 默认启用。
    expect(renderedText(renderer)).toContain('已隐藏 2')
  })

  it('ACP 模式即使目录含带前缀的编排合成条目，退役补行仍用裸家族 ID', async () => {
    vi.setSystemTime(NOW)
    // antigravity-orchestrator 带 antigravity- 前缀但不代表代理链路；
    // 补行若按前缀猜测会写出 host 永远查不中的 override 键。
    const models = {
      status: 'ok' as const,
      models: [
        { id: 'antigravity-orchestrator', name: 'Orchestrator' },
        { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
      ],
    }
    const service = transport()
    const control = vi.fn(async (method: string) => method === 'account'
      ? { state: 'idle', message: 'ready' }
      : models)
    const { renderer } = await mount(service.remote, control)
    // 裸 ID 补行存在且可切换；带前缀的错误补行不存在。
    expect(renderer.root.findAllByProps({ name: 'model-enabled-gemini-4-argon' })).toHaveLength(1)
    expect(renderer.root.findAllByProps({ name: 'model-enabled-antigravity-gemini-4-argon' })).toHaveLength(0)
    // 切换裸 ID 补行后，提交的 override 键与 host 侧 modelSettingFor 直查键一致。
    await act(async () => { modelControl(renderer, 'enabled', 'gemini-4-argon').props.onChange({ target: { checked: true } }) })
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [
      expect.objectContaining({ path: ['modelOverrides'], value: { 'gemini-4-argon': { enabled: true } } }),
    ], expect.anything())
  })

  it('代理模式观测到带档位后缀的退役中家族时不补重复行，退役徽章挂在观测行上', async () => {
    vi.setSystemTime(NOW)
    const models = {
      status: 'ok' as const,
      models: [{ id: 'antigravity-gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' }],
    }
    const control = vi.fn(async (method: string) => method === 'account'
      ? { state: 'idle', message: 'ready', generationMode: { requested: 'proxy', active: 'proxy', proxyRouterReady: true } }
      : models)
    const { renderer } = await mount(transport(document({ proxyMode: true })).remote, control)
    // 真实观测行只有一个开关；不会再补一个 antigravity-gemini-3.8-flash 死行。
    expect(renderer.root.findAllByProps({ name: 'model-enabled-antigravity-gemini-3.8-flash-medium' })).toHaveLength(1)
    expect(renderer.root.findAllByProps({ name: 'model-enabled-antigravity-gemini-3.8-flash' })).toHaveLength(0)
    expect(renderedText(renderer)).toContain('即将下线 11-30')
  })

  it('官方下线日已过的家族移出模型列表：观测行、补行与残留配置键都不显示', async () => {
    vi.setSystemTime(NOW)
    // 上游菜单仍列出 GPT-OSS 120B（代理目录的真实键带档位后缀）；残留配置键是代理链路的家族键。
    const models = {
      status: 'ok' as const,
      models: [
        { id: 'antigravity-gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
        { id: 'antigravity-gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
      ],
    }
    const control = vi.fn(async (method: string) => method === 'account'
      ? { state: 'idle', message: 'ready', generationMode: { requested: 'proxy', active: 'proxy', proxyRouterReady: true } }
      : models)
    const service = transport(document({ proxyMode: true, modelOverrides: { 'antigravity-gpt-oss-120b': { enabled: true } } }))
    const { renderer } = await mount(service.remote, control)
    expect(renderer.root.findAllByProps({ name: 'model-enabled-antigravity-gpt-oss-120b-medium' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ name: 'model-enabled-gpt-oss-120b' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ name: 'model-enabled-antigravity-gpt-oss-120b' })).toHaveLength(0)
    expect(modelControl(renderer, 'enabled', 'antigravity-gemini-4-hydrogen')).toBeDefined()
    expect(renderedText(renderer)).not.toContain('已下线')
    // 一个未退役观测行 + 两个尚未下线的补行。
    expect(renderedText(renderer)).toContain('全部 3')
  })

  it('下线日过后条目按同一判定移出列表', async () => {
    // 11-30 的次日，按本地日历日构造。
    vi.setSystemTime(new Date(2026, 11, 1, 0, 0, 0, 0))
    const { renderer } = await mount(transport().remote, controlWith())
    expect(renderer.root.findAllByProps({ name: 'model-enabled-gemini-4-argon' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ name: 'model-enabled-gemini-3.8-flash' })).toHaveLength(0)
    expect(renderedText(renderer)).not.toContain('即将下线')
    expect(modelControl(renderer, 'enabled', 'gemini-3-pro')).toBeDefined()
  })

  it('已过下线日家族的配置键随草稿保存删除，并说明未保存项的来源', async () => {
    vi.setSystemTime(NOW)
    const service = transport(document({ modelOverrides: { 'antigravity-gpt-oss-120b-medium': { enabled: true, target: 'x' }, 'gemini-3-pro': { effort: 'high' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(renderedText(renderer)).toContain('GPT-OSS 120B 已过官方下线日，不再列入模型列表；保存后移除其模型设置。')
    expect(renderedText(renderer)).toContain('1 项未保存')
    expect(service.mutate).not.toHaveBeenCalled()
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [
      { op: 'set', path: ['modelOverrides'], value: { 'gemini-3-pro': { effort: 'high' } } },
    ], expect.anything())
  })

  it('撤销放弃对已过下线日家族配置键的删除，条目仍不显示', async () => {
    vi.setSystemTime(NOW)
    const service = transport(document({ modelOverrides: { 'gpt-oss-120b': { enabled: true } } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(renderedText(renderer)).toContain('1 项未保存')
    await act(async () => { await button(renderer, '撤销').props.onClick() })
    expect(renderedText(renderer)).not.toContain('项未保存')
    expect(renderedText(renderer)).not.toContain('已过官方下线日')
    expect(renderer.root.findAllByProps({ name: 'model-enabled-gpt-oss-120b' })).toHaveLength(0)
    expect(button(renderer, '保存').props.disabled).toBe(true)
    // 撤销后同 namespace 的通知（内容未变）不把清理重新排入。
    await act(async () => { service.notify() })
    expect(renderedText(renderer)).not.toContain('项未保存')
    // 此后切成只读也不残留待保存项。
    service.set(document({ modelOverrides: { 'gpt-oss-120b': { enabled: true } } }, 2, false))
    await act(async () => { service.notify() })
    expect(renderedText(renderer)).toContain('只读设置')
    expect(renderedText(renderer)).not.toContain('项未保存')
    expect(service.mutate).not.toHaveBeenCalled()
  })

  it('清理保存不覆盖外部更新，也不删除另一链路或仅默认值的键', async () => {
    vi.setSystemTime(NOW)
    const initial = { modelOverrides: { 'gpt-oss-120b': { enabled: true }, 'gemini-3-pro': { effort: 'low' }, 'antigravity-unknown': { enabled: true } } }
    const service = transport(document(initial, 1))
    const { renderer } = await mount(service.remote, controlWith())
    expect(renderedText(renderer)).toContain('1 项未保存')
    // 外部（同 revision 推进）改了裸键的值，并新增了一个代理链路的键。
    const external = { modelOverrides: { ...initial.modelOverrides, 'gemini-3-pro': { effort: 'high' }, 'antigravity-known': { target: 'keep-me' } } }
    service.set(document(external, 2))
    await act(async () => { service.notify() })
    expect(renderedText(renderer)).toContain('GPT-OSS 120B 已过官方下线日')
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledTimes(1)
    const [namespace, ops, revision] = service.mutate.mock.calls[0] as unknown as [string, Array<{ path: string[]; value: unknown }>, number]
    expect(namespace).toBe('llm-antigravity-acp')
    expect(revision).toBe(2)
    expect(ops).toEqual([{ op: 'set', path: ['modelOverrides'], value: {
      'gemini-3-pro': { effort: 'high' },
      'antigravity-unknown': { enabled: true },
      'antigravity-known': { target: 'keep-me' },
    } }])
  })

  it('保存成功回读后不再标脏，清理说明随之消失', async () => {
    vi.setSystemTime(NOW)
    const service = transport(document({ modelOverrides: { 'gpt-oss-120b': { enabled: true }, 'gemini-3-pro': { effort: 'high' } } }, 1))
    // 保存桩写回远端文档并推进 revision，模拟真实宿主。
    const saved = { modelOverrides: { 'gpt-oss-120b': { enabled: true }, 'gemini-3-pro': { effort: 'high' } } }
    service.mutate.mockImplementation(async (_ns, ops, revision) => {
      expect(revision).toBe(1)
      saved.modelOverrides = (ops[0] as { value: typeof saved.modelOverrides }).value
      service.change(document(saved, 2))
      return { ok: true, value: undefined }
    })
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledTimes(1)
    expect(renderedText(renderer)).not.toContain('项未保存')
    expect(renderedText(renderer)).not.toContain('已过官方下线日')
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(modelControl(renderer, 'enabled', 'gemini-3-pro').props.checked).toBe(true)
  })

  it('撤销清理后编辑其它模型，保存不删除已退役键', async () => {
    vi.setSystemTime(NOW)
    const service = transport(document({ modelOverrides: { 'gpt-oss-120b': { enabled: true }, 'gemini-3-pro': { effort: 'low' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { await button(renderer, '撤销').props.onClick() })
    await act(async () => { modelControl(renderer, 'effort', 'gemini-3-pro').props.onChange({ target: { value: 'high' } }) })
    expect(renderedText(renderer)).not.toContain('已过官方下线日')
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [
      { op: 'set', path: ['modelOverrides'], value: { 'gpt-oss-120b': { enabled: true }, 'gemini-3-pro': { effort: 'high' } } },
    ], expect.anything())
  })

  it('未编辑时设置直接转只读，不残留自动排入的未保存项', async () => {
    vi.setSystemTime(NOW)
    const service = transport(document({ modelOverrides: { 'gpt-oss-120b': { enabled: true } } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(renderedText(renderer)).toContain('1 项未保存')
    service.set(document({ modelOverrides: { 'gpt-oss-120b': { enabled: true } } }, 2, false))
    await act(async () => { service.notify() })
    expect(renderedText(renderer)).toContain('只读设置')
    expect(renderedText(renderer)).not.toContain('项未保存')
  })

  it('外部更新后，未触及的模型在界面上跟随服务端最新值', async () => {
    vi.setSystemTime(NOW)
    const service = transport(document({ modelOverrides: { 'gemini-3-pro': { effort: 'low' }, 'claude-sonnet-5-5': { effort: 'high' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(modelControl(renderer, 'effort', 'gemini-3-pro').props.value).toBe('low')
    // 用户只改了 Sonnet：这个键算触及过。
    await act(async () => { modelControl(renderer, 'effort', 'claude-sonnet-5-5').props.onChange({ target: { value: 'low' } }) })
    service.set(document({ modelOverrides: { 'gemini-3-pro': { effort: 'high' }, 'claude-sonnet-5-5': { effort: 'medium' } } }, 2))
    await act(async () => { service.notify() })
    // 未触及的键跟随服务端最新值。
    expect(modelControl(renderer, 'effort', 'gemini-3-pro').props.value).toBe('high')
    // 用户触及过的键保留草稿，不被外部更新覆盖。
    expect(modelControl(renderer, 'effort', 'claude-sonnet-5-5').props.value).toBe('low')
    expect(renderedText(renderer)).toContain('1 项未保存')
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [
      { op: 'set', path: ['modelOverrides'], value: { 'gemini-3-pro': { effort: 'high' }, 'claude-sonnet-5-5': { effort: 'low' } } },
    ], expect.anything())
  })

  it('改回原值的模型不再算触及，保存跟随服务端最新值', async () => {
    vi.setSystemTime(NOW)
    const service = transport(document({ modelOverrides: { 'gemini-3-pro': { effort: 'low' }, 'claude-sonnet-5-5': { effort: 'high' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { modelControl(renderer, 'effort', 'gemini-3-pro').props.onChange({ target: { value: 'high' } }) })
    await act(async () => { modelControl(renderer, 'effort', 'gemini-3-pro').props.onChange({ target: { value: 'low' } }) })
    expect(renderedText(renderer)).not.toContain('项未保存')
    await act(async () => { modelControl(renderer, 'effort', 'claude-sonnet-5-5').props.onChange({ target: { value: 'low' } }) })
    service.set(document({ modelOverrides: { 'gemini-3-pro': { effort: 'high' }, 'claude-sonnet-5-5': { effort: 'high' } } }, 2))
    await act(async () => { service.notify() })
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [
      { op: 'set', path: ['modelOverrides'], value: { 'gemini-3-pro': { effort: 'high' }, 'claude-sonnet-5-5': { effort: 'low' } } },
    ], expect.anything())
  })

  it('只有默认值的已配置 ID 也列出，编辑其它模型后不消失', async () => {
    vi.setSystemTime(NOW)
    const service = transport(document({ modelOverrides: { 'claude-opus-5-5': { enabled: true }, 'unknown-model': {} } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(modelControl(renderer, 'enabled', 'claude-opus-5-5').props['aria-label']).toBe('Claude Opus 5.5')
    expect(modelControl(renderer, 'enabled', 'unknown-model')).toBeDefined()
    await act(async () => { modelControl(renderer, 'effort', 'gemini-3-pro').props.onChange({ target: { value: 'low' } }) })
    expect(modelControl(renderer, 'enabled', 'claude-opus-5-5')).toBeDefined()
    expect(renderedText(renderer)).toContain('1 项未保存')
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [
      { op: 'set', path: ['modelOverrides'], value: { 'claude-opus-5-5': { enabled: true }, 'unknown-model': {}, 'gemini-3-pro': { effort: 'low' } } },
    ], expect.anything())
  })

  it('对仅默认值的行做无效的「全部启用」，该行不消失也不产生未保存项', async () => {
    vi.setSystemTime(NOW)
    const service = transport(document({ modelOverrides: { 'gemini-4-hydrogen': { enabled: true } } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(modelControl(renderer, 'enabled', 'gemini-4-hydrogen').props.checked).toBe(true)
    await act(async () => { renderer.root.findByProps({ 'aria-label': '搜索模型' }).props.onChange({ target: { value: 'hydrogen' } }) })
    await act(async () => { await button(renderer, '全部启用').props.onClick() })
    expect(modelControl(renderer, 'enabled', 'gemini-4-hydrogen')).toBeDefined()
    expect(renderedText(renderer)).not.toContain('项未保存')
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(service.mutate).not.toHaveBeenCalled()
  })

  it('普通模型改回原值不冲掉待保存的退役清理', async () => {
    vi.setSystemTime(NOW)
    const service = transport(document({ modelOverrides: { 'gpt-oss-120b': {}, 'gemini-3-pro': { effort: 'low' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(renderedText(renderer)).toContain('1 项未保存')
    await act(async () => { modelControl(renderer, 'effort', 'gemini-3-pro').props.onChange({ target: { value: 'high' } }) })
    await act(async () => { modelControl(renderer, 'effort', 'gemini-3-pro').props.onChange({ target: { value: 'low' } }) })
    expect(renderedText(renderer)).toContain('GPT-OSS 120B 已过官方下线日')
    expect(renderedText(renderer)).toContain('1 项未保存')
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [
      { op: 'set', path: ['modelOverrides'], value: { 'gemini-3-pro': { effort: 'low' } } },
    ], expect.anything())
  })

  it('显式清空的删除意图保留到远端键消失，外部把该记录改成默认值也不放弃', async () => {
    vi.setSystemTime(NOW)
    const service = transport(document({ modelOverrides: { 'gemini-3-pro': { effort: 'high', name: '旧名' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { modelControl(renderer, 'effort', 'gemini-3-pro').props.onChange({ target: { value: '' } }) })
    await act(async () => { modelControl(renderer, 'name', 'gemini-3-pro').props.onChange({ target: { value: '' } }) })
    expect(renderedText(renderer)).toContain('1 项未保存')
    service.set(document({ modelOverrides: { 'gemini-3-pro': { enabled: true } } }, 2))
    await act(async () => { service.notify() })
    expect(renderedText(renderer)).toContain('1 项未保存')
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [
      { op: 'set', path: ['modelOverrides'], value: {} },
    ], expect.anything())
  })

  it('删除意图在远端键消失后完成，之后外部重建同名键不再被删除', async () => {
    vi.setSystemTime(NOW)
    const service = transport(document({ modelOverrides: { 'gemini-3-pro': { name: '旧名' }, 'claude-sonnet-5-5': { effort: 'low' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { modelControl(renderer, 'name', 'gemini-3-pro').props.onChange({ target: { value: '' } }) })
    expect(renderedText(renderer)).toContain('1 项未保存')
    // 外部先删掉了 A：删除意图完成，界面转干净。
    service.set(document({ modelOverrides: { 'claude-sonnet-5-5': { effort: 'low' } } }, 2))
    await act(async () => { service.notify() })
    expect(renderedText(renderer)).not.toContain('项未保存')
    // 用户编辑 B；外部又把 A 重建（新名称）。
    await act(async () => { modelControl(renderer, 'effort', 'claude-sonnet-5-5').props.onChange({ target: { value: 'high' } }) })
    service.set(document({ modelOverrides: { 'gemini-3-pro': { name: '新名' }, 'claude-sonnet-5-5': { effort: 'low' } } }, 3))
    await act(async () => { service.notify() })
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [
      { op: 'set', path: ['modelOverrides'], value: { 'gemini-3-pro': { name: '新名' }, 'claude-sonnet-5-5': { effort: 'high' } } },
    ], 3)
  })

  it('退役边界按本地日历日：下线日当天最后一刻未退役，次日零点起退役', async () => {
    // GPT-OSS 120B 的下线日是 11-18；用本地时间构造，不依赖进程时区。
    vi.setSystemTime(new Date(2026, 10, 18, 23, 59, 59, 500))
    const before = await mount(transport().remote, controlWith())
    expect(renderedText(before.renderer)).toContain('即将下线 11-18')
    expect(before.renderer.root.findAllByProps({ name: 'model-enabled-gpt-oss-120b' })).toHaveLength(1)
    await act(async () => { before.renderer.unmount() })
    vi.setSystemTime(new Date(2026, 10, 19, 0, 0, 0, 0))
    const after = await mount(transport().remote, controlWith())
    expect(after.renderer.root.findAllByProps({ name: 'model-enabled-gpt-oss-120b' })).toHaveLength(0)
    expect(renderedText(after.renderer)).not.toContain('GPT-OSS 120B')
  })

  it('只读设置下不产生待保存的删除，已过下线日家族的条目仍不显示', async () => {
    vi.setSystemTime(NOW)
    const service = transport(document({ modelOverrides: { 'gpt-oss-120b': { enabled: true } } }, 1, false))
    const { renderer } = await mount(service.remote, controlWith())
    expect(renderedText(renderer)).toContain('只读设置')
    expect(renderedText(renderer)).not.toContain('项未保存')
    expect(renderer.root.findAllByProps({ name: 'model-enabled-gpt-oss-120b' })).toHaveLength(0)
  })

  it('已配置但不在当前目录的已知家族用内置名显示，未知 ID 仍显示原始 ID', async () => {
    vi.setSystemTime(NOW)
    // ACP 模式：退役表家族名用带档位后缀的 ACP 键验证（家族键本身已由退役表补行占据）。
    const service = transport(document({ modelOverrides: {
      'gemini-3.8-flash-medium': { effort: 'high' },
      'antigravity-orchestrator': { target: 'gemini-4-hydrogen' },
      'gemini-4-neon': { enabled: false },
      'claude-sonnet-5-5-high': { effort: 'low' },
      'unknown-model': { effort: 'low' },
    } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(modelControl(renderer, 'enabled', 'gemini-3.8-flash-medium').props['aria-label']).toBe('Gemini 3.8 Flash')
    expect(modelControl(renderer, 'enabled', 'antigravity-orchestrator').props['aria-label']).toBe('Orchestrator（插件编排）')
    expect(modelControl(renderer, 'enabled', 'gemini-4-neon').props['aria-label']).toBe('Gemini 4 Neon')
    expect(modelControl(renderer, 'enabled', 'claude-sonnet-5-5-high').props['aria-label']).toBe('Claude Sonnet 5.5')
    expect(modelControl(renderer, 'enabled', 'unknown-model').props['aria-label']).toBe('unknown-model')
  })

  it('ACP 模式不补代理链路的已配置 ID，配置键随保存原样保留', async () => {
    vi.setSystemTime(NOW)
    // 代理目录键带 antigravity- 前缀，ACP 目录键是裸 ID：切到 ACP 后这些键不再混进列表。
    const service = transport(document({ modelOverrides: {
      'antigravity-gemini-3.8-flash': { enabled: true },
      'antigravity-gemini-4-hydrogen': { effort: 'high' },
      'gemini-4-neon': { enabled: false },
    } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(renderer.root.findAllByProps({ name: 'model-enabled-antigravity-gemini-3.8-flash' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ name: 'model-enabled-antigravity-gemini-4-hydrogen' })).toHaveLength(0)
    expect(modelControl(renderer, 'enabled', 'gemini-4-neon').props['aria-label']).toBe('Gemini 4 Neon')
    expect(renderedText(renderer)).not.toContain('项未保存')
    // 不补行不等于删除：保存其它改动时，代理链路的键随整份 modelOverrides 原样提交。
    await act(async () => { modelControl(renderer, 'enabled', 'gemini-4-neon').props.onChange({ target: { checked: true } }) })
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [
      { op: 'set', path: ['modelOverrides'], value: {
        'antigravity-gemini-3.8-flash': { enabled: true },
        'antigravity-gemini-4-hydrogen': { effort: 'high' },
      } },
    ], expect.anything())
  })

  it('代理模式不补 ACP 链路的已配置 ID，编排合成条目两条链路同名', async () => {
    vi.setSystemTime(NOW)
    const control = vi.fn(async (method: string) => method === 'account'
      ? { state: 'idle', message: 'ready', generationMode: { requested: 'proxy', active: 'proxy', proxyRouterReady: true } }
      : { status: 'ok', models: [] })
    const service = transport(document({ proxyMode: true, modelOverrides: {
      'gemini-4-neon': { effort: 'high' },
      'claude-sonnet-5-5': { enabled: false },
      'antigravity-gemini-4-hydrogen': { effort: 'low' },
      'antigravity-orchestrator': { target: 'x' },
    } }))
    const { renderer } = await mount(service.remote, control)
    expect(renderer.root.findAllByProps({ name: 'model-enabled-gemini-4-neon' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ name: 'model-enabled-claude-sonnet-5-5' })).toHaveLength(0)
    expect(modelControl(renderer, 'enabled', 'antigravity-gemini-4-hydrogen').props['aria-label']).toBe('Gemini 4 Hydrogen')
    expect(modelControl(renderer, 'enabled', 'antigravity-orchestrator').props['aria-label']).toBe('Orchestrator（插件编排）')
  })

  it('模型可搜索并按启停筛选，折叠的高级映射仍可编辑', async () => {
    const service = transport(document({ modelOverrides: { 'gemini-3-pro': { enabled: false } } }))
    const { renderer } = await mount(service.remote, controlWith())
    const search = renderer.root.findByProps({ 'aria-label': '搜索模型' })
    await act(async () => { search.props.onChange({ target: { value: 'claude' } }) })
    expect(renderer.root.findAllByProps({ name: 'model-enabled-gemini-3-pro' })).toHaveLength(0)
    expect(modelControl(renderer, 'enabled', 'claude-sonnet-5-5')).toBeDefined()
    await act(async () => { search.props.onChange({ target: { value: '' } }) })
    const filter = renderer.root.findByProps({ 'aria-label': '筛选模型' })
    await act(async () => { filter.props.onChange({ target: { value: 'hidden' } }) })
    expect(modelControl(renderer, 'enabled', 'gemini-3-pro').props.checked).toBe(false)
    expect(renderer.root.findAllByProps({ name: 'model-enabled-claude-sonnet-5-5' })).toHaveLength(0)
    await act(async () => { button(renderer, '全部启用').props.onClick() })
    await act(async () => { filter.props.onChange({ target: { value: 'all' } }) })
    expect(modelControl(renderer, 'enabled', 'gemini-3-pro').props.checked).toBe(true)
  })

  it('缺少设置 namespace 时解释禁用原因，宿主恢复后重新启用控件', async () => {
    const service = transport({ writable: true, namespaces: [] })
    const { renderer } = await mount(service.remote)
    expect(fieldInput(renderer, 'proxyUrl').props.disabled).toBe(true)
    expect(renderedText(renderer)).toContain('尚未提供 Antigravity ACP 的可编辑设置')
    await act(async () => { service.change(document({ proxyUrl: 'http://restored:7890' })) })
    expect(fieldInput(renderer, 'proxyUrl').props.disabled).toBe(false)
    expect(renderedText(renderer)).not.toContain('尚未提供 Antigravity ACP 的可编辑设置')
  })

  it('respects read-only settings instead of offering a save that will fail', async () => {
    const service = transport(document({ proxyUrl: 'http://old:7890' }, 1, false))
    const { renderer } = await mount(service.remote, controlWith())
    expect(fieldInput(renderer, 'proxyUrl').props.disabled).toBe(true)
    expect(modelControl(renderer, 'enabled', 'gemini-3-pro').props.disabled).toBe(true)
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(renderedText(renderer)).toContain('只读设置')
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).not.toHaveBeenCalled()
  })

  it('preserves edited fields and merges untouched fields after an external update', async () => {
    const service = transport(document({ proxyUrl: 'http://old:7890', modelOverrides: { 'gemini-3-pro': { effort: 'low' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { modelControl(renderer, 'target', 'gemini-3-pro').props.onChange({ target: { value: 'custom-target' } }) })
    // 外部同时改了代理和同一个模型的档位：草稿里的映射必须保留并提示冲突。
    await act(async () => { service.change(document({ proxyUrl: 'http://new:7890', modelOverrides: { 'gemini-3-pro': { effort: 'high' } } }, 2)) })
    expect(modelControl(renderer, 'target', 'gemini-3-pro').props.value).toBe('custom-target')
    expect(modelControl(renderer, 'effort', 'gemini-3-pro').props.value).toBe('low')
    expect(fieldInput(renderer, 'proxyUrl').props.value).toBe('http://new:7890')
    expect(renderedText(renderer)).toContain('已保留你的输入')
    expect(renderedText(renderer)).toContain('模型列表设置')
    expect(renderedText(renderer)).toContain('1 项未保存')
    expect(button(renderer, '保存').props.disabled).toBe(false)
  })

  it('ignores an old settings request that resolves after the latest revision', async () => {
    const service = transport()
    const first = deferred<SettingsDocument>()
    service.describe.mockImplementationOnce(() => first.promise)
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { service.change(document({ proxyUrl: 'http://latest:7890' }, 3)) })
    await act(async () => { first.resolve(document({ proxyUrl: 'http://stale:7890' }, 1)) })
    expect(fieldInput(renderer, 'proxyUrl').props.value).toBe('http://latest:7890')
    expect(button(renderer, '保存').props.disabled).toBe(true)
  })

  it('can discard a conflicted draft and restore the latest server settings', async () => {
    const service = transport(document({ modelOverrides: { 'gemini-3-pro': { effort: 'low' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { modelControl(renderer, 'effort', 'gemini-3-pro').props.onChange({ target: { value: 'high' } }) })
    await act(async () => { service.change(document({ modelOverrides: { 'gemini-3-pro': { effort: 'medium' } } }, 2)) })
    await act(async () => { button(renderer, '撤销').props.onClick() })
    expect(modelControl(renderer, 'effort', 'gemini-3-pro').props.value).toBe('medium')
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(renderedText(renderer)).not.toContain('其他位置更新了以下设置')
    expect(service.mutate).not.toHaveBeenCalled()
  })

  it('serializes save clicks and submits only edited fields, including a cleared value', async () => {
    const service = transport(document({ proxyUrl: 'http://proxy:7890' }))
    const saved = deferred<{ ok: boolean; value: undefined }>()
    service.mutate.mockImplementationOnce(() => saved.promise)
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { fieldInput(renderer, 'proxyUrl').props.onChange({ target: { value: '' } }) })
    const save = button(renderer, '保存').props.onClick as () => Promise<void>
    await act(async () => { void save(); void save() })
    expect(service.mutate).toHaveBeenCalledTimes(1)
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [{ op: 'set', path: ['proxyUrl'], value: '' }], 1)
    expect(button(renderer, '保存中…').props.disabled).toBe(true)
    expect(fieldInput(renderer, 'proxyUrl').props.disabled).toBe(true)
    await act(async () => {
      service.change(document({ proxyUrl: '' }, 2))
      saved.resolve({ ok: true, value: undefined })
    })
    expect(fieldInput(renderer, 'proxyUrl').props.value).toBe('')
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(renderedText(renderer)).not.toContain('项未保存的修改')
  })

  it('preserves the draft and refreshes the revision after a rejected mutation', async () => {
    const service = transport(document({ proxyUrl: 'http://old:7890' }))
    service.mutate.mockRejectedValueOnce(new Error('revision conflict'))
    const { renderer } = await mount(service.remote, controlWith())
    await act(async () => { fieldInput(renderer, 'proxyUrl').props.onChange({ target: { value: 'http://mine:7890' } }) })
    service.set(document({ proxyUrl: 'http://other:7890' }, 2))
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(fieldInput(renderer, 'proxyUrl').props.value).toBe('http://mine:7890')
    expect(renderedText(renderer)).toContain('revision conflict')
    expect(renderedText(renderer)).toContain('已保留你的输入')
    expect(button(renderer, '保存').props.disabled).toBe(false)
    service.set(document({ proxyUrl: 'http://mine:7890' }, 3))
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate.mock.calls[1]?.[2]).toBe(2)
  })

  it('目录变化时刷新逐模型列表，手动列目录也能读到新条目', async () => {
    vi.setSystemTime(NOW)
    const service = transport()
    let revision = 1
    const control = vi.fn(async (method: string, request?: { force?: boolean }) => {
      if (method === 'account') return { state: 'idle', message: 'ready', runtime: { phase: 'ready', modelCatalogRevision: revision } }
      if (request?.force) return { status: 'ok', models: [{ id: 'fresh-model', name: 'Fresh' }] }
      return revision === 1 ? { status: 'ok', models: [] } : catalog()
    })
    const { renderer, intervals } = await mount(service.remote, control)
    // 空目录仍有尚未下线的退役表内置家族补行（默认关闭并带下线徽章），ACP / 代理列表不显示空列表提示。
    // AI Studio Tab 常驻挂载，其空表提示文案不同（请先配置 API key），故只断言 ACP / 代理的空表文案不出现。
    expect(renderedText(renderer)).not.toContain('暂无模型。请先连接当前账户')
    expect(renderedText(renderer)).toContain('即将下线 11-30')
    expect(renderedText(renderer)).toContain('全部 2')
    revision = 2
    await act(async () => { for (const timer of intervals.values()) if (timer.delay === 2000) timer.callback() })
    expect(modelControl(renderer, 'target', 'gemini-3-pro').props.value).toBe('')
    expect(renderedText(renderer)).toContain('文本 · 图片')
    await act(async () => { await button(renderer, '刷新模型目录').props.onClick() })
    expect(modelControl(renderer, 'enabled', 'fresh-model')).toBeDefined()
  })

  it('AI Studio Tab：独立模型表隐藏思考档、显示名覆盖生效，手动 key 经 setKey 写入', async () => {
    const service = transport(document({ aistudioEnabled: true, aistudioCredentialRef: 'AISTUDIO_API_KEY', modelOverrides: { 'aistudio-gemini-3-pro': { name: 'Gemini 3 Pro（长）' } } }))
    const control = vi.fn(async (method: string) => method === 'account' ? { state: 'idle', message: 'ready' } : { status: 'ok', models: [] })
    const aistudioControl = vi.fn(async (method: string) => {
      if (method === 'models') return { status: 'ok', models: [
        { id: 'aistudio-gemini-3.8-flash', name: 'Gemini 3.8 Flash', inputModalities: ['text'], contextWindow: 1048576 },
        { id: 'aistudio-gemini-3-pro', name: 'Gemini 3 Pro', inputModalities: ['text'] },
      ] }
      if (method === 'keyStatus') return { status: 'ok', configured: true, writable: true, masked: 'AIza…xxxx' }
      if (method === 'setKey') return { status: 'ok' }
      return undefined
    })
    const { renderer } = await mount(service.remote, control, undefined, undefined, aistudioControl)
    await act(async () => { await button(renderer, 'AI Studio').props.onClick() })
    await act(async () => {})
    // 独立模型表：aistudio- 目录行在场，显示名覆盖生效。
    expect(modelControl(renderer, 'enabled', 'aistudio-gemini-3.8-flash')).toBeDefined()
    expect(modelControl(renderer, 'name', 'aistudio-gemini-3-pro').props.value).toBe('Gemini 3 Pro（长）')
    // 首期不映射思考档：AI Studio 行无 effort 选择器。
    expect(renderer.root.findAllByProps({ name: 'model-effort-aistudio-gemini-3.8-flash' })).toHaveLength(0)
    // 掩码状态显示已配置。
    expect(renderedText(renderer)).toContain('已配置')
    // 手动 key 写入：密码框输入 + 保存 → setKey（只写不回显）。
    const keyInput = renderer.root.findByProps({ 'aria-label': 'AI Studio API key' })
    await act(async () => { keyInput.props.onChange({ target: { value: 'AIzaSyNEWKEY123' } }) })
    await act(async () => { await button(renderer, '保存 key').props.onClick() })
    expect(aistudioControl).toHaveBeenCalledWith('setKey', { value: 'AIzaSyNEWKEY123' })
  })

  it('Vertex AI 使用独立目录，将模型列表和逐模型设置一同保存', async () => {
    const id = 'vertex-ai-gemini-4-hydrogen'
    const service = transport(document({ vertexEnabled: true, vertexProject: 'example-project', vertexLocation: 'global',
      vertexModels: ['gemini-4-hydrogen'], modelOverrides: { [id]: { name: 'Hydrogen on Vertex' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    const vertex = renderer.root.findByProps({ id: 'agy-settings-page-vertex' })
    const acp = renderer.root.findByProps({ id: 'agy-settings-page-models' })
    expect(acp.findAllByProps({ name: 'model-enabled-' + id })).toHaveLength(0)
    await act(async () => { button(renderer, 'Vertex AI').props.onClick() })
    expect(vertex.props.style.display).toBe('flex')
    expect(modelControl(renderer, 'enabled', id).props.checked).toBe(true)
    expect(modelControl(renderer, 'name', id).props.value).toBe('Hydrogen on Vertex')
    expect(renderer.root.findAllByProps({ name: 'model-effort-' + id })).toHaveLength(0)
    await act(async () => {
      fieldInput(renderer, 'vertexModels').props.onChange({ target: { value: 'gemini-4-hydrogen\n gemini-4-neon \n' } })
      modelControl(renderer, 'enabled', id).props.onChange({ target: { checked: false } })
    })
    expect(modelControl(renderer, 'enabled', 'vertex-ai-gemini-4-neon').props.checked).toBe(true)
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate.mock.calls[0]![1]).toEqual(expect.arrayContaining([
      { op: 'set', path: ['vertexModels'], value: ['gemini-4-hydrogen', 'gemini-4-neon'] },
      { op: 'set', path: ['modelOverrides'], value: { [id]: { enabled: false, name: 'Hydrogen on Vertex' } } },
    ]))
  })

  it('AI Studio 本地用量显示窗口、0 与未知、最近 429 和官方链接，轮换时丢弃旧返回', async () => {
    const settings = transport(document({ aistudioEnabled: true }))
    const old = deferred<unknown>()
    const sample = {
      status: 'ok', pacificDay: '2026-11-27', minuteTruncated: false,
      minute: { requests: 1, inputTokens: null, reportedRequests: 0 },
      today: { requests: 2, inputTokens: 0, reportedRequests: 1 }, models: [],
      last429: { at: '2026-11-27T12:00:00.000Z', source: 'sse', model: 'gemini-4-argon', retryAfterMs: 1250 },
    }
    let reads = 0
    const control = vi.fn(async (method: string) => {
      if (method === 'usage') {
        reads++
        if (reads === 2) return old.promise
        return reads === 1 ? sample : { status: 'unconfigured' }
      }
      return method === 'keyStatus' ? { status: 'ok', configured: true, writable: true } : { status: 'ok', models: [] }
    })
    const { renderer } = await mount(settings.remote, undefined, undefined, undefined, control)
    expect(reads).toBe(0)
    await act(async () => { await button(renderer, 'AI Studio').props.onClick() })
    const current = () => JSON.stringify(renderer.toJSON())
    for (const text of ['最近 1 分钟', 'Pacific 今日（2026-11-27）', '上游输入 token 未报告', '0 输入 token', 'SSE · gemini-4-argon', '1.25 秒', 'https://aistudio.google.com/rate-limit', 'https://aistudio.google.com/usage']) expect(current()).toContain(text)
    await act(async () => { void renderer.root.findByProps({ 'aria-label': '刷新 AI Studio 本地用量' }).props.onClick() })
    await act(async () => { settings.change(document({ aistudioEnabled: true, aistudioCredentialRef: 'NEW_KEY' }, 2)) })
    await act(async () => { old.resolve(sample) })
    expect(current()).toContain('配置 API key 后即可查看本地用量。')
    expect(current()).not.toContain('SSE · gemini-4-argon')
  })

  it('AI Studio 凭据引用变化会刷新目录和掩码，并丢弃旧响应', async () => {
    const settings = transport(document({ aistudioEnabled: true, aistudioCredentialRef: 'OLD_KEY' }))
    const oldModels = deferred<unknown>()
    const oldKey = deferred<unknown>()
    let changed = false
    const control = vi.fn(async (method: string) => {
      if (method === 'keyStatus') return changed ? { status: 'ok', configured: true, writable: true, masked: 'new-mask' } : oldKey.promise
      if (method === 'models') return changed ? { status: 'ok', models: [{ id: 'aistudio-gemini-4-new', name: 'Fresh model' }] } : oldModels.promise
      return { status: 'unconfigured' }
    })
    const { renderer } = await mount(settings.remote, undefined, undefined, undefined, control)
    await act(async () => { button(renderer, 'AI Studio').props.onClick() })
    expect(control.mock.calls.some(([method]) => method === 'models')).toBe(true)
    const reads = control.mock.calls.length
    changed = true
    await act(async () => { settings.change(document({ aistudioEnabled: true, aistudioCredentialRef: 'NEW_KEY' }, 2)) })
    expect(control.mock.calls.slice(reads).map(([method]) => method)).toEqual(expect.arrayContaining(['models', 'keyStatus']))
    await act(async () => {
      oldModels.resolve({ status: 'ok', models: [{ id: 'aistudio-gemini-4-old', name: 'Old model' }] })
      oldKey.resolve({ status: 'ok', configured: true, writable: true, masked: 'old-mask' })
    })
    const rendered = JSON.stringify(renderer.toJSON())
    expect(rendered).toContain('Fresh model')
    expect(rendered).toContain('new-mask')
    expect(rendered).not.toContain('Old model')
    expect(rendered).not.toContain('old-mask')
  })

  it('AI Studio 默认仅 4 系开启、启用置顶、显式启用非 4 系落盘', async () => {
    const service = transport(document({ aistudioEnabled: true }))
    const control = vi.fn(async (method: string) => method === 'account' ? { state: 'idle', message: 'ready' } : { status: 'ok', models: [] })
    const aistudioControl = vi.fn(async (method: string) => {
      if (method === 'models') return { status: 'ok', models: [
        { id: 'aistudio-gemini-3.8-flash', name: 'Gemini 3.8 Flash', inputModalities: ['text'] },
        { id: 'aistudio-gemini-4-argon', name: 'Gemini 4 Argon', inputModalities: ['text'] },
        { id: 'aistudio-gemini-2.5-flash', name: 'Gemini 2.5 Flash', inputModalities: ['text'] },
      ] }
      if (method === 'keyStatus') return { status: 'ok', configured: true, writable: true }
      return { status: 'ok' }
    })
    const { renderer } = await mount(service.remote, control, undefined, undefined, aistudioControl)
    await act(async () => { await button(renderer, 'AI Studio').props.onClick() })
    await act(async () => {})
    const toggles = renderer.root.findAllByProps({ type: 'checkbox' }).filter(node => String(node.props.name).startsWith('model-enabled-aistudio-'))
    // 启用置顶：4 系排第一。
    expect(toggles[0]!.props.name).toBe('model-enabled-aistudio-gemini-4-argon')
    const byId = new Map(toggles.map(node => [node.props.name, node]))
    expect(byId.get('model-enabled-aistudio-gemini-4-argon')!.props.checked).toBe(true)
    expect(byId.get('model-enabled-aistudio-gemini-3.8-flash')!.props.checked).toBe(false)
    expect(byId.get('model-enabled-aistudio-gemini-2.5-flash')!.props.checked).toBe(false)
    // 显式启用非 4 系 → 保存落盘 enabled:true（默认关闭模型的启用必须落盘）。
    await act(async () => { byId.get('model-enabled-aistudio-gemini-3.8-flash')!.props.onChange({ target: { checked: true } }) })
    await act(async () => { await button(renderer, '保存').props.onClick() })
    const ops = service.mutate.mock.calls.at(-1)![1] as Array<{ path: string[]; value: Record<string, unknown> }>
    const overrides = ops.find(op => op.path[0] === 'modelOverrides')!.value
    expect(overrides['aistudio-gemini-3.8-flash']).toMatchObject({ enabled: true })
    // 4 系默认开启不写 enabled:true（默认值不落盘）。
    expect(overrides['aistudio-gemini-4-argon']).toBeUndefined()
  })

  it('后台目录通知不覆盖手动拉取的等待状态和失败原因，可再次点击重试', async () => {
    const service = transport()
    const pending = deferred<unknown>()
    let revision = 1
    let fail = true
    const control = vi.fn(async (method: string, request?: { force?: boolean }) => {
      if (method === 'account') return { state: 'idle', runtime: { modelCatalogRevision: revision } }
      if (request?.force) return fail ? pending.promise : { status: 'ok', models: [{ id: 'new-model', name: 'New Model' }] }
      return { status: 'ok', models: [{ id: 'old-model', name: 'Old Model' }] }
    })
    const { renderer, intervals } = await mount(service.remote, control)
    await act(async () => { void button(renderer, '刷新模型目录').props.onClick() })
    expect(renderedText(renderer)).toContain('正在拉取模型目录')
    const calls = control.mock.calls.filter(([method]) => method === 'models').length
    revision++
    await act(async () => { for (const timer of intervals.values()) if (timer.delay === 2000) timer.callback() })
    expect(control.mock.calls.filter(([method]) => method === 'models')).toHaveLength(calls)
    expect(button(renderer, '正在刷新…').props.disabled).toBe(true)
    await act(async () => { pending.resolve({ status: 'error', models: [{ id: 'old-model', name: 'Old Model' }], message: '目录拉取失败，请重试' }) })
    expect(renderedText(renderer)).toContain('目录拉取失败，请重试')
    expect(button(renderer, '刷新模型目录').props.disabled).toBe(false)
    fail = false
    await act(async () => { await button(renderer, '刷新模型目录').props.onClick() })
    expect(modelControl(renderer, 'enabled', 'new-model')).toBeDefined()
  })

  it('shows session switches and submits timers as numbers, preserving zero', async () => {
    const service = transport()
    const { renderer } = await mount(service.remote)
    expect(renderer.root.findByProps({ name: 'reuseSessions' }).props.checked).toBe(true)
    expect(renderer.root.findByProps({ name: 'resumeSessions' }).props.checked).toBe(false)
    expect(renderer.root.findByProps({ name: 'keepProcessAfterCancel' }).props.checked).toBe(false)
    expect(renderer.root.findByProps({ name: 'cancelGraceMs' }).props.value).toBe(30000)
    expect(renderer.root.findByProps({ name: 'idleRecycleMs' }).props.value).toBe(300000)
    await act(async () => {
      renderer.root.findByProps({ name: 'keepProcessAfterCancel' }).props.onChange({ target: { checked: true } })
      renderer.root.findByProps({ name: 'cancelGraceMs' }).props.onChange({ target: { value: '12000' } })
      renderer.root.findByProps({ name: 'idleRecycleMs' }).props.onChange({ target: { value: '0' } })
    })
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [
      { op: 'set', path: ['keepProcessAfterCancel'], value: true },
      { op: 'set', path: ['cancelGraceMs'], value: 12000 },
      { op: 'set', path: ['idleRecycleMs'], value: 0 },
    ], 1)
  })

  for (const invalid of ['', '-1', '0.5', '60001', 'NaN']) {
    it(`rejects invalid cancel grace ${JSON.stringify(invalid)} without losing the draft`, async () => {
      const service = transport()
      const { renderer } = await mount(service.remote)
      await act(async () => { renderer.root.findByProps({ name: 'cancelGraceMs' }).props.onChange({ target: { value: invalid } }) })
      await act(async () => { await button(renderer, '保存').props.onClick() })
      expect(service.mutate).not.toHaveBeenCalled()
      expect(renderedText(renderer)).toContain('必须是 0–60000 的整数')
      expect(button(renderer, '保存').props.disabled).toBe(false)
    })
  }

  it('displays pool pressure and clears subscriptions and polling on unmount', async () => {
    const service = transport()
    const control = vi.fn(async (method: string) => method === 'account'
      ? { state: 'connected', message: 'ready', runtime: { phase: 'prompt', queue: { active: 2, parked: 1, waiting: 3, workers: 2, capacity: 2 } } }
      : { status: 'ok', models: [] })
    const { renderer, intervals } = await mount(service.remote, control)
    expect(renderedText(renderer)).toContain('运行 2 · 等待工具 1 · 排队 3')
    expect(button(renderer, '连接 / 登录 ACP').props.disabled).toBe(true)
    expect(button(renderer, '立即预热').props.disabled).toBe(true)
    const before = service.describe.mock.calls.length
    await act(async () => { renderer.unmount() })
    expect(intervals.size).toBe(0)
    service.notify()
    expect(service.describe.mock.calls.length).toBe(before)
  })

  it('编排分组渲染 7 个可编辑控件，Executor 可在 Hydrogen / Sonnet 间选择，作为单个顶层对象字段提交且保留 plannerTimeoutMs', async () => {
    const service = transport(document({ orchestrator: { plannerTimeoutMs: 45000, executorModel: 'legacy-executor' } }))
    const { renderer } = await mount(service.remote)
    expect(fieldInput(renderer, 'orchestratorEnabled').props.checked).toBe(true)
    const plannerSelect = fieldInput(renderer, 'orchestratorPlannerModel')
    expect(plannerSelect.type).toBe('select')
    expect(plannerSelect.props.value).toBe('claude-opus-5-5')
    expect(plannerSelect.findAllByType('option').map((opt) => opt.props.value)).toEqual([
      'gemini-4-neon',
      'gemini-4-argon',
      'claude-opus-5-5',
    ])
    expect(fieldInput(renderer, 'orchestratorPlannerEffort').props.value).toBe('medium')
    // 非法 executorModel 回落默认 Hydrogen。
    const executorSelect = fieldInput(renderer, 'orchestratorExecutorModel')
    expect(executorSelect.type).toBe('select')
    expect(executorSelect.props.value).toBe('gemini-4-hydrogen')
    expect(executorSelect.findAllByType('option').map((opt) => opt.props.value)).toEqual([
      'gemini-4-hydrogen',
      'claude-sonnet-5-5',
    ])
    expect(fieldInput(renderer, 'orchestratorExecutorEffort').props.value).toBe('medium')
    expect(fieldInput(renderer, 'orchestratorMaxPlans').props.value).toBe(2)
    expect(fieldInput(renderer, 'orchestratorShowPlan').props.checked).toBe(false)
    expect(button(renderer, '保存').props.disabled).toBe(true)

    await act(async () => {
      fieldInput(renderer, 'orchestratorEnabled').props.onChange({ target: { checked: false } })
      fieldInput(renderer, 'orchestratorPlannerModel').props.onChange({ target: { value: 'gemini-4-neon' } })
      fieldInput(renderer, 'orchestratorPlannerEffort').props.onChange({ target: { value: 'low' } })
      fieldInput(renderer, 'orchestratorExecutorModel').props.onChange({ target: { value: 'claude-sonnet-5-5' } })
      fieldInput(renderer, 'orchestratorExecutorEffort').props.onChange({ target: { value: 'high' } })
      fieldInput(renderer, 'orchestratorMaxPlans').props.onChange({ target: { value: '4' } })
      fieldInput(renderer, 'orchestratorShowPlan').props.onChange({ target: { checked: true } })
    })

    // 7 个控件归属同一个顶层 orchestrator 字段，只计 1 项未保存。
    expect(renderedText(renderer)).toContain('1 项未保存')
    expect(button(renderer, '保存').props.disabled).toBe(false)
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [{
      op: 'set',
      path: ['orchestrator'],
      value: {
        enabled: false,
        plannerModel: 'gemini-4-neon',
        plannerEffort: 'low',
        executorModel: 'claude-sonnet-5-5',
        executorEffort: 'high',
        maxPlansPerTurn: 4,
        plannerTimeoutMs: 45000,
        showPlan: true,
      },
    }], 1)
  })

  it('编排设置按规范化比较，键序差异、非法 executorModel 或写回默认值不误判为未保存', async () => {
    const service = transport(document({
      orchestrator: {
        showPlan: false,
        maxPlansPerTurn: 2,
        executorEffort: 'medium',
        executorModel: 'gemini-4-hydrogen',
        plannerEffort: 'medium',
        plannerModel: 'claude-opus-5-5',
        enabled: true,
      },
    }))
    const { renderer } = await mount(service.remote)
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(renderedText(renderer)).not.toContain('项未保存')

    await act(async () => {
      fieldInput(renderer, 'orchestratorShowPlan').props.onChange({ target: { checked: true } })
    })
    expect(button(renderer, '保存').props.disabled).toBe(false)

    // 改回默认值后应恢复干净状态。
    await act(async () => {
      fieldInput(renderer, 'orchestratorShowPlan').props.onChange({ target: { checked: false } })
    })
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(renderedText(renderer)).not.toContain('项未保存')

    // 外部以不同键序写回等价默认值、非法 plannerModel 或非法 executorModel，均保持干净并回落默认。
    await act(async () => {
      service.change(document({
        orchestrator: { enabled: true, plannerModel: 'unknown-planner', executorModel: 'other-executor', showPlan: false },
      }, 2))
    })
    expect(fieldInput(renderer, 'orchestratorPlannerModel').props.value).toBe('claude-opus-5-5')
    expect(fieldInput(renderer, 'orchestratorExecutorModel').props.value).toBe('gemini-4-hydrogen')
    expect(button(renderer, '保存').props.disabled).toBe(true)
  })

  it('编排设置支持外部更新冲突提示与撤销，且在代理模式下同样可编辑', async () => {
    const service = transport(document({
      proxyMode: true,
      proxyUrl: 'http://old:7890',
      orchestrator: { plannerEffort: 'low', maxPlansPerTurn: 2 },
    }))
    const { renderer } = await mount(service.remote)
    await act(async () => {
      fieldInput(renderer, 'orchestratorShowPlan').props.onChange({ target: { checked: true } })
    })
    await act(async () => {
      service.change(document({
        proxyMode: true,
        proxyUrl: 'http://new:7890',
        orchestrator: { plannerModel: 'gemini-4-argon', plannerEffort: 'high', maxPlansPerTurn: 3 },
      }, 2))
    })
    expect(fieldInput(renderer, 'orchestratorShowPlan').props.checked).toBe(true)
    expect(fieldInput(renderer, 'orchestratorMaxPlans').props.value).toBe(2)
    expect(fieldInput(renderer, 'proxyUrl').props.value).toBe('http://new:7890')
    expect(renderedText(renderer)).toContain('已保留你的输入')
    expect(renderedText(renderer)).toContain('编排（Orchestrator）')
    expect(renderedText(renderer)).toContain('1 项未保存')

    await act(async () => { button(renderer, '撤销').props.onClick() })
    expect(fieldInput(renderer, 'orchestratorShowPlan').props.checked).toBe(false)
    expect(fieldInput(renderer, 'orchestratorPlannerModel').props.value).toBe('gemini-4-argon')
    expect(fieldInput(renderer, 'orchestratorPlannerEffort').props.value).toBe('high')
    expect(fieldInput(renderer, 'orchestratorMaxPlans').props.value).toBe(3)
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(renderedText(renderer)).not.toContain('已保留你的输入')
  })

  for (const invalid of ['', '0', '5', '1.5', 'NaN']) {
    it(`编排最大规划次数拒绝非法值 ${JSON.stringify(invalid)} 且保留草稿`, async () => {
      const service = transport(document())
      const { renderer } = await mount(service.remote)
      await act(async () => {
        fieldInput(renderer, 'orchestratorMaxPlans').props.onChange({ target: { value: invalid } })
      })
      expect(button(renderer, '保存').props.disabled).toBe(false)
      await act(async () => { await button(renderer, '保存').props.onClick() })
      expect(service.mutate).not.toHaveBeenCalled()
      expect(renderedText(renderer)).toContain('必须是 1–4 的整数')
      expect(button(renderer, '保存').props.disabled).toBe(false)
    })
  }
})
