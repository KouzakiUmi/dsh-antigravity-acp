import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PooledAcpAdapter, type AcpWorker } from '../src/pool/pooled-adapter.js'
import type { AcpLifecycleSnapshot } from '../src/runtime/lifecycle.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

type Completion = 'finish' | 'park'
class FakeWorker implements AcpWorker {
  busy = false
  running = false
  calls: Array<{ options: GenerateOptions; complete(value: Completion): void }> = []
  catalog: LlmModelInfo[] = []
  resolved: LlmResolvedModelInfo = { provider: 'test', id: 'model', name: 'Model', inputModalities: ['text'] }
  warmupGate: ReturnType<typeof deferred<void>> | undefined
  discoveryGate: ReturnType<typeof deferred<void>> | undefined
  preparationGate: ReturnType<typeof deferred<void>> | undefined
  preparationSignals: Array<AbortSignal | undefined> = []
  disposeGate: ReturnType<typeof deferred<void>> | undefined
  counters = { starts: 1, reuses: 2, recycles: 3 }

  constructor(readonly index: number) {}

  adapter: AcpWorker['adapter'] = {
    get busy() { return owner(this).busy },
    stream: (options) => this.stream(options),
    listModels: vi.fn(async () => this.catalog),
    resolveModel: vi.fn(async () => this.resolved),
    warmup: vi.fn(async () => { this.running = true; await this.warmupGate?.promise }),
    discoverModels: vi.fn(async () => { this.running = true; await this.discoveryGate?.promise; return this.catalog }),
    prepareCall: vi.fn(async (_provider, _model, signal) => {
      this.running = true
      this.preparationSignals.push(signal)
      if (this.preparationGate) {
        let abort!: () => void
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => reject(Object.assign(new Error('Preparation cancelled'), { code: 'AGY_TURN_ABORTED' }))
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
        })
        try { await Promise.race([this.preparationGate.promise, cancelled]) }
        finally { signal?.removeEventListener('abort', abort) }
      }
      return { model: this.resolved, stream: (options: GenerateOptions) => this.stream(options) }
    }),
  }

  private async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const gate = deferred<Completion>()
    this.calls.push({ options, complete: gate.resolve })
    this.running = true
    this.busy = true
    const result = await gate.promise
    this.busy = result === 'park'
    yield { type: 'text-delta', index: 0, text: `worker-${this.index}` }
    yield { type: 'finish', reason: { kind: result === 'park' ? 'tool-calls' : 'stop' } }
  }

  read(): AcpLifecycleSnapshot {
    return { phase: this.busy ? 'prompt' : this.running ? 'ready' : 'idle', phaseElapsedMs: 0, processRunning: this.running, ...this.counters }
  }

  dispose = vi.fn(async () => {
    for (const call of this.calls) call.complete('finish')
    this.warmupGate?.resolve()
    this.discoveryGate?.resolve()
    this.preparationGate?.resolve()
    this.busy = false
    this.running = false
    await this.disposeGate?.promise
  })
}

// The getter has to be attached to the structural adapter object rather than a fake base class.
const owners = new WeakMap<AcpWorker['adapter'], FakeWorker>()
function owner(adapter: AcpWorker['adapter']): FakeWorker { return owners.get(adapter)! }
const pools: PooledAcpAdapter[] = []
function setup(options: { capacity?: number; queueTimeoutMs?: number } = {}) {
  const workers: FakeWorker[] = []
  const pool = new PooledAcpAdapter(() => {
    const worker = new FakeWorker(workers.length)
    owners.set(worker.adapter, worker)
    workers.push(worker)
    return worker
  }, options)
  pools.push(pool)
  return { pool, workers }
}

function request(sessionId: string, overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'test', model: 'model', messages: [], sessionId: sessionId as GenerateOptions['sessionId'], ...overrides }
}

