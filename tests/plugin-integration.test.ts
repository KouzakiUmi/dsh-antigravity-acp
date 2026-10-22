import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AntigravityAcpAdapterOptions } from '../src/adapter/antigravity-adapter.js'
import type { SettingsControl } from '../src/quota/control.js'
import { PooledAcpAdapter } from '../src/pool/pooled-adapter.js'
import { apply } from '../src/index.js'

interface WorkerStub {
  options: AntigravityAcpAdapterOptions
  close: Mock
  prepareCall: Mock
  discoverModels: Mock
}

const external = vi.hoisted(() => ({
  workers: [] as WorkerStub[],
  events: [] as string[],
  fetch: vi.fn(async () => { throw new Error('Unexpected network request') }),
  fetchClose: vi.fn(async () => {}),
  cli: vi.fn(async () => { throw new Error('Unexpected CLI invocation') }),
  download: vi.fn(async () => { throw new Error('Unexpected binary startup') }),
}))

vi.mock('../src/runtime/binary.js', async (original) => ({
  ...await original<typeof import('../src/runtime/binary.js')>(),
  cleanupStaleRuntimeDirectories: vi.fn(async () => 0),
  cleanupStaleStagingDirs: vi.fn(async () => 0),
  resolveCacheDir: () => '/fake/cache',
  resolveInstallRoot: () => '/fake/install',
  ensureAgentBinary: external.download,
}))
vi.mock('../src/runtime/proxy-env.js', async (original) => ({
  ...await original<typeof import('../src/runtime/proxy-env.js')>(), resolveProxy: () => undefined,
}))
vi.mock('../src/runtime/proxied-fetch.js', () => ({
  createProxiedFetch: () => Object.assign(external.fetch, { close: external.fetchClose }),
}))
vi.mock('../src/runtime/agy-cli.js', () => ({
  agyCliCandidates: () => [], createSubprocessCliRun: () => external.cli, fetchAgyModels: external.cli,
}))
vi.mock('../src/runtime/catalog-cache.js', () => ({
  readCachedCatalog: vi.fn(async () => undefined), writeCachedCatalog: vi.fn(async () => {}),
}))
vi.mock('../src/quota/quota-remote.js', () => ({
  AgYQuotaService: class {}, registerAgYQuotaRemote: vi.fn(),
}))
vi.mock('../src/adapter/antigravity-adapter.js', () => ({
  AGY_PROVIDER_ID: 'antigravity-acp',
  AntigravityAcpAdapter: class {
    busy = false
    finish?: () => void
    readonly index = external.workers.length
    constructor(readonly options: AntigravityAcpAdapterOptions) {
      external.workers.push(this)
      options.registerBridgeTeardown?.(this.close)
    }
    close = vi.fn(async () => {
      external.events.push(`worker-${this.index}`)
      this.finish?.()
      this.busy = false
      this.options.lifecycle?.stopped()
    })
    importMetadata = vi.fn()
    async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
      return { provider, id, name: 'Example', inputModalities: this.options.canReadImages?.() ? ['text', 'image'] : ['text'] }
    }
    async listModels(provider: string) { return [await this.resolveModel(provider, 'example')] }
    prepareCall = vi.fn(async (provider: string, model: string) => ({
      model: await this.resolveModel(provider, model), stream: (options: GenerateOptions) => this.stream(options),
    }))
    discoverModels = vi.fn(async (_signal?: AbortSignal, _interactive = true) => this.listModels('antigravity-acp'))
    warmup = vi.fn(async () => {})
    async *stream(_options: GenerateOptions): AsyncGenerator<StreamChunk> {
      this.busy = true
      this.options.lifecycle?.spawned()
      await new Promise<void>((resolve) => { this.finish = resolve })
      this.busy = false
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  },
}))

type Cleanup = () => void | Promise<void>
type AttachmentStub = { readImage: Mock }
const harnesses: Array<{ dispose(): Promise<void> }> = []

