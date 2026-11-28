/**
 * AI Studio remote：把模型目录、手动 API key 写入与掩码状态经 Typert Gateway 暴露
 * 给浏览器端设置页 AI Studio Tab（`remote.agyAistudio.models / setKey / keyStatus`）。
 *
 * 接线手法与额度 remote 同构（`quota-remote.ts`）：Service 继承 `TypertRemoteService`，
 * invocations 描述符按 `@deepseek-ai/dsh-typert-protocol` 实际类型书写。一个包只注册
 * 一次 Host contribution，故本文件的 `AGY_AISTUDIO_INVOCATIONS` 由 `registerAgYQuotaRemote`
 * 合并进同一 contribution（service 名 `agyAistudio` 与 `agyQuota` / `agyProxyAccount` 并列）。
 *
 * key 安全（设计稿 §8）：`setKey` 只写不回显（`credentials.set`），`keyStatus` 只返回
 * `describe` 的掩码预览与可写性，绝不返回全值；key 不进设置文档 / 日志 / 客户端响应。
 * 错误消息一律经 `redactSensitiveText` 脱敏。
 */
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { InvocationDescriptor, TypertCodec, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { redactSensitiveText } from '../runtime/redact.js'
import type { ModelSnapshot } from '../quota/control.js'
import type { AistudioAdapter } from './adapter.js'
import { isRecord, redactAistudioError } from './response-observation.js'
import type { AistudioUsageResult } from './usage.js'

export const PACKAGE_NAME = 'dsh-bundle-antigravity-host'
/** Typert service / wire namespace（与 agyQuota / agyProxyAccount 并列）。 */
export const AGY_AISTUDIO_SERVICE = 'agyAistudio'

/** models 请求体；force 绕过目录缓存。 */
export interface AgYAistudioModelsRequest {
  force?: boolean
}
/** setKey 请求体；value 是非空密钥字符串（只写不回显）。 */
export interface AgYAistudioSetKeyRequest {
  value: string
}
/** setKey 结果：只报状态与脱敏消息，绝不回显 key。 */
export interface AgYAistudioKeyResult {
  status: 'ok' | 'error'
  message?: string
}
/** keyStatus 结果：describe 的掩码视图，绝不包含全值。 */
export interface AgYAistudioKeyStatus {
  status: 'ok' | 'error'
  configured: boolean
  writable: boolean
  source?: string
  masked?: string
  message?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseModelsRequest(value: unknown): AgYAistudioModelsRequest | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid AgYAistudioModelsRequest')
  const force = (value as Record<string, unknown>).force
  if (force !== undefined && typeof force !== 'boolean') throw new TypeError('Invalid AgYAistudioModelsRequest.force')
  return force === undefined ? {} : { force }
}

function parseSetKeyRequest(value: unknown): AgYAistudioSetKeyRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid AgYAistudioSetKeyRequest')
  const raw = (value as Record<string, unknown>).value
  if (typeof raw !== 'string' || !/^[\x21-\x7e]{1,4096}$/u.test(raw.trim())) throw new TypeError('Invalid AgYAistudioSetKeyRequest.value')
  return { value: raw.trim() }
}

function parseKeyStatusRequest(value: unknown): undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid AgYAistudioKeyStatusRequest')
  return undefined
}

function parseModelsResult(value: unknown): AgYAistudioModelsResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid AgYAistudioModelsResult')
  const record = value as Record<string, unknown>
  if (record.status !== 'ok' && record.status !== 'error') throw new TypeError('Invalid AgYAistudioModelsResult.status')
  if (!Array.isArray(record.models)) throw new TypeError('Invalid AgYAistudioModelsResult.models')
  return value as AgYAistudioModelsResult
}

function parseKeyResult(value: unknown): AgYAistudioKeyResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid AgYAistudioKeyResult')
  const record = value as Record<string, unknown>
  if (record.status !== 'ok' && record.status !== 'error') throw new TypeError('Invalid AgYAistudioKeyResult.status')
  if (record.message !== undefined && typeof record.message !== 'string') throw new TypeError('Invalid AgYAistudioKeyResult.message')
  return value as AgYAistudioKeyResult
}

function parseKeyStatusResult(value: unknown): AgYAistudioKeyStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid AgYAistudioKeyStatusResult')
  const record = value as Record<string, unknown>
  if (record.status !== 'ok' && record.status !== 'error') throw new TypeError('Invalid AgYAistudioKeyStatusResult.status')
  if (typeof record.configured !== 'boolean' || typeof record.writable !== 'boolean') throw new TypeError('Invalid AgYAistudioKeyStatusResult.configured/writable')
  if (record.source !== undefined && typeof record.source !== 'string') throw new TypeError('Invalid AgYAistudioKeyStatusResult.source')
  if (record.masked !== undefined && typeof record.masked !== 'string') throw new TypeError('Invalid AgYAistudioKeyStatusResult.masked')
  if (record.message !== undefined && typeof record.message !== 'string') throw new TypeError('Invalid AgYAistudioKeyStatusResult.message')
  return value as AgYAistudioKeyStatus
}

