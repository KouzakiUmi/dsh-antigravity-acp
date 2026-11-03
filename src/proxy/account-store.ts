/**
 * 代理模式的账户凭据存储（Host 私有，绝不进日志与客户端响应）。
 *
 * 两个来源：
 * 1. **CLI 导入**：只读官方 CLI 登录态 `~/.gemini/antigravity-cli/antigravity-oauth-token`
 *    （复用 `runtime/quota.ts` 的解析口径），导入后落盘为本插件自己的副本；
 *    官方文件保持只读，刷新结果只写本副本。
 * 2. **loopback 登录**：`proxy/oauth.ts` 的 PKCE 流程完成后写入。
 *
 * 落盘位置：`<cacheDir>/proxy-account.json`，原子写（临时文件 + rename），
 * 尽力 chmod 600（Windows 上 chmod 语义有限，失败静默）。
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseTokenState } from '../runtime/quota.js'
import type { QuotaTokenState } from '../runtime/quota.js'

export const PROXY_ACCOUNT_FILE = 'proxy-account.json'
/** 提前多少毫秒视为将过期并触发换发（与额度取数同一口径）。 */
export const PROXY_TOKEN_EXPIRY_MARGIN_MS = 60_000

export interface ProxyCredential {
  accessToken: string
  refreshToken?: string
  /** 过期时刻（epoch 毫秒）；缺省视为不过期，由请求失败兜底。 */
  expiresAt?: number
  projectId?: string
  email?: string
  source: 'cli-import' | 'login'
  updatedAt: string
}

export interface ProxyAccountStoreDeps {
  cacheDir: string
  readFileImpl?: (path: string) => Promise<string>
  writeFileImpl?: (path: string, data: string) => Promise<void>
  renameImpl?: (from: string, to: string) => Promise<void>
  removeImpl?: (path: string) => Promise<void>
  mkdirImpl?: (path: string) => Promise<void>
  chmodImpl?: (path: string, mode: number) => Promise<void>
  now?: () => number
}

