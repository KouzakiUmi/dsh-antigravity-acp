/**
 * 额度 remote：把 `src/runtime/quota.ts` 的套餐额度快照经 Typert Gateway 暴露给
 * 浏览器端药丸（`remote.agyQuota.read`）。
 *
 * 接线手法参考 dsh-subusage（同宿主上已验证可用）：Service 继承
 * `TypertRemoteService`，再向 `typert.register` 提交 generated-contribution
 * 形态的 `invocations` 描述符。描述符按 `@deepseek-ai/dsh-typert-protocol`
 * 的 `InvocationDescriptor` / `TypertCodec` 实际类型书写，不臆造字段。
 *
 * `typert.register` 的 contribution 形态（package/face/schemas/model/invocations）
 * 以已安装壳的 `TypertContribution` 与 dsh-subusage 0.13.3 的实际调用为准；本包
 * 工作区依赖的 dsh-typert-protocol 只导出窄契约，故此处用结构化接口 + 类型守卫
 * 收窄，不用 `any` 掩盖。
 */
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { InvocationDescriptor, TypertCodec, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'
import { fetchQuotaSnapshot, QuotaError, QUOTA_CACHE_MS } from '../runtime/quota.js'
import type { CreditsSnapshot, QuotaDeps, QuotaSnapshot } from '../runtime/quota.js'
import { fetchAgyCredits } from '../runtime/credits.js'
import { fetchAgyUsage } from '../runtime/agy-cli.js'
import type { CliRun } from '../runtime/agy-cli.js'
import type { SettingsControl, AccountSnapshot, ModelSnapshot } from './control.js'
import { redactSensitiveText } from '../runtime/redact.js'
import { fetchProxyQuotaSnapshot } from '../proxy/quota-source.js'
import type { ProxyCredentialSource } from '../proxy/adapter.js'
import type { ProxyTransport } from '../proxy/transport.js'
import { AGY_PROXY_ACCOUNT_INVOCATIONS } from '../proxy/account-remote.js'
import { AGY_AISTUDIO_INVOCATIONS } from '../aistudio/remote.js'
import { AGY_VERTEX_INVOCATIONS } from '../vertex/remote.js'
import { cliQuotaIdentity, markQuotaAge, quotaIdentity, QuotaSnapshotStore } from './snapshot-store.js'
import type { QuotaMode } from './snapshot-store.js'
import type { HistoryTruncationNotice } from '../runtime/history-notices.js'

export const PACKAGE_NAME = 'dsh-bundle-antigravity-host'
/** Typert service / wire namespace。 */
export const AGY_QUOTA_SERVICE = 'agyQuota'

/** 额度 read/refresh 共用的请求体；force 仅供 models 使用。 */
export interface AgYQuotaRequest {
  force?: boolean
  source?: 'acp' | 'proxy'
  model?: string
}

/** 结构化校验：失败抛 TypeError，交由 Gateway 转成 RemoteError。 */
function parseRequest(value: unknown): AgYQuotaRequest | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid AgYQuotaRequest')
  const record = value as Record<string, unknown>
  const force = record.force
  const source = record.source
  if (force !== undefined && typeof force !== 'boolean') throw new TypeError('Invalid AgYQuotaRequest.force')
  if (source !== undefined && source !== 'acp' && source !== 'proxy') throw new TypeError('Invalid AgYQuotaRequest.source')
  const model = record.model
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw new TypeError('Invalid AgYQuotaRequest.model')
  return { ...(force === undefined ? {} : { force }), ...(source === undefined ? {} : { source }), ...(model === undefined ? {} : { model }) }
}

function parseResult(value: unknown): QuotaSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid AgYQuotaResult')
  const record = value as Record<string, unknown>
  if (record.status !== 'ok' && record.status !== 'error') throw new TypeError('Invalid AgYQuotaResult.status')
  if (typeof record.updatedAt !== 'string') throw new TypeError('Invalid AgYQuotaResult.updatedAt')
  if (!Array.isArray(record.groups)) throw new TypeError('Invalid AgYQuotaResult.groups')
  return value as QuotaSnapshot
}

function strictCodec(typeSymbol: string, parse: (value: unknown) => unknown): TypertCodec {
  const schema: TypertSchema = { parse }
  return { mode: 'strict', typeSymbol, create: () => schema }
}

