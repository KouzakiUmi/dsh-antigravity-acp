import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ProxyAccountService } from '../src/proxy/account-service.js'
import { ProxyAccountStore } from '../src/proxy/account-store.js'
import type { ProxyCredential } from '../src/proxy/account-store.js'
import { createProxyOAuthFlow, refreshProxyAccessToken } from '../src/proxy/oauth.js'
import type { ProxyOAuthFlow, ProxyOAuthToken } from '../src/proxy/oauth.js'
import { AgYProxyAccountService, AGY_PROXY_ACCOUNT_SERVICE } from '../src/proxy/account-remote.js'
import { fetchProxyQuotaSnapshot, resolveProxyProject } from '../src/proxy/quota-source.js'

const cli = vi.hoisted(() => ({ raw: '' }))
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, readFile: vi.fn((path, ...args) => {
    if (path === '/synthetic-cli') return Promise.resolve(cli.raw)
    // 服务测试只允许这个合成路径与明确不存在的路径。
    if (String(path).includes('nonexistent-review-token')) return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    throw new Error('Unexpected file read in isolated account test')
  }) }
})
afterEach(() => { cli.raw = ''; vi.useRealTimers() })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const expired: ProxyCredential = { accessToken: 'synthetic-old', refreshToken: 'synthetic-refresh', expiresAt: 0, source: 'login', updatedAt: 'x' }
const token: ProxyOAuthToken = { accessToken: 'synthetic-new', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3600_000 }
const projectTransport = { request: vi.fn(async () => new Response(JSON.stringify({ cloudaicompanionProject: { id: 'synthetic-project' } }))) }
const oauth: ProxyOAuthFlow = {
  start: async () => ({ authorizationUrl: 'https://example.invalid', expiresAt: 'x' }),
  status: () => ({ phase: 'idle' }), cancel: async () => ({ phase: 'cancelled' }),
  dispose: async () => {}, completeCallbackUrl: async () => ({ completed: false }),
}
function memoryStore() {
  let value: ProxyCredential | undefined = { ...expired }
  const save = vi.fn(async (next: ProxyCredential) => { value = next })
  const clear = vi.fn(async () => { value = undefined })
  const store = { peek: () => value, load: async () => value, save, clear } as unknown as ProxyAccountStore
  return { store, save, clear }
}

