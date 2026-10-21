/**
 * ACP v1 stdio 客户端链接层（原创实现）。
 *
 * 以官方 `@agentclientprotocol/sdk` 的 transport 原语（`ndJsonStream`、
 * `Stream`、JSON-RPC 消息类型与 schema 类型）为基础，自写客户端侧的
 * 请求多路复用、超时/取消、通知分发与协议方法封装。SDK 1.4.0 的高层
 * `ClientApp` 面向一次性 `connectWith` 工作流，不适合长生命周期 adapter，
 * 因此不复用其连接编排，仅用其帧协议原语与类型。
 *
 * 进程启动不在此文件内触碰 child_process：stdio 通道由调用方注入
 * （生产路径经宿主注入的 ctx.subprocess，测试路径注入 fake 双向流）。
 */
import { readFileSync } from 'node:fs'
import { dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable, Readable } from 'node:stream'
import { PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk'
import type {
  AnyMessage,
  AnyNotification,
  AnyRequest,
  AnyResponse,
  AuthMethodId,
  AuthenticateResponse,
  CancelNotification,
  Implementation,
  InitializeRequest,
  InitializeResponse,
  JsonRpcId,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  Stream,
} from '@agentclientprotocol/sdk'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { ambientProxyEnv, buildProxyEnv } from '../runtime/proxy-env.js'
import type { ProxySettings } from '../runtime/proxy-env.js'

/** 本包原创协议层错误码（AGY_* 前缀命名体系）。 */
export const AGY_LINK_ERROR = {
  /** 子进程启动失败或 stdio 形状不符合预期。 */
  LAUNCH_FAILED: 'AGY_LAUNCH_FAILED',
  /** initialize 握手超时。 */
  HANDSHAKE_TIMEOUT: 'AGY_HANDSHAKE_TIMEOUT',
  /** 普通请求等待响应超时。 */
  REQUEST_TIMEOUT: 'AGY_REQUEST_TIMEOUT',
  /** authenticate 等待人工授权超时（与普通请求超时区分，便于诊断与重试策略）。 */
  AUTH_TIMEOUT: 'AGY_AUTH_TIMEOUT',
  /** 链接已关闭后再发起请求，或链接对端断开。 */
  LINK_CLOSED: 'AGY_LINK_CLOSED',
  /** 收到无法路由/结构非法的消息。 */
  PROTOCOL_VIOLATION: 'AGY_PROTOCOL_VIOLATION',
  /** 对端以 JSON-RPC error 显式拒绝。 */
  AGENT_REFUSED: 'AGY_AGENT_REFUSED',
  /** 未完成 initialize 就调用会话方法。 */
  NOT_INITIALIZED: 'AGY_NOT_INITIALIZED',
} as const

export class AgentLinkError extends Error {
  /** AGY_* 机器错误码。 */
  public readonly code: string
  /** 对端返回的 JSON-RPC 错误细节（AGY_AGENT_REFUSED 时存在）。 */
  public readonly jsonRpc?: { code: number; message: string; data?: unknown }

  constructor(code: string, message: string, options?: { cause?: unknown; jsonRpc?: { code: number; message: string; data?: unknown } }) {
    super(message, options)
    this.name = 'AgentLinkError'
    this.code = code
    this.jsonRpc = options?.jsonRpc
  }
}

export interface AgentLinkHandlers {
  /**
   * `session/update` 通知回调（流式 chunk、工具调用、计划等）。
   * worker2 将在此挂点上把 ACP 更新映射为 DSH StreamChunk。
   */
  onSessionUpdate?(notification: SessionNotification): void | Promise<void>
  /**
   * `session/request_permission` 入站请求处理（agent 请用户授权工具调用）。
   * 返回值作为响应发回 agent。
   */
  onRequestPermission?(request: RequestPermissionRequest): Promise<RequestPermissionResponse> | RequestPermissionResponse
  /**
   * worker2 补丁：其余 agent→client 方法（`fs/*`、`terminal/*`、
   * `session/create_elicitation` 等，即 clientCapabilities 未声明支持的原生
   * 能力）的入站观测点。既有控制流不变——没有注册该回调时，仍按原样回
   * method-not-found；注册后先回调再照旧回错误响应，便于上层在同一次交互里
   * 记录「非预期原生活动」并终止回合。
   */
  onUnexpectedAgentRequest?(method: string, request: AnyRequest): void | Promise<void>
}

export interface AgentLinkOptions {
  /** 已连接的 JSON-RPC 双向流（可来自子进程 stdio 或测试 fake）。 */
  stream: Stream
  /** initialize 时上报的客户端信息。 */
  clientInfo?: Implementation
  /** 单请求默认超时（毫秒）。 */
  requestTimeoutMs?: number
  /** initialize 握手专用超时（毫秒）。 */
  handshakeTimeoutMs?: number
  /**
   * authenticate 专用超时（毫秒）。官方 personal OAuth 认证需要人工在浏览器里
   * 完成授权，普通请求超时（默认 30s）会把正常登录直接判死，因此单列一档。
   */
  authTimeoutMs?: number
  handlers?: AgentLinkHandlers
}

export interface AgentLinkRequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

interface PendingEntry {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

/** 官方 personal OAuth 认证方法 id（ACP v1 规范约定的固定值）。 */
export const OAUTH_PERSONAL_AUTH_METHOD: AuthMethodId = 'oauth-personal'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000
/** 认证默认上限：人工点浏览器授权的时间尺度，与普通请求超时分开。 */
const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60_000

/** 官方 client 实现信息（initialize 上报）。 */
export const AGY_CLIENT_INFO: Implementation = { name: 'dsh-bundle-antigravity-host', version: readPackageVersion() }

/** 读本包 package.json 的版本（src 与 dist 到它的相对路径一致）；读不到不影响启动。 */
function readPackageVersion(): string {
  try {
    const file = fileURLToPath(new URL('../../package.json', import.meta.url))
    const version = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version
    return typeof version === 'string' && version.length > 0 ? version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * ACP v1 客户端链接。生命周期：new AgentLink({ stream }) → start() →
 * initialize() → authenticate() → 会话方法 … → close()。
 */
export class AgentLink {
  #stream: Stream
  #clientInfo?: Implementation
  #requestTimeoutMs: number
  #handshakeTimeoutMs: number
  #authTimeoutMs: number
  #handlers: AgentLinkHandlers

  #pending = new Map<JsonRpcId, PendingEntry>()
  #nextId = 1
  #closed = false
  #pumpPromise?: Promise<void>
  #initialized = false
  #initializeResponse?: InitializeResponse
  #boundSessionId: string | undefined
  /** 出站单例 writer：并发 #write 复用同一个 writer，避免重复 getWriter 撞锁。 */
  #writer?: WritableStreamDefaultWriter<AnyMessage>
  /** 入站单例 reader；close 时 cancel，保证 pump 可结束、close 可完成。 */
  #reader?: ReadableStreamDefaultReader<AnyMessage>

  constructor(options: AgentLinkOptions) {
    this.#stream = options.stream
    this.#clientInfo = options.clientInfo
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    this.#authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS
    this.#handlers = options.handlers ?? {}
  }

  /** 链路是否已关闭（主动 close、对端断流或协议违规都会置位）；已关闭的链路不可复用。 */
  get closed(): boolean {
    return this.#closed
  }

  /** 是否已完成 initialize。 */
  get initialized(): boolean {
    return this.#initialized
  }

  /** 最近一次 session/new 保存的会话 id；未创建时为 undefined。 */
  get sessionId(): string | undefined {
    return this.#boundSessionId
  }

  /**
   * worker2 补丁：保存的 initialize 响应。目录/能力观察需要读到协议版本与
   * agentCapabilities，且不得为此重发一次 initialize。
   */
  get initializeResponse(): InitializeResponse | undefined {
    return this.#initializeResponse
  }

  /** 启动入站消息泵。重复调用无副作用。 */
  start(): void {
    this.#pumpPromise ??= this.#pump()
  }

  async #pump(): Promise<void> {
    const reader = this.#stream.readable.getReader()
    this.#reader = reader
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        this.#route(value)
      }
    } catch (error) {
      this.#rejectAllPending(new AgentLinkError(AGY_LINK_ERROR.LINK_CLOSED, 'ACP 流读取失败，链接关闭', { cause: error }))
    } finally {
      reader.releaseLock()
      this.#closed = true
      this.#rejectAllPending(new AgentLinkError(AGY_LINK_ERROR.LINK_CLOSED, 'ACP 链路已关闭'))
    }
  }

  #route(message: AnyMessage): void {
    if ('method' in message) {
      if ('id' in message && message.id !== undefined) {
        void this.#routeInboundRequest(message as AnyRequest)
      } else {
        this.#routeNotification(message as AnyNotification)
      }
      return
    }
    if ('id' in message && ('result' in message || 'error' in message)) {
      this.#routeResponse(message as AnyResponse)
      return
    }
    throw new AgentLinkError(AGY_LINK_ERROR.PROTOCOL_VIOLATION, `无法路由的 JSON-RPC 消息: ${JSON.stringify(message).slice(0, 200)}`)
  }

  async #routeInboundRequest(request: AnyRequest): Promise<void> {
    if (request.method === 'session/request_permission') {
      const handler = this.#handlers.onRequestPermission
      if (!handler) {
        await this.#write({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: `本客户端未注册 session/request_permission 处理器（${AGY_LINK_ERROR.NOT_INITIALIZED}）` },
        }).catch(() => undefined)
        return
      }
      try {
        const outcome = await handler(request.params as RequestPermissionRequest)
        await this.#write({ jsonrpc: '2.0', id: request.id, result: outcome })
      } catch (cause) {
        await this.#write({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32000, message: cause instanceof Error ? cause.message : String(cause) },
        }).catch(() => undefined)
      }
      return
    }
    // 其余 agent→client 方法本阶段未实现，回标准 method-not-found。
    // 先给可选观测回调一个机会（worker2 补丁）：它只旁路记录，不改变回包。
    // 观测回调出错不能让 agent 的请求永远得不到应答，也不能变成 unhandledRejection。
    try {
      await this.#handlers.onUnexpectedAgentRequest?.(request.method, request)
    } catch {
      // 仅旁路观测；照旧回 method-not-found。
    }
    await this.#write({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: `未实现的入站请求方法: ${request.method}` },
    }).catch(() => undefined)
  }

  #routeNotification(notification: AnyNotification): void {
    if (notification.method !== 'session/update') return
    const handler = this.#handlers.onSessionUpdate
    if (!handler) return
    // 回调属于上层（adapter）逻辑：同步抛错会沿 #route → #pump 把整条链路判死，
    // 异步 reject 无人接会变成 unhandledRejection 终止宿主进程。两者都隔离在这里。
    try {
      const outcome = handler(notification.params as SessionNotification)
      if (outcome) void Promise.resolve(outcome).catch(() => undefined)
    } catch {
      // 单条通知处理失败不影响后续消息与在途请求。
    }
  }

  #routeResponse(response: AnyResponse): void {
    const entry = this.#pending.get(response.id)
    if (!entry) return
    this.#pending.delete(response.id)
    clearTimeout(entry.timer)
    const failure = (response as { error?: { code: number; message: string; data?: unknown } }).error
    if (failure) {
      entry.reject(
        new AgentLinkError(AGY_LINK_ERROR.AGENT_REFUSED, `ACP 请求被拒绝 (${entry.method}): ${failure.message}`, {
          jsonRpc: { code: failure.code, message: failure.message, data: failure.data },
        }),
      )
      return
    }
    entry.resolve((response as { result?: unknown }).result)
  }

  #rejectAllPending(error: AgentLinkError): void {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.#pending.clear()
  }

  async #write(message: AnyMessage): Promise<void> {
    if (this.#closed) {
      throw new AgentLinkError(AGY_LINK_ERROR.LINK_CLOSED, 'ACP 链路已关闭，无法写出消息')
    }
    // 单例 writer：WritableStream 只允许一个 writer，并发写必须复用。
    this.#writer ??= this.#stream.writable.getWriter()
    await this.#writer.write(message)
  }

  /** 发出一次请求并等待关联响应；超时同时发出协作式取消通知。 */
  async request<Response = unknown>(method: string, params: unknown, options: AgentLinkRequestOptions = {}): Promise<Response> {
    if (this.#closed) {
      throw new AgentLinkError(AGY_LINK_ERROR.LINK_CLOSED, `ACP 链路已关闭，无法发起请求 ${method}`)
    }
    // signal 在发起前就已中止：不发请求（否则会留下一个无人关心的在途请求）。
    if (options.signal?.aborted) {
      throw new AgentLinkError(AGY_LINK_ERROR.REQUEST_TIMEOUT, `ACP 请求被中止: ${method}`, { cause: options.signal.reason })
    }
    const id: JsonRpcId = this.#nextId++
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs
    const pending = new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        // 协作式取消：JSON-RPC 标准的 $/cancel_request 通知（尽力而为）。
        void this.#write({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: id } }).catch(() => undefined)
        reject(new AgentLinkError(AGY_LINK_ERROR.REQUEST_TIMEOUT, `ACP 请求超时（${timeoutMs}ms）: ${method}`))
      }, timeoutMs)
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method })
    })
    // 写失败路径不会 await 这个 promise：先挂一个 no-op 处理器，保证任何时序下
    // 它的 rejection 都不会变成 unhandledRejection（那会终止宿主进程）。
    // 正常路径仍用 `await pending` 取到同一 rejection，语义不变。
    void pending.catch(() => undefined)
    const abortHandler = () => {
      const entry = this.#pending.get(id)
      if (!entry) return
      this.#pending.delete(id)
      clearTimeout(entry.timer)
      void this.#write({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: id } }).catch(() => undefined)
      entry.reject(new AgentLinkError(AGY_LINK_ERROR.REQUEST_TIMEOUT, `ACP 请求被中止: ${method}`, { cause: options.signal?.reason }))
    }
    options.signal?.addEventListener('abort', abortHandler, { once: true })
    try {
      await this.#write({ jsonrpc: '2.0', id, method, params })
      return await pending
    } catch (error) {
      // 写出失败（对端断流、链路关闭）时 pending 条目没有人消费：必须当场摘除并
      // 清掉超时定时器，否则它会一直留在表里，定时器到期后写出多余的
      // $/cancel_request，并 reject 一个无人等待的 promise。
      const entry = this.#pending.get(id)
      if (entry) {
        this.#pending.delete(id)
        clearTimeout(entry.timer)
      }
      throw error
    } finally {
      options.signal?.removeEventListener('abort', abortHandler)
    }
  }

  /** 发出一条通知（无 id、无响应）。 */
  async notify(method: string, params: unknown): Promise<void> {
    await this.#write({ jsonrpc: '2.0', method, params })
  }

  /**
   * 握手：initialize。请求携带协议版本与客户端信息；握手专用超时触发
   * AGY_HANDSHAKE_TIMEOUT（区别于普通请求超时码）。
   */
  async initialize(params: Partial<InitializeRequest> = {}): Promise<InitializeResponse> {
    try {
      const response = await this.request<InitializeResponse>(
        'initialize',
        {
          protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
          clientInfo: params.clientInfo ?? this.#clientInfo,
          ...params,
        },
        { timeoutMs: this.#handshakeTimeoutMs },
      )
      this.#initialized = true
      this.#initializeResponse = response
      return response
    } catch (error) {
      if (error instanceof AgentLinkError && error.code === AGY_LINK_ERROR.REQUEST_TIMEOUT) {
        throw new AgentLinkError(AGY_LINK_ERROR.HANDSHAKE_TIMEOUT, `ACP initialize 握手超时（${this.#handshakeTimeoutMs}ms）`, { cause: error })
      }
      throw error
    }
  }

  /**
   * 认证；默认官方 personal OAuth 方法。
   *
   * 走**独立的** `authTimeoutMs`（默认 5 分钟）：该流程要人工在浏览器里完成
   * 授权，用普通请求的 30s 超时会在用户还没点完就判死。
   *
   * 超时被改写成 `AGY_AUTH_TIMEOUT` 而不是通用的 `AGY_REQUEST_TIMEOUT`：认证超时
   * 之后重放请求等于重新 spawn 一次官方进程并重新弹一次登录，**不可重试**，必须
   * 与普通请求超时在错误码上分开。
   */
  async authenticate(methodId: AuthMethodId = OAUTH_PERSONAL_AUTH_METHOD): Promise<AuthenticateResponse> {
    this.#requireInitialized('authenticate')
    try {
      return await this.request<AuthenticateResponse>('authenticate', { methodId }, { timeoutMs: this.#authTimeoutMs })
    } catch (error) {
      if (error instanceof AgentLinkError && error.code === AGY_LINK_ERROR.REQUEST_TIMEOUT) {
        throw new AgentLinkError(
          AGY_LINK_ERROR.AUTH_TIMEOUT,
          `ACP authenticate 超时（${this.#authTimeoutMs}ms）：等待人工完成授权未果`,
          { cause: error },
        )
      }
      throw error
    }
  }

  /** 创建会话并保存会话 id。 */
  async newSession(request: NewSessionRequest, options?: AgentLinkRequestOptions): Promise<NewSessionResponse> {
    this.#requireInitialized('session/new')
    const response = await this.request<NewSessionResponse>('session/new', request, options)
    this.#boundSessionId = response.sessionId
    return response
  }

  /** 设置会话配置选项（configId/value 形状按 ACP v1 schema）。 */
  async setConfigOption(params: SetSessionConfigOptionRequest, options?: AgentLinkRequestOptions): Promise<SetSessionConfigOptionResponse> {
    this.#requireInitialized('session/set_config_option')
    return this.request<SetSessionConfigOptionResponse>('session/set_config_option', params, options)
  }

  /** 发送一轮用户 prompt；响应只含 stopReason，流式内容走 session/update。 */
  async prompt(params: PromptRequest, options?: AgentLinkRequestOptions): Promise<PromptResponse> {
    this.#requireInitialized('session/prompt')
    return this.request<PromptResponse>('session/prompt', params, options)
  }

  /** 请求-响应版的权限询问（客户端代用户作答时使用）。 */
  async requestPermission(params: RequestPermissionRequest, options?: AgentLinkRequestOptions): Promise<RequestPermissionResponse> {
    this.#requireInitialized('session/request_permission')
    return this.request<RequestPermissionResponse>('session/request_permission', params, options)
  }

  /** 取消会话当前回合（通知，无响应）。 */
  async cancel(sessionId: string = this.#boundSessionId ?? ''): Promise<void> {
    const payload: CancelNotification = { sessionId }
    await this.notify('session/cancel', payload)
  }

  #requireInitialized(operation: string): void {
    if (!this.#initialized) {
      throw new AgentLinkError(AGY_LINK_ERROR.NOT_INITIALIZED, `调用 ${operation} 前必须先完成 initialize`)
    }
  }

  /**
   * 关闭链接：拒绝所有在途请求、关闭出站流、等待入站泵结束。幂等。
   */
  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true
      this.#rejectAllPending(new AgentLinkError(AGY_LINK_ERROR.LINK_CLOSED, 'ACP 链路已关闭'))
      // 先取消入站泵（对端不关流时 pump 才能结束），再关出站流。
      await this.#reader?.cancel().catch(() => undefined)
      try {
        if (this.#writer) await this.#writer.close()
        else await this.#stream.writable.close()
      } catch {
        // 出站流可能已由对端关闭；忽略。
      }
    }
    await this.#pumpPromise?.catch(() => undefined)
  }
}

