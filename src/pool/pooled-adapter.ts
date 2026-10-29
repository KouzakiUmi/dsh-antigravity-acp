import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AcpLifecycleSnapshot } from '../runtime/lifecycle.js'
import type { AntigravityAcpAdapter } from '../adapter/antigravity-adapter.js'
import { AGY_TURN_ERROR } from '../adapter/prompt-turn.js'

/** Workers own independent transports, bridges and prompt state. No tool execution lives here. */
export interface AcpWorker {
  adapter: Pick<AntigravityAcpAdapter, 'busy' | 'stream' | 'listModels' | 'resolveModel' | 'warmup' | 'discoverModels'> & Partial<Pick<AntigravityAcpAdapter, 'prepareCall'>>
  ensureImages?: (signal?: AbortSignal) => Promise<void>
  read(): AcpLifecycleSnapshot
  dispose(): Promise<void>
}
interface Slot {
  worker: AcpWorker
  leased: boolean
  owner?: Pick<GenerateOptions, 'sessionId' | 'purpose'>
  /** 最近一次服务过的 DSH 对话：新对话优先用别的 worker，避免抢走别人的复用会话。 */
  lastOwner?: string
}
interface Waiter {
  options?: GenerateOptions
  resolve(slot: Slot): void
  reject(error: unknown): void
  cleanup(): void
}

export class PooledAcpAdapter extends LlmAdapter {
  private readonly slots: Slot[] = []
  private readonly waiters: Waiter[] = []
  /** DSH 对话 → 承载它的 worker 下标：会话复用记录在 worker 内部，换 worker 即丢失。 */
  private readonly affinity = new Map<string, number>()
  private closed = false
  private poll?: ReturnType<typeof setInterval>
  private readonly capacity: number
  private readonly queueTimeoutMs: number
  private readonly readSessionAffinity: () => boolean
  private get sessionAffinity(): boolean { return this.readSessionAffinity() }
  private preparation?: Promise<void>
  private preparationAbort?: AbortController
  private preparationWaiters = 0
  private prepared = false
  private preparationGeneration = 0
  private disposal?: Promise<void>

  constructor(private readonly create: () => AcpWorker, options: { capacity?: number; queueTimeoutMs?: number; sessionAffinity?: boolean | (() => boolean) } = {}) {
    super()
    this.capacity = Math.max(1, Math.min(4, Math.floor(options.capacity ?? 2)))
    this.queueTimeoutMs = Math.max(1_000, options.queueTimeoutMs ?? 120_000)
    const affinity = options.sessionAffinity ?? true
    this.readSessionAffinity = typeof affinity === 'function' ? affinity : () => affinity
    this.addSlot()
  }

