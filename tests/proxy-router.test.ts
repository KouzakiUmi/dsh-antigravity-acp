/**
 * 模式互斥的接线测试：宿主行的 ACP 路由替换 + 代理行的路由注册/注销，
 * 都只由同一个 `proxyMode` volatile 值驱动。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { ProxyModelCatalog } from '../src/proxy/adapter.js'
import { apply as applyProxyRow } from '../src/proxy/index.js'
import { createProxyModeBus } from '../src/proxy/mode-bus.js'
import type { ProxyModeBus } from '../src/proxy/mode-bus.js'
import { ProxyAccountService } from '../src/proxy/account-service.js'
import type { ProxyCredential } from '../src/proxy/account-store.js'

interface FakeLlm {
  registerAdapter: ReturnType<typeof vi.fn>
  registrations: Array<{ providers: string[]; replace: ReturnType<typeof vi.fn>; disposed: boolean }>
}

function fakeCtx(bus: ProxyModeBus, auth: ProxyAccountService) {
  const llm: FakeLlm = {
    registerAdapter: vi.fn(),
    registrations: [],
  }
  llm.registerAdapter.mockImplementation((providers: string[]) => {
    const entry = { providers: [...providers], replace: vi.fn(), disposed: false }
    entry.replace.mockImplementation((next: string[]) => { entry.providers = [...next] })
    llm.registrations.push(entry)
    const dispose = () => { entry.disposed = true; entry.providers = [] }
    return Object.assign(dispose, { replace: entry.replace })
  })
  const injected: Record<string, (scope: unknown) => void> = {}
  const cleanups: Array<() => void> = []
  const provided = new Map<string, unknown>()
  const ctx = {
    llm,
    logger: { info: vi.fn(), warn: vi.fn() },
    emit: vi.fn(),
    get: (name: string) => provided.get(name) ?? (name === 'antigravityProxyAuth' ? auth : name === 'antigravityProxyMode' ? bus : undefined),
    provide(name: string, value: unknown) {
      provided.set(name, value)
      const dispose = () => { provided.delete(name) }
      cleanups.push(dispose)
      return dispose
    },
    inject(names: string[], callback: (scope: unknown) => void) {
      for (const name of names) injected[name] = callback
      // 服务齐备时立即执行（模拟 cordis 的依赖就绪回调）。
      if (names.every((name) => ctx.get(name) !== undefined)) callback(ctx)
    },
    effect(callback: () => Generator<() => void>) {
      cleanups.push(...callback())
    },
  }
  return { ctx: ctx as unknown as Context, llm, injected, cleanups }
}

function fakeAuth(): ProxyAccountService {
  return new ProxyAccountService({
    cacheDir: '/tmp/unused',
    // 测试绝不读真实登录态：指向不存在的路径。
    cliTokenPath: '/nonexistent/antigravity-oauth-token',
    store: { load: async () => undefined, peek: () => undefined, save: async () => {}, clear: async () => {} } as never,
    oauthFlow: { start: async () => ({ authorizationUrl: 'https://accounts.google.com/x', expiresAt: '' }), status: () => ({ phase: 'idle' as const }), cancel: async () => ({ phase: 'idle' as const }), dispose: async () => {}, completeCallbackUrl: async () => ({ completed: false }) } as never,
  })
}

describe('代理行：路由随模式注册与注销', () => {
  it('真实 Cordis 中目录服务随代理行就绪并随依赖卸载清理', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      const llm = ctx.get('llm')
      if (!llm) throw new Error('LLM service did not start')
      const bus = createProxyModeBus({ mode: () => true, proxySettings: () => ({}) })
      const host = await ctx.plugin(scope => {
        scope.provide('antigravityProxyAuth', { credential: async () => undefined, subscribe: () => () => {} })
        scope.provide('antigravityProxyMode', bus)
      })
      await ctx.plugin({ inject: ['llm'], apply: applyProxyRow }, {})
      await vi.waitFor(() => expect(ctx.get('antigravityProxyCatalog')).toBeDefined())
      const catalog = ctx.get('antigravityProxyCatalog') as ProxyModelCatalog
      await expect(catalog.models(true)).rejects.toMatchObject({ code: 'AUTH' })
      expect(llm.listProviders().map(row => row.id)).toEqual(['antigravity-proxy'])
      await host.dispose()
      await vi.waitFor(() => expect(ctx.get('antigravityProxyCatalog')).toBeUndefined())
      expect(llm.listProviders()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('默认关闭时不注册路由；开启后注册 antigravity-proxy；再关闭注销', () => {
    let mode = false
    const bus = createProxyModeBus({ mode: () => mode, proxySettings: () => ({}) })
    const auth = fakeAuth()
    const { ctx, llm, cleanups } = fakeCtx(bus, auth)
    applyProxyRow(ctx, {})
    expect(llm.registrations).toHaveLength(0)

    mode = true
    bus.notify()
    expect(llm.registrations).toHaveLength(1)
    expect(llm.registrations[0]?.providers).toEqual(['antigravity-proxy'])

    mode = false
    bus.notify()
    expect(llm.registrations[0]?.providers).toEqual([])

    for (const cleanup of cleanups.reverse()) cleanup()
  })

  it('宿主行缺席（服务未 provide）时代理行安静地不注册', () => {
    const llm = { registerAdapter: vi.fn(), registrations: [] }
    const ctx = {
      llm,
      logger: { info: vi.fn(), warn: vi.fn() },
      emit: vi.fn(),
      get: () => undefined,
      inject: vi.fn(),
      effect: vi.fn(),
    } as unknown as Context
    applyProxyRow(ctx, {})
    expect(llm.registerAdapter).not.toHaveBeenCalled()
  })
})

describe('宿主行语义：registration.replace 的互斥计划', () => {
  it('replace 空集与恢复都在同一条 registration 上原子完成', () => {
    const replace = vi.fn()
    const dispose = vi.fn()
    const registration = Object.assign(dispose, { replace })
    let held = true
    const sync = (proxyMode: boolean): void => {
      if (proxyMode && held) { registration.replace([]); held = false }
      else if (!proxyMode && !held) { registration.replace(['antigravity-acp']); held = true }
    }
    sync(true)
    expect(replace).toHaveBeenLastCalledWith([])
    sync(true)
    expect(replace).toHaveBeenCalledTimes(1)
    sync(false)
    expect(replace).toHaveBeenLastCalledWith(['antigravity-acp'])
    expect(dispose).not.toHaveBeenCalled()
  })
})

describe('账户服务：凭据面', () => {
  it('未登录时 credential 返回 undefined，adapter 据此报 AUTH', async () => {
    const auth = fakeAuth()
    await expect(auth.credential()).resolves.toBeUndefined()
  })

  it('状态快照不含凭据字段', async () => {
    const auth = fakeAuth()
    const snapshot = auth.status()
    expect(Object.keys(snapshot).sort()).toEqual(['message', 'oauth', 'phase', 'revision', 'updatedAt'])
    const credential: ProxyCredential | undefined = undefined
    expect(credential).toBeUndefined()
  })
})
