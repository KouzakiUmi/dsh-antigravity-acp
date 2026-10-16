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
import { cleanupStalePyiTempDirs, PYI_TEMP_MAX_AGE_MS, PYI_TEMP_PREFIX } from '../src/runtime/binary.js'

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
  it('删除陈旧的 _MEI* 目录，保留新鲜的与无关目录', async () => {
    const now = Date.parse('2026-10-16T12:00:00.000Z')
    const root = await makeTempRoot()
    const stale = await makeMeiDir(root, `${PYI_TEMP_PREFIX}00000aaaa`, PYI_TEMP_MAX_AGE_MS + 60_000, now)
    const fresh = await makeMeiDir(root, `${PYI_TEMP_PREFIX}00000bbbb`, 1_000, now)
    const unrelated = await makeMeiDir(root, 'not-ours', PYI_TEMP_MAX_AGE_MS * 10, now)

    expect(await cleanupStalePyiTempDirs(root, { now: () => now })).toBe(1)
    expect(existsSync(stale)).toBe(false)
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
