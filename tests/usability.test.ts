/**
 * 可用性回归（全插件审查第二批）：代理 fetch、下载超时/取消、凭据换发回退与原子写、
 * 额度失败保留旧值、预中止的请求、客户端版本号。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import { AgentLink, AGY_CLIENT_INFO, AGY_LINK_ERROR } from '../src/protocol/agent-link.js'
import { downloadBinary } from '../src/runtime/binary.js'
import { ensureAcpCredentials } from '../src/runtime/credentials.js'
import { createProxiedFetch, matchesBypass } from '../src/runtime/proxied-fetch.js'
import type { UndiciLike } from '../src/runtime/proxied-fetch.js'
import { AgYQuotaService, AGY_QUOTA_SERVICE } from '../src/quota/quota-remote.js'
import type { CliRun } from '../src/runtime/agy-cli.js'
import type { QuotaTokenState } from '../src/runtime/quota.js'

describe('createProxiedFetch', () => {
  const proxy = { url: 'http://127.0.0.1:7890', bypass: 'localhost,127.0.0.1,::1' }

  function fakeUndici(): { undici: UndiciLike; calls: Array<{ url: string; dispatcher: unknown }>; agents: string[] } {
    const calls: Array<{ url: string; dispatcher: unknown }> = []
    const agents: string[] = []
    class ProxyAgent {
      constructor(options: { uri: string }) {
        agents.push(options.uri)
      }
    }
    return {
      calls,
      agents,
      undici: {
        ProxyAgent: ProxyAgent as unknown as UndiciLike['ProxyAgent'],
        fetch: async (url, init) => {
          calls.push({ url, dispatcher: init?.dispatcher })
          return new Response('via-proxy')
        },
      },
    }
  }

  it('配置了 http 代理：经 undici ProxyAgent 发出，且 agent 只建一次', async () => {
    const fake = fakeUndici()
    const direct: string[] = []
    const doFetch = createProxiedFetch(proxy, {
      loadUndici: async () => fake.undici,
      fallback: async (input) => { direct.push(String(input)); return new Response('direct') },
    })
    expect(await (await doFetch('https://oauth2.googleapis.com/token')).text()).toBe('via-proxy')
    await doFetch('https://dl.google.com/x')
    expect(fake.agents).toEqual(['http://127.0.0.1:7890'])
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[0]!.dispatcher).toBeDefined()
    expect(direct).toEqual([])
  })

  it('未配置代理、socks 代理、命中排除列表、undici 加载失败：都回退到直连 fetch', async () => {
    const direct: string[] = []
    const fallback = async (input: string | URL | Request): Promise<Response> => { direct.push(String(input)); return new Response('direct') }
    const fake = fakeUndici()
    await createProxiedFetch(undefined, { fallback })('https://a.test/')
    await createProxiedFetch({ url: 'socks5://127.0.0.1:1080', bypass: '' }, { loadUndici: async () => fake.undici, fallback })('https://b.test/')
    await createProxiedFetch(proxy, { loadUndici: async () => fake.undici, fallback })('http://127.0.0.1:9/mcp')
    await createProxiedFetch(proxy, { loadUndici: async () => undefined, fallback })('https://c.test/')
    expect(direct).toEqual(['https://a.test/', 'https://b.test/', 'http://127.0.0.1:9/mcp', 'https://c.test/'])
    expect(fake.calls).toEqual([])
  })

  it('排除列表匹配：精确主机与通配后缀', () => {
    expect(matchesBypass('localhost', 'localhost,127.0.0.1')).toBe(true)
    expect(matchesBypass('a.internal', '*.internal')).toBe(true)
    expect(matchesBypass('a.internal', '.internal')).toBe(true)
    expect(matchesBypass('example.com', '*.internal,localhost')).toBe(false)
  })
})

describe('downloadBinary 超时与取消', () => {
  const hang = (_url: string, init: { signal?: AbortSignal }): Promise<never> =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })

  it('网络挂住时按超时中止，而不是永远等待', async () => {
    await expect(downloadBinary('https://dl.google.com/x.zip', { fetchImpl: hang, timeoutMs: 30 })).rejects.toBeDefined()
  })

  it('调用方 signal（插件卸载）可立即取消下载', async () => {
    const controller = new AbortController()
    const pending = downloadBinary('https://dl.google.com/x.zip', { fetchImpl: hang, signal: controller.signal, timeoutMs: 60_000 })
    controller.abort(new Error('插件已卸载'))
    await expect(pending).rejects.toThrow('插件已卸载')
  })
})

const HOME = '/home/tester'
const ACP_DIR = join(HOME, '.gemini', 'antigravity-acp')
const TOKEN_PATH = join(ACP_DIR, 'acp_token.json')
const CLI_TOKEN_PATH = join(HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
const CLIENT = { clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-x' }
const STALE_DOC = JSON.stringify({
  client_id: CLIENT.clientId,
  client_secret: CLIENT.clientSecret,
  refresh_token: 'revoked-token',
  token_uri: 'https://oauth2.googleapis.com/token',
  scopes: [],
  token: 'old',
  expiry: '2020-01-01T00:00:00.000Z',
})

describe('ensureAcpCredentials 换发回退', () => {
  function setup() {
    const files = new Map<string, string>([
      [TOKEN_PATH, STALE_DOC],
      [CLI_TOKEN_PATH, JSON.stringify({ token: { refresh_token: 'fresh-cli-token' } })],
    ])
    const tried: string[] = []
    return {
      files,
      tried,
      deps: {
        homedir: () => HOME,
        env: {},
        readFileImpl: async (path: string) => {
          const value = files.get(path)
          if (value === undefined) throw new Error('ENOENT')
          return value
        },
        writeFileImpl: async (path: string, data: string) => { files.set(path, data) },
        mkdirImpl: async () => undefined,
        resolveClient: async () => CLIENT,
        now: () => Date.parse('2026-10-20T00:00:00.000Z'),
      },
    }
  }

  it('acp_token.json 里的 refresh_token 被撤销时，回退用 CLI 当前登录态换发', async () => {
    const { files, tried, deps } = setup()
    const result = await ensureAcpCredentials({
      ...deps,
      refresh: async (state: QuotaTokenState) => {
        tried.push(state.refreshToken ?? '')
        if (state.refreshToken === 'revoked-token') throw new Error('invalid_grant')
        return { accessToken: 'new-access', refreshToken: state.refreshToken, expiry: '2099-01-01T00:00:00.000Z' }
      },
    })
    expect(tried).toEqual(['revoked-token', 'fresh-cli-token'])
    expect(result).toMatchObject({ ready: true, status: 'imported' })
    expect(JSON.parse(files.get(TOKEN_PATH)!)).toMatchObject({ refresh_token: 'fresh-cli-token', token: 'new-access' })
  })

  it('两条都失败时仍按既有降级走（磁盘上有可用凭据就算 ready）', async () => {
    const { deps } = setup()
    const result = await ensureAcpCredentials({ ...deps, refresh: async () => { throw new Error('invalid_grant') } })
    expect(result.ready).toBe(true)
    expect(result.status).toBe('existing')
    expect(result.note).toMatch(/换发 access token 失败/)
  })
})

describe('额度失败保留旧值', () => {
  const USAGE = JSON.stringify({
    command: { data: { groups: [{ name: 'Gemini', buckets: [{ name: '5h', window: '5h', remaining_fraction: 0.62 }] }] } },
  })

  it('先成功后失败：返回上次数据并标记 stale，且下次调用立刻重试而不是被缓存挡住', async () => {
    let call = 0
    const run: CliRun = async () => {
      call += 1
      if (call === 1) return { exitCode: 0, stdout: USAGE, stderr: '' }
      if (call === 2) return { exitCode: 1, stdout: '', stderr: 'network down' }
      return { exitCode: 0, stdout: USAGE, stderr: '' }
    }
    const ctx = new Context()
    ctx.plugin(AgYQuotaService, { cli: { run, cliPath: '/fake/agy' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const service = (ctx as unknown as Record<string, { read(r?: { force?: boolean }): Promise<{ status: string; stale?: boolean; staleReason?: string; groups: unknown[] }> }>)[AGY_QUOTA_SERVICE]!
    expect((await service.read({ force: true })).stale).toBeUndefined()
    const failed = await service.read({ force: true })
    expect(failed).toMatchObject({ status: 'ok', stale: true })
    expect(failed.staleReason).toMatch(/network down|退出码/)
    expect(failed.groups).toHaveLength(1)
    const recovered = await service.read()
    expect(call).toBe(3)
    expect(recovered.stale).toBeUndefined()
  })

  it('HTTP 回退路径同样保留上次成功数据：刷新失败不退化为「额度读取失败」', async () => {
    let healthy = true
    const SUMMARY = { groups: [{ displayName: 'Gemini 模型', buckets: [{ bucketId: '5h', displayName: '5 小时', window: '5h', remainingFraction: 0.625 }] }] }
    const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith(':loadCodeAssist')) {
        if (!healthy) return new Response('internal error', { status: 500 })
        return json({ cloudaicompanionProject: 'proj-1' })
      }
      if (url.endsWith(':retrieveUserQuotaSummary')) return json(SUMMARY)
      return new Response('{}', { status: 404 })
    }
    const deps = {
      homedir: () => HOME,
      // 只提供 CLI 登录态（token 新鲜，不需要换发）；其余路径一律 ENOENT，
      // 不触碰真实文件（包括本机真实存在的 agy.exe）。
      readFileImpl: async (path: string) => {
        if (path.endsWith('antigravity-oauth-token')) {
          return JSON.stringify({ token: { access_token: 'A', expiry: '2099-01-01T00:00:00Z' } })
        }
        throw new Error('ENOENT')
      },
      fetchImpl,
      baseUrl: 'https://fake.example/v1internal',
    }
    const ctx = new Context()
    ctx.plugin(AgYQuotaService, { deps })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const service = (ctx as unknown as Record<string, { read(r?: { force?: boolean }): Promise<{ status: string; stale?: boolean; staleReason?: string; groups: unknown[] }> }>)[AGY_QUOTA_SERVICE]!
    const first = await service.read({ force: true })
    expect(first).toMatchObject({ status: 'ok' })
    expect(first.groups).toHaveLength(1)
    healthy = false
    const failed = await service.read({ force: true })
    // 与 CLI 主路径同一条 stale 保留语义：显示旧数据 + stale 标记，而不是整页报错。
    expect(failed).toMatchObject({ status: 'ok', stale: true })
    expect(failed.staleReason).toMatch(/HTTP 500|失败/)
    expect(failed.groups).toHaveLength(1)
  })

  it('force 刷新不并入「命中缓存」的在途读取：同一 tick 的刷新必须真正重新取数', async () => {
    let call = 0
    const run: CliRun = async () => {
      call += 1
      return { exitCode: 0, stdout: USAGE, stderr: '' }
    }
    const ctx = new Context()
    ctx.plugin(AgYQuotaService, { cli: { run, cliPath: '/fake/agy' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const service = (ctx as unknown as Record<string, { read(r?: { force?: boolean }): Promise<{ status: string; groups: unknown[] }> }>)[AGY_QUOTA_SERVICE]!
    await service.read()
    const before = call
    // 同一同步段内：非 force 读取命中缓存（在途、即时返回），force 紧随其后到达。
    const cached = service.read()
    const forced = service.read({ force: true })
    const [a, b] = await Promise.all([cached, forced])
    expect(a.groups).toHaveLength(1)
    expect(b.groups).toHaveLength(1)
    // force 必须触发一次真实的 CLI 取数，而不是拿缓存在途读取的结果直接返回。
    expect(call).toBe(before + 1)
  })
})

describe('AgentLink 细节', () => {
  it('signal 已中止时不发出请求', async () => {
    const written: AnyMessage[] = []
    const stream: Stream = {
      readable: new ReadableStream<AnyMessage>(),
      writable: new WritableStream<AnyMessage>({ write: (message) => { written.push(message) } }),
    }
    const link = new AgentLink({ stream })
    const controller = new AbortController()
    controller.abort(new Error('用户取消'))
    await expect(link.request('session/prompt', {}, { signal: controller.signal })).rejects.toMatchObject({
      code: AGY_LINK_ERROR.REQUEST_TIMEOUT,
    })
    expect(written).toEqual([])
  })

  it('clientInfo 版本取自 package.json，而不是硬编码的 0.1.0', async () => {
    const { readFileSync } = await import('node:fs')
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(AGY_CLIENT_INFO.version).toBe(pkg.version)
  })
})