async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve() }
function run(pool: PooledAcpAdapter, options: GenerateOptions) {
  return (async () => { const chunks: StreamChunk[] = []; for await (const chunk of pool.stream(options)) chunks.push(chunk); return chunks })()
}
function outcome<T>(promise: Promise<T>) {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
}

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.dispose()
  vi.useRealTimers()
})

describe('PooledAcpAdapter scheduling with independent fake workers', () => {
  it('runs different sessions concurrently up to capacity and queues the third', async () => {
    const { pool, workers } = setup({ capacity: 2 })
    const a = run(pool, request('a'))
    const b = run(pool, request('b'))
    const c = run(pool, request('c'))
    await flush()
    expect(workers).toHaveLength(2)
    expect(workers.map(w => w.calls.length)).toEqual([1, 1])
    expect(pool.read().queue).toMatchObject({ active: 2, waiting: 1, capacity: 2, workers: 2 })
    workers[0]!.calls[0]!.complete('finish')
    await a
    await flush()
    expect(workers[0]!.calls[1]!.options.sessionId).toBe('c')
    workers[0]!.calls[1]!.complete('finish')
    workers[1]!.calls[0]!.complete('finish')
    await Promise.all([b, c])
    expect(pool.read().queue).toMatchObject({ active: 0, waiting: 0, parked: 0 })
  })

  it('routes a parked owner back to its worker while another session continues', async () => {
    const { pool, workers } = setup()
    const a = run(pool, request('a'))
    await flush()
    workers[0]!.calls[0]!.complete('park')
    await a
    expect(pool.read().queue?.parked).toBe(1)
    const b = run(pool, request('b'))
    const resumed = run(pool, request('a'))
    await flush()
    expect(workers[0]!.calls.map(call => call.options.sessionId)).toEqual(['a', 'a'])
    expect(workers[1]!.calls.map(call => call.options.sessionId)).toEqual(['b'])
    workers[0]!.calls[1]!.complete('finish')
    workers[1]!.calls[0]!.complete('finish')
    await Promise.all([b, resumed])
  })

  it('keeps overlapping requests of the same owner on one worker', async () => {
    const { pool, workers } = setup()
    const first = run(pool, request('a'))
    const second = run(pool, request('a'))
    await flush()
    expect(workers).toHaveLength(1)
    expect(pool.read().queue).toMatchObject({ active: 1, waiting: 1 })
    workers[0]!.calls[0]!.complete('finish')
    await first
    await flush()
    workers[0]!.calls[1]!.complete('finish')
    await second
  })

  it('prioritizes foreground work over a title already queued', async () => {
    const { pool, workers } = setup({ capacity: 1 })
    const busy = run(pool, request('busy'))
    const title = run(pool, request('title', { purpose: 'session-title' }))
    const chat = run(pool, request('chat'))
    await flush()
    workers[0]!.calls[0]!.complete('finish')
    await busy
    await flush()
    expect(workers[0]!.calls[1]!.options.sessionId).toBe('chat')
    workers[0]!.calls[1]!.complete('finish')
    await chat
    await flush()
    expect(workers[0]!.calls[2]!.options.purpose).toBe('session-title')
    workers[0]!.calls[2]!.complete('finish')
    await title
  })

  it('rejects a full queue but still accepts the parked owner needed to release it', async () => {
    const { pool, workers } = setup({ capacity: 1 })
    const first = run(pool, request('owner'))
    await flush()
    workers[0]!.calls[0]!.complete('park')
    await first
    const waiting = Array.from({ length: 64 }, (_, i) => outcome(run(pool, request(`queued-${i}`))))
    const rejected = await outcome(run(pool, request('overflow')))
    expect(rejected).toMatchObject({ ok: false, error: { code: 'AGY_QUEUE_FULL' } })
    const resumed = outcome(run(pool, request('owner')))
    await flush()
    expect(workers[0]!.calls[1]?.options.sessionId).toBe('owner')
    workers[0]!.calls[1]?.complete('finish')
    expect((await resumed).ok).toBe(true)
    await pool.dispose()
    await Promise.all(waiting)
  })

  it('times out waiting requests without disturbing the active worker', async () => {
    vi.useFakeTimers()
    const { pool, workers } = setup({ capacity: 1, queueTimeoutMs: 1_000 })
    const active = run(pool, request('active'))
    const waiting = outcome(run(pool, request('waiting')))
    await flush()
    await vi.advanceTimersByTimeAsync(1_001)
    expect(await waiting).toMatchObject({ ok: false, error: { code: 'AGY_QUEUE_TIMEOUT' } })
    expect(workers[0]!.calls).toHaveLength(1)
    expect(pool.read().queue).toMatchObject({ active: 1, waiting: 0 })
    workers[0]!.calls[0]!.complete('finish')
    await active
  })

  it('honors abort before queueing and while waiting without starting the request', async () => {
    const { pool, workers } = setup({ capacity: 1 })
    const active = run(pool, request('active'))
    const already = new AbortController()
    already.abort()
    expect(await outcome(run(pool, request('already', { signal: already.signal })))).toMatchObject({ ok: false, error: { code: 'AGY_TURN_ABORTED' } })
    const controller = new AbortController()
    const waiting = outcome(run(pool, request('waiting', { signal: controller.signal })))
    controller.abort()
    expect(await waiting).toMatchObject({ ok: false, error: { code: 'AGY_TURN_ABORTED' } })
    expect(pool.read().queue?.waiting).toBe(0)
    expect(workers[0]!.calls).toHaveLength(1)
    workers[0]!.calls[0]!.complete('finish')
    await active
  })

  it('rejects queued and future work on disposal and disposes every worker', async () => {
    const { pool, workers } = setup()
    const a = outcome(run(pool, request('a')))
    const b = outcome(run(pool, request('b')))
    const waiting = outcome(run(pool, request('waiting')))
    await flush()
    await pool.dispose()
    expect(await waiting).toMatchObject({ ok: false, error: { code: 'AGY_LINK_CLOSED' } })
    expect(await outcome(run(pool, request('later')))).toMatchObject({ ok: false, error: { code: 'AGY_LINK_CLOSED' } })
    expect(workers.every(worker => worker.dispose.mock.calls.length === 1)).toBe(true)
    await Promise.all([a, b])
  })

  it('merges catalogs and picks measured context metadata from an available worker', async () => {
    const { pool, workers } = setup()
    const a = run(pool, request('a'))
    const b = run(pool, request('b'))
    await flush()
    workers[0]!.catalog = [{ provider: 'test', id: 'one', name: 'One' }]
    workers[1]!.catalog = [{ provider: 'test', id: 'one', name: 'One updated' }, { provider: 'test', id: 'two', name: 'Two', inputModalities: ['text', 'image'] }]
    workers[1]!.resolved = { ...workers[1]!.resolved, context: { contextWindow: 123_456 }, inputModalities: ['text', 'image'] }
    expect((await pool.listModels('test')).map(model => model.id)).toEqual(['one', 'two'])
    expect(await pool.resolveModel('test', 'model')).toMatchObject({ context: { contextWindow: 123_456 }, inputModalities: ['text', 'image'] })
    expect(pool.read()).toMatchObject({ starts: 2, reuses: 4, recycles: 6 })
    workers[0]!.calls[0]!.complete('finish')
    workers[1]!.calls[0]!.complete('finish')
    await Promise.all([a, b])
  })

  it('reserves a worker for warmup and queues chat until preparation finishes', async () => {
    const { pool, workers } = setup({ capacity: 1 })
    workers[0]!.warmupGate = deferred<void>()
    const warmup = pool.warmup()
    const chat = run(pool, request('chat'))
    await flush()
    expect(workers[0]!.adapter.warmup).toHaveBeenCalledTimes(1)
    expect(workers[0]!.calls).toHaveLength(0)
    expect(pool.read().queue).toMatchObject({ active: 1, waiting: 1 })
    workers[0]!.warmupGate.resolve()
    await warmup
    await flush()
    workers[0]!.calls[0]!.complete('finish')
    await chat
  })

  it('does not warm an active worker and performs discovery on a separate free worker', async () => {
    const { pool, workers } = setup()
    const chat = run(pool, request('chat'))
    await flush()
    await pool.warmup()
    expect(workers[0]!.adapter.warmup).not.toHaveBeenCalled()
    await pool.discoverModels()
    expect(workers).toHaveLength(2)
    expect(workers[0]!.adapter.discoverModels).not.toHaveBeenCalled()
    expect(workers[1]!.adapter.discoverModels).toHaveBeenCalledTimes(1)
    workers[0]!.calls[0]!.complete('finish')
    await chat
  })

  it('queues discovery instead of interrupting a parked owner', async () => {
    const { pool, workers } = setup({ capacity: 1 })
    const first = run(pool, request('owner'))
    await flush()
    workers[0]!.calls[0]!.complete('park')
    await first
    const discovery = pool.discoverModels()
    await flush()
    expect(workers[0]!.adapter.discoverModels).not.toHaveBeenCalled()
    const resumed = run(pool, request('owner', { purpose: 'compaction' }))
    await flush()
    expect(workers[0]!.calls[1]?.options.purpose).toBe('compaction')
    workers[0]!.calls[1]!.complete('finish')
    await resumed
    await discovery
    expect(workers[0]!.adapter.discoverModels).toHaveBeenCalledTimes(1)
  })

  it('shares initial capability preparation and dispatches the prepared call through the pool', async () => {
    const { pool, workers } = setup()
    workers[0]!.preparationGate = deferred<void>()
    const first = pool.prepareCall('test', 'model')
    const second = pool.prepareCall('test', 'model')
    await flush()
    expect(workers).toHaveLength(1)
    expect(workers[0]!.adapter.prepareCall).toHaveBeenCalledTimes(1)
    expect(pool.read().queue?.active).toBe(1)
    workers[0]!.preparationGate.resolve()
    const [prepared] = await Promise.all([first, second])
    expect(pool.read().queue?.active).toBe(0)
    const stream = prepared!.stream(request('prepared'))[Symbol.asyncIterator]()
    const chunk = stream.next()
    await flush()
    expect(workers[0]!.calls[0]?.options.sessionId).toBe('prepared')
    workers[0]!.calls[0]!.complete('finish')
    expect((await chunk).value).toMatchObject({ type: 'text-delta', text: 'worker-0' })
    await stream.return?.()
  })

  it('allows one capability-preparation waiter to abort without cancelling another', async () => {
    const { pool, workers } = setup()
    workers[0]!.preparationGate = deferred<void>()
    const first = pool.prepareCall('test', 'model')
    const controller = new AbortController()
    const cancelled = outcome(pool.prepareCall('test', 'model', controller.signal))
    let result: Awaited<typeof cancelled> | undefined
    void cancelled.then(value => { result = value })
    await flush()
    controller.abort()
    await flush()
    expect(result).toMatchObject({ ok: false, error: { code: 'AGY_TURN_ABORTED' } })
    expect(workers[0]!.adapter.prepareCall).toHaveBeenCalledTimes(1)
    workers[0]!.preparationGate.resolve()
    expect((await first).model.id).toBe('model')
  })

  it('rejects preparation after disposal even when capability discovery had completed', async () => {
    const { pool } = setup()
    await pool.prepareCall('test', 'model')
    await pool.dispose()
    expect(await outcome(pool.prepareCall('test', 'model'))).toMatchObject({ ok: false, error: { code: 'AGY_LINK_CLOSED' } })
  })

  it('aborts shared initialization only after its last waiter leaves and permits a fresh attempt', async () => {
    const { pool, workers } = setup()
    workers[0]!.preparationGate = deferred<void>()
    const firstController = new AbortController()
    const lastController = new AbortController()
    const first = outcome(pool.prepareCall('test', 'model', firstController.signal))
    const last = outcome(pool.prepareCall('test', 'model', lastController.signal))
    await flush()
    const sharedSignal = workers[0]!.preparationSignals[0]!
    firstController.abort()
    expect(await first).toMatchObject({ ok: false, error: { code: 'AGY_TURN_ABORTED' } })
    expect(sharedSignal.aborted).toBe(false)
    lastController.abort()
    expect(await last).toMatchObject({ ok: false, error: { code: 'AGY_TURN_ABORTED' } })
    expect(sharedSignal.aborted).toBe(true)
    await flush()
    expect(pool.read().queue?.active).toBe(0)
    workers[0]!.preparationGate = deferred<void>()
    const retry = pool.prepareCall('test', 'model')
    await flush()
    expect(workers[0]!.adapter.prepareCall).toHaveBeenCalledTimes(2)
    expect(workers[0]!.preparationSignals[1]?.aborted).toBe(false)
    workers[0]!.preparationGate.resolve()
    expect((await retry).model.id).toBe('model')
  })

  it('shares disposal completion across concurrent callers and disposes each worker once', async () => {
    const { pool, workers } = setup()
    workers[0]!.disposeGate = deferred<void>()
    const first = pool.dispose()
    const second = pool.dispose()
    let secondFinished = false
    void second.then(() => { secondFinished = true })
    await flush()
    const finishedBeforeCleanup = secondFinished
    workers[0]!.disposeGate.resolve()
    await Promise.all([first, second])
    expect(finishedBeforeCleanup).toBe(false)
    expect(workers[0]!.dispose).toHaveBeenCalledTimes(1)
    await pool.dispose()
    expect(workers[0]!.dispose).toHaveBeenCalledTimes(1)
  })

  it('repeats capability discovery after host services invalidate a completed preparation', async () => {
    const { pool, workers } = setup()
    await pool.prepareCall('test', 'model')
    await pool.prepareCall('test', 'model')
    expect(workers[0]!.adapter.prepareCall).toHaveBeenCalledTimes(1)
    pool.invalidatePreparation()
    workers[0]!.resolved = { ...workers[0]!.resolved, inputModalities: ['text', 'image'] }
    const refreshed = await pool.prepareCall('test', 'model')
    expect(workers[0]!.adapter.prepareCall).toHaveBeenCalledTimes(2)
    expect(refreshed.model.inputModalities).toEqual(['text', 'image'])
  })

  it('does not let an old in-flight completion consume a newer invalidation', async () => {
    const { pool, workers } = setup()
    const oldGate = deferred<void>()
    const freshGate = deferred<void>()
    workers[0]!.preparationGate = oldGate
    const first = pool.prepareCall('test', 'model')
    await flush()
    expect(workers[0]!.adapter.prepareCall).toHaveBeenCalledTimes(1)
    pool.invalidatePreparation()
    workers[0]!.preparationGate = freshGate
    const second = pool.prepareCall('test', 'model')
    let secondCompleted = false
    void second.then(() => { secondCompleted = true })
    oldGate.resolve()
    await flush()
    expect(workers[0]!.adapter.prepareCall).toHaveBeenCalledTimes(2)
    expect(secondCompleted).toBe(false)
    freshGate.resolve()
    await Promise.all([first, second])
    await pool.prepareCall('test', 'model')
    expect(workers[0]!.adapter.prepareCall).toHaveBeenCalledTimes(2)
  })

  it('passes the requested interactive-auth policy to model discovery', async () => {
    const { pool, workers } = setup()
    const controller = new AbortController()
    await pool.discoverModels(controller.signal, false)
    expect(workers[0]!.adapter.discoverModels).toHaveBeenLastCalledWith(controller.signal, false)
    await pool.discoverModels(controller.signal)
    expect(workers[0]!.adapter.discoverModels).toHaveBeenLastCalledWith(controller.signal, true)
  })
})
