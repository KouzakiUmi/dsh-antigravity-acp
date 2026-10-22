/**
 * 进程内假 ACP agent（测试桩，非产品代码）。
 *
 * 与既有 tests/agent-link.test.ts 同模式：用两条交叉的 TransformStream 组成
 * 一条双向 JSON-RPC 通道注入 AgentLink，**不启动真实官方二进制、不触碰
 * child_process**。本桩额外提供：
 * - 按方法注册的应答器（返回值即 JSON-RPC result；返回 NO_REPLY 则挂起该
 *   请求，交由测试手动应答）；
 * - agent → client 的请求（用于 session/request_permission 与非预期原生请求）；
 * - 客户端请求/通知的记录，供断言。
 *
 * 构造时可注入外部消息级双向流（例如由假 subprocess 的字节通道转型而来），
 * 缺省仍自建内部通道对。
 */
import type { AnyMessage, JsonRpcId, Stream } from '@agentclientprotocol/sdk'

/** 应答器返回该符号表示「本次不自动应答」。 */
export const NO_REPLY = Symbol('no-reply')

type AnyMessageView = AnyMessage & { method?: string; params?: unknown; id?: JsonRpcId | null }

export interface RecordedRequest {
  id: JsonRpcId
  method: string
  params: Record<string, unknown>
}

export type RequestHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>

export class FakeAcpAgent {
  /** 注入给 AgentLink 的双向流。 */
  readonly stream: Stream
  /** client → agent 的请求记录（按到达顺序）。 */
  readonly requests: RecordedRequest[] = []
  /** client → agent 的通知记录（按到达顺序）。 */
  readonly notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  /** 尚未应答的 client 请求 id。 */
  readonly unanswered = new Set<JsonRpcId>()

  #reader: ReadableStreamDefaultReader<AnyMessage>
  #writer: WritableStreamDefaultWriter<AnyMessage>
  #handlers = new Map<string, RequestHandler>()
  #clientRequestSeq = 1
  #clientCallWaiters = new Map<JsonRpcId, (message: AnyMessageView) => void>()

  constructor(stream?: Stream) {
    if (stream) {
      this.stream = stream
      this.#reader = stream.readable.getReader()
      this.#writer = stream.writable.getWriter()
    } else {
      const agentToClient = new TransformStream<AnyMessage, AnyMessage>()
      const clientToAgent = new TransformStream<AnyMessage, AnyMessage>()
      this.stream = { writable: clientToAgent.writable, readable: agentToClient.readable }
      this.#reader = clientToAgent.readable.getReader()
      this.#writer = agentToClient.writable.getWriter()
    }
    void this.#pump()
  }

  /** 注册某个 client → agent 请求方法的自动应答器。 */
  on(method: string, handler: RequestHandler): this {
    this.#handlers.set(method, handler)
    return this
  }

  /** 取某个方法已收到的全部请求。 */
  requestsFor(method: string): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method)
  }

  /** 取某个方法收到的通知。 */
  notificationsFor(method: string): Array<{ method: string; params: Record<string, unknown> }> {
    return this.notifications.filter((notification) => notification.method === method)
  }

  /** 手动应答某个方法的第 index 个请求。 */
  async reply(method: string, result: unknown, index = 0): Promise<void> {
    const request = this.requestsFor(method)[index]
    if (!request) throw new Error(`假 agent 未收到 ${method} 请求（index=${index}）`)
    this.unanswered.delete(request.id)
    await this.#write({ jsonrpc: '2.0', id: request.id, result })
  }

  /** 以 JSON-RPC error 应答某个方法的第 index 个请求。 */
  async replyError(method: string, error: { code: number; message: string }, index = 0): Promise<void> {
    const request = this.requestsFor(method)[index]
    if (!request) throw new Error(`假 agent 未收到 ${method} 请求（index=${index}）`)
    this.unanswered.delete(request.id)
    await this.#write({ jsonrpc: '2.0', id: request.id, error })
  }

  /** 主动发出一个 client 通知（如 session/update）。 */
  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.#write({ jsonrpc: '2.0', method, params })
  }

  /** 主动发起一个 agent → client 请求并等待 client 的应答。 */
  async callClient(method: string, params: Record<string, unknown>, timeoutMs = 2_000): Promise<AnyMessageView> {
    const id: JsonRpcId = `agent-req-${this.#clientRequestSeq++}`
    const waiter = new Promise<AnyMessageView>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#clientCallWaiters.delete(id)
        reject(new Error(`假 agent 发起的 ${method} 等待 client 应答超时`))
      }, timeoutMs)
      this.#clientCallWaiters.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
    await this.#write({ jsonrpc: '2.0', id, method, params })
    return waiter
  }

  async #write(message: AnyMessage): Promise<void> {
    await this.#writer.write(message)
  }

  async #pump(): Promise<void> {
    for (;;) {
      const { done, value } = await this.#reader.read()
      if (done) return
      const message = value as AnyMessageView
      if ('method' in message && message.id !== undefined && message.id !== null) {
        const record: RecordedRequest = {
          id: message.id,
          method: message.method ?? '',
          params: (message.params ?? {}) as Record<string, unknown>,
        }
        this.requests.push(record)
        this.unanswered.add(record.id)
        const handler = this.#handlers.get(record.method)
        if (!handler) continue
        void Promise.resolve().then(() => handler(record.params)).then(
          (result) => {
            if (result === NO_REPLY) return
            if (!this.unanswered.has(record.id)) return
            this.unanswered.delete(record.id)
            void this.#write({ jsonrpc: '2.0', id: record.id, result })
          },
          (error: unknown) => {
            if (!this.unanswered.has(record.id)) return
            this.unanswered.delete(record.id)
            void this.#write({
              jsonrpc: '2.0',
              id: record.id,
              error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
            })
          },
        )
        continue
      }
      if ('method' in message) {
        this.notifications.push({
          method: message.method ?? '',
          params: (message.params ?? {}) as Record<string, unknown>,
        })
        continue
      }
      const id = 'id' in message ? message.id : undefined
      if (id === undefined || id === null) continue
      const waiter = this.#clientCallWaiters.get(id)
      if (!waiter) continue
      this.#clientCallWaiters.delete(id)
      waiter(message)
    }
  }
}
