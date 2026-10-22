/**
 * DSH 会话 → ACP 会话 的映射缓存（只存 id 与已发送历史的指纹，不存对话内容）。
 *
 * 用途：`resumeSessions` 打开时，插件/宿主重启后还能找回上一次的 ACP 会话并
 * 用 `session/load` 恢复，而不是从零重建。历史权威仍是 DSH：这里只记录
 * 「哪些消息已经发给了那个 ACP 会话」，用于校验当前历史是否仍是它的纯追加。
 *
 * 缓存语义（刻意保守）：
 * - 只存 ID、条数与 sha256 指纹，绝不写入消息正文、系统提示或凭据；
 * - 读取失败、JSON 损坏、格式版本不符一律当作没有映射，静默回退重建；
 * - 条目按最近使用时间保留有限条，避免无限增长。
 */
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** 单条会话映射；字段语义变化时提升 SESSION_MAP_FORMAT。 */
export interface SessionMapEntry {
  /** ACP 会话 id（官方 agent 分配）。 */
  sessionId: string
  /** 建立会话时的 cwd（`session/load` 需要）。 */
  cwd: string
  /** 已发送给该 ACP 会话的 DSH 消息条数。 */
  sentCount: number
  /** 前 sentCount 条消息的滚动指纹（sha256 hex）。 */
  sentHash: string
  /** 上一步实际交付的 assistant blocks 指纹；恢复时必须与 DSH 新增历史一致。 */
  outputHash: string
  /** 路由指纹：模型、思考强度、系统提示与工具目录。 */
  route: string
  /** 最近一次成功发送的时间（毫秒）。 */
  updatedAt: number
}

interface SessionMapFile {
  format: number
  entries: Record<string, SessionMapEntry>
}

/** 映射文件格式版本。 */
const SESSION_MAP_FORMAT = 2
/** 默认保留的会话映射条数。 */
const MAX_ENTRIES = 64
/** 默认文件名。 */
const FILE_NAME = 'sessions.json'

/** 读取会话映射；任何异常都返回空表（调用方回退重建）。 */
export async function readSessionMap(cacheDir: string): Promise<Record<string, SessionMapEntry>> {
  const file = join(cacheDir, FILE_NAME)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as SessionMapFile
    if (parsed.format !== SESSION_MAP_FORMAT || typeof parsed.entries !== 'object' || parsed.entries === null) return {}
    const entries: Record<string, SessionMapEntry> = {}
    for (const [key, entry] of Object.entries(parsed.entries)) {
      if (!entry || typeof entry !== 'object') continue
      const row = entry as Partial<SessionMapEntry>
      if (typeof row.sessionId !== 'string' || row.sessionId === '') continue
      if (typeof row.cwd !== 'string' || row.cwd === '') continue
      if (!Number.isSafeInteger(row.sentCount) || row.sentCount === undefined || row.sentCount < 0) continue
      if (!isHash(row.sentHash) || !isHash(row.outputHash) || !isHash(row.route)) continue
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      entries[key] = {
        sessionId: row.sessionId,
        cwd: row.cwd,
        sentCount: row.sentCount,
        sentHash: row.sentHash,
        outputHash: row.outputHash,
        route: row.route,
        updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
      }
    }
    return entries
  } catch {
    return {}
  }
}

/**
 * 写入会话映射。写入失败（只读缓存目录、磁盘满、文件被占用）静默忽略：
 * 恢复能力是优化，不是功能。
 */
export async function writeSessionMap(cacheDir: string, entries: Record<string, SessionMapEntry>): Promise<boolean> {
  const kept = Object.entries(entries)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ENTRIES)
  const payload: SessionMapFile = { format: SESSION_MAP_FORMAT, entries: Object.fromEntries(kept) }
  const file = join(cacheDir, FILE_NAME)
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
  let ownsTemporary = false
  try {
    await mkdir(dirname(file), { recursive: true })
    const handle = await open(temporary, 'wx', 0o600)
    ownsTemporary = true
    try {
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    ownsTemporary = false
    return true
  } catch {
    return false
  } finally {
    if (ownsTemporary) await unlink(temporary).catch(() => undefined)
  }
}

