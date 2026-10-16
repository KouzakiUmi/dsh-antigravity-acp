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
import type { QuotaDeps, QuotaSnapshot } from '../runtime/quota.js'
import { fetchAgyUsage } from '../runtime/agy-cli.js'
import type { CliRun } from '../runtime/agy-cli.js'

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
  /** 测试注入面（fetch/文件/时钟等），生产不传。 */
  deps?: QuotaDeps
  /**
   * 官方 CLI 只读取数通道（`agy -p /usage`，2026-10-16 授权仅限只读取数用途）。
   * 给了就优先用它：本账户上 Cloud Code Assist 是企业授权产品（403 #3501），
   * 官方 CLI 是套餐额度的唯一可用来源。
   */
  cli?: { run: CliRun; cliPath: string }
  /** 宿主日志（index.ts 接 `ctx.logger`）；用于记录每次取数的来源与结果。 */
  log?: { info(message: string): void; warn(message: string, error?: unknown): void }
}

/** 额度取数服务：`read(request)` 返回快照，失败折叠成 `status: 'error'` 而不抛。 */
export class AgYQuotaService extends TypertRemoteService {
  readonly #cache: { value?: QuotaSnapshot; at?: number } = {}
  readonly #deps: QuotaDeps
  readonly #cli: { run: CliRun; cliPath: string } | undefined
  readonly #log: AgYQuotaServiceOptions['log']

  constructor(ctx: Context, options: AgYQuotaServiceOptions = {}) {
    super(ctx, AGY_QUOTA_SERVICE)
    this.#deps = options.deps ?? {}
    this.#cli = options.cli
    this.#log = options.log
  }

  /** 客户端药丸的取数入口。 */
  async read(request?: AgYQuotaRequest): Promise<QuotaSnapshot> {
    if (request?.force === true) {
      delete this.#cache.value
      delete this.#cache.at
    }
    // 这条日志让「药丸到底有没有把请求发到 Host」可证：浏览器侧完全无法写宿主日志。
    const source = this.#cli ? `cli=${this.#cli.cliPath}` : 'http（未找到 agy CLI）'
    this.#log?.info(`antigravity-acp: 额度取数请求（force=${request?.force === true}，来源 ${source}）`)
    try {
      const cli = this.#cli
      if (!cli) return await fetchQuotaSnapshot(this.#cache, this.#deps)
      const now = Date.now()
      const cached = this.#cache.value
      if (cached && this.#cache.at !== undefined && now - this.#cache.at < QUOTA_CACHE_MS && cached.status === 'ok') {
        this.#log?.info(`antigravity-acp: 额度取数命中缓存（${cached.groups.length} 组）`)
        return cached
      }
      const snapshot = await fetchAgyUsage(cli.run, cli.cliPath)
      this.#cache.value = snapshot
      this.#cache.at = now
      this.#log?.info(
        `antigravity-acp: 额度取数结果 status=${snapshot.status} 组数=${snapshot.groups.length}` +
          (snapshot.error ? ` 错误=${snapshot.error.code}:${snapshot.error.message.slice(0, 160)}` : ''),
      )
      return snapshot
    } catch (error) {
      // 取数实现自身已折叠错误；这里兜住意外异常，绝不让原始错误穿到客户端。
      const message = error instanceof Error ? error.message : String(error)
      this.#log?.warn?.('antigravity-acp: 额度取数抛异常', error)
      return {
        status: 'error',
        updatedAt: new Date().toISOString(),
        groups: [],
        error: { code: error instanceof QuotaError ? error.code : 'request-failed', message },
      }
    }
  }
}
