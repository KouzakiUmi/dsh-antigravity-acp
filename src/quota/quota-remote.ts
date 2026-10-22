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

export const PACKAGE_NAME = 'dsh-bundle-antigravity-host'
/** Typert service / wire namespace。 */
export const AGY_QUOTA_SERVICE = 'agyQuota'

/** `read` 的请求体：`force` 绕过内存缓存重新取数。 */
export interface AgYQuotaRequest {
  force?: boolean
}

/** 结构化校验：失败抛 TypeError，交由 Gateway 转成 RemoteError。 */
function parseRequest(value: unknown): AgYQuotaRequest | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid AgYQuotaRequest')
  const record = value as Record<string, unknown>
  const force = record.force
  if (force !== undefined && typeof force !== 'boolean') throw new TypeError('Invalid AgYQuotaRequest.force')
  return force === undefined ? {} : { force }
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
  {
    id: `${PACKAGE_NAME}#${AGY_QUOTA_SERVICE}/read`,
    service: AGY_QUOTA_SERVICE,
    namespace: AGY_QUOTA_SERVICE,
    method: 'read',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: requestCodec },
    ],
    result: resultCodec,
  },
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
          invocations: AGY_QUOTA_INVOCATIONS,
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
   * 给了就优先用它：本账户上 Cloud Code Assist 是企业授权产品（403 #3501），
   * 官方 CLI 是套餐额度的唯一可用来源。
   */
  cli?: { run: CliRun; cliPath: string }
  /** Re-detect installations without restarting the host. */
  resolveCli?: () => { run: CliRun; cliPath: string } | undefined
  /** 宿主日志（index.ts 接 `ctx.logger`）；用于记录每次取数的来源与结果。 */
  log?: { info(message: string): void; warn(message: string, error?: unknown): void }
}

/**
 * 额度取数服务：`read(request)` 返回快照，失败折叠成 `status: 'error'` 而不抛。
 *
 * 字段刻意用 TS `private` 而非 ES `#私有`：Cordis Service 的方法经 Proxy 调用，
 * `this` 是代理而非真实实例，`#x` 会抛 “Cannot read private member #x from an
 * object whose class did not declare it”。
 */
export class AgYQuotaService extends TypertRemoteService {
  private readonly _cache: { value?: QuotaSnapshot; at?: number } = {}
  private readonly _creditsCache: { value?: CreditsSnapshot; at?: number } = {}
  private readonly _deps: QuotaDeps
  private readonly _cli: { run: CliRun; cliPath: string } | undefined
  private readonly _resolveCli: AgYQuotaServiceOptions['resolveCli']
  private readonly _log: AgYQuotaServiceOptions['log']
  private readonly _control: SettingsControl | undefined
  /** 在途取数：并发调用（多会话药丸 / 定时器 + 手动刷新）共享同一次取数，而不是各起一个进程。 */
  private _inflight: Promise<QuotaSnapshot> | undefined
  /** 在途取数是否真的绕过了缓存（而非「命中缓存」的即时返回）；force 的合并判定依据。 */
  private _inflightBypassed = false

  constructor(ctx: Context, options: AgYQuotaServiceOptions = {}) {
    super(ctx, AGY_QUOTA_SERVICE)
    this._deps = options.deps ?? {}
    this._cli = options.cli
    this._resolveCli = options.resolveCli
    this._log = options.log
    this._control = options.control
  }

  account(request?: { action: 'status' | 'login' | 'warmup' | 'cancel' }): AccountSnapshot {
    if (!this._control) throw new Error('账户控制服务未就绪')
    return this._control.account(parseAccountRequest(request).action)
  }

  async models(request?: AgYQuotaRequest): Promise<ModelSnapshot> {
    if (!this._control) throw new Error('模型管理服务未就绪')
    return this._control.models(parseRequest(request)?.force === true)
  }

  /** 客户端药丸的取数入口；并发调用合并为同一次取数。 */
  async read(request?: AgYQuotaRequest): Promise<QuotaSnapshot> {
    const force = request?.force === true
    while (this._inflight) {
      const existing = this._inflight
      // force 只并入「确实在取新数」的在途读取（结果即新数据）；在途读取若只是
      // 命中缓存的即时返回，必须等它结束后另行取数，否则刷新会拿到旧缓存。
      if (!force || this._inflightBypassed) return existing
      await existing.catch(() => undefined)
    }
    const run = this._read(request)
    this._inflight = run
    try {
      return await run
    } finally {
      if (this._inflight === run) this._inflight = undefined
    }
  }