describe('代理账户退出与取消', () => {
  it.each(['refresh', 'project'] as const)('取消 pre-OAuth 的 CLI %s 请求会中止实际 signal，且可再次连接', async stage => {
    cli.raw = JSON.stringify({ access_token: 'synthetic-cli', refresh_token: 'synthetic-refresh',
      expiry: stage === 'refresh' ? '2000-01-01T00:00:00Z' : new Date(Date.now() + 3600_000).toISOString() })
    const memory = memoryStore(); await memory.clear()
    const entered = deferred<void>()
    let observed: AbortSignal | undefined
    const start = vi.fn(oauth.start)
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      observed = init!.signal as AbortSignal; entered.resolve()
      return new Promise<Response>(() => {})
    })
    const request = vi.fn(async (input: { signal?: AbortSignal }) => {
      observed = input.signal; entered.resolve()
      return new Promise<Response>(() => {})
    })
    const service = new ProxyAccountService({ cacheDir: '/unused', cliTokenPath: '/synthetic-cli', store: memory.store,
      oauthFlow: { ...oauth, start }, fetchImpl, projectTransport: stage === 'project' ? { request } : projectTransport })
    try {
      const login = service.login()
      await entered.promise
      expect(service.status()).toMatchObject({ phase: 'pending-login', connectionStage: 'preparing', revision: 0 })
      await service.cancelLogin()
      expect(observed?.aborted).toBe(true)
      expect(await login).toEqual({ message: '代理模式登录已取消' })
      expect(start).not.toHaveBeenCalled()
      expect(memory.save).not.toHaveBeenCalled()
      expect(service.status().phase).toBe('signed-out')
      cli.raw = ''
      expect((await service.login()).authorizationUrl).toBeDefined()
      expect(service.status()).toMatchObject({ phase: 'pending-login', connectionStage: 'authorizing' })
    } finally { await service.dispose() }
  })

  it('取消发生在 save 中途时，取消返回后没有旧提交残留，状态保持退出', async () => {
    const memory = memoryStore()
    const entered = deferred<void>()
    const release = deferred<void>()
    memory.save.mockImplementationOnce(async next => {
      entered.resolve(); await release.promise
      memory.store.peek = () => next
    })
    const service = new ProxyAccountService({ cacheDir: '/unused', store: memory.store, oauthFlow: oauth,
      fetchImpl: async () => new Response(JSON.stringify({ access_token: 'synthetic-new' })) })
    const refresh = service.refresh()
    await entered.promise
    const cancel = service.cancelLogin()
    expect(service.status().phase).toBe('signed-out')
    release.resolve()
    await cancel
    expect(await refresh).toBeUndefined()
    expect(memory.clear).toHaveBeenCalled()
    expect(await service.credential()).toBeUndefined()
    expect(service.status().phase).toBe('signed-out')
    await service.dispose()
  })

  it('clear 磁盘失败会报告错误，但本次生命周期仍保持退出', async () => {
    const memory = memoryStore()
    memory.clear.mockRejectedValueOnce(Object.assign(new Error('synthetic denied'), { code: 'EACCES' }))
    const service = new ProxyAccountService({ cacheDir: '/unused', store: memory.store, oauthFlow: oauth })
    await expect(service.logout()).rejects.toThrow('synthetic denied')
    expect(service.status().phase).toBe('signed-out')
    expect(service.status().message).toContain('本地登录态清除失败')
    expect(await service.credential()).toBeUndefined()
    await service.dispose()
  })
  it('退出后的迟到刷新不能恢复登录态，后续自动取凭据仍保持退出', async () => {
    const memory = memoryStore()
    const entered = deferred<void>()
    const response = deferred<Response>()
    const service = new ProxyAccountService({ cacheDir: '/unused', store: memory.store, oauthFlow: oauth,
      fetchImpl: async () => { entered.resolve(); return response.promise },
    })
    const refresh = service.refresh()
    await entered.promise
    await service.logout()
    response.resolve(new Response(JSON.stringify({ access_token: 'synthetic-new', expires_in: 3600 })))
    expect(await refresh).toBeUndefined()
    expect(memory.save).not.toHaveBeenCalled()
    expect(service.status().phase).toBe('signed-out')
    expect(await service.credential()).toBeUndefined()
    await service.dispose()
  })

  it('退出等待已经开始的保存完成后清除，磁盘与内存保持退出状态', async () => {
    const memory = memoryStore()
    const entered = deferred<void>()
    const release = deferred<void>()
    memory.save.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
    const service = new ProxyAccountService({ cacheDir: '/unused', store: memory.store, oauthFlow: oauth,
      fetchImpl: async () => new Response(JSON.stringify({ access_token: 'synthetic-new', expires_in: 3600 })),
    })
    const refresh = service.refresh()
    await entered.promise
    const logout = service.logout()
    await Promise.resolve()
    expect(memory.clear).not.toHaveBeenCalled()
    release.resolve()
    await logout
    expect(await refresh).toBeUndefined()
    expect(memory.store.peek()).toBeUndefined()
    expect(service.status().phase).toBe('signed-out')
    await service.dispose()
  })

  it('退出后仍可显式重新连接账户', async () => {
    const memory = memoryStore()
    const start = vi.fn(oauth.start)
    const service = new ProxyAccountService({ cacheDir: '/unused', cliTokenPath: '/nonexistent-review-token', store: memory.store, oauthFlow: { ...oauth, start } })
    await service.logout()
    expect((await service.login()).authorizationUrl).toBe('https://example.invalid')
    expect(start).toHaveBeenCalledOnce()
    expect(service.status().phase).toBe('pending-login')
    await service.dispose()
  })
})

