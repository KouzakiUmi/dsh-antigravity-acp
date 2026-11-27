/**
 * AI Studio 行入口（bundle 第三组件 `antigravity-aistudio-router`）。
 *
 * 职责边界：
 * - 只注册 `aistudio` 路由，并 provide 模型目录服务 `antigravityAistudioCatalog`（宿主 Cordis service）；
 * - 独立 provider，与 ACP / 代理两条互斥链路并存，不参与模式仲裁、不碰官方进程；
 * - 设置总线 `antigravityAistudioSettings` 由宿主行 provide（开关、凭据引用名、
 *   模型设置、出网代理）。本行用 `ctx.inject` 弱等待：宿主行缺席时安静不注册。
 * - 凭据经宿主 `credentials` 接缝按操作解析（引用名 → 值）；credentials 服务缺席
 *   或 key 未配置时解析返回 undefined，adapter 报 AUTH 可读态，不静默注册可用模型。
 *
 * 开关默认关闭：`aistudioEnabled` 为 false 时不注册路由。
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import { AistudioAdapter } from './adapter.js'
import { AgYAistudioService } from './remote.js'
import { AISTUDIO_PROVIDER_ID } from './endpoints.js'
import type { AistudioSettingsBus } from './settings-bus.js'
import { createLiveProxiedFetch } from '../runtime/proxied-fetch.js'
import { ProxyConfigError, resolveHttpsProxy } from '../runtime/proxy-env.js'
import { llmError } from '../runtime/llm-error.js'
import { redactSensitiveText } from '../runtime/redact.js'

export const name = 'antigravity-aistudio-router'
export const inject = ['llm']

export function apply(ctx: Context): void {
  // credentials 是可选依赖：缺席时 key 解析返回 undefined（adapter 报 AUTH 可读态）。
  let credentials: CredentialProvider | undefined
  ctx.inject(['credentials'], (scope) => {
    const service = scope.get('credentials') as CredentialProvider | undefined
    credentials = service
    scope.effect(() => () => { if (credentials === service) credentials = undefined })
  })
  // 弱等待宿主行的设置总线：宿主行未装载时本行不注册路由（默认关闭语义）。
  ctx.inject(['antigravityAistudioSettings'], (scope) => {
    const bus = scope.get('antigravityAistudioSettings') as AistudioSettingsBus | undefined
    if (!bus) return
    mountAistudioRouter(scope, bus, () => credentials)
  })
}

function mountAistudioRouter(ctx: Context, bus: AistudioSettingsBus, readCredentials: () => CredentialProvider | undefined): void {
  // AI Studio 出网与官方进程同一套代理设置；标准 Google REST，不需要 agy 线身份
  // 伪装或固定头序，普通代理感知 fetch 即可（不经 wire-identity 端点白名单）。
  const fetch = createLiveProxiedFetch(() => {
    try {
      return resolveHttpsProxy(bus.proxySettings())
    } catch (error) {
      if (error instanceof ProxyConfigError) throw llmError(`代理配置无效，AI Studio 无法出网：${error.message}`, 'AGY_INVALID_PROXY')
      throw error
    }
  })

  const adapter = new AistudioAdapter({
    credential: async () => {
      const service = readCredentials()
      const ref = bus.credentialRef()
      if (service === undefined || !isCredentialRefName(ref)) return undefined
      const resolved = await service.resolve(credentialRef(ref))
      if (readCredentials() !== service || bus.credentialRef() !== ref) return undefined
      return resolved?.value
    },
    fetch,
    dispatch: fetch.dispatch,
    readSettings: () => bus.modelSettings(),
    log: {
      warn: (message, error) => ctx.logger?.warn?.(redactSensitiveText(`${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ''}`)),
    },
  })

  ctx.provide('antigravityAistudioCatalog', { models: (force: boolean) => adapter.discoverModels(force) })

  // 设置页 AI Studio Tab 的 remote 服务：目录读取 + 手动 key 写入（只写不回显）+ 掩码状态。
  // 一个包只注册一次 Host contribution，AGY_AISTUDIO_INVOCATIONS 已由 registerAgYQuotaRemote
  // 合并进同一 contribution；这里只实例化服务（TypertRemoteService 基类向 typert 注册）。
  ctx.plugin(AgYAistudioService, {
    adapter,
    credentials: readCredentials,
    credentialRef: () => bus.credentialRef(),
    log: {
      warn: (message, error) => ctx.logger?.warn?.(redactSensitiveText(`${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ''}`)),
    },
  })

  let registration: (() => void) | undefined
  const syncRegistration = (enabled: boolean): void => {
    const want = enabled && ctx.llm !== undefined
    if (want && registration === undefined) {
      registration = ctx.llm.registerAdapter([AISTUDIO_PROVIDER_ID], adapter)
      ctx.logger?.info?.('antigravity-aistudio: AI Studio 路由已注册')
      try { ctx.emit('llm/adapters-updated') } catch { /* 观察者不能否决目录更新 */ }
    } else if (!want && registration !== undefined) {
      registration()
      registration = undefined
      adapter.invalidateModelCatalog()
      ctx.logger?.info?.('antigravity-aistudio: AI Studio 路由已注销')
      try { ctx.emit('llm/adapters-updated') } catch { /* 同上 */ }
    }
  }

  // 初始状态 + 后续切换都走同一条幂等路径；开关或引用名变化都刷新目录。
  syncRegistration(bus.enabled())
  let lastRef = bus.credentialRef()
  const unsubscribe = bus.subscribe(() => {
    const ref = bus.credentialRef()
    if (ref !== lastRef) { lastRef = ref; adapter.invalidateCredential() }
    else adapter.invalidateModelCatalog()
    try { syncRegistration(bus.enabled()) } catch (error) {
      ctx.logger?.warn?.(`antigravity-aistudio: 路由注册失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ctx.effect(function* () {
    yield () => {
      unsubscribe()
      adapter.invalidateCredential()
      if (registration !== undefined) { registration(); registration = undefined }
      void fetch.close()
    }
  }, 'antigravity-aistudio 路由生命周期清理')
}
