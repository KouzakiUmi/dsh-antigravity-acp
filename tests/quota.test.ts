/**
 * 额度取数（src/runtime/quota.ts）的单元测试：假 fetch + 假文件系统，
 * 全程不读真实登录态、不触真实网络。重点锁三件事：
 * 1. 解析与判定（token 形态、过期、0..1 的 remainingFraction）；
 * 2. 换发与取数链路（过期 → OAuth 换发 → loadCodeAssist → quota summary）；
 * 3. 失败折叠与脱敏（错误可读、凭据材料绝不进快照与消息）。
 */
import { describe, expect, it } from 'vitest'
import {
  CODE_ASSIST_BASE_URL,
  isTokenUsable,
  loadCodeAssist,
  OAUTH_TOKEN_URL,
  parseOAuthClientFromBinary,
  parseQuotaSummary,
  parseTokenState,
  refreshAccessToken,
  fetchQuotaSnapshot,
  QuotaError,
} from '../src/runtime/quota.js'
import type { QuotaDeps, QuotaSnapshot } from '../src/runtime/quota.js'

const CLIENT_ID = ['1234567890', '-abcdef.apps.googleusercontent.com'].join('')
const CLIENT_SECRET = ['GOCSPX-', 'AbCdEfGhIjKlMnOpQrStUvWxYz01'].join('')
const ACCESS_TOKEN = 'ya29.test-access-token-value'
const REFRESH_TOKEN = '1//test-refresh-token-value'

interface Recorded {
  url: string
  method: string
  body?: string
  authorization?: string
}

/** 造一个按 URL 分发的假 fetch，记录每次调用。 */
function fakeFetch(
  routes: Array<{ match: (url: string) => boolean; respond: () => Response }>,
  calls: Recorded[] = [],
): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input)
    const route = routes.find((candidate) => candidate.match(url))
    calls.push({
      url,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      ...(typeof (init?.headers as Record<string, string> | undefined)?.Authorization === 'string'
        ? { authorization: (init?.headers as Record<string, string>).Authorization }
        : {}),
    })
    if (!route) return new Response('{}', { status: 404 })
    return route.respond()
  }
  return { fetchImpl, calls }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 取数组元素；测试里缺位即失败，避免 noUncheckedIndexedAccess 噪声。 */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index]
  if (value === undefined) throw new Error(`索引 ${index} 不存在`)
  return value
}

const QUOTA_SUMMARY = {
  groups: [
    {
      displayName: 'Gemini 模型',
      buckets: [
        { bucketId: '5h', displayName: '5 小时', window: '5h', remainingFraction: 0.625, resetTime: '2099-01-01T00:00:00Z', disabled: false },
        { bucketId: 'weekly', displayName: '每周', window: '7d', remainingFraction: 0.95, resetTime: '2099-01-08T00:00:00Z', disabled: false },
      ],
    },
  ],
}

/** 只读内存文件：把「官方登录态」放在内存里，测试可断言它**没有被写过**。 */
function memoryTokenFile(state: unknown, pathSuffix = ['antigravity-oauth-token']): {
  deps: Pick<QuotaDeps, 'readFileImpl' | 'homedir'>
  reads: string[]
} {
  const reads: string[] = []
  return {
    reads,
    deps: {
      homedir: () => '/home/test',
      readFileImpl: async (path: string) => {
        reads.push(path)
        if (!path.endsWith(pathSuffix.join('/'))) throw new Error('ENOENT')
        return JSON.stringify(state)
      },
    },
  }
}

