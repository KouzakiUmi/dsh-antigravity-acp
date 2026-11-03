/**
 * 代理模式（proxy router）的单元测试：线身份、传输分帧、OAuth 回调、
 * 账户存储、payload 映射与额度源。全部用注入替身，不碰真实网络与凭据。
 */
import { describe, expect, it, vi } from 'vitest'
import { buildProxyHeaderPairs, serializeProxyRequest, assertProxyEndpoint, AGY_PROXY_USER_AGENT, WireIdentityError } from '../src/proxy/wire-identity.js'
import { proxyStatusError, ProxyTransportError, createProxyTransport } from '../src/proxy/transport.js'
import { createProxyOAuthFlow } from '../src/proxy/oauth.js'
import { ProxyAccountStore, importCliCredential, parseProxyCredential, isProxyCredentialUsable, proxyAccountPath } from '../src/proxy/account-store.js'
import { buildProxyGeneratePayload, createProxySessionStore, parseProxyProviderEvent } from '../src/proxy/payload.js'
import { readProxyImage, requiredProxyImageOffload } from '../src/proxy/image.js'
import { createProxyReplayState, compatibleProxyReplayState, PROXY_PROVIDER_ID } from '../src/proxy/replay.js'
import { registrationPlan, modeFromFlag, createProxyModeBus } from '../src/proxy/mode-bus.js'
import { fetchProxyQuotaSnapshot } from '../src/proxy/quota-source.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { createDeveloperMessage, createSystemMessage, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'

const STREAM_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'
const QUOTA_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'

describe('wire identity：agy 线伪装', () => {
  it('streamGenerateContent 用 chunked，其余用 Content-Length，且头顺序固定', () => {
    const streamPairs = buildProxyHeaderPairs(STREAM_URL, { authorization: 'Bearer tok', body: '{}' })
    expect(streamPairs.map(([name]) => name)).toEqual(['Host', 'User-Agent', 'Transfer-Encoding', 'Authorization', 'Content-Type', 'Accept-Encoding'])
    expect(streamPairs.find(([name]) => name === 'User-Agent')?.[1]).toBe(AGY_PROXY_USER_AGENT)
    const plainPairs = buildProxyHeaderPairs(QUOTA_URL, { authorization: 'Bearer tok', body: '{"project":"p"}' })
    expect(plainPairs.map(([name]) => name)).toEqual(['Host', 'User-Agent', 'Content-Length', 'Authorization', 'Content-Type', 'Accept-Encoding'])
    expect(plainPairs.find(([name]) => name === 'Content-Length')?.[1]).toBe('15')
  })

  it('序列化产出字面 HTTP/1.1 请求字节（chunked 单帧 + 终止帧）', () => {
    const bytes = serializeProxyRequest(STREAM_URL, { authorization: 'Bearer tok', body: '{"a":1}' })
    const text = Buffer.from(bytes).toString('latin1')
    expect(text.startsWith('POST /v1internal:streamGenerateContent?alt=sse HTTP/1.1\r\n')).toBe(true)
    expect(text).toContain('Transfer-Encoding: chunked')
    expect(text.endsWith('7\r\n{"a":1}\r\n0\r\n\r\n')).toBe(true)
  })

  it('白名单外端点、非法授权值与 fragment 都被拒绝', () => {
    expect(() => assertProxyEndpoint('https://example.com/v1internal:streamGenerateContent')).toThrow(WireIdentityError)
    expect(() => assertProxyEndpoint('https://daily-cloudcode-pa.googleapis.com/v1internal:other')).toThrow(WireIdentityError)
    expect(() => assertProxyEndpoint(`${STREAM_URL}#x`)).toThrow(WireIdentityError)
    expect(() => buildProxyHeaderPairs(QUOTA_URL, { authorization: 'Bearer ', body: '' })).toThrow(WireIdentityError)
    // token 端点（OAuth 换发）在白名单内。
    expect(assertProxyEndpoint('https://oauth2.googleapis.com/token').pathname).toBe('/token')
    expect(() => assertProxyEndpoint('https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser')).toThrow(WireIdentityError)
    expect(() => assertProxyEndpoint('https://oauth2.googleapis.com/v1internal:onboardUser')).toThrow(WireIdentityError)
    expect(() => assertProxyEndpoint('https://daily-cloudcode-pa.googleapis.com/token')).toThrow(WireIdentityError)
    expect(() => assertProxyEndpoint('https://user:pass@daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist')).toThrow(WireIdentityError)
  })
})

