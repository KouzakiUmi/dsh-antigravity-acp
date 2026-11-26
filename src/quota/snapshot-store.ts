import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseTokenState, QUOTA_CACHE_MS, QUOTA_TOKEN_SUBPATHS } from '../runtime/quota.js'
import type { QuotaDeps, QuotaSnapshot } from '../runtime/quota.js'

export type QuotaMode = 'acp' | 'proxy'
export const quotaIdentity = (...parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const MAX_SNAPSHOT_BYTES = 512 * 1024

/**
 * Identifies the credential the quota fetch will use (CLI token, else ACP token,
 * else the macOS keychain entry) without refreshing it or persisting a token.
 * The order mirrors fetchQuotaSnapshot's source chain so identity and fetch
 * never disagree about which account a snapshot belongs to (issue #23).
 */
export async function cliQuotaIdentity(deps: QuotaDeps): Promise<string | undefined> {
  for (const subpath of QUOTA_TOKEN_SUBPATHS) {
    const file = join((deps.homedir ?? homedir)(), ...subpath)
    try {
      const raw = deps.readFileImpl ? await deps.readFileImpl(file) : await readBounded(file)
      const state = parseTokenState(JSON.parse(raw))
      const token = state.refreshToken ?? state.accessToken
      if (token) return quotaIdentity(token)
    } catch { /* try the next credential file */ }
  }
  if (deps.readKeychainToken) {
    try {
      const state = await deps.readKeychainToken()
      const token = state?.refreshToken ?? state?.accessToken
      if (token) return quotaIdentity(token)
    } catch { /* keychain unavailable: no identifiable credential */ }
  }
  return undefined
}

/** One slot per mode. The stored identifier must match the current credential before use. */
export class QuotaSnapshotStore {
  private current = new Map<QuotaMode, { key: string; snapshot: QuotaSnapshot }>()
  constructor(private readonly directory?: string) {}

  async read(mode: QuotaMode, key: string, persistent: boolean): Promise<QuotaSnapshot | undefined> {
    const memory = this.current.get(mode)
    if (memory?.key === key) return memory.snapshot
    if (this.directory === undefined || !persistent) return undefined
    try {
      const row = JSON.parse(await readBounded(join(this.directory, `quota-${mode}.json`)))
      const latest = this.current.get(mode)
      if (latest?.key === key) return latest.snapshot
      if (row?.version !== 1 || row.key !== key || !validSnapshot(row.snapshot)) return undefined
      return row.snapshot
    } catch { return undefined }
  }

  async put(mode: QuotaMode, key: string, snapshot: QuotaSnapshot, persistent: boolean): Promise<void> {
    this.current.set(mode, { key, snapshot })
    if (!persistent || this.directory === undefined) return
    const { credits, ...quota } = snapshot
    // Never store transient diagnostics or model-selection decorations.
    const saved = {
      status: quota.status, updatedAt: quota.updatedAt, plan: quota.plan, groups: quota.groups,
      ...(quota.status === 'error' ? { error: { code: 'not-fetched', message: '暂无套餐额度快照' } } : {}),
      ...(quota.stale ? { stale: true, staleReason: '上次刷新失败' } : {}),
      ...(credits?.status === 'ok' ? { credits: { status: 'ok', updatedAt: credits.updatedAt,
        remainingCredits: credits.remainingCredits, planName: credits.planName,
        ...(credits.stale ? { stale: true, staleReason: '上次刷新失败' } : {}) } } : {}),
    }
    const text = JSON.stringify({ version: 1, key, snapshot: saved })
    if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) return
    const target = join(this.directory, `quota-${mode}.json`)
    const temp = `${target}.${randomUUID()}.tmp`
    await mkdir(this.directory, { recursive: true })
    try { await writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await rename(temp, target) }
    finally { await unlink(temp).catch(() => undefined) }
  }
}

export function markQuotaAge(snapshot: QuotaSnapshot, now: number): QuotaSnapshot {
  const aged = (item: { updatedAt: string; stale?: boolean }) => !item.stale && now - Date.parse(item.updatedAt) >= QUOTA_CACHE_MS
  const stale = snapshot.status === 'ok' && aged(snapshot)
  const credits = snapshot.credits
  return {
    ...snapshot,
    ...(stale ? { stale: true, staleReason: '已超过刷新周期' } : {}),
    ...(credits?.status === 'ok' && aged(credits) ? { credits: { ...credits, stale: true, staleReason: '已超过刷新周期' } } : {}),
  }
}

async function readBounded(path: string): Promise<string> {
  const fd = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await fd.read(buffer, used, buffer.length - used, used)
      if (bytesRead === 0) return buffer.toString('utf8', 0, used)
      used += bytesRead
    }
    throw new Error('quota file too large')
  } finally { await fd.close() }
}

function validSnapshot(value: unknown): value is QuotaSnapshot {
  if (!record(value) || !['ok', 'error'].includes(String(value.status)) || !date(value.updatedAt) || (value.plan !== undefined && typeof value.plan !== 'string')) return false
  if (!Array.isArray(value.groups) || !value.groups.every(group => record(group) && typeof group.name === 'string' && Array.isArray(group.buckets)
    && group.buckets.every(bucket => record(bucket) && typeof bucket.name === 'string' && typeof bucket.disabled === 'boolean'
      && (bucket.remainingPct === undefined || typeof bucket.remainingPct === 'number')))) return false
  const credits = value.credits
  return credits === undefined || (record(credits) && credits.status === 'ok' && date(credits.updatedAt)
    && (credits.remainingCredits === undefined || (typeof credits.remainingCredits === 'number' && Number.isSafeInteger(credits.remainingCredits) && credits.remainingCredits >= 0)))
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function date(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
