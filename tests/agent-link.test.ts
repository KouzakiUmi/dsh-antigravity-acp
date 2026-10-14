/**
 * ACP 握手测试桩：不起真实官方二进制，用注入的 fake 双向流（Web
 * TransformStream 交叉连接）验证 initialize 请求构造、响应关联、
 * authenticate 参数、session/new 会话保存、超时、通知分发与关闭语义。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnyMessage } from '@agentclientprotocol/sdk'
import { AgentLink, AGY_LINK_ERROR, AgentLinkError, OAUTH_PERSONAL_AUTH_METHOD, agentStreamFromSubprocess } from '../src/protocol/agent-link.js'
import type { Stream } from '@agentclientprotocol/sdk'

/** client 侧 Stream 与 fake agent 侧读写端的交叉连接。 */
function fakePair(): {
  stream: Stream
  agentIn: ReadableStreamDefaultReader<AnyMessage>
  agentOut: WritableStreamDefaultWriter<AnyMessage>
} {
  const agentToClient = new TransformStream<AnyMessage, AnyMessage>()
  const clientToAgent = new TransformStream<AnyMessage, AnyMessage>()
  const stream: Stream = {
    writable: clientToAgent.writable,
    readable: agentToClient.readable,
  }
  return {
    stream,
    agentIn: clientToAgent.readable.getReader(),
    agentOut: agentToClient.writable.getWriter(),
  }
}

/** fake agent 侧的消息视图：按需窄化 AnyMessage 的 method/id/params。 */
type FakeAgentView = AnyMessage & { method?: string; params?: unknown; id?: string | number | null }

/** fake agent 的入站泵：对每个收到的消息调用 handler。 */
function pumpAgent(
  pair: ReturnType<typeof fakePair>,
  handler: (message: FakeAgentView, reply: (response: AnyMessage) => Promise<void>) => void | Promise<void>,
): void {
  void (async () => {
    for (;;) {
      const { done, value } = await pair.agentIn.read()
      if (done) break
      await handler(value as FakeAgentView, (response) => pair.agentOut.write(response))
    }
  })()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AgentLink 握手', () => {
  it('initialize 请求构造正确并解析响应', async () => {
    const pair = fakePair()
    let seenMethod: string | undefined
    let seenParams: unknown
    pumpAgent(pair, async (message, reply) => {
      if (message.method === 'initialize') {
        seenMethod = message.method
        seenParams = message.params
        await reply({ jsonrpc: '2.0', id: message.id!, result: { protocolVersion: 1, agentCapabilities: {} } })
      }
    })
    const link = new AgentLink({ stream: pair.stream, clientInfo: { name: 'test-client', version: '0.0.1' } })
    link.start()
    const response = await link.initialize()
    expect(link.initialized).toBe(true)
    expect(response.protocolVersion).toBe(1)
    expect(seenMethod).toBe('initialize')
    expect(seenParams).toMatchObject({ protocolVersion: 1, clientInfo: { name: 'test-client', version: '0.0.1' } })
    await link.close()
  })

  it('并发请求的响应按 id 正确关联', async () => {
    const pair = fakePair()
    pumpAgent(pair, async (message, reply) => {
      if (message.method === 'initialize') {
        await reply({ jsonrpc: '2.0', id: message.id!, result: { protocolVersion: 1 } })
      } else if (message.method === 'session/new') {
        // 故意延迟回包，打乱与 initialize 的返回顺序。
        await new Promise((resolve) => setTimeout(resolve, 10))
        await reply({ jsonrpc: '2.0', id: message.id!, result: { sessionId: 'session-concurrent' } })
      } else if (message.method === 'session/list') {
        await reply({ jsonrpc: '2.0', id: message.id!, result: { sessions: [] } })
      }
    })
    const link = new AgentLink({ stream: pair.stream })
    link.start()
    await link.initialize()
    const [authless, session] = await Promise.all([
      link.request('session/list', {}),
      link.newSession({ cwd: '/tmp', mcpServers: [] }),
    ])
    expect(session.sessionId).toBe('session-concurrent')
    expect(link.sessionId).toBe('session-concurrent')
    expect(authless).toBeDefined()
    await link.close()
  })

  it('authenticate 默认携带 oauth-personal 方法 id', async () => {
    const pair = fakePair()
    let seenAuthParams: unknown
    pumpAgent(pair, async (message, reply) => {
      if (message.method === 'initialize') {
        await reply({ jsonrpc: '2.0', id: message.id!, result: { protocolVersion: 1 } })
      } else if (message.method === 'authenticate') {
        seenAuthParams = message.params
        await reply({ jsonrpc: '2.0', id: message.id!, result: {} })
      }
    })
    const link = new AgentLink({ stream: pair.stream })
    link.start()
    await link.initialize()
    await link.authenticate()
    expect(seenAuthParams).toEqual({ methodId: OAUTH_PERSONAL_AUTH_METHOD })
    await link.close()
  })

  it('未 initialize 时调用会话方法抛 AGY_NOT_INITIALIZED', async () => {
    const pair = fakePair()
    const link = new AgentLink({ stream: pair.stream })
    await expect(link.newSession({ cwd: '/tmp', mcpServers: [] })).rejects.toMatchObject({
      code: AGY_LINK_ERROR.NOT_INITIALIZED,
    })
  })
})

