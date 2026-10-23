import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import React from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
    window: { __ModuleLoader__: { load: (value: typeof registration) => { registration = value } } },
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
  return { Card: components.get('antigravity-acp')!, intervals }
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

function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  return renderer.root.findAllByType('button').find((node) => node.children.join('') === label)!
}
function modelInput(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.findByProps({ placeholder: '选择目录中的模型，或输入自定义 ID' })
}
function renderedText(renderer: ReactTestRenderer): string { return JSON.stringify(renderer.toJSON()) }

describe('settings card with real React state and effects', () => {
  it('respects read-only settings instead of offering a save that will fail', async () => {
    const service = transport(document({ preferredModel: 'old-model' }, 1, false))
    const { renderer } = await mount(service.remote)
    expect(modelInput(renderer).props.disabled).toBe(true)
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(renderedText(renderer)).toContain('当前设置为只读')
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate).not.toHaveBeenCalled()
  })

  it('preserves edited fields and merges untouched fields after an external update', async () => {
    const service = transport(document({ preferredModel: 'old-model', proxyUrl: 'http://old:7890' }))
    const { renderer } = await mount(service.remote)
    await act(async () => { modelInput(renderer).props.onChange({ target: { value: 'my-model' } }) })
    await act(async () => { service.change(document({ preferredModel: 'other-model', proxyUrl: 'http://new:7890' }, 2)) })
    expect(modelInput(renderer).props.value).toBe('my-model')
    expect(renderer.root.findByProps({ placeholder: 'http://127.0.0.1:7890' }).props.value).toBe('http://new:7890')
    expect(renderedText(renderer)).toContain('已保留你的输入')
    expect(renderedText(renderer)).toContain('有 1 项未保存的修改')
    expect(button(renderer, '保存').props.disabled).toBe(false)
  })

  it('ignores an old settings request that resolves after the latest revision', async () => {
    const service = transport()
    const first = deferred<SettingsDocument>()
    service.describe.mockImplementationOnce(() => first.promise)
    const { renderer } = await mount(service.remote)
    await act(async () => { service.change(document({ preferredModel: 'latest-model' }, 3)) })
    await act(async () => { first.resolve(document({ preferredModel: 'stale-model' }, 1)) })
    expect(modelInput(renderer).props.value).toBe('latest-model')
    expect(button(renderer, '保存').props.disabled).toBe(true)
  })

  it('can discard a conflicted draft and restore the latest server settings', async () => {
    const service = transport(document({ preferredModel: 'old-model' }))
    const { renderer } = await mount(service.remote)
    await act(async () => { modelInput(renderer).props.onChange({ target: { value: 'my-model' } }) })
    await act(async () => { service.change(document({ preferredModel: 'latest-model' }, 2)) })
    await act(async () => { button(renderer, '撤销未保存修改').props.onClick() })
    expect(modelInput(renderer).props.value).toBe('latest-model')
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(renderedText(renderer)).not.toContain('其他位置更新了以下设置')
    expect(service.mutate).not.toHaveBeenCalled()
  })

  it('serializes save clicks and submits only edited fields, including a cleared value', async () => {
    const service = transport(document({ preferredModel: 'old-model', proxyUrl: 'http://proxy:7890' }))
    const saved = deferred<{ ok: boolean; value: undefined }>()
    service.mutate.mockImplementationOnce(() => saved.promise)
    const { renderer } = await mount(service.remote)
    await act(async () => { modelInput(renderer).props.onChange({ target: { value: '' } }) })
    const save = button(renderer, '保存').props.onClick as () => Promise<void>
    await act(async () => { void save(); void save() })
    expect(service.mutate).toHaveBeenCalledTimes(1)
    expect(service.mutate).toHaveBeenCalledWith('llm-antigravity-acp', [{ op: 'set', path: ['preferredModel'], value: '' }], 1)
    expect(button(renderer, '保存中…').props.disabled).toBe(true)
    expect(modelInput(renderer).props.disabled).toBe(true)
    await act(async () => {
      service.change(document({ preferredModel: '', proxyUrl: 'http://proxy:7890' }, 2))
      saved.resolve({ ok: true, value: undefined })
    })
    expect(modelInput(renderer).props.value).toBe('')
    expect(button(renderer, '保存').props.disabled).toBe(true)
    expect(renderedText(renderer)).not.toContain('项未保存的修改')
  })

  it('preserves the draft and refreshes the revision after a rejected mutation', async () => {
    const service = transport(document({ preferredModel: 'old-model' }))
    service.mutate.mockRejectedValueOnce(new Error('revision conflict'))
    const { renderer } = await mount(service.remote)
    await act(async () => { modelInput(renderer).props.onChange({ target: { value: 'my-model' } }) })
    service.set(document({ preferredModel: 'other-model' }, 2))
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(modelInput(renderer).props.value).toBe('my-model')
    expect(renderedText(renderer)).toContain('revision conflict')
    expect(renderedText(renderer)).toContain('已保留你的输入')
    expect(button(renderer, '保存').props.disabled).toBe(false)
    service.set(document({ preferredModel: 'my-model' }, 3))
    await act(async () => { await button(renderer, '保存').props.onClick() })
    expect(service.mutate.mock.calls[1]?.[2]).toBe(2)
  })

  it('refreshes the model selector when the backend catalog revision changes', async () => {
    const service = transport(document({ preferredModel: 'example-model' }))
    let revision = 1
    const control = vi.fn(async (method: string) => method === 'account'
      ? { state: 'idle', message: 'ready', runtime: { phase: 'ready', modelCatalogRevision: revision } }
      : { status: 'ok', models: revision === 1 ? [] : [{ id: 'example-model', name: 'Example', inputModalities: ['text', 'image'] }] })
    const { renderer, intervals } = await mount(service.remote, control)
    const before = control.mock.calls.filter(([method]) => method === 'models').length
    revision = 2
    await act(async () => { for (const timer of intervals.values()) if (timer.delay === 2000) timer.callback() })
    expect(control.mock.calls.filter(([method]) => method === 'models').length).toBeGreaterThan(before)
    expect(renderer.root.findAllByType('option').some((option) => option.props.value === 'example-model')).toBe(true)
    expect(renderedText(renderer)).toContain('当前目录支持的输入：文本、图片')
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
    await act(async () => { void button(renderer, '一键拉取模型').props.onClick() })
    expect(renderedText(renderer)).toContain('正在拉取模型目录')
    const calls = control.mock.calls.filter(([method]) => method === 'models').length
    revision++
    await act(async () => { for (const timer of intervals.values()) if (timer.delay === 2000) timer.callback() })
    expect(control.mock.calls.filter(([method]) => method === 'models')).toHaveLength(calls)
    expect(button(renderer, '拉取中…').props.disabled).toBe(true)
    await act(async () => { pending.resolve({ status: 'error', models: [{ id: 'old-model', name: 'Old Model' }], message: '目录拉取失败，请重试' }) })
    expect(renderedText(renderer)).toContain('目录拉取失败，请重试')
    expect(button(renderer, '一键拉取模型').props.disabled).toBe(false)
    fail = false
    await act(async () => { await button(renderer, '一键拉取模型').props.onClick() })
    expect(renderer.root.findAllByType('option').some((option) => option.props.value === 'new-model')).toBe(true)
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
    const before = service.describe.mock.calls.length
    await act(async () => { renderer.unmount() })
    expect(intervals.size).toBe(0)
    service.notify()
    expect(service.describe.mock.calls.length).toBe(before)
  })
})