function harness(initialAttachment?: AttachmentStub) {
  const cleanup: Cleanup[] = []
  let attachmentCleanup: Cleanup[] = []
  let injectAttachment: ((scope: unknown) => void) | undefined
  let registered: PooledAcpAdapter | undefined
  let control: SettingsControl | undefined
  const unregister = vi.fn(() => { external.events.push('unregister') })
  const attach = (store: AttachmentStub) => {
    injectAttachment?.({ attachments: store, effect: (callback: () => Cleanup) => { attachmentCleanup.push(callback()) } })
  }
  const detach = async () => {
    for (const release of attachmentCleanup.reverse()) await release()
    attachmentCleanup = []
  }
  const ctx = {
    subprocess: { spawn: vi.fn(() => { throw new Error('Unexpected subprocess') }) },
    llm: { registerAdapter: vi.fn((_providers: string[], adapter: PooledAcpAdapter) => { registered = adapter; return unregister }) },
    logger: { info: vi.fn(), warn: vi.fn() }, emit: vi.fn(),
    inject(names: string[], callback: (scope: unknown) => void) {
      if (names.includes('attachments')) {
        injectAttachment = callback
        if (initialAttachment) attach(initialAttachment)
      }
    },
    plugin(_service: unknown, options: { control: SettingsControl }) { control = options.control },
    effect(callback: () => Generator<Cleanup> | Cleanup) {
      const result = callback()
      if (typeof result === 'function') cleanup.push(result)
      else cleanup.push(...result)
    },
  }
  let disposed = false
  const result = {
    ctx: ctx as unknown as Context,
    registered: () => registered!, control: () => control!, attach, detach, unregister,
    async dispose() {
      if (disposed) return
      disposed = true
      for (const release of cleanup.reverse()) await release()
      await detach()
    },
  }
  harnesses.push(result)
  return result
}

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve() }
function request(id: string): GenerateOptions {
  return { provider: 'antigravity-acp', model: 'example', messages: [], sessionId: id as GenerateOptions['sessionId'] }
}

beforeEach(() => {
  external.workers.length = 0
  external.events.length = 0
  vi.clearAllMocks()
  external.fetchClose.mockImplementation(async () => { external.events.push('fetch-close') })
})
afterEach(async () => {
  for (const instance of harnesses.splice(0)) await instance.dispose()
  expect(external.fetch).not.toHaveBeenCalled()
  expect(external.cli).not.toHaveBeenCalled()
  expect(external.download).not.toHaveBeenCalled()
})

describe('apply wiring with real pool and SettingsControl', () => {
  it('handles synchronously available attachments without initialization-order errors', async () => {
    const instance = harness({ readImage: vi.fn() })
    expect(() => apply(instance.ctx, {})).not.toThrow()
    expect(instance.registered()).toBeInstanceOf(PooledAcpAdapter)
    const prepared = await instance.registered().prepareCall('antigravity-acp', 'example')
    expect(prepared.model.inputModalities).toEqual(['text', 'image'])
    expect(instance.control().account().runtime?.modelCatalogRevision).toBeGreaterThan(0)
  })

  it('invalidates capability preparation as the attachment service appears and disappears', async () => {
    const instance = harness()
    apply(instance.ctx, {})
    const pool = instance.registered()
    expect((await pool.prepareCall('antigravity-acp', 'example')).model.inputModalities).toEqual(['text'])
    expect(external.workers[0]!.prepareCall).toHaveBeenCalledTimes(1)
    instance.attach({ readImage: vi.fn() })
    expect((await pool.prepareCall('antigravity-acp', 'example')).model.inputModalities).toEqual(['text', 'image'])
    expect(external.workers[0]!.prepareCall).toHaveBeenCalledTimes(2)
    await instance.detach()
    expect((await pool.prepareCall('antigravity-acp', 'example')).model.inputModalities).toEqual(['text'])
    expect(external.workers[0]!.prepareCall).toHaveBeenCalledTimes(3)
  })

  it('refreshes models without interactive login but permits it for an explicit account login', async () => {
    const instance = harness()
    apply(instance.ctx, {})
    const control = instance.control()
    expect((await control.models(true)).status).toBe('ok')
    expect(external.workers[0]!.discoverModels).toHaveBeenLastCalledWith(expect.any(AbortSignal), false)
    expect(control.account().state).toBe('idle')
    expect(control.account('login').state).toBe('connecting')
    await flush()
    expect(external.workers[0]!.discoverModels).toHaveBeenLastCalledWith(expect.any(AbortSignal), true)
    expect(control.account().state).toBe('connected')
  })

  it('registers the pool and releases all worker resources and the shared fetch on unload', async () => {
    const instance = harness()
    apply(instance.ctx, { maxConcurrentSessions: 2 })
    const pool = instance.registered()
    expect(pool).toBeInstanceOf(PooledAcpAdapter)
    const a = pool.stream(request('a'))
    const b = pool.stream(request('b'))
    const first = a.next()
    const second = b.next()
    await flush()
    expect(external.workers).toHaveLength(2)
    await instance.dispose()
    await Promise.all([first, second])
    await Promise.all([a.return(undefined), b.return(undefined)])
    expect(external.workers.every(worker => worker.close.mock.calls.length === 1)).toBe(true)
    expect(external.fetchClose).toHaveBeenCalledTimes(1)
    expect(instance.unregister).toHaveBeenCalledTimes(1)
    expect(external.events.indexOf('fetch-close')).toBeGreaterThan(external.events.indexOf('worker-1'))
    expect(() => instance.control().account()).toThrow('已卸载')
  })
})