describe('AgentLink 超时与取消', () => {
  it('握手超时触发 AGY_HANDSHAKE_TIMEOUT', async () => {
    const pair = fakePair()
    // fake agent 对 initialize 装聋。
    pumpAgent(pair, () => undefined)
    const link = new AgentLink({ stream: pair.stream, handshakeTimeoutMs: 30 })
    link.start()
    await expect(link.initialize()).rejects.toMatchObject({ code: AGY_LINK_ERROR.HANDSHAKE_TIMEOUT })
    await link.close()
  })

  it('普通请求超时触发 AGY_REQUEST_TIMEOUT', async () => {
    const pair = fakePair()
    pumpAgent(pair, async (message, reply) => {
      if (message.method === 'initialize') {
        await reply({ jsonrpc: '2.0', id: message.id!, result: { protocolVersion: 1 } })
      }
    })
    const link = new AgentLink({ stream: pair.stream, requestTimeoutMs: 30 })
    link.start()
    await link.initialize()
    await expect(link.request('session/list', {})).rejects.toMatchObject({ code: AGY_LINK_ERROR.REQUEST_TIMEOUT })
    await link.close()
  })

  it('authenticate 走独立的 authTimeoutMs，不被普通请求超时掐断', async () => {
    const pair = fakePair()
    pumpAgent(pair, async (message, reply) => {
      if (message.method === 'initialize') {
        await reply({ jsonrpc: '2.0', id: message.id!, result: { protocolVersion: 1 } })
      }
      // authenticate 故意装聋：只有 authTimeoutMs 该到点。
    })
    const link = new AgentLink({ stream: pair.stream, requestTimeoutMs: 10, authTimeoutMs: 40 })
    link.start()
    await link.initialize()
    await expect(link.authenticate()).rejects.toMatchObject({
      code: AGY_LINK_ERROR.REQUEST_TIMEOUT,
      message: expect.stringContaining('40ms'),
    })
    await link.close()
  })

  it('未设置 authTimeoutMs 时 authenticate 用默认的分钟级上限，不受普通请求短超时限制', async () => {
    const pair = fakePair()
    let authSeen = false
    pumpAgent(pair, async (message, reply) => {
      if (message.method === 'initialize') {
        await reply({ jsonrpc: '2.0', id: message.id!, result: { protocolVersion: 1 } })
      } else if (message.method === 'authenticate') {
        authSeen = true // 装聋：不回认证响应。
      }
    })
    const link = new AgentLink({ stream: pair.stream, requestTimeoutMs: 30 })
    link.start()
    await link.initialize()
    const pending = link.authenticate()
    const settled = await Promise.race([
      pending.then(() => 'settled', () => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 200)),
    ])
    expect(authSeen).toBe(true)
    // 普通请求超时（30ms）早已过去，认证仍在等待 → 用的是独立的分钟级上限。
    expect(settled).toBe('pending')
    await link.close()
  })

  it('外部 abort 触发请求拒绝并发出 $/cancel_request', async () => {
    const pair = fakePair()
    const cancelNotifications: unknown[] = []
    pumpAgent(pair, async (message, reply) => {
      if (message.method === 'initialize') {
        await reply({ jsonrpc: '2.0', id: message.id!, result: { protocolVersion: 1 } })
      } else if (message.method === '$/cancel_request') {
        cancelNotifications.push(message.params)
      }
    })
    const link = new AgentLink({ stream: pair.stream })
    link.start()
    await link.initialize()
    const controller = new AbortController()
    const pending = link.request('session/prompt', { sessionId: 's', prompt: [] }, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: AGY_LINK_ERROR.REQUEST_TIMEOUT })
    await vi.waitFor(() => expect(cancelNotifications.length).toBeGreaterThan(0))
    await link.close()
  })
})