describe('transport：状态折叠', () => {
  it('2xx 通过，401/403/429/5xx 折成对应错误码', () => {
    expect(proxyStatusError(200)).toBeUndefined()
    expect(proxyStatusError(401)?.code).toBe('authentication')
    expect(proxyStatusError(403)?.code).toBe('forbidden')
    expect(proxyStatusError(429)?.code).toBe('rate-limited')
    expect(proxyStatusError(503)?.code).toBe('upstream')
    expect(proxyStatusError(418)?.code).toBe('protocol-drift')
  })

  it('SOCKS 代理在代理模式明确报错而不是静默直连', async () => {
    const transport = createProxyTransport({ resolveProxy: () => ({ url: 'socks5://127.0.0.1:7891', bypass: '' }) })
    await expect(transport.request({ url: QUOTA_URL, accessToken: 'tok', body: '{}' }))
      .rejects.toMatchObject({ name: 'ProxyTransportError', code: 'proxy-unsupported' })
  })
})

describe('oauth：loopback 回调', () => {
  it('state 匹配的回调完成交换并 commit；不匹配则失败', async () => {
    const listeners: Array<(request: { method: string; host?: string; url: string }) => Promise<{ status: number }>> = []
    const commit = vi.fn(async (token: { accessToken: string }) => ({
      accessToken: token.accessToken, refreshToken: 'r', expiresAt: Date.now() + 60_000, source: 'login' as const, updatedAt: new Date().toISOString(),
    }))
    const exchange = vi.fn(async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }))
    const flow = createProxyOAuthFlow({
      listenerFactory: { listen: async (handler) => { listeners.push(handler as never); return { close: () => {} } } },
      exchangeCode: exchange as never,
      commit: commit as never,
      ttlMs: 60_000,
    })
    const started = await flow.start()
    expect(started.authorizationUrl).toContain('accounts.google.com/o/oauth2/v2/auth')
    expect(started.authorizationUrl).toContain('code_challenge_method=S256')
    const handler = listeners[0]!
    const state = new URL(started.authorizationUrl).searchParams.get('state')!
    const bad = await handler({ method: 'GET', host: 'localhost:51121', url: `/oauth-callback?state=wrong&code=c` })
    expect(bad.status).toBe(400)
    const good = await handler({ method: 'GET', host: 'localhost:51121', url: `/oauth-callback?state=${state}&code=code1` })
    expect(good.status).toBe(200)
    expect(exchange).toHaveBeenCalledWith(expect.objectContaining({ code: 'code1' }))
    expect(commit).toHaveBeenCalled()
    expect(flow.status().phase).toBe('success')
    await flow.dispose()
  })

  it('非 loopback 主机与错误路径被拒绝', async () => {
    const flow = createProxyOAuthFlow({
      listenerFactory: { listen: async (handler) => { void handler; return { close: () => {} } } },
    })
    await flow.start()
    await expect(flow.completeCallbackUrl('http://evil.example:51121/oauth-callback?state=s&code=c')).rejects.toMatchObject({ code: 'invalid-callback-url' })
    await flow.dispose()
  })
})

describe('account store：副本与 CLI 导入', () => {
  it('落盘为原子写且读回一致；缺 access 的 CLI 登录态不导入', async () => {
    const files = new Map<string, string>()
    const store = new ProxyAccountStore({
      cacheDir: '/cache',
      readFileImpl: async (path) => { const value = files.get(path); if (value === undefined) throw new Error('ENOENT'); return value },
      writeFileImpl: async (path, data) => { files.set(path, data) },
      renameImpl: async (from, to) => { files.set(to, files.get(from)!); files.delete(from) },
      removeImpl: async (path) => { files.delete(path) },
      mkdirImpl: async () => {},
      chmodImpl: async () => {},
    })
    await store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 120_000, source: 'login', updatedAt: new Date().toISOString() })
    const path = proxyAccountPath('/cache')
    expect(files.has(path)).toBe(true)
    expect(files.has(`${path}.tmp-0`)).toBe(false)
    const reloaded = new ProxyAccountStore({ cacheDir: '/cache', readFileImpl: async (path) => files.get(path) ?? '' })
    const credential = await reloaded.load()
    expect(credential?.accessToken).toBe('a')
    expect(isProxyCredentialUsable(credential, Date.now())).toBe(true)
    expect(isProxyCredentialUsable(credential, Date.now() + 120_000)).toBe(false)
    expect(await importCliCredential('/cli/token', Date.now(), async () => JSON.stringify({}))).toBeUndefined()
    // 只有 refresh_token 也算可导入：使用前由适配器换发 access。
    const refreshOnly = await importCliCredential('/cli/token', Date.now(), async () => JSON.stringify({ refresh_token: 'only' }))
    expect(refreshOnly?.refreshToken).toBe('only')
    expect(refreshOnly?.accessToken).toBe('')
    const imported = await importCliCredential('/cli/token', Date.now(), async () => JSON.stringify({ access_token: 'x', refresh_token: 'y', expiry: new Date(Date.now() + 60_000).toISOString() }))
    expect(imported?.source).toBe('cli-import')
  })

  it('parseProxyCredential 拒绝缺来源或两种 token 全缺的副本', () => {
    expect(parseProxyCredential({ source: 'login' })).toBeUndefined()
    expect(parseProxyCredential({ accessToken: 'a' })).toBeUndefined()
    expect(parseProxyCredential({ accessToken: 'a', source: 'login', updatedAt: 'x' })?.source).toBe('login')
  })
})

