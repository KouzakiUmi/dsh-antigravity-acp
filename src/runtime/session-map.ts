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
const SESSION_MAP_FORMAT = 1
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
      if (typeof row.sentCount !== 'number' || !Number.isFinite(row.sentCount) || row.sentCount < 0) continue
      if (typeof row.sentHash !== 'string' || row.sentHash === '') continue
      if (typeof row.route !== 'string') continue
      entries[key] = {
        sessionId: row.sessionId,
        cwd: row.cwd,
        sentCount: row.sentCount,
        sentHash: row.sentHash,
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
export async function writeSessionMap(cacheDir: string, entries: Record<string, SessionMapEntry>): Promise<void> {
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
  } catch {
    // 映射写不进去不影响对话。
  } finally {
    if (ownsTemporary) await unlink(temporary).catch(() => undefined)
  }
}