  private async _read(request?: AgYQuotaRequest): Promise<QuotaSnapshot> {
    // 本次读取是否真正取了新数（_read 的同步段就会定出，供 read() 做合并判定）。
    this._inflightBypassed = false
    if (request?.force === true) {
      // 只让缓存失效（清时间戳），保留上一次成功的数据：刷新失败时还能以 stale 形式展示。
      delete this._cache.at
      delete this._creditsCache.at
    }
    // 这条日志让「药丸到底有没有把请求发到 Host」可证：浏览器侧完全无法写宿主日志。
    const cli = this._resolveCli?.() ?? this._cli
    const source = cli ? `cli=${redactSensitiveText(cli.cliPath)}` : 'http（未找到 agy CLI）'
    this._log?.info(`antigravity-acp: 额度取数请求（force=${request?.force === true}，来源 ${source}）`)
    try {
      const now = Date.now()
      const cached = this._cache.value
      const previousCredits = this._creditsCache.value
      const quotaCached = Boolean(cached && this._cache.at !== undefined && now - this._cache.at < QUOTA_CACHE_MS && cached.status === 'ok' && cached.stale !== true)
      const creditsCached = Boolean(previousCredits && this._creditsCache.at !== undefined && now - this._creditsCache.at < QUOTA_CACHE_MS && previousCredits.status !== 'error' && !previousCredits.stale)
      if (quotaCached && creditsCached) {
        this._log?.info('antigravity-acp: 套餐额度与余额命中独立缓存')
        return { ...cached!, credits: previousCredits }
      }
      // force 只能加入两路均取新数据的请求，不能把局部刷新误认成全部刷新。
      this._inflightBypassed = !quotaCached && !creditsCached
      // 上一次成功数据必须在取数**前**捕获：HTTP 回退实现（fetchQuotaSnapshot）
      // 会把失败快照写进同一个缓存对象，取完再读就只剩失败结果了。
      const previous = this._cache.value
      // 两个只读命令并发且各有超时，不把 45s + 45s 串成超过客户端 60s 的请求。
      const [fresh, freshCredits] = await Promise.all([
        quotaCached ? Promise.resolve(cached!) : cli
          ? fetchAgyUsage(cli.run, cli.cliPath)
          : fetchQuotaSnapshot(this._cache, this._deps),
        creditsCached ? Promise.resolve(previousCredits!) : cli
          ? fetchAgyCredits(cli.run, cli.cliPath)
          : Promise.resolve<CreditsSnapshot>({ status: 'unavailable', updatedAt: new Date().toISOString(), error: { code: 'cli-unavailable', message: '未找到官方 agy CLI，无法查询 AI Credits' } }),
      ])
      const credits: CreditsSnapshot = freshCredits.status === 'error' && previousCredits?.status === 'ok'
        ? { ...previousCredits, stale: true, staleReason: freshCredits.error?.message ?? '余额刷新失败' }
        : freshCredits
      this._creditsCache.value = credits
      if (credits.stale || credits.status === 'error') delete this._creditsCache.at
      else if (!creditsCached) this._creditsCache.at = now
      // 刷新失败但手里有上一次成功的数据：继续展示它并标记 stale，而不是让药丸
      // 因为一次网络抖动就从「剩余 62%」变成「额度读取失败」。CLI 与 HTTP 回退
      // 共用同一条 stale 保留语义。
      const snapshot: QuotaSnapshot = fresh.status === 'error' && previous?.status === 'ok'
        ? { ...previous, stale: true, staleReason: fresh.error?.message ?? '刷新失败' }
        : fresh
      this._cache.value = snapshot
      // stale 不算新鲜：不刷新时间戳，也不被缓存命中分支当作可复用结果，下次调用立刻重试。
      if (snapshot.stale === true) delete this._cache.at
      else if (!quotaCached) this._cache.at = now
      this._log?.info(
        `antigravity-acp: 额度取数结果 status=${snapshot.status} 组数=${snapshot.groups.length}` +
          (snapshot.error ? ` 错误=${snapshot.error.code}:${snapshot.error.message.slice(0, 160)}` : ''),
      )
      return { ...snapshot, credits }
    } catch (error) {
      // 取数实现自身已折叠错误；这里兜住意外异常，绝不让原始错误穿到客户端。
      // 脱敏与快照内其它错误一致：token / URL userinfo 等不能进 UI 或宿主日志。
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error))
      this._log?.warn?.(`antigravity-acp: 额度取数抛异常：${message}`)
      return {
        status: 'error',
        updatedAt: new Date().toISOString(),
        groups: [],
        error: { code: error instanceof QuotaError ? error.code : 'request-failed', message },
      }
    }
  }
}