/** 把由 ctx.subprocess 启动的子进程 stdio 包装成 ACP JSON-RPC 双向流。 */
export function agentStreamFromSubprocess(handle: SubprocessHandle): Stream {
  if (!handle.stdin || !handle.stdout) {
    throw new AgentLinkError(AGY_LINK_ERROR.LAUNCH_FAILED, '子进程 stdio 不完整（需要 stdin/stdout 均为 pipe），无法建立 ACP 链路')
  }
  const stdinWeb = Writable.toWeb(handle.stdin) as WritableStream<Uint8Array>
  const stdoutWeb = Readable.toWeb(handle.stdout) as ReadableStream<Uint8Array>
  return ndJsonStream(stdinWeb, stdoutWeb)
}

/**
 * PyInstaller 冻结的官方 exe 需要可写 TEMP。DSH subprocess 会 scrub 父环境，
 * 只显式传入的键会保留；若不转发 TMP/TEMP，bootloader 报
 * `[PYI-…:ERROR] Could not create temporary directory!` 后立刻退出。
 */
export function officialAgentEnv(options: {
  binaryDir: string
  tmpDir: string
  /** 出网代理；留空则不注入任何代理变量（官方进程直连）。 */
  proxy?: ProxySettings | undefined
  parent?: NodeJS.ProcessEnv
}): NodeJS.ProcessEnv {
  const parent = options.parent ?? process.env
  const pathPrefix = `${options.binaryDir}${delimiter}`
  const parentPath = parent.PATH ?? ''
  const env: NodeJS.ProcessEnv = {
    PATH: parentPath.startsWith(pathPrefix) ? parentPath : `${pathPrefix}${parentPath}`,
    TEMP: options.tmpDir,
    TMP: options.tmpDir,
    TMPDIR: options.tmpDir,
  }
  const forward = [
    'USERPROFILE',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'APPDATA',
    'USERNAME',
    'USERDOMAIN',
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'WINDIR',
    'ComSpec',
    'COMSPEC',
    'PATHEXT',
    'SystemDrive',
  ] as const
  for (const key of forward) {
    const value = parent[key]
    if (value) env[key] = value
  }
  if (!env.SystemRoot && process.platform === 'win32') env.SystemRoot = 'C:\\Windows'
  // 代理放在最后合并：用户配置优先；未配置时转发宿主自身的代理环境，避免出现
  // 「宿主走代理、官方进程直连」的分裂路由（本机直连 Google 不通）。
  Object.assign(env, options.proxy ? buildProxyEnv(options.proxy) : ambientProxyEnv(parent))
  return env
}

/** 经 ctx.subprocess 启动官方 ACP server（本文件不触碰 child_process）。 */
export function launchAcpAgent(
  subprocess: SubprocessRuntime,
  options: {
    executable: string
    extraArgs?: readonly string[]
    cwd?: string
    tmpDir: string
    proxy?: ProxySettings | undefined
    signal?: AbortSignal
  },
): SubprocessHandle {
  const executable = options.executable
  const binaryDir = dirname(executable)
  // 官方 zip 带 sibling（如 localharness_external.exe）。cwd 必须是二进制目录，
  // 否则 Windows 上进程立刻退出，stdout EOF，上层只会看到「ACP 链路已关闭」。
  const cwd = options.cwd ?? binaryDir
  return subprocess.spawn({
    argv: [executable, ...(options.extraArgs ?? [])],
    cwd,
    env: officialAgentEnv({ binaryDir, tmpDir: options.tmpDir, proxy: options.proxy }),
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
    graceMs: 5_000,
    signal: options.signal,
  })
}