describe('OAuth 交换阶段可取消', () => {
  it('旧 listen 迟到失败不会把新登录的 pending 状态改成 failed', async () => {
    const oldListen = deferred<{ close(): void }>()
    const listen = vi.fn().mockImplementationOnce(() => oldListen.promise).mockResolvedValue({ close() {} })
    const flow = createProxyOAuthFlow({ listenerFactory: { listen } })
    const first = flow.start().catch(error => error)
    await Promise.resolve()
    const second = await flow.start()
    oldListen.reject(new Error('late failure'))
    await first
    expect(flow.status()).toMatchObject({ phase: 'pending', authorizationUrl: second.authorizationUrl })
    await flow.dispose()
  })
  it.each(['cancel', 'dispose'] as const)('%s 可中止已收到回调的 token 交换', async action => {
    const entered = deferred<void>()
    const release = deferred<ProxyOAuthToken>()
    const commit = vi.fn(async () => ({ ...expired }))
    const flow = createProxyOAuthFlow({
      listenerFactory: { listen: async () => ({ close: async () => {} }) },
      exchangeCode: async () => { entered.resolve(); return release.promise }, commit,
    })
    const started = await flow.start()
    const state = new URL(started.authorizationUrl).searchParams.get('state')!
    const completion = flow.completeCallbackUrl(`http://localhost:51121/oauth-callback?state=${state}&code=synthetic`)
    await entered.promise
    await flow[action]()
    release.resolve(token)
    expect(await completion).toEqual({ completed: false, errorCode: 'cancelled' })
    expect(commit).not.toHaveBeenCalled()
    expect(flow.status().phase).toBe('cancelled')
    await flow.dispose()
  })

  it('重新开始登录后，旧交换结果不会提交或覆盖新流程状态', async () => {
    const entered = deferred<void>()
    const release = deferred<ProxyOAuthToken>()
    const commit = vi.fn(async () => ({ ...expired }))
    const flow = createProxyOAuthFlow({
      listenerFactory: { listen: async () => ({ close: async () => {} }) },
      exchangeCode: async () => { entered.resolve(); return release.promise }, commit,
    })
    const started = await flow.start()
    const state = new URL(started.authorizationUrl).searchParams.get('state')!
    const completion = flow.completeCallbackUrl(`http://localhost:51121/oauth-callback?state=${state}&code=synthetic`)
    await entered.promise
    const restarted = await flow.start()
    release.resolve(token)
    expect((await completion).completed).toBe(false)
    expect(commit).not.toHaveBeenCalled()
    expect(flow.status()).toMatchObject({ phase: 'pending', authorizationUrl: restarted.authorizationUrl })
    await flow.dispose()
  })
})