const requestCodec = strictCodec(`${PACKAGE_NAME}#AgYQuotaRequest`, parseRequest)
const resultCodec = strictCodec(`${PACKAGE_NAME}#AgYQuotaResult`, parseResult)

function parseAccountRequest(value: unknown): { action: 'status' | 'login' | 'warmup' | 'cancel' } {
  if (value === undefined) return { action: 'status' }
  if (!value || typeof value !== 'object' || !('action' in value)
    || !['status', 'login', 'warmup', 'cancel'].includes(String(value.action))) throw new TypeError('Invalid AgYAccountRequest')
  return { action: value.action as 'status' | 'login' | 'warmup' | 'cancel' }
}
function parseAccount(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('state' in value) || !('message' in value)
    || !['idle', 'connecting', 'cancelling', 'connected', 'cancelled', 'error'].includes(String(value.state))
    || typeof value.message !== 'string') throw new TypeError('Invalid AgYAccountResult')
  return value
}
function parseModels(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('models' in value) || !Array.isArray(value.models)
    || !('status' in value) || !['ok', 'error'].includes(String(value.status))) throw new TypeError('Invalid AgYModelsResult')
  return value
}

/** 本包贡献的 invocation 描述符（直连一元调用）。 */
export const AGY_QUOTA_INVOCATIONS: readonly InvocationDescriptor[] = [
  ...(['read', 'refresh'] as const).map((method): InvocationDescriptor => ({
    id: `${PACKAGE_NAME}#${AGY_QUOTA_SERVICE}/${method}`,
    service: AGY_QUOTA_SERVICE,
    namespace: AGY_QUOTA_SERVICE,
    method,
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: requestCodec },
    ],
    result: resultCodec,
  })),
  ...(['account', 'models'] as const).map((method): InvocationDescriptor => ({
    id: `${PACKAGE_NAME}#${AGY_QUOTA_SERVICE}/${method}`,
    service: AGY_QUOTA_SERVICE, namespace: AGY_QUOTA_SERVICE, method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true,
      codec: method === 'account' ? strictCodec(`${PACKAGE_NAME}#AgYAccountRequest`, parseAccountRequest) : requestCodec }],
    result: method === 'account' ? strictCodec(`${PACKAGE_NAME}#AgYAccountResult`, parseAccount) : strictCodec(`${PACKAGE_NAME}#AgYModelsResult`, parseModels),
  })),
]

/** 宿主 typert 注册面（对准已安装壳的 TypertContribution 形态）。 */
interface TypertContribution {
  readonly package: string
  readonly face: 'host' | 'client'
  readonly schemas: readonly unknown[]
  readonly model: {
    readonly services: readonly unknown[]
    readonly events: readonly unknown[]
    readonly objects: readonly unknown[]
  }
  readonly invocations: readonly InvocationDescriptor[]
}

interface HostTypertRegistrar {
  register(contribution: TypertContribution): () => void | Promise<void>
}

function isRegistrar(value: unknown): value is HostTypertRegistrar {
  return typeof value === 'object' && value !== null
    && typeof (value as { register?: unknown }).register === 'function'
}

/** 把 contribution 提交给 Gateway；typert 服务缺席时静默跳过（无 Web 的 profile 也能加载）。 */
export function registerAgYQuotaRemote(ctx: Context): void {
  ctx.inject(['typert'], (scope) => {
    scope.effect(() => {
      const candidate: unknown = scope.get('typert')
      if (!isRegistrar(candidate)) {
        // 必须留痕：typert 缺席时以前是「静默跳过」，出问题时无法与「注册成功但
        // 客户端没挂上」区分（2026-10-17 排查额度药丸就卡在这里）。
        ctx.logger?.warn?.('antigravity-acp: typert 服务不可用，额度 remote 未注册')
        return () => undefined
      }
      let dispose: () => void | Promise<void>
      try {
        dispose = candidate.register({
          package: PACKAGE_NAME,
          face: 'host',
          schemas: [],
          model: { services: [], events: [], objects: [] },
          invocations: [...AGY_QUOTA_INVOCATIONS, ...AGY_PROXY_ACCOUNT_INVOCATIONS, ...AGY_AISTUDIO_INVOCATIONS, ...AGY_VERTEX_INVOCATIONS],
        })
      } catch (error) {
        ctx.logger?.warn?.('antigravity-acp: 额度 remote 注册失败', error)
        return () => undefined
      }
      ctx.logger?.info?.(
        `antigravity-acp: 额度 remote 已注册（package=${PACKAGE_NAME} service=${AGY_QUOTA_SERVICE} method=read）`,
      )
      return dispose
    }, 'antigravity-acp: quota remote')
  })
}

