/** Host 私有代理账户：CLI 导入、OAuth、项目连接与可取消的串行提交。 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { ProxyAccountStore, importCliCredential, isProxyCredentialUsable } from './account-store.js'
import type { ProxyCredential } from './account-store.js'
import { createProxyOAuthFlow, ProxyOAuthError, refreshProxyAccessToken } from './oauth.js'
import type { ProxyOAuthFlow, ProxyOAuthFlowOptions, ProxyOAuthStatus } from './oauth.js'
import type { ProxyCredentialSource } from './adapter.js'
import { TOKEN_SUBPATH } from '../runtime/quota.js'
import { redactSensitiveText } from '../runtime/redact.js'
import { resolveProxyProject } from './quota-source.js'
import { createProxyTransport } from './transport.js'
import type { ProxyTransport } from './transport.js'

export type ProxyAccountPhase = 'signed-out' | 'pending-login' | 'signed-in' | 'login-failed'
export interface ProxyAccountSnapshot {
  phase: ProxyAccountPhase
  message: string
  email?: string
  source?: ProxyCredential['source']
  updatedAt: string
  oauth?: ProxyOAuthStatus
  revision?: number
  connectionStage?: 'preparing' | 'authorizing' | 'finishing'
}
export interface ProxyAccountServiceOptions {
  cacheDir: string
  fetchImpl?: typeof fetch
  cliTokenPath?: string
  log?: { info(message: string): void; warn(message: string, error?: unknown): void }
  now?: () => number
  store?: ProxyAccountStore
  oauthFlow?: ProxyOAuthFlow
  /** 隔离测试可替换监听与期限，仍运行实际 OAuth 流程。 */
  oauthOptions?: Pick<ProxyOAuthFlowOptions, 'listenerFactory' | 'ttlMs'>
  /** 共享生成请求的代理感知 agy 线传输。 */
  projectTransport?: ProxyTransport
}

export class ProxyAccountService implements ProxyCredentialSource {
  private readonly store: ProxyAccountStore
  private readonly oauth: ProxyOAuthFlow
  private readonly options: ProxyAccountServiceOptions
  private readonly projectTransport: ProxyTransport
  private refreshing: Promise<ProxyCredential | undefined> | undefined
  private refreshAbort?: AbortController
  private loginAbort?: AbortController
  private generation = 0
  private signedOut = false
  private accountRevision = 0
  private publishedAccount = false
  private readonly listeners = new Set<() => void>()
  private writes: Promise<void> = Promise.resolve()
  private lastStatus: ProxyAccountSnapshot = { phase: 'signed-out', message: '代理模式未登录', updatedAt: new Date().toISOString() }