describe('payload：消息映射与线载荷', () => {
  const options = (over: Partial<GenerateOptions> = {}): GenerateOptions => ({
    provider: PROXY_PROVIDER_ID,
    model: 'gemini-3-pro',
    messages: [],
    ...over,
  } as GenerateOptions)

  it('system 进 systemInstruction，tool-call 补 sentinel 签名，tool 结果配对', async () => {
    const messages = [
      { role: 'system', content: [{ type: 'text', text: 'sys' }], id: 'm0', source: { kind: 'system-prompt' } },
      { role: 'user', content: [{ type: 'text', text: 'hi' }], id: 'm1', source: { kind: 'user' } },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' }], id: 'm2', source: { kind: 'model', provider: PROXY_PROVIDER_ID, model: 'gemini-3-pro' } },
      { role: 'tool', content: [{ type: 'text', text: 'ok' }], id: 'm3', source: { kind: 'tool', toolCallId: 'c1' as never }, toolCallId: ToolCallId('c1') },
    ] as unknown as Message[]
    const payload = await buildProxyGeneratePayload(options({ messages, system: 'preface' }), { projectId: 'proj' }, createProxySessionStore(), 1)
    expect(payload.project).toBe('proj')
    expect(payload.requestType).toBe('agent')
    expect(payload.userAgent).toBe('antigravity')
    const request = payload.request as { systemInstruction?: { parts: { text: string }[] }; contents: { role: string; parts: Record<string, unknown>[] }[]; labels?: unknown; sessionId?: string }
    expect(request.systemInstruction?.parts.map((part) => part.text)).toEqual(['preface', 'sys'])
    const modelTurn = request.contents.find((content) => content.role === 'model')!
    const call = modelTurn.parts[0] as { functionCall: { name: string }; thoughtSignature?: string }
    expect(call.functionCall.name).toBe('read')
    expect(call.thoughtSignature).toBe('skip_thought_signature_validator')
    const userTurn = request.contents.find((content) => content.role === 'user' && (content.parts[0] as { functionResponse?: unknown }).functionResponse)!
    expect((userTurn.parts[0] as { functionResponse: { name: string; response: { content: string } } }).functionResponse.response.content).toBe('ok')
    expect(request.labels).toBeDefined()
    expect(typeof request.sessionId).toBe('string')
  })

  it('system 与 developer 文本按消息顺序保留到 systemInstruction', async () => {
    const messages = [
      createSystemMessage('first'),
      createDeveloperMessage({ content: [{ type: 'text', text: 'developer instructions' }], source: { kind: 'user' } }),
      createSystemMessage('last'),
    ]
    const payload = await buildProxyGeneratePayload(options({ messages, system: 'preface' }), {}, createProxySessionStore(), 1)
    expect(payload.request.systemInstruction).toEqual({ parts: [{ text: 'preface' }, { text: 'first' }, { text: 'developer instructions' }, { text: 'last' }] })
  })

  it('图片输入：附件服务缺席时报 UNSUPPORTED_MODALITY，在场时转 inlineData', async () => {
    const messages = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a', width: 10, height: 10, bytes: 8 } }], id: 'm1', source: { kind: 'user' } }] as unknown as Message[]
    await expect(buildProxyGeneratePayload(options({ messages, model: 'antigravity-gemini-3.8-flash' }), {}, createProxySessionStore(), 1))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_MODALITY' })
    const attachments = {
      readImage: vi.fn(),
      readImageRequest: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' })),
    }
    const payload = await buildProxyGeneratePayload(options({ messages, model: 'antigravity-gemini-3.8-flash' }), {}, createProxySessionStore(), 1, attachments)
    const contents = (payload.request as { contents: { parts: Record<string, unknown>[] }[] }).contents
    const inline = contents[0]?.parts[0] as { inlineData: { mimeType: string; data: string } }
    expect(inline.inlineData.mimeType).toBe('image/png')
    expect(inline.inlineData.data).toBe(Buffer.from([1, 2, 3]).toString('base64'))
    expect(payload.sentImageBytes.get('a')).toBe(3)
    expect(attachments.readImageRequest).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: 'a' }),
      expect.objectContaining({ maxBytes: 1024 * 1024 }),
      undefined,
    )
  })

  it('内联图片超 12MB 预算时协商 IMAGE_OFFLOAD_REQUIRED', async () => {
    const big = { type: 'image', attachment: { attachmentId: 'big', width: 10, height: 10, bytes: 13 * 1024 * 1024 } }
    const messages = [{ role: 'user', content: [big], id: 'm1', source: { kind: 'user' } }] as unknown as Message[]
    const sent = new Map<string, number>([['big', 13 * 1024 * 1024]])
    const offload = requiredProxyImageOffload(messages, sent)
    expect(offload).toBeGreaterThan(0)
    // 预算内的单图不需要 offload。
    expect(requiredProxyImageOffload(messages, new Map([['big', 1024]]))).toBe(0)
  })

  it('replay 元数据只接受同 provider 同模型的签名', () => {
    const state = createProxyReplayState('gemini-3-pro', 'gemini', 'STOP', [{ kind: 'text', signature: 'sig' }])
    const assistant = { role: 'assistant', content: [{ type: 'text', text: 'x' }], id: 'm', source: { kind: 'model', provider: PROXY_PROVIDER_ID, model: 'gemini-3-pro', replayState: state } } as unknown as Message
    expect(compatibleProxyReplayState(assistant, 'gemini-3-pro', ['text'])?.blocks[0]?.signature).toBe('sig')
    expect(compatibleProxyReplayState(assistant, 'gemini-3-flash', ['text'])).toBeUndefined()
  })

  it('SSE 事件解析兼容 )]}\' 前缀与 usageMetadata', () => {
    const event = parseProxyProviderEvent(`)]}'\n{"response":{"candidates":[{"content":{"parts":[{"text":"hi"},{"functionCall":{"name":"f","args":{"a":1}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}}`)
    expect(event.parts.map((part) => part.kind)).toEqual(['text', 'tool-call'])
    expect(event.finish).toBe('STOP')
    expect(event.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 })
  })

  it('Gemini 3.8 完整默认载荷匹配审计参考，显式输出上限优先', async () => {
    const defaults = await buildProxyGeneratePayload(options({ model: 'antigravity-gemini-3.8-flash' }), {}, createProxySessionStore(), 1)
    expect(defaults.model).toBe('gemini-3.8-flash-medium')
    expect(defaults.request.generationConfig).toEqual({ maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true, thinkingBudget: 4000 } })
    const explicit = await buildProxyGeneratePayload(options({ model: 'antigravity-gemini-3.8-flash', maxTokens: 2000 }), {}, createProxySessionStore(), 1)
    expect(explicit.request.generationConfig).toMatchObject({ maxOutputTokens: 2000 })
  })

  it('缓存命中从总 prompt 计数扣除，避免宿主重复统计', () => {
    const parsed = parseProxyProviderEvent('{"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":80,"candidatesTokenCount":4}}')
    expect(parsed.usage).toMatchObject({ inputTokens: 20, cacheReadTokens: 80, outputTokens: 4 })
  })

  it('图片读取后校验 1MB 上限，旧附件面不发送超过 4MP 的原图', async () => {
    const ref = { attachmentId: 'synthetic', mediaType: 'image/png', width: 10, height: 10, bytes: 1 } as import('@deepseek-ai/dsh-attachment').ImageAttachmentRef
    await expect(readProxyImage({ readImage: vi.fn(), readImageRequest: async () => ({ data: new Uint8Array(1024 * 1024 + 1), mediaType: 'image/png' }) }, ref, undefined)).rejects.toMatchObject({ code: 'UNSUPPORTED_MODALITY' })
    const readImage = vi.fn()
    await expect(readProxyImage({ readImage }, { ...ref, width: 4000, height: 4000 }, undefined)).rejects.toMatchObject({ code: 'UNSUPPORTED_MODALITY' })
    expect(readImage).not.toHaveBeenCalled()
  })

  it('附件后端不响应时取消仍能结束等待', async () => {
    const ref = { attachmentId: 'synthetic', mediaType: 'image/png', width: 10, height: 10, bytes: 1 } as import('@deepseek-ai/dsh-attachment').ImageAttachmentRef
    const controller = new AbortController()
    const reading = readProxyImage({ readImage: vi.fn(), readImageRequest: async () => new Promise(() => {}) }, ref, controller.signal)
    controller.abort()
    await expect(reading).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('模型映射改变后不回放旧 wire 模型的 thinking 签名', () => {
    const state = createProxyReplayState('public', 'claude', 'STOP', [{ kind: 'reasoning', signature: 'synthetic-signature' }], 'claude-sonnet-5-5-low')
    const assistant = { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }], id: 'm', source: { kind: 'model', provider: PROXY_PROVIDER_ID, model: 'public', replayState: state } } as unknown as Message
    expect(compatibleProxyReplayState(assistant, 'public', ['reasoning'], 'claude-sonnet-5-5-low')).toBeDefined()
    expect(compatibleProxyReplayState(assistant, 'public', ['reasoning'], 'claude-opus-5-5-low')).toBeUndefined()
  })
})