export interface AgYQuotaServiceOptions {
  control?: SettingsControl

  /** 测试注入面（fetch/文件/时钟等），生产不传。 */
  deps?: QuotaDeps
  /**
   * 官方 CLI 只读取数通道（`agy -p /usage` 与 `agy -p /credits`）。
   * 仅当 {@link cliQuotaEnabled} 返回 true 时才会被使用；缺省 / 关闭时
   * 任何模式都不 spawn agy（套餐额度走内置直连，AI Credits 不查询）。
   */
  cli?: { run: CliRun; cliPath: string }
  /** Re-detect installations without restarting the host. */
  resolveCli?: () => { run: CliRun; cliPath: string } | undefined
  /** 是否允许调用本机 agy CLI 取数；默认不允许（实时读取，可随设置即时切换）。 */
  cliQuotaEnabled?: () => boolean
  /** 当前生成模式；代理模式下套餐额度改走代理账户取数。 */
  mode?: () => 'acp' | 'proxy'
  /** 已保存的官方模型映射，供药丸按实际家族选择额度组。 */
  modelTarget?: (model: string) => string | undefined
  /** 代理模式额度取数面（凭据 + agy 线传输）；缺省时代理模式回落 ACP 口径。 */
  proxyQuota?: { credential: ProxyCredentialSource & { revision?(): number }; transport: ProxyTransport }
  /** Stable, read-only proxy account fingerprint; never obtains or refreshes access. */
  proxyIdentity?: () => Promise<string | undefined>
  snapshotDirectory?: string
  background?: boolean
  onScopeChange?: (tick: () => void) => () => void
  /** 宿主日志（index.ts 接 `ctx.logger`）；用于记录每次取数的来源与结果。 */
  log?: { info(message: string): void; warn(message: string, error?: unknown): void }
  /** 最近历史裁剪事件的只读来源（issue #16）；read 结果附带，不落盘。 */
  historyNotices?: () => readonly HistoryTruncationNotice[]
}

/**
 * 额度取数服务：`read(request)` 返回快照，失败折叠成 `status: 'error'` 而不抛。
 *
 * 字段刻意用 TS `private` 而非 ES `#私有`：Cordis Service 的方法经 Proxy 调用，
 * `this` 是代理而非真实实例，`#x` 会抛 “Cannot read private member #x from an
 * object whose class did not declare it”。
 */
export class AgYQuotaService extends TypertRemoteService {
  private readonly _snapshots: QuotaSnapshotStore
  private readonly _persistent: boolean
  private readonly _proxyIdentity: AgYQuotaServiceOptions['proxyIdentity']
  private readonly _lifetime = new AbortController()
  private readonly _deps: QuotaDeps
  private readonly _cli: { run: CliRun; cliPath: string } | undefined
  private readonly _resolveCli: AgYQuotaServiceOptions['resolveCli']
  private readonly _cliQuotaEnabled: AgYQuotaServiceOptions['cliQuotaEnabled']
  private readonly _mode: AgYQuotaServiceOptions['mode']
  private readonly _modelTarget: AgYQuotaServiceOptions['modelTarget']
  private readonly _proxyQuota: AgYQuotaServiceOptions['proxyQuota']
  private readonly _log: AgYQuotaServiceOptions['log']
  private readonly _control: SettingsControl | undefined
  private readonly _historyNotices: AgYQuotaServiceOptions['historyNotices']
  private _inflight?: { key: string; result: Promise<boolean> }
  private _scopeGeneration = 0

