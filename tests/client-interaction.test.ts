import { readFileSync } from 'node:fs'
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
})

/** Real React hooks and rerenders; only the DSH loader/transport and browser timers are substituted. */
function loadCard() {
  let registration: { factory(require: (id: string) => unknown): { apply(ctx: unknown): void } } | undefined
  const components = new Map<string, React.ComponentType<Record<string, unknown>>>()
  const intervals = new Map<number, { callback: () => void; delay: number }>()
  let timerId = 0
  runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (value: typeof registration) => { registration = value } }, innerHeight: 800, addEventListener: () => {}, removeEventListener: () => {} },
    document: { documentElement: { clientWidth: 1200 }, addEventListener: () => {}, removeEventListener: () => {} },
    setInterval: (callback: () => void, delay: number) => { intervals.set(++timerId, { callback, delay }); return timerId },
    clearInterval: (id: number) => intervals.delete(id),
    setTimeout, clearTimeout,
  })
  const slots = {
    inject: (_name: string, callback: () => void) => { callback(); return () => {} },
    register: (row: { id: string }, component: React.ComponentType<Record<string, unknown>>) => {
      components.set(row.id, component)
      return () => {}
    },
  }
  const ctx = {
    slots,
    remote: { $mount: () => () => {} },
    effect: (callback: () => unknown) => callback(),
    inject: (_names: string[], callback: (scope: unknown) => void) => callback(ctx),
  }
  registration!.factory(() => React).apply(ctx)
  return { Card: components.get('antigravity-acp')!, Pill: components.get('antigravity-quota')!, intervals }
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

async function mount(remote: unknown, control?: unknown) {
  const { Card, intervals } = loadCard()
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(React.createElement(Card, { remote, control })) })
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

function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.findAllByType('button').find((node) => node.children.join('') === label)!
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
  it('失败信封转成可读错误，不把异常抛出组件', async () => {
    const renderer = await mountPill(async () => ({ ok: false, error: { message: 'remote denied' } }))
    expect(renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props['aria-label']).toContain('额度读取失败')
    await act(async () => { await renderer.root.findByProps({ 'aria-haspopup': 'dialog' }).props.onClick() })
    expect(renderedText(renderer)).toContain('remote denied')
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
  /** 目录桩：两个模型，供逐模型设置渲染。 */
  const catalog = () => ({ status: 'ok' as const, models: [
    { id: 'gemini-3-pro', name: 'Gemini 3 Pro', inputModalities: ['text', 'image'] },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet' },
  ] })
  const controlWith = (models: unknown = catalog(), account: Record<string, unknown> = { state: 'idle', message: 'ready' }) =>
    vi.fn(async (method: string) => method === 'account' ? account : models)

  it('普通设置控件都来自宿主可投影的 volatile 字段，并可与逐模型设置一起保存、回读', async () => {
    const fields = Object.entries(Config.dict ?? {}).filter(([, field]) => field.meta.volatile).map(([key]) => key)
    expect([...fields].sort()).toEqual([...LIVE_SETTING_KEYS].sort())
    const values = liveHostConfig(Config({ autoWarmup: false }))
    const projected: Record<string, unknown> = Object.fromEntries(fields.map(key => [key, Reflect.get(values, key)]))
    const service = transport(document(projected))
    service.mutate.mockImplementation(async (_ns, ops, revision) => {
      expect(revision).toBe(1)
      for (const value of ops) {
        const op = value as { path: string[]; value: unknown }
        expect(fields).toContain(op.path[0])
        projected[op.path[0]!] = op.value
      }
      service.change(document(projected, 2))
      return { ok: true, value: undefined }
    })
    const { renderer } = await mount(service.remote, controlWith())
    // modelOverrides 由逐模型行渲染，不是普通输入框。
    const plain = fields.filter(key => key !== 'modelOverrides')
    const inputs = renderer.root.findAllByType('input').filter(input => !String(input.props.name).startsWith('model-'))
    expect(inputs).toHaveLength(plain.length)
    expect(inputs.every(input => input.props.disabled === false)).toBe(true)
    await act(async () => {
      for (const input of inputs) input.props.onChange({ target: input.props.type === 'checkbox'
        ? { checked: !input.props.checked }
        : { value: input.props.type === 'number' ? '0' : 'test-value' } })
      modelControl(renderer, 'enabled', 'gemini-3-pro').props.onChange({ target: { checked: false } })
      modelControl(renderer, 'effort', 'claude-sonnet-5-5').props.onChange({ target: { value: 'high' } })
    })
    expect(button(renderer, '保存').props.disabled).toBe(false)
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).toHaveBeenCalledTimes(1)
    const ops = service.mutate.mock.calls[0]![1] as Array<{ path: string[]; value: unknown }>
    expect(ops.map(op => op.path[0]).sort()).toEqual([...plain, 'modelOverrides'].sort())
    expect(ops.find(op => op.path[0] === 'modelOverrides')!.value).toEqual({
      'claude-sonnet-5-5': { effort: 'high' },
      'gemini-3-pro': { enabled: false },
    })
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(fieldInput(renderer, 'proxyUrl').props.value).toBe('test-value')
    expect(renderedText(renderer)).toContain('会话偏好从下一轮生效')
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

  it('全部模型被隐藏时提示 provider 会从选择器消失，重新启用后提示消失', async () => {
    const service = transport(document({ modelOverrides: { 'gemini-3-pro': { enabled: false }, 'claude-sonnet-5-5': { enabled: false } } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(renderedText(renderer)).toContain('所有模型都已隐藏')
    await act(async () => { modelControl(renderer, 'enabled', 'gemini-3-pro').props.onChange({ target: { checked: true } }) })
    expect(renderedText(renderer)).not.toContain('所有模型都已隐藏')
    expect(renderedText(renderer)).toContain('1 个已从选择器隐藏')
  })

  it('已经保存但当前目录没有的模型 ID 仍可编辑，并标注不在目录', async () => {
    const service = transport(document({ modelOverrides: { 'retired-model': { target: 'retired-model-high' } } }))
    const { renderer } = await mount(service.remote, controlWith())
    expect(modelControl(renderer, 'target', 'retired-model').props.value).toBe('retired-model-high')
    expect(renderedText(renderer)).toContain('不在当前目录')
    expect(renderedText(renderer)).toContain('3 个模型')
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
    expect(renderedText(renderer)).toContain('当前设置为只读')
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
    expect(renderedText(renderer)).toContain('有 1 项未保存的修改')
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
    await act(async () => { button(renderer, '撤销未保存修改').props.onClick() })
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
    const service = transport()
    let revision = 1
    const control = vi.fn(async (method: string, request?: { force?: boolean }) => {
      if (method === 'account') return { state: 'idle', message: 'ready', runtime: { phase: 'ready', modelCatalogRevision: revision } }
      if (request?.force) return { status: 'ok', models: [{ id: 'fresh-model', name: 'Fresh' }] }
      return revision === 1 ? { status: 'ok', models: [] } : catalog()
    })
    const { renderer, intervals } = await mount(service.remote, control)
    expect(renderedText(renderer)).toContain('还没有模型目录')
    revision = 2
    await act(async () => { for (const timer of intervals.values()) if (timer.delay === 2000) timer.callback() })
    expect(modelControl(renderer, 'target', 'gemini-3-pro').props.value).toBe('')
    expect(renderedText(renderer)).toContain('文本、图片')
    await act(async () => { await button(renderer, '刷新模型目录').props.onClick() })
    expect(modelControl(renderer, 'enabled', 'fresh-model')).toBeDefined()
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
})