describe('mode bus：互斥计划', () => {
  it('默认 ACP；proxyMode 真值切代理', () => {
    expect(modeFromFlag(undefined)).toBe('acp')
    expect(registrationPlan('proxy')).toEqual({ acp: false, proxy: true })
    expect(registrationPlan('acp')).toEqual({ acp: true, proxy: false })
  })

  it('notify 只在值变化时触发订阅者', () => {
    let value = false
    const bus = createProxyModeBus({ mode: () => value, proxySettings: () => ({}) })
    bus.setRouterReady(true)
    const seen: boolean[] = []
    const off = bus.subscribe((mode) => seen.push(mode))
    bus.notify()
    expect(seen).toEqual([])
    value = true
    bus.notify()
    bus.notify()
    expect(seen).toEqual([true])
    expect(bus.current()).toBe(true)
    off()
    value = false
    bus.notify()
    expect(seen).toEqual([true])
  })
  it('代理组件未就绪也保持代理模式，不回退 ACP', () => {
    const bus = createProxyModeBus({ mode: () => true, proxySettings: () => ({}) })
    expect(bus.current()).toBe(true)
    expect(bus.requested()).toBe(true)
    expect(bus.routerReady()).toBe(false)
  })
})

describe('quota source：代理账户取数', () => {
  it('loadCodeAssist + retrieveUserQuotaSummary 折成快照；401 换发一次重试', async () => {
    const calls: string[] = []
    const staleTokens = new Set(['stale'])
    let current = 'stale'
    const transport = {
      request: async (input: { url: string; accessToken?: string }) => {
        calls.push(`${input.url} ${input.accessToken}`)
        if (staleTokens.has(input.accessToken ?? '')) return new Response(JSON.stringify({ error: { status: 401 } }), { status: 401 })
        if (input.url.includes('loadCodeAssist')) return new Response(JSON.stringify({ cloudaicompanionProject: 'proj', currentTier: { name: 'Pro' } }), { status: 200 })
        return new Response(JSON.stringify({ groups: [{ displayName: 'Gemini', buckets: [{ displayName: '5h', remainingFraction: 0.5 }] }] }), { status: 200 })
      },
    }
    const credential = vi.fn(async (_signal?: AbortSignal, opts?: { forceRefresh?: boolean }) => {
      if (opts?.forceRefresh) current = 'fresh'
      return { accessToken: current, source: 'login' as const, updatedAt: 'x' }
    })
    const snapshot = await fetchProxyQuotaSnapshot({ credential: { credential }, transport: transport as never })
    expect(snapshot.status).toBe('ok')
    expect(snapshot.plan).toBe('Pro')
    expect(snapshot.groups[0]?.buckets[0]?.remainingPct).toBe(50)
    expect(credential).toHaveBeenCalledTimes(2)
  })

  it('未登录折成 error 快照而不是抛', async () => {
    const snapshot = await fetchProxyQuotaSnapshot({ credential: { credential: async () => undefined }, transport: { request: async () => new Response('', { status: 200 }) } as never })
    expect(snapshot.status).toBe('error')
    expect(snapshot.error?.code).toBe('token-missing')
  })
})