  get busy(): boolean { return this.slots.some(s => s.leased || s.worker.adapter.busy) }
  override providerInfo(provider: string) { return { id: provider, name: 'Antigravity (ACP)' } }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const lists = await Promise.all(this.slots.map(s => s.worker.adapter.listModels(provider)))
    return [...new Map(lists.flat().map(m => [m.id, m])).values()]
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const models = await Promise.all(this.slots.map(s => s.worker.adapter.resolveModel(provider, model, signal)))
    const first = models[0]
    if (!first) throw new LlmError('ACP 没有可用的模型元数据', 'AGY_MODEL_UNAVAILABLE')
    const known = models.find(m => m.name !== m.id)
    const reasoning = mergeReasoning(models)
    const modalities = models.every(m => m.inputModalities !== undefined)
      ? models.map(m => m.inputModalities!).reduce((supported, entries) => supported.filter(entry => entries.includes(entry)))
      : undefined
    return {
      ...first,
      inputModalities: undefined,
      ...(modalities === undefined ? {} : { inputModalities: modalities }),
      ...(known ? { name: known.name, ...(known.description === undefined ? {} : { description: known.description }) } : {}),
      ...(models.some(m => m.context !== undefined) ? { context: models.find(m => m.context !== undefined)!.context } : {}),
      ...(reasoning ? { reasoning } : {}),
    }
  }

  /** Recheck capabilities when host services change, without interrupting active callers. */
  invalidatePreparation(): void {
    this.preparationGeneration++
    this.prepared = false
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    if (this.closed) throw new LlmError('ACP 插件已卸载', 'AGY_LINK_CLOSED')
    if (signal?.aborted) throw new LlmError('ACP 请求已取消', AGY_TURN_ERROR.ABORTED)
    // Discover input capabilities before DSH projects attachments into a text-only request.
    while (!this.prepared) {
      if (this.closed) throw new LlmError('ACP 插件已卸载', 'AGY_LINK_CLOSED')
      if (signal?.aborted) throw new LlmError('ACP 请求已取消', AGY_TURN_ERROR.ABORTED)
      if (!this.preparation) {
        const controller = new AbortController()
        const generation = this.preparationGeneration
        this.preparationAbort = controller
        const preparation = (async () => {
          const slot = await this.acquire(undefined, controller.signal)
          try {
            await slot.worker.adapter.prepareCall?.(provider, model, controller.signal)
            if (!controller.signal.aborted && !this.closed && generation === this.preparationGeneration) this.prepared = true
          } finally { slot.leased = false; this.dispatch() }
        })().finally(() => {
          if (this.preparation === preparation) { this.preparation = undefined; this.preparationAbort = undefined }
        })
        this.preparation = preparation
      }
      this.preparationWaiters++
      try { await waitWithSignal(this.preparation, signal) }
      finally {
        this.preparationWaiters--
        if (!this.preparationWaiters && !this.prepared) this.preparationAbort?.abort()
      }
    }
    if (this.closed) throw new LlmError('ACP 插件已卸载', 'AGY_LINK_CLOSED')
    return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options) }
  }
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const slot = await this.acquire(options, options.signal)
    try {
      // 握手失败或取消也必须归还槽位，不能让池被一次图片准备错误耗尽。
      if (slot.worker.ensureImages && hasImageInput(options)) await slot.worker.ensureImages(options.signal)
      slot.owner = { sessionId: options.sessionId, purpose: options.purpose }
      // 粘住承载该对话的 worker：ACP 会话复用记录在 worker 内部。
      const affinityKey = this.affinityKey(options)
      if (affinityKey !== undefined) this.rememberAffinity(affinityKey, this.slots.indexOf(slot))
      yield* slot.worker.adapter.stream(options)
    } finally {
      slot.leased = false
      if (!slot.worker.adapter.busy) slot.owner = undefined
      if (this.sessionAffinity && options.sessionId !== undefined && options.purpose === undefined) slot.lastOwner = options.sessionId
      this.dispatch()
    }
  }

  async warmup(signal?: AbortSignal): Promise<void> {
    // An active worker already has a connection; warming a second worker is unnecessary.
    if (this.busy) return
    const slot = await this.acquire(undefined, signal)
    try { await slot.worker.adapter.warmup(signal) }
    finally { slot.leased = false; this.dispatch() }
  }

  async discoverModels(signal?: AbortSignal, interactive = true): Promise<readonly LlmModelInfo[]> {
    const slot = await this.acquire(undefined, signal)
    try { return await slot.worker.adapter.discoverModels(signal, interactive) }
    finally { slot.leased = false; this.dispatch() }
  }

  read(): AcpLifecycleSnapshot {
    const rows = this.slots.map(s => s.worker.read())
    const index = this.slots.findIndex(s => s.leased || s.worker.adapter.busy)
    const current = rows[index >= 0 ? index : rows.findIndex(r => r.processRunning)] ?? rows[0]!
    return {
      ...current,
      starts: rows.reduce((n, r) => n + r.starts, 0),
      reuses: rows.reduce((n, r) => n + r.reuses, 0),
      recycles: rows.reduce((n, r) => n + r.recycles, 0),
      processRunning: rows.some(r => r.processRunning),
      queue: {
        active: this.slots.filter(s => s.leased).length,
        waiting: this.waiters.length,
        capacity: this.capacity,
        workers: rows.filter(r => r.processRunning).length,
        parked: this.slots.filter(s => !s.leased && s.worker.adapter.busy).length,
      },
    }
  }

  dispose(): Promise<void> {
    this.disposal ??= this.disposeWorkers()
    return this.disposal
  }

  private async disposeWorkers(): Promise<void> {
    this.closed = true
    this.preparationAbort?.abort()
    if (this.poll) clearInterval(this.poll)
    this.poll = undefined
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup()
      waiter.reject(new LlmError('ACP 插件已卸载', 'AGY_LINK_CLOSED'))
    }
    const results = await Promise.allSettled(this.slots.map(s => s.worker.dispose()))
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) throw failed.reason
  }

  private addSlot(): Slot {
    const slot = { worker: this.create(), leased: false }
    this.slots.push(slot)
    return slot
  }

  /** 只有普通聊天轮参与粘性；标题/压缩等一次性请求不占用会话绑定。 */
  private affinityKey(options?: GenerateOptions): string | undefined {
    if (!this.sessionAffinity || !options?.sessionId || options.purpose !== undefined) return undefined
    return options.sessionId
  }

  private rememberAffinity(key: string, index: number): void {
    if (index < 0) return
    this.affinity.delete(key)
    this.affinity.set(key, index)
    while (this.affinity.size > 64) {
      const oldest = this.affinity.keys().next().value
      if (oldest === undefined) break
      this.affinity.delete(oldest)
    }
  }

  private select(options?: GenerateOptions): Slot | undefined {
    // Preserve ownership across tool-result calls, including synchronous compaction.
    const owner = options && this.slots.find(s => s.owner
      && (s.leased || s.worker.adapter.busy)
      && s.owner.sessionId === options.sessionId
      && (s.owner.purpose === options.purpose || options.purpose === 'compaction'))
    if (owner) return owner.leased ? undefined : owner
    // 已有归属的 DSH 对话只等它自己的 worker：换一个 worker 会丢掉 ACP 会话
    // 复用记录，退化成每轮重建。没有归属（或记录已被淘汰）时照常调度。
    const affinityKey = this.affinityKey(options)
    if (affinityKey !== undefined) {
      const pinned = this.slots[this.affinity.get(affinityKey) ?? -1]
      // 空闲就用自己的 worker（保住 ACP 会话复用）；被别的对话占用时不硬等——
      // 宁可这一轮换 worker 重建会话，也不让用户看着「没反应」。同一对话自己的
      // 并发请求由上面的 owner 分支负责排队，不会走到这里。
      if (pinned && !pinned.leased && !pinned.worker.adapter.busy) return pinned
    }
    const free = this.slots.filter(s => !s.leased && !s.worker.adapter.busy)
    if (free.length > 0) {
      // 开启会话粘性时，新对话优先用没服务过任何对话的 worker；都在服务过时，
      // 容量允许就先扩容——避免已有对话的复用会话被顺手接管。关闭粘性时保持
      // 旧的纯负载调度（不额外 spawn）。
      if (affinityKey !== undefined) {
        const unbound = free.find(s => s.lastOwner === undefined)
        if (unbound) return unbound
        if (this.slots.length < this.capacity) return this.addSlot()
      }
      return free[0]
    }
    if (this.slots.length < this.capacity) return this.addSlot()
    return undefined
  }

  private acquire(options: GenerateOptions | undefined, signal?: AbortSignal): Promise<Slot> {
    if (this.closed) return Promise.reject(new LlmError('ACP 插件已卸载', 'AGY_LINK_CLOSED'))
    if (signal?.aborted) return Promise.reject(new LlmError('ACP 请求在排队前已取消', AGY_TURN_ERROR.ABORTED))
    // Tool results release parked work and must never be refused by an unrelated full queue.
    const owner = options && this.slots.find(s => !s.leased && s.worker.adapter.busy && s.owner
      && s.owner.sessionId === options.sessionId
      && (s.owner.purpose === options.purpose || options.purpose === 'compaction'))
    if (owner) { owner.leased = true; return Promise.resolve(owner) }
    if (this.waiters.length >= 64) return Promise.reject(new LlmError('ACP 等待队列已满，请稍后重试', 'AGY_QUEUE_FULL'))
    return new Promise((resolve, reject) => {
      const remove = (error: LlmError): void => {
        const index = this.waiters.indexOf(waiter)
        if (index < 0) return
        this.waiters.splice(index, 1)
        waiter.cleanup()
        reject(error)
        this.dispatch()
      }
      const abort = (): void => remove(new LlmError('ACP 请求在等待连接时已取消', AGY_TURN_ERROR.ABORTED))
      const timer = setTimeout(() => remove(new LlmError('ACP 连接繁忙，等待超时；请完成其他对话的工具审批或稍后重试', 'AGY_QUEUE_TIMEOUT')), this.queueTimeoutMs)
      const waiter: Waiter = { options, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) } }
      signal?.addEventListener('abort', abort, { once: true })
      this.waiters.push(waiter)
      if (signal?.aborted) abort()
      this.dispatch()
    })
  }

  private dispatch(): void {
    if (this.closed) return
    // Stable sort keeps FIFO within a priority. A blocked owner does not block other sessions.
    this.waiters.sort((a, b) => Number(a.options?.purpose === 'session-title') - Number(b.options?.purpose === 'session-title'))
    for (const waiter of [...this.waiters]) {
      let slot: Slot | undefined
      try { slot = this.select(waiter.options) }
      catch (error) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.cleanup(); waiter.reject(error)
        continue
      }
      if (!slot) continue
      slot.leased = true
      // Set the owner synchronously, before a second request can acquire another worker.
      if (waiter.options) slot.owner = { sessionId: waiter.options.sessionId, purpose: waiter.options.purpose }
      else slot.owner = undefined
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      waiter.cleanup(); waiter.resolve(slot)
    }
    // Parked prompts can be aborted by their existing signal while no stream is running.
    if (this.waiters.length && !this.poll) { this.poll = setInterval(() => this.dispatch(), 100); this.poll.unref() }
    if (!this.waiters.length && this.poll) { clearInterval(this.poll); this.poll = undefined }
  }
}