/**
 * 跨 Host 的排他写租约；另一实例持有缓存时，本实例仅保留内存复用，不读写恢复映射。
 * 不按 mtime 猜测锁过期：崩溃残留锁需在确认所有 Host 已退出后人工清理。
 */
export function createFileSessionMapStore(cacheDir: string, onError?: () => void): SessionMapStore {
  const file = join(cacheDir, 'sessions.lock')
  const marker = JSON.stringify({ pid: process.pid, token: randomUUID() })
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let ready = false
  return new SessionMapStore({
    load: async () => {
      await mkdir(cacheDir, { recursive: true })
      handle = await open(file, 'wx', 0o600)
      await handle.writeFile(marker, 'utf8')
      ready = true
      return readSessionMap(cacheDir)
    },
    save: async entries => {
      if (!ready || !await writeSessionMap(cacheDir, entries)) throw new Error('Session map unavailable')
    },
    onError,
    close: async () => {
      if (!handle) return
      ready = false
      const owned = handle
      handle = undefined
      await owned.close()
      // 只删除本实例确实创建、且内容仍匹配的锁；绝不清理其他 Host 的锁。
      if (await readFile(file, 'utf8').catch(() => '') === marker) await unlink(file).catch(() => undefined)
    },
  })
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export interface SessionMapStorage {
  load(): Promise<Record<string, SessionMapEntry>>
  save(entries: Record<string, SessionMapEntry>): Promise<void> | void
  onError?(): void
  close?(): Promise<void>
}

/**
 * 同一插件的所有 worker 共用一个存储：键的所有权与增量更新集中管理，写入串行化。
 * 接管仍被另一 worker 持有的键时不 load 旧 ACP 会话（它仍可能在旧进程内存中）。
 * 每次只更新调用方本轮的键，旧 worker 无法覆盖或删除新 owner 的状态。
 */
export class SessionMapStore {
  readonly #owners = new Map<string, symbol>()
  #entries: Record<string, SessionMapEntry> = {}
  #ready?: Promise<void>
  #writes: Promise<void> = Promise.resolve()
  #errorReported = false

  constructor(private readonly storage: SessionMapStorage) {}

  async claim(key: string, owner: symbol): Promise<SessionMapEntry | undefined> {
    this.#ready ??= this.storage.load().then(entries => { this.#entries = { ...entries } }, () => { this.#reportError() })
    await this.#ready
    const previous = this.#owners.get(key)
    const entry = previous === undefined || previous === owner ? this.#entries[key] : undefined
    this.#owners.delete(key)
    this.#owners.set(key, owner)
    if (previous !== undefined && previous !== owner) {
      delete this.#entries[key]
      this.#enqueue()
    }
    while (this.#owners.size > MAX_ENTRIES) {
      const oldest = this.#owners.keys().next().value
      if (oldest === undefined) break
      this.#owners.delete(oldest)
    }
    return entry ? { ...entry } : undefined
  }

  owns(key: string, owner: symbol): boolean { return this.#owners.get(key) === owner }

  set(key: string, owner: symbol, entry: SessionMapEntry): void {
    if (!this.owns(key, owner)) return
    this.#entries[key] = { ...entry }
    this.#entries = Object.fromEntries(Object.entries(this.#entries)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, MAX_ENTRIES))
    this.#enqueue()
  }

  delete(key: string, owner: symbol): void {
    if (!this.owns(key, owner)) return
    delete this.#entries[key]
    this.#enqueue()
  }

  /** 卸载释放内存所有权但保留可恢复条目。 */
  release(owner: symbol): void {
    for (const [key, current] of this.#owners) if (current === owner) this.#owners.delete(key)
  }

  async flush(): Promise<void> { await this.#writes }

  async close(): Promise<void> {
    await this.#ready
    await this.flush()
    await this.storage.close?.()
  }

  #enqueue(): void {
    const snapshot = structuredClone(this.#entries)
    this.#writes = this.#writes.then(async () => {
      await this.storage.save(snapshot)
      this.#errorReported = false
    }).catch(() => { this.#reportError() })
  }

  #reportError(): void {
    if (!this.#errorReported) this.storage.onError?.()
    this.#errorReported = true
  }
}