describe('代理账户连接流程', () => {
  it.each(['failed', 'expired', 'port-conflict'] as const)('OAuth %s 投影为失败且不暴露授权 URL', async phase => {
    const memory = memoryStore(); await memory.clear()
    let oauthPhase: 'pending' | typeof phase = 'pending'
    const service = new ProxyAccountService({ cacheDir: '/unused', cliTokenPath: '/synthetic-cli', store: memory.store,
      oauthFlow: { ...oauth, status: () => ({ phase: oauthPhase, authorizationUrl: 'https://example.invalid/synthetic-url' }) } })
    await service.login()
    expect(JSON.stringify(service.status())).not.toContain('https://example.invalid')
    oauthPhase = phase
    expect(service.status().phase).toBe('login-failed')
    await service.dispose()
  })

  it.each([401, 403, 503])('项目校验 HTTP %s 只在认证失败时转 OAuth', async status => {
    cli.raw = JSON.stringify({ access_token: 'synthetic-access', expiry: new Date(Date.now() + 3600_000).toISOString() })
    const memory = memoryStore(); await memory.clear()
    const start = vi.fn(oauth.start)
    const service = new ProxyAccountService({ cacheDir: '/unused', cliTokenPath: '/synthetic-cli', store: memory.store,
      oauthFlow: { ...oauth, start }, projectTransport: { request: async () => new Response('{}', { status }) } })
    if (status === 503) {
      await expect(service.login()).rejects.toThrow('HTTP 503')
      expect(service.status().phase).toBe('login-failed')
      expect(start).not.toHaveBeenCalled()
    } else {
      expect((await service.login()).authorizationUrl).toBeDefined()
      expect(start).toHaveBeenCalledOnce()
    }
    await service.dispose()
  })

  it('退出清除期间重连等待清除完成', async () => {
    const memory = memoryStore()
    const entered = deferred<void>(); const gate = deferred<void>()
    memory.clear.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; memory.store.peek = () => undefined })
    const start = vi.fn(oauth.start)
    // 隔离网络：清除期间 load 仍会返回过期凭据，缺省 fetchImpl 会真去请求
    // Google token 端点，让用例结果依赖运行环境的网络行为。
    const service = new ProxyAccountService({ cacheDir: '/unused', cliTokenPath: '/synthetic-cli', store: memory.store,
      fetchImpl: async () => { throw new Error('synthetic token endpoint unreachable') },
      oauthFlow: { ...oauth, start } })
    const exiting = service.logout()
    await entered.promise
    const reconnect = service.login()
    await Promise.resolve()
    expect(start).not.toHaveBeenCalled()
    gate.resolve()
    await exiting
    expect((await reconnect).authorizationUrl).toBeDefined()
    expect(service.status().phase).toBe('pending-login')
    await service.dispose()
  })

  it('项目探测有界且可取消，后端不响应时也能结束', async () => {
    vi.useFakeTimers()
    const request = vi.fn(() => new Promise<Response>(() => {}))
    const controller = new AbortController()
    const result = resolveProxyProject('synthetic', { request }, controller.signal).catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledOnce()
    controller.abort(new Error('synthetic cancelled'))
    expect(await result).toMatchObject({ message: 'synthetic cancelled' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(request).toHaveBeenCalledOnce()
  })
  it.each(['expired', 'refresh-only'])('导入 %s CLI 凭据后先刷新并解析项目才成功', async kind => {
    cli.raw = JSON.stringify({ access_token: kind === 'expired' ? 'synthetic-expired' : '', refresh_token: 'synthetic-refresh', expiry: '2000-01-01T00:00:00Z' })
    const memory = memoryStore()
    await memory.clear()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'synthetic-fresh', expires_in: 3600 })))
    const start = vi.fn(oauth.start)
    const service = new ProxyAccountService({ cacheDir: '/unused', cliTokenPath: '/synthetic-cli', store: memory.store,
      oauthFlow: { ...oauth, start }, fetchImpl, projectTransport })
    const listener = vi.fn()
    const unsubscribe = service.subscribe(listener)
    expect((await service.login()).authorizationUrl).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
    expect(await service.credential()).toMatchObject({ accessToken: 'synthetic-fresh', projectId: 'synthetic-project' })
    expect(service.status()).toMatchObject({ phase: 'signed-in', revision: 1 })
    await service.refresh()
    expect(service.revision()).toBe(1)
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    await service.dispose()
  })

  it('已有账户刷新失败时不静默导入 CLI 的另一账户', async () => {
    cli.raw = JSON.stringify({ access_token: 'cli-account-b', expiry: new Date(Date.now() + 3600_000).toISOString() })
    const memory = memoryStore()
    const project = vi.fn(async () => new Response('{}'))
    const service = new ProxyAccountService({ cacheDir: '/unused', cliTokenPath: '/synthetic-cli', store: memory.store,
      oauthFlow: oauth, fetchImpl: async () => new Response('{}', { status: 500 }), projectTransport: { request: project } })
    expect(await service.credential()).toBeUndefined()
    expect(memory.save).not.toHaveBeenCalled()
    expect(memory.store.peek()).toMatchObject({ accessToken: 'synthetic-old', refreshToken: 'synthetic-refresh' })
    expect(project).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('CLI 刷新失败允许 OAuth，不保存无效导入也不循环宣称成功', async () => {
    cli.raw = JSON.stringify({ access_token: 'synthetic-expired', refresh_token: 'synthetic-bad', expiry: '2000-01-01T00:00:00Z' })
    const memory = memoryStore()
    await memory.clear()
    const start = vi.fn(oauth.start)
    const service = new ProxyAccountService({ cacheDir: '/unused', cliTokenPath: '/synthetic-cli', store: memory.store,
      oauthFlow: { ...oauth, start }, fetchImpl: async () => new Response('{}', { status: 400 }), projectTransport })
    expect((await service.login()).authorizationUrl).toBe('https://example.invalid')
    expect(memory.save).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledOnce()
    expect(service.status().phase).toBe('pending-login')
    await service.dispose()
  })

  it('上游未返回项目时报告可读原因，连接只执行一次只读探测', async () => {
    const request = vi.fn(async (_input: { url: string; body: string }) => new Response(JSON.stringify({ allowedTiers: [{ id: 'synthetic-tier', isDefault: true }] })))
    await expect(resolveProxyProject('synthetic-access', { request })).rejects.toMatchObject({ code: 'AGY_PROXY_PROJECT' })
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]![0].url).toMatch(/:loadCodeAssist$/)
    expect(JSON.parse(request.mock.calls[0]![0].body)).toEqual({ metadata: { ideType: 'ANTIGRAVITY' } })
  })
})