function hasImageInput(options: GenerateOptions): boolean {
  return options.messages.some(message => message.role === 'tool'
    ? message.content.some(block => block.type === 'image')
    : Array.isArray(message.content) && message.content.some(block => block.type === 'image'))
}

const effortOrder: Record<string, number> = { low: 0, medium: 1, high: 2 }
function mergeReasoning(models: readonly LlmResolvedModelInfo[]): LlmResolvedModelInfo['reasoning'] {
  const known = models.filter(model => model.reasoning !== undefined)
  if (known.length === 0) return undefined
  const efforts = [...new Map(known.flatMap(model => model.reasoning!.efforts).map(entry => [entry.id.toString(), entry])).values()]
    .sort((a, b) => (effortOrder[a.id.toString()] ?? 99) - (effortOrder[b.id.toString()] ?? 99))
  const preferred = known.map(model => model.reasoning!.defaultEffort?.toString()).find(value => value !== undefined)
  const fallback = efforts.find(entry => entry.id.toString() === preferred) ?? efforts.find(entry => entry.id.toString() === 'medium')
  return { efforts, ...(fallback ? { defaultEffort: fallback.id } : {}) }
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(new LlmError('ACP 请求已取消', AGY_TURN_ERROR.ABORTED)) }
    const cleanup = (): void => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) abort()
  })
}