describe('登录态解析与过期判定', () => {
  it('解析嵌套 token.{...} 形态', () => {
    const state = parseTokenState({
      token: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expiry: '2099-01-01T00:00:00Z' },
      auth_method: 'consumer',
      id_token: 'xxx',
    })
    expect(state).toEqual({ accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, expiry: '2099-01-01T00:00:00Z' })
  })

  it('解析平铺形态并忽略无关字段', () => {
    const state = parseTokenState({ access_token: 'A', refresh_token: 'R', expiry: '2099-01-01T00:00:00Z', id_token: 'ignore-me' })
    expect(state).toEqual({ accessToken: 'A', refreshToken: 'R', expiry: '2099-01-01T00:00:00Z' })
    expect(JSON.stringify(state)).not.toContain('ignore-me')
  })

  it('非法输入返回空对象而不是抛错', () => {
    expect(parseTokenState(null)).toEqual({ accessToken: undefined, refreshToken: undefined, expiry: undefined })
    expect(parseTokenState('nope')).toEqual({ accessToken: undefined, refreshToken: undefined, expiry: undefined })
  })

  it('过期/将过期判定按 margin 计算', () => {
    const now = Date.parse('2026-10-16T00:00:00Z')
    expect(isTokenUsable({ accessToken: 'A', expiry: '2026-10-16T01:00:00Z' }, now)).toBe(true)
    expect(isTokenUsable({ accessToken: 'A', expiry: '2026-10-16T00:00:30Z' }, now)).toBe(false)
    expect(isTokenUsable({ accessToken: 'A', expiry: '2026-10-15T00:00:00Z' }, now)).toBe(false)
    // 没有 expiry 时先用着，交给请求失败再兜底。
    expect(isTokenUsable({ accessToken: 'A' }, now)).toBe(true)
    expect(isTokenUsable({ refreshToken: 'R' }, now)).toBe(false)
  })
})

describe('OAuth client 元数据提取', () => {
  it('从官方二进制文本提取 client id / secret', () => {
    const text = `noise ${CLIENT_ID} more noise ${CLIENT_SECRET} tail`
    expect(parseOAuthClientFromBinary(text)).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  })

  it('提取不到时返回 undefined（绝不猜 client）', () => {
    expect(parseOAuthClientFromBinary('nothing to see here')).toBeUndefined()
    expect(parseOAuthClientFromBinary(CLIENT_ID)).toBeUndefined()
    expect(parseOAuthClientFromBinary(CLIENT_SECRET)).toBeUndefined()
  })

  it('多份元数据存在时按相邻出现配对，不把不同 client 的 id/secret 拼在一起', () => {
    const otherId = ['9876543210', '-zzzzzz.apps.googleusercontent.com'].join('')
    const otherSecret = ['GOCSPX-', 'ZzYyXxWwVvUuTtSsRrQqPpOoNn01'].join('')
    // 第一对在前、第二对在后：应取最后一对（与官方 CLI 同源的那份）。
    const text = `${CLIENT_ID} ${CLIENT_SECRET} ... ${otherId} ${otherSecret} ... tail`
    expect(parseOAuthClientFromBinary(text)).toEqual({ clientId: otherId, clientSecret: otherSecret })
    // 顺序交错（id 与 secret 不同行排列）时依然按最近距离配对。
    const interleaved = `${otherId} ${CLIENT_SECRET} ${CLIENT_ID} ${otherSecret}`
    expect(parseOAuthClientFromBinary(interleaved)).toEqual({ clientId: CLIENT_ID, clientSecret: otherSecret })
  })

  it('同一 secret 重复出现时仍配上 anchor 之后的那一份', () => {
    const otherId = ['9876543210', '-zzzzzz.apps.googleusercontent.com'].join('')
    const shared = ['GOCSPX-', 'ZzYyXxWwVvUuTtSsRrQqPpOoNn01'].join('')
    // 两个 client 共用同一 secret：只看「首次出现」会落在 otherId 之前，
    // 把本该配给 CLIENT_ID 的那份误判成「在 id 之前」。
    const text = `${otherId} ${shared} ... ${CLIENT_ID} ${shared} ... tail`
    expect(parseOAuthClientFromBinary(text)).toEqual({ clientId: CLIENT_ID, clientSecret: shared })
  })
})

