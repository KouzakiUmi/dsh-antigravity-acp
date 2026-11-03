/**
 * 代理模式的额度取数：复用本插件既有的额度监控口径（`runtime/quota.ts` 的
 * 快照结构与解析函数），只是凭据与传输换成代理账户：
 * - 凭据：{@link ProxyCredentialSource}（不再读官方 CLI 登录态文件）；
 * - 传输：{@link ProxyTransport} 的 agy 线形态（与生成请求同一伪装口径）；
 * - 失败折叠成 `status: 'error'` 快照，401/403 换发一次重试一次。
 *
 * AI Credits 仍走官方 CLI 只读命令（与模式无关），本模块不改动它。
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { buildAntigravityLoadCodeAssistMetadata } from '@cortexkit/antigravity-auth-core'
import { withProxyAccountDeadline } from './oauth.js'
import { parseQuotaSummary } from '../runtime/quota.js'
import type { QuotaGroup, QuotaSnapshot } from '../runtime/quota.js'
import { redactSensitiveText } from '../runtime/redact.js'
import type { ProxyCredentialSource } from './adapter.js'
import { proxyStatusError, readProxyText } from './transport.js'
import type { ProxyTransport } from './transport.js'

const LOAD_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
const QUOTA_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'

export interface ProxyQuotaDeps {
  credential: ProxyCredentialSource
  transport: ProxyTransport
  log?: { info(message: string): void; warn(message: string, error?: unknown): void }
}

/** 取一份额度快照；任何失败都折叠成 error 快照，不抛穿线。 */
export async function fetchProxyQuotaSnapshot(deps: ProxyQuotaDeps, signal?: AbortSignal): Promise<QuotaSnapshot> {
  const stamp = () => new Date(Date.now()).toISOString()
  try {
    return await withProxyAccountDeadline(async signal => {
    const credential = await deps.credential.credential(signal)
    if (credential === undefined) {
      return failure(stamp(), 'token-missing', '代理模式未登录，无法读取套餐额度；请在设置页连接代理账户')
    }
    try {
      return await readWith(credential.accessToken, stamp, deps, signal)
    } catch (error) {
      const status = error instanceof LlmError ? error.failure?.status : undefined
      if (status === 401 || status === 403) {
        const refreshed = await deps.credential.credential(signal, { forceRefresh: true })
        if (refreshed) return await readWith(refreshed.accessToken, stamp, deps, signal)
      }
      throw error
    }
    }, signal, 45_000)
  } catch (error) {
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error))
    deps.log?.warn(`antigravity-proxy: 额度取数失败：${message}`)
    return failure(stamp(), 'request-failed', message)
  }
}

async function readWith(accessToken: string, stamp: () => string, deps: ProxyQuotaDeps, signal?: AbortSignal): Promise<QuotaSnapshot> {
  const projectPayload = await post(LOAD_ENDPOINT, { metadata: buildAntigravityLoadCodeAssistMetadata() }, accessToken, deps, signal)
  const projectId = managedProjectId(projectPayload.cloudaicompanionProject)
  if (!projectId) throw new LlmError('loadCodeAssist 未返回项目 id', 'PROTOCOL_DRIFT')
  const tiers = [projectPayload.paidTier, projectPayload.currentTier]
  const plan = tiers
    .map((tier) => (isRecord(tier) && typeof tier.name === 'string' ? tier.name : undefined))
    .find((name) => name)
  const summary = await post(QUOTA_ENDPOINT, { project: projectId }, accessToken, deps, signal)
  const groups: QuotaGroup[] = parseQuotaSummary(summary)
  return {
    status: 'ok',
    updatedAt: stamp(),
    ...(plan === undefined ? {} : { plan }),
    groups,
  }
}

async function post(url: string, payload: Record<string, unknown>, accessToken: string, deps: ProxyQuotaDeps, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await deps.transport.request({
    url,
    accessToken,
    body: JSON.stringify(payload),
    ...(signal === undefined ? {} : { signal }),
  })
  const statusError = proxyStatusError(response.status)
  if (statusError !== undefined) {
    try { await response.body?.cancel() } catch { /* best effort */ }
    throw new LlmError(`代理账户服务请求失败（HTTP ${response.status}）`, response.status === 401 || response.status === 403 ? 'AUTH' : 'UPSTREAM', { status: response.status })
  }
  const text = await readProxyText(response, { ...(signal === undefined ? {} : { signal }), maxBytes: 512 * 1024,
    idleTimeoutMs: 15_000, totalTimeoutMs: 30_000 })
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : {}
  } catch {
    throw new LlmError('代理账户服务响应不是合法 JSON', 'PROTOCOL_DRIFT')
  }
}

/** 连接阶段只读解析已有项目，与参考插件 project-context 的探测流程一致。 */
export async function resolveProxyProject(accessToken: string, transport: ProxyTransport, signal?: AbortSignal): Promise<string> {
  return withProxyAccountDeadline(async signal => {
    const deps: ProxyQuotaDeps = { credential: { credential: async () => undefined }, transport }
    const payload = await post(LOAD_ENDPOINT, { metadata: buildAntigravityLoadCodeAssistMetadata() }, accessToken, deps, signal)
    const projectId = managedProjectId(payload.cloudaicompanionProject)
    if (projectId) return projectId
    throw new LlmError('上游未返回可用项目；请先确认该账户可使用官方 Antigravity，再重新连接', 'AGY_PROXY_PROJECT')
  }, signal, 30_000)
}

function managedProjectId(value: unknown): string | undefined {
  const candidate = isRecord(value) ? value.id : value
  if (typeof candidate !== 'string') return undefined
  const project = candidate.trim()
  return /^[a-z][a-z0-9-]{2,127}$/u.test(project) ? project : undefined
}

function failure(updatedAt: string, code: 'token-missing' | 'request-failed', message: string): QuotaSnapshot {
  return { status: 'error', updatedAt, groups: [], error: { code, message: redactSensitiveText(message) } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
