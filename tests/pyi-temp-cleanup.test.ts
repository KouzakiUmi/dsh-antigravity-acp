/**
 * onefile 解压目录清理（原创回归测试）。
 *
 * 官方 server 是 PyInstaller onefile：每次启动解压约 330MB 到 TMPDIR，正常退出自行
 * 删除，被强杀时不会——实测重复调试后累积到数十 GB。这里只删「足够陈旧」的目录，
 * 避免误删并发实例正在用的那个。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupStalePyiTempDirs,
  cleanupStaleStagingDirs,
  PYI_TEMP_MAX_AGE_MS,
  PYI_TEMP_PREFIX,
  STAGING_MAX_AGE_MS,
  STAGING_DIR_PREFIX,
} from '../src/runtime/binary.js'

const dirs: string[] = []

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true })
})

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agy-pyi-'))
  dirs.push(root)
  return root
}

/** 造一个带文件的解压目录，并把 mtime 设为指定年龄。 */
async function makeMeiDir(root: string, name: string, ageMs: number, nowMs: number): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'python310.dll'), 'x')
  const stamp = new Date(nowMs - ageMs)
  await utimes(dir, stamp, stamp)
  return dir
}

describe('cleanupStalePyiTempDirs', () => {
  it('没有进程所有权记录的旧 _MEI* 目录无论年龄均保留', async () => {
    const now = Date.parse('2026-10-16T12:00:00.000Z')
    const root = await makeTempRoot()
    const stale = await makeMeiDir(root, `${PYI_TEMP_PREFIX}00000aaaa`, PYI_TEMP_MAX_AGE_MS + 60_000, now)
    const fresh = await makeMeiDir(root, `${PYI_TEMP_PREFIX}00000bbbb`, 1_000, now)
    const unrelated = await makeMeiDir(root, 'not-ours', PYI_TEMP_MAX_AGE_MS * 10, now)

    expect(await cleanupStalePyiTempDirs(root, { now: () => now })).toBe(0)
    expect(existsSync(stale)).toBe(true)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })

  it('目录不存在时返回 0，不抛错', async () => {
    expect(await cleanupStalePyiTempDirs(join(tmpdir(), 'agy-pyi-missing-xyz'))).toBe(0)
  })

  it('阈值可覆盖，用于「什么都不算陈旧」的极端配置', async () => {
    const now = Date.parse('2026-10-16T12:00:00.000Z')
    const root = await makeTempRoot()
    const dir = await makeMeiDir(root, `${PYI_TEMP_PREFIX}00000cccc`, PYI_TEMP_MAX_AGE_MS * 2, now)
    expect(await cleanupStalePyiTempDirs(root, { maxAgeMs: Number.MAX_SAFE_INTEGER, now: () => now })).toBe(0)
    expect(existsSync(dir)).toBe(true)
  })
})

describe('cleanupStaleStagingDirs', () => {
  it('删除陈旧的 .staging-* 目录（包含直接子目录与版本子目录下的），保留新鲜目录', async () => {
    const now = Date.parse('2026-10-16T12:00:00.000Z')
    const root = await makeTempRoot()
    // 根目录下的 stale staging
    const directStale = await makeMeiDir(root, `${STAGING_DIR_PREFIX}111`, STAGING_MAX_AGE_MS + 10_000, now)
    // 根目录下的 fresh staging
    const directFresh = await makeMeiDir(root, `${STAGING_DIR_PREFIX}222`, 1_000, now)
    // 版本目录 1.4.0 下的 stale staging
    const versionSubdir = join(root, '1.4.0')
    const nestedStale = await makeMeiDir(versionSubdir, `${STAGING_DIR_PREFIX}333`, STAGING_MAX_AGE_MS + 20_000, now)
    const nestedFresh = await makeMeiDir(versionSubdir, `${STAGING_DIR_PREFIX}444`, 2_000, now)

    for (const path of [directStale, directFresh, nestedStale, nestedFresh]) {
      await writeFile(join(path, 'dsh-owner.json'), JSON.stringify({ version: 1, pid: 12345, id: 'test', startedAt: '2026-01-01', state: 'active' }))
      // Writing the marker updates mtime; restore the fixture's age afterwards.
      const age = path === directStale || path === nestedStale ? STAGING_MAX_AGE_MS + 60_000 : 1_000
      await utimes(path, new Date(now - age), new Date(now - age))
    }
    const removed = await cleanupStaleStagingDirs(root, { now: () => now, isProcessAlive: () => false })
    expect(removed).toBe(2)
    expect(existsSync(directStale)).toBe(false)
    expect(existsSync(directFresh)).toBe(true)
    expect(existsSync(nestedStale)).toBe(false)
    expect(existsSync(nestedFresh)).toBe(true)
  })

  it('即使很旧也保留活跃、状态未知以及无所有权标记的 staging', async () => {
    const root = await makeTempRoot()
    const now = Date.now()
    const path = await makeMeiDir(root, `${STAGING_DIR_PREFIX}live`, STAGING_MAX_AGE_MS * 2, now)
    expect(await cleanupStaleStagingDirs(root, { now: () => now, isProcessAlive: () => false })).toBe(0)
    await writeFile(join(path, 'dsh-owner.json'), JSON.stringify({ version: 1, pid: 12345, id: 'test', startedAt: '2026-01-01' }))
    await utimes(path, new Date(now - STAGING_MAX_AGE_MS * 2), new Date(now - STAGING_MAX_AGE_MS * 2))
    expect(await cleanupStaleStagingDirs(root, { now: () => now, isProcessAlive: () => true })).toBe(0)
    expect(await cleanupStaleStagingDirs(root, { now: () => now, isProcessAlive: () => undefined })).toBe(0)
    expect(existsSync(path)).toBe(true)
  })

  it('不存在的目录返回 0', async () => {
    expect(await cleanupStaleStagingDirs(join(tmpdir(), 'staging-missing-xyz'))).toBe(0)
  })
})