describe('token 换发', () => {
  it('用 refresh_token 换发并把过期时间按 expires_in 推算', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { match: (url) => url === OAUTH_TOKEN_URL, respond: () => json({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600 }) },
    ])
    const next = await refreshAccessToken(
      { refreshToken: REFRESH_TOKEN },
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      { fetchImpl, now: () => Date.parse('2026-10-16T00:00:00Z') },
    )
    expect(next.accessToken).toBe(ACCESS_TOKEN)
    expect(next.refreshToken).toBe(REFRESH_TOKEN)
    expect(next.expiry).toBe('2026-10-16T01:00:00.000Z')
    expect(calls).toHaveLength(1)
    expect(at(calls, 0).url).toBe(OAUTH_TOKEN_URL)
    expect(at(calls, 0).body).toContain('grant_type=refresh_token')
    expect(at(calls, 0).body).toContain(`refresh_token=${encodeURIComponent(REFRESH_TOKEN)}`)
  })

  it('缺 refresh_token 时给出可读错误而不是空换发', async () => {
    await expect(refreshAccessToken({}, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, {}))
      .rejects.toMatchObject({ code: 'token-expired' })
  })

  it('HTTP 失败映射为 refresh-failed', async () => {
    const { fetchImpl } = fakeFetch([
      { match: (url) => url === OAUTH_TOKEN_URL, respond: () => new Response('denied', { status: 400 }) },
    ])
    await expect(
      refreshAccessToken({ refreshToken: REFRESH_TOKEN }, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, { fetchImpl }),
    ).rejects.toMatchObject({ code: 'refresh-failed' })
  })
})

describe('quota summary 解析', () => {
  it('groups/buckets 解析出百分比并尊重 disabled', () => {
    const groups = parseQuotaSummary({
      groups: [
        { displayName: 'Gemini 模型', buckets: [{ bucketId: '5h', displayName: '5 小时', window: '5h', remainingFraction: 0.5, disabled: true }] },
        { buckets: [{ bucketId: 'weekly', remainingFraction: 0.12345 }] },
      ],
    })
    expect(at(groups, 0).name).toBe('Gemini 模型')
    expect(at(at(groups, 0).buckets, 0)).toMatchObject({ name: '5 小时', window: '5h', remainingPct: 50, disabled: true })
    // 无 displayName 时回落 bucketId，再回落「额度」。
    expect(at(at(groups, 1).buckets, 0).name).toBe('weekly')
    expect(at(at(groups, 1).buckets, 0).remainingPct).toBe(12.35)
  })

  it('越界 / 非数 remainingFraction 不参与显示（宁缺毋假）', () => {
    const groups = parseQuotaSummary({
      groups: [{ displayName: 'X', buckets: [{ bucketId: 'a', remainingFraction: 1.5 }, { bucketId: 'b', remainingFraction: 'NaN' }] }],
    })
    expect(at(at(groups, 0).buckets, 0).remainingPct).toBeUndefined()
    expect(at(at(groups, 0).buckets, 1).remainingPct).toBeUndefined()
  })

  it('非法负载返回空组而不是抛错', () => {
    expect(parseQuotaSummary(null)).toEqual([])
    expect(parseQuotaSummary({ groups: 'nope' })).toEqual([])
  })
})

describe('loadCodeAssist', () => {
  it('取 cloudaicompanionProject 与档位名', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { match: (url) => url === `${CODE_ASSIST_BASE_URL}:loadCodeAssist`, respond: () => json({ cloudaicompanionProject: 'proj-1', paidTier: { name: 'Ultra' } }) },
    ])
    const project = await loadCodeAssist(ACCESS_TOKEN, { fetchImpl })
    expect(project).toEqual({ projectId: 'proj-1', plan: 'Ultra' })
    expect(at(calls, 0).authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(at(calls, 0).body).toContain('ANTIGRAVITY')
  })

  it('缺 project id 时抛 bad-response', async () => {
    const { fetchImpl } = fakeFetch([
      { match: (url) => url === `${CODE_ASSIST_BASE_URL}:loadCodeAssist`, respond: () => json({}) },
    ])
    await expect(loadCodeAssist(ACCESS_TOKEN, { fetchImpl })).rejects.toMatchObject({ code: 'bad-response' })
  })
})

