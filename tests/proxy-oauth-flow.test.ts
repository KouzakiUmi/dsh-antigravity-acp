import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProxyAccountService } from '../src/proxy/account-service.js'
import { ProxyAccountStore } from '../src/proxy/account-store.js'
import { AntigravityProxyAdapter } from '../src/proxy/adapter.js'
import { createProxyLoopbackListenerFactory } from '../src/proxy/oauth.js'
import type { ProxyLoopbackListenerFactory } from '../src/proxy/oauth.js'
import type { ProxyTransport } from '../src/proxy/transport.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function isolated() {
  const cacheDir = await mkdtemp(join(tmpdir(), 'agy-oauth-flow-'))
  cleanups.push(async () => {
    // 只清理本测试创建且核实位于系统临时目录下的独立目录。
    if (resolve(cacheDir).startsWith(resolve(tmpdir()) + '\\') || resolve(cacheDir).startsWith(resolve(tmpdir()) + '/')) {
      await rm(cacheDir, { recursive: true, force: true })
    } else throw new Error('Unexpected test directory')
  })
  const factory = createProxyLoopbackListenerFactory(0)
  let port = 0
  const listenerFactory: ProxyLoopbackListenerFactory = {
    listen: async handler => {
      const listener = await factory.listen(handler)
      port = listener.port!
      expect(port).toBeGreaterThan(0)
      return listener
    },
  }
  const tokenFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600,
  })))
  const project = vi.fn<ProxyTransport['request']>(async () => new Response(JSON.stringify({ cloudaicompanionProject: { id: 'synthetic-project' } })))
  const options = { cacheDir, cliTokenPath: join(cacheDir, 'missing-cli-token'), fetchImpl: tokenFetch,
    projectTransport: { request: project }, oauthOptions: { listenerFactory } }
  const service = new ProxyAccountService(options)
  cleanups.push(() => service.dispose())
  const callback = (url: string, query: Record<string, string> = { code: 'synthetic-code' }) => {
    const state = new URL(url).searchParams.get('state')!
    return sendCallback(port, new URLSearchParams({ state, ...query }).toString())
  }
  return { cacheDir, options, service, callback, tokenFetch, project, port: () => port }
}

function sendCallback(port: number, query: string, host = 'localhost:51121') {
  return new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
    // 网络连接使用随机端口，Host 仍匹配生产的官方 redirect，未放宽 host 校验。
    const req = request({ host: '127.0.0.1', port, path: `/oauth-callback?${query}`, headers: { Host: host, Connection: 'close' } }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', value => { body += value })
      response.on('end', () => resolveResponse({ status: response.statusCode!, body }))
      response.on('error', reject)
    })
    req.setTimeout(2000, () => req.destroy(new Error('Synthetic callback timed out')))
    req.on('error', reject)
    req.end()
  })
}