export function proxyAccountPath(cacheDir: string): string {
  return join(cacheDir, PROXY_ACCOUNT_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析落盘副本；access 与 refresh 至少其一，缺来源返回 undefined（按未登录处理，不猜）。 */
export function parseProxyCredential(raw: unknown): ProxyCredential | undefined {
  if (!isRecord(raw)) return undefined
  const accessToken = typeof raw.accessToken === 'string' ? raw.accessToken : undefined
  const refreshToken = typeof raw.refreshToken === 'string' && raw.refreshToken.length > 0 ? raw.refreshToken : undefined
  if (!accessToken && !refreshToken) return undefined
  const expiresAt = typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt) ? raw.expiresAt : undefined
  const projectId = typeof raw.projectId === 'string' && raw.projectId.length > 0 ? raw.projectId : undefined
  const email = typeof raw.email === 'string' && raw.email.length > 0 ? raw.email : undefined
  const source = raw.source === 'login' ? 'login' as const : raw.source === 'cli-import' ? 'cli-import' as const : undefined
  if (!source) return undefined
  return {
    accessToken: accessToken ?? '',
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(email === undefined ? {} : { email }),
    source,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
  }
}

export function isProxyCredentialUsable(credential: ProxyCredential | undefined, nowMs: number, marginMs = PROXY_TOKEN_EXPIRY_MARGIN_MS): boolean {
  if (!credential || !credential.accessToken) return false
  if (credential.expiresAt === undefined) return true
  return credential.expiresAt - nowMs > marginMs
}

/** 把官方 CLI 登录态映射成代理凭据。
 *
 * 只有 refresh_token 也允许导入：适配器在使用前会先换发 access token，
 * 与额度取数对官方登录态的口径一致（access 过期 ≠ 未登录）。
 */
export function proxyCredentialFromCliToken(state: QuotaTokenState, nowMs: number): ProxyCredential | undefined {
  if (!state.accessToken && !state.refreshToken) return undefined
  const expiresAt = state.expiry ? Date.parse(state.expiry) : Number.NaN
  return {
    accessToken: state.accessToken ?? '',
    ...(state.refreshToken === undefined ? {} : { refreshToken: state.refreshToken }),
    ...(Number.isNaN(expiresAt) ? {} : { expiresAt }),
    source: 'cli-import',
    updatedAt: new Date(nowMs).toISOString(),
  }
}

export class ProxyAccountStore {
  private readonly deps: ProxyAccountStoreDeps
  private memory: ProxyCredential | undefined
  private loaded = false
  private loading?: Promise<ProxyCredential | undefined>
  private generation = 0
  private writes: Promise<void> = Promise.resolve()

  constructor(deps: ProxyAccountStoreDeps) {
    this.deps = deps
  }

  private get now(): number { return (this.deps.now ?? Date.now)() }
  private get path(): string { return proxyAccountPath(this.deps.cacheDir) }

  /** 内存优先；未加载过则读盘一次。读不到即未登录。 */
  async load(): Promise<ProxyCredential | undefined> {
    if (this.loaded) return this.memory
    if (this.loading) return this.loading
    const generation = this.generation
    const run = (async () => {
      let credential: ProxyCredential | undefined
      try {
        const read = this.deps.readFileImpl ?? ((path: string) => readFile(path, 'utf8'))
        credential = parseProxyCredential(JSON.parse(await read(this.path)))
      } catch { /* 缺失或损坏的副本按未登录处理。 */ }
      if (generation === this.generation) {
        this.memory = credential
        this.loaded = true
      }
      return this.memory
    })()
    this.loading = run
    try { return await run } finally { if (this.loading === run) this.loading = undefined }
  }

  peek(): ProxyCredential | undefined { return this.memory }

  usable(marginMs?: number): ProxyCredential | undefined {
    return isProxyCredentialUsable(this.memory, this.now, marginMs) ? this.memory : undefined
  }

  /** 写入内存与磁盘；调用方保证不含凭据以外的敏感字段。 */
  async save(credential: ProxyCredential): Promise<void> {
    const generation = ++this.generation
    // 阻止写入期间另起磁盘读取；已有读取由 generation 拦截。
    this.loaded = true
    const run = this.writes.then(async () => {
      const write = this.deps.writeFileImpl ?? ((path: string, data: string) => writeFile(path, data, 'utf8'))
      const ren = this.deps.renameImpl ?? ((from: string, to: string) => rename(from, to))
      const mk = this.deps.mkdirImpl ?? ((path: string) => mkdir(path, { recursive: true }))
      const mode = this.deps.chmodImpl ?? ((path: string, m: number) => chmod(path, m))
      await mk(this.deps.cacheDir)
      const temp = `${this.path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
      await write(temp, `${JSON.stringify(credential, undefined, 2)}\n`)
      await mode(temp, 0o600).catch(() => undefined)
      await ren(temp, this.path)
      await mode(this.path, 0o600).catch(() => undefined)
      if (generation === this.generation) this.memory = credential
    })
    this.writes = run.catch(() => undefined)
    await run
  }

  /** 只更新项目 id / 邮箱等派生字段（换发与目录发现后回写）。 */
  async patch(patch: Partial<Pick<ProxyCredential, 'projectId' | 'email' | 'accessToken' | 'refreshToken' | 'expiresAt'>>): Promise<ProxyCredential | undefined> {
    const current = this.memory ?? await this.load()
    if (!current) return undefined
    const next: ProxyCredential = { ...current, ...patch, updatedAt: new Date(this.now).toISOString() }
    await this.save(next)
    return next
  }

  async clear(): Promise<void> {
    ++this.generation
    this.memory = undefined
    this.loaded = true
    const run = this.writes.then(async () => {
      const remove = this.deps.removeImpl ?? ((path: string) => rm(path))
      try { await remove(this.path) } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error
      }
    })
    this.writes = run.catch(() => undefined)
    await run
  }
}

/** 读官方 CLI 登录态并映射为代理凭据；任何失败返回 undefined（不抛）。 */
export async function importCliCredential(
  tokenPath: string,
  nowMs: number,
  readFileImpl?: (path: string) => Promise<string>,
): Promise<ProxyCredential | undefined> {
  try {
    const read = readFileImpl ?? ((path: string) => readFile(path, 'utf8'))
    const state = parseTokenState(JSON.parse(await read(tokenPath)))
    const credential = proxyCredentialFromCliToken(state, nowMs)
    // 只有 access 或 refresh 至少其一才有意义；只有 refresh 时由适配器先换发再用。
    if (!credential || (!credential.accessToken && !credential.refreshToken)) return undefined
    return credential
  } catch {
    return undefined
  }
}