  constructor(options: ProxyAccountServiceOptions) {
    this.options = options
    this.store = options.store ?? new ProxyAccountStore({ cacheDir: options.cacheDir })
    this.projectTransport = options.projectTransport ?? createProxyTransport()
    this.oauth = options.oauthFlow ?? createProxyOAuthFlow({
      ...options.oauthOptions,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      commit: async (token, signal) => {
        const generation = this.generation
        this.setStatus({ phase: 'pending-login', connectionStage: 'finishing', message: 'Google 授权已完成，正在检测项目并保存登录态…' })
        let projectId: string
        try { projectId = await resolveProxyProject(token.accessToken, this.projectTransport, signal) } catch (error) {
          signal.throwIfAborted()
          const status = error instanceof LlmError ? error.failure?.status : undefined
          const detail = error instanceof LlmError && error.code === 'AGY_PROXY_PROJECT'
            ? '上游未返回可用项目；请先确认该账户可使用官方 Antigravity，再重新连接'
            : status ? `项目服务请求失败（HTTP ${status}），请重新连接` : '项目服务请求失败或超时，请检查网络后重新连接'
          throw new ProxyOAuthError('project-detection-failed', `Google 授权已完成，但${detail}`)
        }
        const credential: ProxyCredential = {
          accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: token.expiresAt,
          projectId, ...(token.email === undefined ? {} : { email: token.email }), source: 'login',
          updatedAt: new Date(this.now()).toISOString(),
        }
        try {
          if (!await this.saveCredential(credential, generation, signal) || signal.aborted || generation !== this.generation) throw new ProxyOAuthError('cancelled', '代理模式登录已取消')
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof ProxyOAuthError) throw error
          throw new ProxyOAuthError('credential-save-failed', 'Google 授权已完成，但本地登录态保存失败，请检查缓存目录权限后重新连接')
        }
        this.setStatus({ phase: 'signed-in', message: '代理模式登录完成', ...(token.email ? { email: token.email } : {}), source: 'login' })
        // 每次显式 OAuth 都可能换成另一账户；普通 token 刷新才保持原代际。
        this.publishedAccount = false
        this.publishAccount()
        return credential
      },
    })
  }

  /** 返回时 access 必须可用，且项目连接完成；失效 CLI 不阻止显式 OAuth。 */
  async ensureCredential(signal?: AbortSignal): Promise<ProxyCredential | undefined> {
    signal?.throwIfAborted()
    if (this.signedOut) return undefined
    const generation = this.generation
    await this.writes
    if (generation !== this.generation || this.signedOut) return undefined
    const current = this.store.peek() ?? await this.store.load()
    if (generation !== this.generation) return undefined
    if (isProxyCredentialUsable(current, this.now())) return this.prepareCredential(current!, generation, signal)
    if (current?.refreshToken) {
      const refreshed = await this.refresh(signal)
      if (refreshed) return this.prepareCredential(refreshed, generation, signal)
    }
    // 只有没有既有代理账户时才允许导入 CLI。已有账户刷新失败不能静默改用
    // CLI 中可能完全不同的另一账户；显式重登会继续走 OAuth。
    const imported = current ? undefined : await importCliCredential(this.cliTokenPath(), this.now())
    if (imported && generation === this.generation) {
      let usable = imported
      if (!isProxyCredentialUsable(usable, this.now())) {
        if (!usable.refreshToken) return undefined
        try {
          const issued = await refreshProxyAccessToken(usable.refreshToken, this.options.fetchImpl ?? globalThis.fetch, () => this.now(), signal)
          usable = { ...usable, ...issued }
        } catch { signal?.throwIfAborted(); return undefined }
      }
      usable = { ...usable, projectId: await resolveProxyProject(usable.accessToken, this.projectTransport, signal) }
      if (!await this.saveCredential(usable, generation, signal) || generation !== this.generation || signal?.aborted) return undefined
      this.setStatus({ phase: 'signed-in', message: '已导入官方 CLI 登录态', source: 'cli-import' })
      this.publishedAccount = false
      this.publishAccount()
      return usable
    }
    if (!current && generation === this.generation && this.lastStatus.phase !== 'pending-login') this.setStatus({ phase: 'signed-out', message: '代理模式未登录：请先在设置页连接代理账户' })
    return undefined
  }

  async credential(signal?: AbortSignal, options?: { forceRefresh?: boolean }): Promise<ProxyCredential | undefined> {
    if (options?.forceRefresh) {
      const generation = this.generation
      const credential = await this.refresh(signal)
      return credential ? this.prepareCredential(credential, generation, signal) : undefined
    }
    return this.ensureCredential(signal)
  }

  async refresh(signal?: AbortSignal): Promise<ProxyCredential | undefined> {
    signal?.throwIfAborted()
    if (this.signedOut) return undefined
    if (this.refreshing) return this.refreshing
    const generation = this.generation
    const controller = new AbortController()
    this.refreshAbort = controller
    const refreshSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const run = (async (): Promise<ProxyCredential | undefined> => {
      const current = this.store.peek() ?? await this.store.load()
      if (!current?.refreshToken || generation !== this.generation) return undefined
      try {
        const issued = await refreshProxyAccessToken(current.refreshToken, this.options.fetchImpl ?? globalThis.fetch, () => this.now(), refreshSignal)
        const next = { ...current, ...issued, updatedAt: new Date(this.now()).toISOString() }
        return await this.saveCredential(next, generation, refreshSignal) ? next : undefined
      } catch (error) {
        if (!refreshSignal.aborted) this.options.log?.warn('antigravity-proxy: 换发 access token 失败')
        return undefined
      }
    })()
    this.refreshing = run
    try { return await run } finally {
      if (this.refreshing === run) this.refreshing = undefined
      if (this.refreshAbort === controller) this.refreshAbort = undefined
    }
  }

  async login(signal?: AbortSignal): Promise<{ authorizationUrl?: string; message: string }> {
    signal?.throwIfAborted()
    this.loginAbort?.abort(new ProxyOAuthError('cancelled', '代理模式登录已取消'))
    const controller = new AbortController()
    this.loginAbort = controller
    const loginSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    this.signedOut = false
    const generation = this.generation
    this.setStatus({ phase: 'pending-login', connectionStage: 'preparing', message: '正在检查现有登录态并连接项目…' })
    try {
      let existing: ProxyCredential | undefined
      try {
        existing = await this.ensureCredential(loginSignal)
      } catch (error) {
        if (generation !== this.generation || loginSignal.aborted) return { message: '代理模式登录已取消' }
        const status = error instanceof LlmError ? error.failure?.status : undefined
        if (status !== 401 && status !== 403) {
          this.setStatus({ phase: 'login-failed', message: toProxyAccountError(error).message })
          throw error
        }
        // 已导入的 access 被服务端拒绝，允许用户改用新的 OAuth 授权。
      }
      if (generation !== this.generation || loginSignal.aborted) return { message: '代理模式登录已取消' }
      if (isProxyCredentialUsable(existing, this.now())) return { message: existing!.source === 'cli-import' ? '已导入官方 CLI 登录态，代理账户可用' : '代理账户已登录' }
      let started: Awaited<ReturnType<ProxyOAuthFlow['start']>>
      try { started = await this.oauth.start() } catch (error) {
        if (generation === this.generation && !loginSignal.aborted) this.setStatus({ phase: 'login-failed', message: toProxyAccountError(error).message })
        throw error
      }
      if (generation !== this.generation) return { message: '代理模式登录已取消' }
      this.setStatus({ phase: 'pending-login', connectionStage: 'authorizing', message: '等待浏览器完成 Google 授权…' })
      return { authorizationUrl: started.authorizationUrl, message: '请在浏览器完成 Google 授权；完成后自动回到本插件' }
    } finally {
      if (this.loginAbort === controller) this.loginAbort = undefined
    }
  }

  oauthStatus(): ProxyOAuthStatus {
    const { authorizationUrl: _authorizationUrl, ...status } = this.oauth.status()
    return status
  }

  async cancelLogin(): Promise<void> {
    this.setStatus({ phase: 'signed-out', message: '正在取消代理模式登录…' })
    this.invalidatePending()
    const clear = this.clearCredential()
    try {
      await Promise.all([this.oauth.cancel(), clear])
      this.setStatus({ phase: 'signed-out', message: '代理模式登录已取消' })
    } catch (error) {
      this.setStatus({ phase: 'signed-out', message: `登录已停止，本地登录态清除失败：${toProxyAccountError(error).message}` })
      throw error
    }
  }

  async logout(): Promise<void> {
    this.setStatus({ phase: 'signed-out', message: '正在退出并清除代理模式登录态…' })
    this.invalidatePending()
    const clear = this.clearCredential()
    try {
      await Promise.all([this.oauth.cancel(), clear])
      this.setStatus({ phase: 'signed-out', message: '代理模式登录态已清除' })
    } catch (error) {
      this.setStatus({ phase: 'signed-out', message: `账户已停用，本地登录态清除失败：${toProxyAccountError(error).message}` })
      throw error
    }
  }

  status(): ProxyAccountSnapshot {
    const credential = this.store.peek()
    if (!this.signedOut && credential?.projectId && isProxyCredentialUsable(credential, this.now())) {
      return { ...this.lastStatus, phase: 'signed-in', connectionStage: undefined,
        message: this.lastStatus.phase === 'signed-in' ? this.lastStatus.message : '代理账户可用',
        ...(credential.email === undefined ? {} : { email: credential.email }), source: credential.source,
        updatedAt: credential.updatedAt, revision: this.accountRevision }
    }
    const oauth = this.oauthStatus()
    if (!this.signedOut && this.lastStatus.phase === 'pending-login' && this.lastStatus.connectionStage !== 'preparing' && ['failed', 'expired', 'port-conflict'].includes(oauth.phase)) {
      return { ...this.lastStatus, phase: 'login-failed', connectionStage: undefined, message: oauthFailureMessage(oauth),
        revision: this.accountRevision, oauth }
    }
    if (!this.signedOut && this.lastStatus.phase === 'pending-login' && this.lastStatus.connectionStage !== 'preparing' && oauth.phase === 'finishing') {
      return { ...this.lastStatus, connectionStage: 'finishing', message: '正在完成 Google 授权并连接项目…', revision: this.accountRevision, oauth }
    }
    if (!this.signedOut && this.lastStatus.phase === 'signed-in') {
      return { ...this.lastStatus, phase: 'login-failed', message: '代理账户凭据已失效，请重新连接', revision: this.accountRevision, oauth }
    }
    return { ...this.lastStatus, revision: this.accountRevision, oauth }
  }

  email(): string | undefined { return this.signedOut ? undefined : this.store.peek()?.email }
  revision(): number { return this.accountRevision }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async dispose(): Promise<void> {
    this.invalidatePending()
    await this.oauth.dispose()
    await this.writes
    this.listeners.clear()
  }

  private now(): number { return (this.options.now ?? Date.now)() }
  private cliTokenPath(): string { return this.options.cliTokenPath ?? join(homedir(), ...TOKEN_SUBPATH) }

  private invalidatePending(): void {
    this.generation++
    this.signedOut = true
    this.publishedAccount = false
    this.refreshAbort?.abort()
    this.loginAbort?.abort(new ProxyOAuthError('cancelled', '代理模式登录已取消'))
    this.loginAbort = undefined
    this.refreshAbort = undefined
    this.refreshing = undefined
    this.accountChanged()
  }

  private async saveCredential(credential: ProxyCredential, generation: number, signal?: AbortSignal): Promise<boolean> {
    const write = this.writes.then(async () => {
      if (generation !== this.generation || signal?.aborted) return false
      await this.store.save(credential)
      if (generation !== this.generation || signal?.aborted) {
        await this.store.clear()
        return false
      }
      return true
    })
    this.writes = write.then(() => undefined, () => undefined)
    return write
  }

  private async clearCredential(): Promise<void> {
    const clear = this.writes.then(() => this.store.clear())
    this.writes = clear.catch(() => undefined)
    await clear
  }

  private async prepareCredential(credential: ProxyCredential, generation: number, signal?: AbortSignal): Promise<ProxyCredential | undefined> {
    let next = credential
    if (!next.projectId) {
      next = { ...next, projectId: await resolveProxyProject(next.accessToken, this.projectTransport, signal) }
      if (!await this.saveCredential(next, generation, signal)) return undefined
    }
    if (generation !== this.generation || this.signedOut || signal?.aborted) return undefined
    this.setStatus({ phase: 'signed-in', message: '代理账户可用', source: next.source, ...(next.email ? { email: next.email } : {}) })
    this.publishAccount()
    return next
  }

  private publishAccount(): void {
    if (this.publishedAccount) return
    this.publishedAccount = true
    this.accountChanged()
  }
  private accountChanged(): void {
    this.accountRevision++
    for (const listener of this.listeners) {
      try { listener() } catch { this.options.log?.warn('antigravity-proxy: 账户变更监听失败') }
    }
  }
  private setStatus(patch: Partial<ProxyAccountSnapshot> & { phase: ProxyAccountPhase; message: string }): void {
    this.lastStatus = { phase: patch.phase, message: redactSensitiveText(patch.message),
      ...(patch.email === undefined ? {} : { email: patch.email }), ...(patch.source === undefined ? {} : { source: patch.source }),
      ...(patch.connectionStage === undefined ? {} : { connectionStage: patch.connectionStage }),
      updatedAt: new Date(this.now()).toISOString() }
  }
}

function oauthFailureMessage(oauth: ProxyOAuthStatus): string {
  if (oauth.phase === 'expired') return '代理模式授权已过期，请重新连接'
  if (oauth.phase === 'port-conflict') return '代理模式授权回调端口被占用，请关闭占用程序后重试'
  if (oauth.errorCode === 'project-detection-failed' || oauth.errorCode === 'credential-save-failed') {
    return oauth.errorMessage ?? (oauth.errorCode === 'project-detection-failed' ? 'Google 授权已完成，但项目检测失败，请重新连接' : '本地登录态保存失败，请重新连接')
  }
  if (oauth.errorCode === 'oauth-error') return 'Google 授权被拒绝或未完成，请重新连接并允许授权'
  if (oauth.errorCode === 'missing-code') return 'Google 回调缺少授权码，请重新连接'
  if (oauth.errorCode === 'token-exchange-failed') return 'Google 授权码交换失败或超时，请检查网络后重新连接'
  return '代理模式授权未完成，请重新连接'
}

export function toProxyAccountError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error))
  return new LlmError(`代理模式账户操作失败：${message}`, 'AGY_PROXY_ACCOUNT')
}