  constructor(ctx: Context, options: AgYQuotaServiceOptions = {}) {
    super(ctx, AGY_QUOTA_SERVICE)
    this._deps = options.deps ?? {}
    this._snapshots = new QuotaSnapshotStore(options.snapshotDirectory)
    this._persistent = options.snapshotDirectory !== undefined
    this._proxyIdentity = options.proxyIdentity
    this._cli = options.cli
    this._resolveCli = options.resolveCli
    this._cliQuotaEnabled = options.cliQuotaEnabled
    this._mode = options.mode
    this._modelTarget = options.modelTarget
    this._proxyQuota = options.proxyQuota
    this._log = options.log
    this._control = options.control
    this._historyNotices = options.historyNotices
    if (options.background || options.onScopeChange) {
      ctx.effect(() => {
        const tick = () => { void this.refresh().catch(error => this._log?.warn('antigravity-acp: 额度刷新失败：' + redactSensitiveText(String(error)))) }
        let start: ReturnType<typeof setTimeout> | undefined
        const schedule = () => { clearTimeout(start); start = setTimeout(tick, 0); start.unref() }
        const off = options.onScopeChange?.(() => {
          this._scopeGeneration += 1
          if (options.background) schedule()
        })
        if (options.background) schedule()
        const interval = options.background ? setInterval(tick, QUOTA_CACHE_MS) : undefined
        interval?.unref()
        return () => { off?.(); clearTimeout(start); clearInterval(interval); this._lifetime.abort() }
      }, 'antigravity: background quota refresh')
    }
  }

  account(request?: { action: 'status' | 'login' | 'warmup' | 'cancel' }): AccountSnapshot {
    if (!this._control) throw new Error('账户控制服务未就绪')
    return this._control.account(parseAccountRequest(request).action)
  }

  async models(request?: AgYQuotaRequest): Promise<ModelSnapshot> {
    if (!this._control) throw new Error('模型管理服务未就绪')
    return this._control.models(parseRequest(request)?.force === true)
  }

  /** Pure snapshot read: no provider requests, CLI calls, or OAuth refresh. */
  async read(request?: AgYQuotaRequest): Promise<QuotaSnapshot> {
    const scope = await this.snapshotScope(request)
    const snapshot = await this._snapshots.read(scope.mode, scope.key, scope.persistent)
    if (scope.epoch !== this.epoch()) return this.read(request)
    const value = snapshot === undefined ? this.emptySnapshot() : markQuotaAge(snapshot, (this._deps.now ?? Date.now)())
    if (!scope.cliOn && value.credits === undefined) value.credits = this.creditsUnavailable(false, value.updatedAt)
    // 历史裁剪是内存态事件，只随 read 附带，不进入快照存储与 stale 回退。
    const notices = this._historyNotices?.() ?? []
    const withNotices = notices.length > 0 ? { ...value, historyNotices: notices } : value
    return request?.model ? { ...withNotices, requestedModel: request.model, routeModel: this._modelTarget?.(request.model) || request.model } : withNotices
  }

  /** Sole upstream entry point; host timer and explicit refresh share in-flight work. */
  async refresh(request?: AgYQuotaRequest): Promise<QuotaSnapshot> {
    return this.refreshCurrent(request, true)
  }

  private async refreshCurrent(request: AgYQuotaRequest | undefined, retry: boolean): Promise<QuotaSnapshot> {
    const scope = await this.snapshotScope(request)
    const flightKey = scope.epoch + ':' + scope.key
    if (this._inflight?.key === flightKey) {
      const committed = await this._inflight.result
      if (!committed && retry && !this._lifetime.signal.aborted) return this.refreshCurrent(request, false)
      return this.read(request)
    }
    if (this._inflight) {
      await this._inflight.result
      return this.refreshCurrent(request, retry)
    }
    if (this._lifetime.signal.aborted) return this.read(request)
    const result = this.pull(scope)
    this._inflight = { key: flightKey, result }
    let committed: boolean
    try { committed = await result }
    finally { if (this._inflight?.result === result) this._inflight = undefined }
    if (!committed && retry && !this._lifetime.signal.aborted) return this.refreshCurrent(request, false)
    return this.read(request)
  }

  private currentMode(): QuotaMode { return this._mode?.() ?? 'acp' }

  private epoch(): string {
    const mode = this.currentMode()
    return JSON.stringify([this._scopeGeneration, mode, mode === 'proxy' ? this._proxyQuota?.credential.revision?.() ?? 0 : 0, this._cliQuotaEnabled?.() === true])
  }