describe('账户存储一致性', () => {
  function storeDeps() {
    return { cacheDir: '/unused', mkdirImpl: async () => {}, writeFileImpl: async () => {}, renameImpl: async () => {},
      chmodImpl: async () => {}, removeImpl: async () => {} }
  }
  it('并发 load 共享读取，迟到 load 不覆盖 clear', async () => {
    const read = deferred<string>()
    const readFileImpl = vi.fn(() => read.promise)
    const store = new ProxyAccountStore({ ...storeDeps(), readFileImpl })
    const first = store.load(); const second = store.load()
    expect(readFileImpl).toHaveBeenCalledOnce()
    await store.clear()
    read.resolve(JSON.stringify(expired))
    expect(await first).toBeUndefined()
    expect(await second).toBeUndefined()
    expect(store.peek()).toBeUndefined()
  })
  it('迟到 load 不覆盖 save，写失败不把新凭据发布到内存', async () => {
    const read = deferred<string>()
    const store = new ProxyAccountStore({ ...storeDeps(), readFileImpl: () => read.promise })
    const loading = store.load()
    await store.save({ ...expired, accessToken: 'synthetic-saved' })
    read.resolve(JSON.stringify(expired))
    expect((await loading)?.accessToken).toBe('synthetic-saved')
    const failed = new ProxyAccountStore({ ...storeDeps(), writeFileImpl: async () => { throw new Error('write failed') } })
    await expect(failed.save(expired)).rejects.toThrow('write failed')
    expect(failed.peek()).toBeUndefined()
  })
  it('clear 只忽略 ENOENT，EACCES 向上传递且内存保持退出', async () => {
    for (const code of ['ENOENT', 'EACCES']) {
      const store = new ProxyAccountStore({ ...storeDeps(), removeImpl: async () => { throw Object.assign(new Error(code), { code }) } })
      await store.save(expired)
      const clear = store.clear()
      if (code === 'ENOENT') await clear
      else await expect(clear).rejects.toThrow('EACCES')
      expect(store.peek()).toBeUndefined()
    }
  })
})

describe('账户 remote 控制可抢占', () => {
  it.each(['cancel', 'logout'] as const)('%s 不会复用在途 login Promise', async action => {
    const ctx = new Context()
    const login = deferred<{ message: string }>()
    const auth = { login: vi.fn(() => login.promise), cancelLogin: vi.fn(async () => {}), logout: vi.fn(async () => {}),
      status: () => ({ phase: 'signed-out', message: 'synthetic', updatedAt: 'x' }) } as unknown as ProxyAccountService
    const fiber = await ctx.plugin(AgYProxyAccountService, auth)
    try {
      const remote = ctx.get(AGY_PROXY_ACCOUNT_SERVICE) as AgYProxyAccountService
      const pending = remote.account({ action: 'login' })
      await remote.account({ action })
      expect(action === 'cancel' ? auth.cancelLogin : auth.logout).toHaveBeenCalledOnce()
      login.resolve({ message: 'synthetic cancelled' })
      await pending
    } finally { await fiber.dispose(); await ctx.fiber.dispose() }
  })
})

describe('OAuth 与额度有界请求', () => {
  it('token 流式超限立即取消读取', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(70 * 1024)) }, cancel }))
    await expect(refreshProxyAccessToken('synthetic', async () => response)).rejects.toThrow(/上限/)
    expect(cancel).toHaveBeenCalled()
  })
  it('忽略 signal 的 token fetch 也在截止时间结束', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}))
    const result = refreshProxyAccessToken('synthetic', fetchImpl).catch(error => error)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(await result).toMatchObject({ message: '代理账户请求超时' })
  })
  it('永不返回的额度传输按总预算结束', async () => {
    vi.useFakeTimers()
    const result = fetchProxyQuotaSnapshot({ credential: { credential: async () => ({ ...expired, ...token }) },
      transport: { request: () => new Promise<Response>(() => {}) } })
    await vi.advanceTimersByTimeAsync(45_001)
    expect(await result).toMatchObject({ status: 'error', groups: [], error: { code: 'request-failed' } })
  })
})
