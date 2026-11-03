/**
 * 代理账户 remote：把代理模式的账户控制面经 Typert Gateway 暴露给设置页。
 *
 * 与 `quota/quota-remote.ts` 同一接线手法（generated-contribution 形态的
 * invocations 描述符），但命名空间独立为 `agyProxyAccount`：
 * - `status`：阶段 / 邮箱 / 来源 / 更新时间（不含凭据与授权 URL）；
 * - `login`：启动 loopback 登录，返回**一次性**授权 URL 供设置页展示；
 * - `cancel` / `logout`：取消在途登录 / 清除本地登录态。
 *
 * 额度快照本身仍走既有 `agyQuota.read`：宿主行的额度服务按当前模式选择
 * 取数来源（CLI / HTTP 回退 / 代理账户），客户端药丸无需感知模式。
 */
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { InvocationDescriptor, TypertCodec, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'
import type { ProxyAccountService, ProxyAccountSnapshot } from './account-service.js'
import { toProxyAccountError } from './account-service.js'

export const PACKAGE_NAME = 'dsh-bundle-antigravity-host'
export const AGY_PROXY_ACCOUNT_SERVICE = 'agyProxyAccount'

export interface ProxyAccountRequest {
  action?: 'status' | 'login' | 'cancel' | 'logout'
}

export interface ProxyAccountResult {
  snapshot: ProxyAccountSnapshot
  authorizationUrl?: string
  message: string
}

function parseRequest(value: unknown): ProxyAccountRequest {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid AgYProxyAccountRequest')
  const action = (value as Record<string, unknown>).action
  if (action !== undefined && !['status', 'login', 'cancel', 'logout'].includes(String(action))) throw new TypeError('Invalid AgYProxyAccountRequest.action')
  return action === undefined ? {} : { action: action as NonNullable<ProxyAccountRequest['action']> }
}

function parseResult(value: unknown): ProxyAccountResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid AgYProxyAccountResult')
  const record = value as Record<string, unknown>
  if (typeof record.message !== 'string' || typeof record.snapshot !== 'object' || record.snapshot === null) throw new TypeError('Invalid AgYProxyAccountResult')
  return value as ProxyAccountResult
}

function strictCodec(typeSymbol: string, parse: (value: unknown) => unknown): TypertCodec {
  const schema: TypertSchema = { parse }
  return { mode: 'strict', typeSymbol, create: () => schema }
}

const requestCodec = strictCodec(`${PACKAGE_NAME}#AgYProxyAccountRequest`, parseRequest)
const resultCodec = strictCodec(`${PACKAGE_NAME}#AgYProxyAccountResult`, parseResult)

export const AGY_PROXY_ACCOUNT_INVOCATIONS: readonly InvocationDescriptor[] = [
  {
    id: `${PACKAGE_NAME}#${AGY_PROXY_ACCOUNT_SERVICE}/account`,
    service: AGY_PROXY_ACCOUNT_SERVICE,
    namespace: AGY_PROXY_ACCOUNT_SERVICE,
    method: 'account',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: requestCodec }],
    result: resultCodec,
  },
]

/** Host 侧服务实现：失败折叠成 message，不向客户端抛原始错误。 */
export class AgYProxyAccountService extends TypertRemoteService {
  private readonly auth: ProxyAccountService
  private inflight: Promise<ProxyAccountResult> | undefined

  constructor(ctx: Context, auth: ProxyAccountService) {
    super(ctx, AGY_PROXY_ACCOUNT_SERVICE)
    this.auth = auth
  }

  async account(request?: ProxyAccountRequest): Promise<ProxyAccountResult> {
    const action = request?.action ?? 'status'
    if (action === 'status') {
      const snapshot = this.auth.status()
      return { snapshot, message: snapshot.message }
    }
    if (action === 'login' && this.inflight) return this.inflight
    // 取消/退出必须立即进入账户服务，不能并入尚未完成的登录。
    if (action !== 'login') this.inflight = undefined
    const run = (async (): Promise<ProxyAccountResult> => {
      try {
        if (action === 'login') {
          const started = await this.auth.login()
          return {
            snapshot: this.auth.status(),
            ...(started.authorizationUrl === undefined ? {} : { authorizationUrl: started.authorizationUrl }),
            message: started.message,
          }
        }
        if (action === 'cancel') {
          await this.auth.cancelLogin()
          return { snapshot: this.auth.status(), message: '代理模式登录已取消' }
        }
        await this.auth.logout()
        return { snapshot: this.auth.status(), message: '代理模式登录态已清除' }
      } catch (error) {
        const safe = toProxyAccountError(error)
        return { snapshot: this.auth.status(), message: safe.message }
      }
    })()
    if (action === 'login') this.inflight = run
    try {
      return await run
    } finally {
      if (this.inflight === run) this.inflight = undefined
    }
  }
}