describe('AgentLink 事件与会话', () => {
  it('session/update 通知分发到注册回调', async () => {
    const pair = fakePair()
    pumpAgent(pair, async (message, reply) => {
      if (message.method === 'initialize') {
        await reply({ jsonrpc: '2.0', id: message.id!, result: { protocolVersion: 1 } })
        await pair.agentOut.write({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } },
        })
      }
    })
    const updates: unknown[] = []
    const link = new AgentLink({ stream: pair.stream, handlers: { onSessionUpdate: (n) => void updates.push(n) } })
    link.start()
    await link.initialize()
    await vi.waitFor(() => expect(updates.length).toBe(1))
    expect(updates[0]).toMatchObject({ sessionId: 's1' })
    await link.close()
  })

  it('session/cancel 以无 id 通知发出', async () => {
    const pair = fakePair()
    const notifications: AnyMessage[] = []
    pumpAgent(pair, async (message, reply) => {
      if (message.method === 'initialize') {
        await reply({ jsonrpc: '2.0', id: message.id!, result: { protocolVersion: 1 } })
      } else if (message.method === 'session/cancel') {
        notifications.push(message)
      }
    })
    const link = new AgentLink({ stream: pair.stream })
    link.start()
    await link.initialize()
    await link.cancel('s-9')
    await vi.waitFor(() => expect(notifications.length).toBe(1))
    expect(notifications[0]).toMatchObject({ method: 'session/cancel', params: { sessionId: 's-9' } })
    expect(notifications[0]).not.toHaveProperty('id')
    await link.close()
  })

  it('session/request_permission 入站请求交由 handler 应答', async () => {
    const pair = fakePair()
    let permissionOutcome: unknown
    pumpAgent(pair, async (message, reply) => {
      if (message.method === 'initialize') {
        await reply({ jsonrpc: '2.0', id: message.id!, result: { protocolVersion: 1 } })
        // fake agent 主动发起权限询问，等待 client 的应答（由 handler 给出）。
        await pair.agentOut.write({
          jsonrpc: '2.0',
          id: 'perm-1',
          method: 'session/request_permission',
          params: { sessionId: 's1', toolCall: { toolCallId: 't1' }, options: [{ optionId: 'opt-1', name: 'Allow', kind: 'allow_once' }] },
        })
      } else if (message.method === 'session/prompt') {
        await reply({ jsonrpc: '2.0', id: message.id!, result: { stopReason: 'end_turn' } })
      } else if (message.id === 'perm-1' && !('method' in message)) {
        permissionOutcome = message
      }
    })
    const link = new AgentLink({
      stream: pair.stream,
      handlers: {
        onRequestPermission: () => ({ outcome: { outcome: 'selected', optionId: 'opt-1' } }),
      },
    })
    link.start()
    await link.initialize()
    await link.request('session/prompt', { sessionId: 's1', prompt: [] })
    await vi.waitFor(() => expect(permissionOutcome).toBeDefined())
    expect(permissionOutcome).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'opt-1' } } })
    await link.close()
  })

  it('对端 JSON-RPC error 映射为 AGY_AGENT_REFUSED', async () => {
    const pair = fakePair()
    pumpAgent(pair, async (message, reply) => {
      if (message.method === 'initialize') {
        await reply({ jsonrpc: '2.0', id: message.id!, result: { protocolVersion: 1 } })
      } else if (message.method === 'session/new') {
        await reply({ jsonrpc: '2.0', id: message.id!, error: { code: -32000, message: 'auth required' } })
      }
    })
    const link = new AgentLink({ stream: pair.stream })
    link.start()
    await link.initialize()
    const caught: unknown = await link.newSession({ cwd: '/tmp', mcpServers: [] }).then(
      () => null,
      (e: unknown) => e,
    )
    const error = caught as AgentLinkError
    expect(caught).toBeInstanceOf(AgentLinkError)
    expect(error.code).toBe(AGY_LINK_ERROR.AGENT_REFUSED)
    expect(error.jsonRpc?.code).toBe(-32000)
    await link.close()
  })
})

describe('AgentLink 关闭语义', () => {
  it('close 后在途请求按 AGY_LINK_CLOSED 拒绝', async () => {
    const pair = fakePair()
    pumpAgent(pair, async (message, reply) => {
      if (message.method === 'initialize') {
        await reply({ jsonrpc: '2.0', id: message.id!, result: { protocolVersion: 1 } })
      }
    })
    const link = new AgentLink({ stream: pair.stream })
    link.start()
    await link.initialize()
    const pending = link.request('session/list', {})
    await link.close()
    await expect(pending).rejects.toMatchObject({ code: AGY_LINK_ERROR.LINK_CLOSED })
    await expect(link.request('session/list', {})).rejects.toMatchObject({ code: AGY_LINK_ERROR.LINK_CLOSED })
  })

  it('agentStreamFromSubprocess 在 stdio 不完整时抛 AGY_LAUNCH_FAILED', () => {
    expect(() => agentStreamFromSubprocess({ stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {}, done: Promise.resolve({ exitCode: 0, signal: null }), terminate: () => undefined, waitForExit: async () => true } as never)).toThrowError(
      expect.objectContaining({ code: AGY_LINK_ERROR.LAUNCH_FAILED }),
    )
  })
})