describe('无 CLI 的实际 OAuth 与 loopback 账户闭环', () => {
  it('授权 URL / PKCE → 真实 HTTP 回调 → token → 项目 → 磁盘 → 适配器目录与重建', async () => {
    const fixture = await isolated()
    const { service, tokenFetch, project } = fixture
    const changed = vi.fn()
    service.subscribe(changed)
    const started = await service.login()
    const authorization = new URL(started.authorizationUrl!)
    expect(authorization.origin + authorization.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(authorization.searchParams.get('redirect_uri')).toBe('http://localhost:51121/oauth-callback')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('state')).toMatch(/^[\w-]{43}$/)
    expect(service.status()).toMatchObject({ phase: 'pending-login', connectionStage: 'authorizing', revision: 0 })
    expect(await service.credential()).toBeUndefined()
    expect(service.status()).toMatchObject({ phase: 'pending-login', connectionStage: 'authorizing', revision: 0 })
    expect(JSON.stringify(service.status())).not.toContain('https://accounts.google.com')
    expect((await fixture.callback(started.authorizationUrl!)).status).toBe(200)
    expect(tokenFetch).toHaveBeenCalledOnce()
    const [endpoint, init] = tokenFetch.mock.calls[0]!
    expect(endpoint).toBe('https://oauth2.googleapis.com/token')
    const params = init!.body as URLSearchParams
    expect(params.get('grant_type')).toBe('authorization_code')
    expect(params.get('code')).toBe('synthetic-code')
    expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'))
    expect(project).toHaveBeenCalledOnce()
    expect(service.status()).toMatchObject({ phase: 'signed-in', source: 'login', revision: 1 })
    expect(service.status().connectionStage).toBeUndefined()
    expect(await service.credential()).toMatchObject({ accessToken: 'synthetic-access', projectId: 'synthetic-project' })
    const modelsRequest = vi.fn<ProxyTransport['request']>(async () => new Response(JSON.stringify({ models: {
      'gemini-3.8-flash': {}, 'synthetic-unaudited-model': {},
    } })))
    const log = { info: vi.fn(), warn: vi.fn() }
    const adapter = new AntigravityProxyAdapter({ credential: service, transport: { request: modelsRequest }, log })
    const models = await adapter.discoverModels(true)
    expect(models.some(model => model.id === 'antigravity-gemini-3.8-flash')).toBe(true)
    expect(models.some(model => model.id.includes('synthetic-unaudited-model'))).toBe(false)
    expect(modelsRequest).toHaveBeenCalledOnce()
    const modelsInput = modelsRequest.mock.calls[0]![0]
    expect(modelsInput.url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels')
    expect(modelsInput.accessToken).toBe('synthetic-access')
    expect(modelsInput.body).toBe(JSON.stringify({ project: 'synthetic-project' }))
    expect(log.info).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
    for (let index = 0; index < 3; index++) service.status()
    expect(changed).toHaveBeenCalledOnce()
    expect(JSON.stringify(service.status())).not.toMatch(/synthetic-access|synthetic-refresh|synthetic-code|code_verifier/)
    await service.dispose()
    const reloaded = new ProxyAccountService(fixture.options)
    cleanups.push(() => reloaded.dispose())
    expect(await reloaded.credential()).toMatchObject({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', projectId: 'synthetic-project' })
    expect(reloaded.status().phase).toBe('signed-in')
    expect(tokenFetch).toHaveBeenCalledOnce()
    expect(project).toHaveBeenCalledOnce()
  })

  it('无效 Host 和旧 state 不消耗流程，拒绝或缺授权码后可重新授权', async () => {
    const fixture = await isolated()
    const started = await fixture.service.login()
    expect((await sendCallback(fixture.port(), 'state=wrong&code=synthetic', 'example.invalid')).status).toBe(400)
    expect((await fixture.callback(started.authorizationUrl!, { state: 'wrong', code: 'synthetic' })).status).toBe(400)
    expect(fixture.service.status().phase).toBe('pending-login')
    expect((await fixture.callback(started.authorizationUrl!, { error: 'access_denied' })).status).toBe(400)
    expect(fixture.service.status()).toMatchObject({ phase: 'login-failed', oauth: { errorCode: 'oauth-error' } })
    expect(fixture.service.status().message).toContain('拒绝')
    const missing = await fixture.service.login()
    expect((await fixture.callback(missing.authorizationUrl!, {})).status).toBe(400)
    expect(fixture.service.status().message).toContain('缺少授权码')
    const retry = await fixture.service.login()
    expect((await fixture.callback(retry.authorizationUrl!)).status).toBe(200)
  })

  it.each(['token', 'project-missing', 'project-http', 'store'] as const)('%s 失败有具体原因且可重试，不提交半成品', async failure => {
    const fixture = await isolated()
    let failWrite = failure === 'store'
    let service = fixture.service
    if (failWrite) {
      await service.dispose()
      service = new ProxyAccountService({ ...fixture.options, store: new ProxyAccountStore({ cacheDir: fixture.cacheDir,
        writeFileImpl: async (path, data) => {
          if (failWrite) throw new Error('synthetic write failure')
          const { writeFile } = await import('node:fs/promises')
          await writeFile(path, data)
        } }) })
      cleanups.push(() => service.dispose())
    }
    if (failure === 'token') fixture.tokenFetch.mockResolvedValueOnce(new Response('{}', { status: 400 }))
    if (failure === 'project-missing') fixture.project.mockResolvedValueOnce(new Response('{}'))
    if (failure === 'project-http') fixture.project.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    const started = await service.login()
    expect((await fixture.callback(started.authorizationUrl!)).status).toBe(400)
    const snapshot = service.status()
    expect(snapshot.phase).toBe('login-failed')
    expect(snapshot.connectionStage).toBeUndefined()
    expect(snapshot.oauth?.errorCode).toBe(failure === 'token' ? 'token-exchange-failed' : failure === 'store' ? 'credential-save-failed' : 'project-detection-failed')
    expect(snapshot.message).toContain(failure === 'token' ? '授权码交换' : failure === 'store' ? '保存失败' : failure === 'project-http' ? 'HTTP 503' : '未返回可用项目')
    expect(await new ProxyAccountStore({ cacheDir: fixture.cacheDir }).load()).toBeUndefined()
    failWrite = false
    const retrying = service.login()
    expect(service.status()).toMatchObject({ phase: 'pending-login', connectionStage: 'preparing' })
    const retry = await retrying
    expect((await fixture.callback(retry.authorizationUrl!)).status).toBe(200)
    expect(service.status().phase).toBe('signed-in')
  })

  it.each(['token', 'project'] as const)('取消 %s 阶段不等待忽略 signal 的上游，当前 HTTP 响应与重试都能结束', async stage => {
    const fixture = await isolated()
    let entered!: () => void
    const entering = new Promise<void>(done => { entered = done })
    let observed: AbortSignal | undefined
    if (stage === 'token') fixture.tokenFetch.mockImplementationOnce(async (_url, init) => {
      observed = init!.signal as AbortSignal; entered(); return new Promise<Response>(() => {})
    })
    else fixture.project.mockImplementationOnce(async input => {
      observed = input.signal; entered(); return new Promise<Response>(() => {})
    })
    const started = await fixture.service.login()
    const callback = fixture.callback(started.authorizationUrl!)
    await entering
    expect(fixture.service.status()).toMatchObject({ phase: 'pending-login', connectionStage: 'finishing' })
    await fixture.service.cancelLogin()
    expect(observed?.aborted).toBe(true)
    expect((await callback).status).toBe(409)
    expect(fixture.service.status().phase).toBe('signed-out')
    const retry = await fixture.service.login()
    expect((await fixture.callback(retry.authorizationUrl!)).status).toBe(200)
  })

  it('过期会释放实际监听，随后可重试', async () => {
    const fixture = await isolated()
    await fixture.service.dispose()
    const service = new ProxyAccountService({ ...fixture.options, oauthOptions: { ...fixture.options.oauthOptions, ttlMs: 100 } })
    cleanups.push(() => service.dispose())
    await service.login()
    await vi.waitFor(() => expect(service.status()).toMatchObject({ phase: 'login-failed', oauth: { phase: 'expired' } }))
    const retry = await service.login()
    expect((await fixture.callback(retry.authorizationUrl!)).status).toBe(200)
  })

  it('已收到 HTTP 回调后的过期会中止交换并结束响应，随后可重试', async () => {
    const fixture = await isolated()
    await fixture.service.dispose()
    const service = new ProxyAccountService({ ...fixture.options, oauthOptions: { ...fixture.options.oauthOptions, ttlMs: 150 } })
    cleanups.push(() => service.dispose())
    let entered!: () => void
    const entering = new Promise<void>(done => { entered = done })
    let signal: AbortSignal | undefined
    fixture.tokenFetch.mockImplementationOnce(async (_url, init) => {
      signal = init!.signal as AbortSignal; entered(); return new Promise<Response>(() => {})
    })
    const started = await service.login()
    const response = fixture.callback(started.authorizationUrl!)
    await entering
    expect(service.status().connectionStage).toBe('finishing')
    expect((await response).status).toBe(400)
    expect(signal?.aborted).toBe(true)
    expect(service.status()).toMatchObject({ phase: 'login-failed', oauth: { phase: 'expired' } })
    const retry = await service.login()
    expect((await fixture.callback(retry.authorizationUrl!)).status).toBe(200)
  })

  it('真实端口冲突报告原因，释放占用后可重试', async () => {
    const fixture = await isolated()
    const blocker = await createProxyLoopbackListenerFactory(0).listen(async () => ({ status: 200, headers: {}, body: '' }))
    cleanups.push(async () => { await blocker.close() })
    await fixture.service.dispose()
    const conflictFactory = createProxyLoopbackListenerFactory(blocker.port)
    let port = blocker.port!
    const service = new ProxyAccountService({ ...fixture.options, oauthOptions: { listenerFactory: {
      listen: async handler => { const listener = await conflictFactory.listen(handler); port = listener.port!; return listener },
    } } })
    cleanups.push(() => service.dispose())
    await expect(service.login()).rejects.toMatchObject({ code: 'port-conflict' })
    expect(service.status().message).toContain('占用')
    await blocker.close()
    const retry = await service.login()
    const state = new URL(retry.authorizationUrl!).searchParams.get('state')!
    expect((await sendCallback(port, `state=${state}&code=synthetic`)).status).toBe(200)
  })
})