function parseUsageResult(value: unknown): AistudioUsageResult {
  const count = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
  const counts = (x: unknown): boolean => isRecord(x) && count(x.requests) && count(x.reportedRequests)
    && x.reportedRequests <= x.requests && (x.reportedRequests === 0 ? x.inputTokens === null : count(x.inputTokens))
  const model = (x: unknown): boolean => x === null || (typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(x))
  const invalid = () => new TypeError('Invalid AgYAistudioUsageResult')
  if (!isRecord(value)) throw invalid()
  if (value.status === 'unconfigured' || value.status === 'error') return { status: value.status }
  if (value.status !== 'ok' || typeof value.pacificDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.pacificDay)
    || !counts(value.minute) || !counts(value.today) || typeof value.minuteTruncated !== 'boolean'
    || !Array.isArray(value.models) || value.models.length > 130 || !value.models.every(x => isRecord(x) && model(x.model) && counts(x.minute) && counts(x.today))) throw invalid()
  const last = value.last429
  if (last !== undefined && (!isRecord(last) || !model(last.model) || typeof last.at !== 'string' || !Number.isFinite(Date.parse(last.at))
    || (last.source !== 'http' && last.source !== 'sse') || (last.retryAfterMs !== undefined && !count(last.retryAfterMs))
    || (last.quotaFailure !== undefined && last.quotaFailure !== true))) throw invalid()
  return value as unknown as AistudioUsageResult
}

function strictCodec(typeSymbol: string, parse: (value: unknown) => unknown): TypertCodec {
  const schema: TypertSchema = { parse }
  return { mode: 'strict', typeSymbol, create: () => schema }
}

const modelsRequestCodec = strictCodec(`${PACKAGE_NAME}#AgYAistudioModelsRequest`, parseModelsRequest)
const modelsResultCodec = strictCodec(`${PACKAGE_NAME}#AgYAistudioModelsResult`, parseModelsResult)
const setKeyRequestCodec = strictCodec(`${PACKAGE_NAME}#AgYAistudioSetKeyRequest`, parseSetKeyRequest)
const keyResultCodec = strictCodec(`${PACKAGE_NAME}#AgYAistudioKeyResult`, parseKeyResult)
const keyStatusRequestCodec = strictCodec(`${PACKAGE_NAME}#AgYAistudioKeyStatusRequest`, parseKeyStatusRequest)
const keyStatusResultCodec = strictCodec(`${PACKAGE_NAME}#AgYAistudioKeyStatusResult`, parseKeyStatusResult)

/** 本包贡献的 AI Studio invocation 描述符（直连一元调用），合并进 Host contribution。 */
export const AGY_AISTUDIO_INVOCATIONS: readonly InvocationDescriptor[] = [
  {
    id: `${PACKAGE_NAME}#${AGY_AISTUDIO_SERVICE}/models`,
    service: AGY_AISTUDIO_SERVICE, namespace: AGY_AISTUDIO_SERVICE, method: 'models',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: modelsRequestCodec }],
    result: modelsResultCodec,
  },
  {
    id: `${PACKAGE_NAME}#${AGY_AISTUDIO_SERVICE}/setKey`,
    service: AGY_AISTUDIO_SERVICE, namespace: AGY_AISTUDIO_SERVICE, method: 'setKey',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: setKeyRequestCodec }],
    result: keyResultCodec,
  },
  {
    id: `${PACKAGE_NAME}#${AGY_AISTUDIO_SERVICE}/keyStatus`,
    service: AGY_AISTUDIO_SERVICE, namespace: AGY_AISTUDIO_SERVICE, method: 'keyStatus',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: keyStatusRequestCodec }],
    result: keyStatusResultCodec,
  },
  {
    id: `${PACKAGE_NAME}#${AGY_AISTUDIO_SERVICE}/usage`,
    service: AGY_AISTUDIO_SERVICE, namespace: AGY_AISTUDIO_SERVICE, method: 'usage',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: strictCodec(`${PACKAGE_NAME}#AgYAistudioUsageRequest`, parseKeyStatusRequest) }],
    result: strictCodec(`${PACKAGE_NAME}#AgYAistudioUsageResult`, parseUsageResult),
  },
]

type CatalogRow = Awaited<ReturnType<AistudioAdapter['discoverModels']>>[number]
type AistudioModelRow = ModelSnapshot['models'][number] & { compat?: CatalogRow['compat'] }
export type AgYAistudioModelsResult = Omit<ModelSnapshot, 'models'> & { models: AistudioModelRow[] }