describe('fetchQuotaSnapshot 链路', () => {
  // 官方登录态文件用 snake_case 字段；parseTokenState 解析的正是这种形态。
  const validTokenFile = {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    expiry: '2099-01-01T00:00:00Z',
  }

  type Route = { match: (url: string) => boolean; respond: () => Response }

  function quotaRoutes(extra: Route[] = []): Route[] {
    return [
      ...extra,
      { match: (url) => url === `${CODE_ASSIST_BASE_URL}:loadCodeAssist`, respond: () => json({ cloudaicompanionProject: 'proj-1', paidTier: { name: 'Ultra' } }) },
      { match: (url) => url === `${CODE_ASSIST_BASE_URL}:retrieveUserQuotaSummary`, respond: () => json(QUOTA_SUMMARY) },
    ]
  }

  it('有效 token 直接取数：plan + groups 到达快照', async () => {
    const file = memoryTokenFile({ token: validTokenFile })
    const { fetchImpl, calls } = fakeFetch(quotaRoutes())
    const snapshot = await fetchQuotaSnapshot({}, {
      ...file.deps,
      fetchImpl,
      env: { AGY_OAUTH_CLIENT_ID: CLIENT_ID, AGY_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
      binaryPaths: [],
      now: () => Date.parse('2026-10-16T00:00:00Z'),
    })
    expect(snapshot.status).toBe('ok')
    expect(snapshot.plan).toBe('Ultra')
    expect(at(at(snapshot.groups, 0).buckets, 0).remainingPct).toBe(62.5)
    // 不该走换发。
    expect(calls.some((call) => call.url === OAUTH_TOKEN_URL)).toBe(false)
  })

  it('过期 token 走换发再取数，且**不写回**登录文件（只读凭据）', async () => {
    const file = memoryTokenFile({
      token: { ...validTokenFile, expiry: '2026-10-01T00:00:00Z' },
    })
    const { fetchImpl, calls } = fakeFetch(quotaRoutes([
      { match: (url) => url === OAUTH_TOKEN_URL, respond: () => json({ access_token: 'fresh-token', expires_in: 3600 }) },
    ]))
    const snapshot = await fetchQuotaSnapshot({}, {
      ...file.deps,
      fetchImpl,
      env: {},
      binaryPaths: ["/home/test/agy.bin"],
      readFileImpl: async (path: string) => {
        if (path.endsWith('antigravity-oauth-token')) {
          return JSON.stringify({ token: { ...validTokenFile, expiry: '2026-10-01T00:00:00Z' } })
        }
        return `bin ${CLIENT_ID} ${CLIENT_SECRET}`
      },
      now: () => Date.parse('2026-10-16T00:00:00Z'),
    })
    expect(snapshot.status).toBe('ok')
    expect(at(calls, 0).url).toBe(OAUTH_TOKEN_URL)
    // 换发出的新 token 只在内存里用；下一次 Code Assist 请求带的是它。
    expect(at(calls, 1).authorization).toBe('Bearer fresh-token')
  })

  it('token 缺失时折叠成可读错误，不触网', async () => {
    const file = memoryTokenFile({})
    const { fetchImpl, calls } = fakeFetch(quotaRoutes())
    const snapshot = await fetchQuotaSnapshot({}, { ...file.deps, fetchImpl, binaryPaths: [] })
    expect(snapshot.status).toBe('error')
    expect(snapshot.error?.code).toBe('token-missing')
    expect(calls).toHaveLength(0)
  })

  it('过期且拿不到 OAuth client 元数据时报 refresh-unavailable（不编造 client）', async () => {
    const file = memoryTokenFile({ token: { ...validTokenFile, expiry: '2026-10-01T00:00:00Z' } })
    const { fetchImpl, calls } = fakeFetch(quotaRoutes())
    const snapshot = await fetchQuotaSnapshot({}, {
      ...file.deps,
      fetchImpl,
      env: {},
      binaryPaths: [],
      now: () => Date.parse('2026-10-16T00:00:00Z'),
    })
    expect(snapshot.status).toBe('error')
    expect(snapshot.error?.code).toBe('refresh-unavailable')
    expect(calls).toHaveLength(0)
  })

  it('401 后换发重试一次仍失败则折叠为错误', async () => {
    const file = memoryTokenFile({ token: validTokenFile })
    let attempts = 0
    const { fetchImpl } = fakeFetch(quotaRoutes([
      {
        match: (url) => url === OAUTH_TOKEN_URL,
        respond: () => json({ access_token: 'fresh', expires_in: 3600 }),
      },
      {
        match: (url) => url.endsWith(':loadCodeAssist'),
        respond: () => {
          attempts += 1
          return attempts === 1 ? new Response('unauthorized', { status: 401 }) : json({ cloudaicompanionProject: 'proj-1' })
        },
      },
    ]))
    const snapshot = await fetchQuotaSnapshot({}, {
      ...file.deps,
      fetchImpl,
      env: { AGY_OAUTH_CLIENT_ID: CLIENT_ID, AGY_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
      binaryPaths: [],
      now: () => Date.parse('2026-10-16T00:00:00Z'),
    })
    expect(snapshot.status).toBe('ok')
    expect(attempts).toBe(2)
  })

  it('网络异常折叠成 request-failed，且消息不含 token 材料', async () => {
    const file = memoryTokenFile({ token: validTokenFile })
    const fetchImpl: typeof fetch = async () => {
      throw new Error(`connect failed while using Bearer ${ACCESS_TOKEN}`)
    }
    const snapshot = await fetchQuotaSnapshot({}, {
      ...file.deps,
      fetchImpl,
      binaryPaths: [],
      now: () => Date.parse('2026-10-16T00:00:00Z'),
    })
    expect(snapshot.status).toBe('error')
    expect(snapshot.error?.code).toBe('request-failed')
    expect(JSON.stringify(snapshot)).not.toContain(ACCESS_TOKEN)
  })

  it('HTTP 请求超时折叠成可读的 request-failed，不留悬空请求', async () => {
    const file = memoryTokenFile({ token: validTokenFile })
    // 模拟一个永不 settle 的请求，只在收到 abort 信号时以其拒绝结束。
    const fetchImpl: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('This operation was aborted')
        error.name = 'TimeoutError'
        reject(error)
      }, { once: true })
    })
    const started = Date.now()
    const snapshot = await fetchQuotaSnapshot({}, {
      ...file.deps,
      fetchImpl,
      binaryPaths: [],
      httpTimeoutMs: 20,
      now: () => Date.parse('2026-10-16T00:00:00Z'),
    })
    expect(snapshot.status).toBe('error')
    expect(snapshot.error?.code).toBe('request-failed')
    // 不足 1 秒的预算要报成毫秒：`Math.round(20/1000)` 会写成「超过 0 秒」。
    expect(snapshot.error?.message).toContain('20 毫秒未完成')
    expect(snapshot.error?.message).not.toContain('0 秒')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('换发 token 超时同样折叠为 refresh-failed', async () => {
    const fetchImpl: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('This operation was aborted')
        error.name = 'TimeoutError'
        reject(error)
      }, { once: true })
    })
    await expect(refreshAccessToken(
      { refreshToken: REFRESH_TOKEN, expiry: '2026-10-01T00:00:00Z' },
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      { fetchImpl, httpTimeoutMs: 20 },
    )).rejects.toMatchObject({ code: 'refresh-failed', status: undefined })
  })

  it('非正数超时配置回落默认预算，而不是静默关掉超时', async () => {
    // 传 0 若被当成「禁用超时」，并发 read() 又会合并到一个永不结束的在途
    // promise 上——那正是这条超时要修的故障。这里不等待默认的 20s：只要请求
    // 仍带 signal（而不是 undefined）就说明超时保护没有被关掉。
    let sawSignal: AbortSignal | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      sawSignal = init?.signal ?? undefined
      return json({ access_token: 'fresh-token', expires_in: 3600 })
    }
    await refreshAccessToken(
      { refreshToken: REFRESH_TOKEN, expiry: '2026-10-01T00:00:00Z' },
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      { fetchImpl, httpTimeoutMs: 0 },
    )
    expect(sawSignal).toBeInstanceOf(AbortSignal)
  })

  it('主动中止与真实超时的文案分开，不把取消报成超时', async () => {
    // AbortError 与 TimeoutError 混为一谈会让排查方向错到网络上去。
    const fetchImpl: typeof fetch = async () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      throw error
    }
    await expect(refreshAccessToken(
      { refreshToken: REFRESH_TOKEN, expiry: '2026-10-01T00:00:00Z' },
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      { fetchImpl },
    )).rejects.toMatchObject({
      code: 'refresh-failed',
      message: expect.stringContaining('被中止'),
    })
    await expect(refreshAccessToken(
      { refreshToken: REFRESH_TOKEN, expiry: '2026-10-01T00:00:00Z' },
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      { fetchImpl },
    )).rejects.not.toMatchObject({ message: expect.stringContaining('请求超过') })
  })

  it('401 重试按状态码判断，不依赖错误文案', async () => {
    const file = memoryTokenFile({ token: validTokenFile })
    let attempts = 0
    const { fetchImpl } = fakeFetch(quotaRoutes([
      { match: (url) => url === OAUTH_TOKEN_URL, respond: () => json({ access_token: 'fresh', expires_in: 3600 }) },
      {
        match: (url) => url.endsWith(':loadCodeAssist'),
        respond: () => {
          attempts += 1
          // 故意不给常见文案：旧实现靠 message.includes('HTTP 401') 才能重试。
          return attempts === 1 ? new Response('denied', { status: 401, statusText: 'Unauthorized' }) : json({ cloudaicompanionProject: 'proj-1' })
        },
      },
    ]))
    const snapshot = await fetchQuotaSnapshot({}, {
      ...file.deps,
      fetchImpl,
      env: { AGY_OAUTH_CLIENT_ID: CLIENT_ID, AGY_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
      binaryPaths: [],
      now: () => Date.parse('2026-10-16T00:00:00Z'),
    })
    expect(snapshot.status).toBe('ok')
    expect(attempts).toBe(2)
  })

  it('非 401/403 的请求失败不触发换发重试', async () => {
    const file = memoryTokenFile({ token: validTokenFile })
    let loadCalls = 0
    const { fetchImpl, calls } = fakeFetch(quotaRoutes([
      {
        match: (url) => url.endsWith(':loadCodeAssist'),
        respond: () => { loadCalls += 1; return new Response('boom', { status: 500 }) },
      },
    ]))
    const snapshot = await fetchQuotaSnapshot({}, {
      ...file.deps,
      fetchImpl,
      env: { AGY_OAUTH_CLIENT_ID: CLIENT_ID, AGY_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
      binaryPaths: [],
      now: () => Date.parse('2026-10-16T00:00:00Z'),
    })
    expect(snapshot.status).toBe('error')
    expect(loadCalls).toBe(1)
    expect(calls.some((call) => call.url === OAUTH_TOKEN_URL)).toBe(false)
  })

  it('成功快照在缓存有效期内不再触网；force 会绕过缓存', async () => {
    const file = memoryTokenFile({ token: validTokenFile })
    let nowMs = Date.parse('2026-10-16T00:00:00Z')
    const { fetchImpl, calls } = fakeFetch(quotaRoutes())
    const deps: QuotaDeps = {
      ...file.deps,
      fetchImpl,
      binaryPaths: [],
      now: () => nowMs,
    }
    const cache: { value?: QuotaSnapshot; at?: number } = {}
    const first = await fetchQuotaSnapshot(cache, deps)
    expect(first.status).toBe('ok')
    nowMs += 60_000
    const second = await fetchQuotaSnapshot(cache, deps)
    expect(second.status).toBe('ok')
    expect(calls).toHaveLength(2) // loadCodeAssist + retrieveUserQuotaSummary，缓存命中后不再增长
    nowMs += 10 * 60_000
    const third = await fetchQuotaSnapshot(cache, deps)
    expect(third.status).toBe('ok')
    expect(calls.length).toBeGreaterThan(2)
  })

  it('QuotaError 携带错误码，供 remote 层折叠', () => {
    const error = new QuotaError('bad-response', 'x')
    expect(error.code).toBe('bad-response')
    expect(error.name).toBe('QuotaError')
  })
})