  private async snapshotScope(request?: AgYQuotaRequest): Promise<{ mode: QuotaMode; epoch: string; key: string; persistent: boolean; cliOn: boolean }> {
    const mode = this.currentMode()
    if (request?.source !== undefined && request.source !== mode) throw new Error('模型所属模式与当前生成模式不一致，请在会话中重新选择模型')
    const cliOn = this._cliQuotaEnabled?.() === true
    const epoch = this.epoch()
    const [cli, proxy] = await Promise.all([
      this._persistent && (mode === 'acp' || cliOn) ? cliQuotaIdentity(this._deps) : undefined,
      mode === 'proxy' ? this._proxyIdentity?.() : undefined,
    ])
    if (epoch !== this.epoch()) return this.snapshotScope(request)
    const persistent = mode === 'acp' ? cli !== undefined : proxy !== undefined && (!cliOn || cli !== undefined)
    const key = quotaIdentity(mode, cliOn ? 'cli-on' : 'cli-off', cli ?? '', proxy ?? '', persistent ? '' : epoch)
    return { mode, epoch, key, persistent, cliOn }
  }

  private emptySnapshot(): QuotaSnapshot {
    return { status: 'error', updatedAt: new Date((this._deps.now ?? Date.now)()).toISOString(), groups: [],
      error: { code: 'not-fetched', message: '暂无额度快照，可手动拉取' } }
  }

  private creditsUnavailable(cliOn: boolean, updatedAt: string): CreditsSnapshot {
    return { status: 'unavailable', updatedAt, error: { code: cliOn ? 'cli-unavailable' : 'cli-disabled',
      message: cliOn ? '未找到官方 agy CLI，无法查询 AI Credits' : '未开启 agy CLI 取数，不查询 AI Credits' } }
  }

  private async pull(scope: Awaited<ReturnType<AgYQuotaService['snapshotScope']>>): Promise<boolean> {
    const previous = await this._snapshots.read(scope.mode, scope.key, scope.persistent)
    if (scope.epoch !== this.epoch() || this._lifetime.signal.aborted) return false
    const [fresh, freshCredits] = await this.collect(scope)
    // The account may have changed outside DSH (official CLI), or in this host.
    const latest = await this.snapshotScope()
    if (this._lifetime.signal.aborted || scope.epoch !== latest.epoch || scope.key !== latest.key) return false
    const credits = freshCredits.status === 'error' && previous?.credits?.status === 'ok'
      ? { ...previous.credits, stale: true, staleReason: freshCredits.error?.message ?? '余额刷新失败' } : freshCredits
    const snapshot = fresh.status === 'error' && previous?.status === 'ok'
      ? { ...previous, stale: true, staleReason: fresh.error?.message ?? '刷新失败' } : fresh
    try { await this._snapshots.put(scope.mode, scope.key, { ...snapshot, credits }, scope.persistent) }
    catch { this._log?.warn('antigravity-acp: 额度快照写入失败；本次额度仍可在当前宿主读取') }
    return true
  }

  private async collect({ mode, cliOn }: { mode: QuotaMode; cliOn: boolean }): Promise<[QuotaSnapshot, CreditsSnapshot]> {
    const updatedAt = new Date((this._deps.now ?? Date.now)()).toISOString()
    try {
      const cli = cliOn ? (this._resolveCli?.() ?? this._cli) : undefined
      const proxy = this._proxyQuota
      this._log?.info('antigravity-acp: 正在刷新额度快照')
      return await Promise.all([
        mode === 'proxy'
          ? proxy === undefined ? Promise.resolve<QuotaSnapshot>({ status: 'error', updatedAt, groups: [], error: { code: 'request-failed', message: '代理额度服务未就绪' } })
            : fetchProxyQuotaSnapshot({ credential: proxy.credential, transport: proxy.transport, log: this._log }, this._lifetime.signal)
          : cli ? fetchAgyUsage(cli.run, cli.cliPath) : fetchQuotaSnapshot({}, this._deps),
        cli ? fetchAgyCredits(cli.run, cli.cliPath) : Promise.resolve(this.creditsUnavailable(cliOn, updatedAt)),
      ])
    } catch (error) {
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error))
      this._log?.warn('antigravity-acp: 额度刷新失败：' + message)
      return [{ status: 'error', updatedAt, groups: [], error: { code: error instanceof QuotaError ? error.code : 'request-failed', message } },
        { status: 'error', updatedAt, error: { code: 'request-failed', message } }]
    }
  }
}