/** 目录行投影：只保留设置页模型表所需字段（与 quota/control.ts ModelRow 同形）。 */
function mapRow(row: CatalogRow): AistudioModelRow {
  return {
    id: row.id,
    name: row.name,
    ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}),
    ...(row.contextWindow === undefined ? {} : { contextWindow: row.contextWindow }),
    ...(row.maxOutputTokens === undefined ? {} : { maxOutputTokens: row.maxOutputTokens }),
    ...(row.contextWindowSource === undefined ? {} : { contextWindowSource: row.contextWindowSource }),
    ...(row.compat === undefined ? {} : { compat: row.compat }),
  }
}

export interface AgYAistudioServiceOptions {
  /** 目录发现面（AI Studio adapter）；models 方法消费。 */
  adapter: Pick<AistudioAdapter, 'discoverModels'> & Partial<Pick<AistudioAdapter, 'readUsage' | 'invalidateCredential'>>
  /** 凭据服务（可选注入）；缺席时 setKey/keyStatus 报可读态。 */
  credentials: () => CredentialProvider | undefined
  /** 当前凭据引用名（设置总线）。 */
  credentialRef: () => string
  log?: { warn(message: string, error?: unknown): void }
}

/**
 * AI Studio 设置控制服务：目录读取 + 手动 key 写入 + 掩码状态。
 *
 * 字段用 TS `private` 而非 ES `#私有`：Cordis Service 方法经 Proxy 调用，`this` 是
 * 代理而非真实实例（与 AgYQuotaService 同口径）。
 */
export class AgYAistudioService extends TypertRemoteService {
  private readonly _adapter: AgYAistudioServiceOptions['adapter']
  private readonly _credentials: AgYAistudioServiceOptions['credentials']
  private readonly _credentialRef: AgYAistudioServiceOptions['credentialRef']
  private readonly _log: AgYAistudioServiceOptions['log']

  constructor(ctx: Context, options: AgYAistudioServiceOptions) {
    super(ctx, AGY_AISTUDIO_SERVICE)
    this._adapter = options.adapter
    this._credentials = options.credentials
    this._credentialRef = options.credentialRef
    this._log = options.log
  }

  /** 实时发现目录；失败折叠成 status:'error' + 脱敏消息，不抛。 */
  async models(request?: AgYAistudioModelsRequest): Promise<AgYAistudioModelsResult> {
    const force = parseModelsRequest(request)?.force === true
    try {
      const rows = await this._adapter.discoverModels(force)
      return { status: 'ok', models: rows.map(mapRow) }
    } catch (error) {
      return { status: 'error', models: [], message: redactSensitiveText(errorMessage(error)) }
    }
  }

  async usage(): Promise<AistudioUsageResult> {
    return await this._adapter.readUsage?.() ?? { status: 'error' }
  }

  /** 手动写入 key：只写不回显。凭据服务缺席 / 引用名无效 / 写入失败都报可读态。 */
  async setKey(request: AgYAistudioSetKeyRequest): Promise<AgYAistudioKeyResult> {
    let value: string
    try {
      value = parseSetKeyRequest(request).value
    } catch (error) {
      return { status: 'error', message: redactSensitiveText(errorMessage(error)) }
    }
    const service = this._credentials()
    const ref = this._credentialRef()
    if (service === undefined) return { status: 'error', message: '凭据服务未就绪，无法保存 API key。' }
    if (!isCredentialRefName(ref)) return { status: 'error', message: '凭据引用名无效，无法保存 API key。' }
    try {
      await service.set(credentialRef(ref), value)
      if (service === this._credentials() && ref === this._credentialRef()) this._adapter.invalidateCredential?.(value)
      return { status: 'ok' }
    } catch (error) {
      this._log?.warn('antigravity-aistudio: API key 写入失败')
      return { status: 'error', message: redactAistudioError(errorMessage(error), value) }
    }
  }

  /** 掩码状态：describe 的 configured/writable/source/masked，绝不返回全值。 */
  async keyStatus(): Promise<AgYAistudioKeyStatus> {
    const service = this._credentials()
    const ref = this._credentialRef()
    if (service === undefined || !isCredentialRefName(ref)) {
      return { status: 'error', configured: false, writable: false, message: '凭据服务未就绪或引用名无效。' }
    }
    try {
      const info = await service.describe(credentialRef(ref))
      if (service !== this._credentials() || ref !== this._credentialRef()) {
        return { status: 'error', configured: false, writable: false, message: 'AI Studio 凭据设置已变更' }
      }
      return {
        status: 'ok',
        configured: info.configured,
        writable: info.writable,
        ...(info.source === undefined ? {} : { source: info.source }),
        ...(info.masked === undefined ? {} : { masked: info.masked }),
      }
    } catch {
      return { status: 'error', configured: false, writable: false, message: 'AI Studio 凭据读取失败' }
    }
  }
}
