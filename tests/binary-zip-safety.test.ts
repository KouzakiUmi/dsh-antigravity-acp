/**
 * 下载安全测试：重定向拒绝、非 2xx 状态、zip 条目校验、可执行挑选、
 * 临时文件失败清理。全部使用注入的 fake fetch / 真实临时目录，无网络。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgyBinaryError,
  AGY_BINARY_ERROR,
  downloadBinary,
  downloadBinaryToFile,
  ensureAgentBinary,
  extractZipSafely,
  pickExecutablePath,
  validateZipEntryPath,
} from '../src/runtime/binary.js'
import type { FetchLike } from '../src/runtime/binary.js'
import { zip, zipToFile } from './helpers/make-zip.js'

function fakeFetch(status: number, body: Uint8Array | string = new Uint8Array([1, 2, 3])): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body).buffer : body.slice().buffer),
  })
}

describe('downloadBinary', () => {
  it('3xx 重定向被拒绝且不跟随（AGY_DOWNLOAD_REDIRECT_REFUSED）', async () => {
    const fetchImpl = fakeFetch(302, '')
    await expect(
      downloadBinary('https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-x86_64.zip', {
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: AGY_BINARY_ERROR.REDIRECT_REFUSED })
  })

  it('非 2xx 非 3xx 状态报 AGY_DOWNLOAD_BAD_STATUS', async () => {
    await expect(
      downloadBinary('https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-x86_64.zip', {
        fetchImpl: fakeFetch(404),
      }),
    ).rejects.toMatchObject({ code: AGY_BINARY_ERROR.BAD_STATUS })
  })

  it('200 时返回字节', async () => {
    const bytes = await downloadBinary('https://dl.google.com/agy-extensions/releases/windows/a.zip', {
      fetchImpl: fakeFetch(200, new Uint8Array([9, 9, 9])),
    })
    expect(Array.from(bytes)).toEqual([9, 9, 9])
  })

  it('非白名单 URL 在下载前即被拒绝', async () => {
    await expect(downloadBinary('https://evil.example.com/a.zip', { fetchImpl: fakeFetch(200) })).rejects.toMatchObject({
      code: AGY_BINARY_ERROR.BLOCKED_URL,
    })
  })

  it('downloadBinaryToFile 支持流式下载直接写入文件', async () => {
    const tmp = join(tmpdir(), `test-dl-${Date.now()}.bin`)
    try {
      const data = new Uint8Array([1, 2, 3, 4, 5])
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(data)
          controller.close()
        },
      })
      await downloadBinaryToFile('https://dl.google.com/test.zip', tmp, {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          body: stream,
          arrayBuffer: async () => data.buffer,
        }),
      })
      const saved = await readFile(tmp)
      expect(Array.from(saved)).toEqual([1, 2, 3, 4, 5])
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined)
    }
  })

  it('downloadBinaryToFile 在未提供 stream body 时回退写入 arrayBuffer', async () => {
    const tmp = join(tmpdir(), `test-dl-fb-${Date.now()}.bin`)
    try {
      const data = new Uint8Array([6, 7, 8])
      await downloadBinaryToFile('https://dl.google.com/test.zip', tmp, {
        fetchImpl: fakeFetch(200, data),
      })
      const saved = await readFile(tmp)
      expect(Array.from(saved)).toEqual([6, 7, 8])
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined)
    }
  })
})

describe('validateZipEntryPath', () => {
  it.each([
    ['ok/file.exe', 'ok/file.exe'],
    ['agy-acp-server-1.4.0-windows-x86_64/agy-acp-server.exe', 'agy-acp-server-1.4.0-windows-x86_64/agy-acp-server.exe'],
    // 目录条目：尾随斜杠是「这是目录」的标记，不是穿越/绝对路径，必须放行
    // （官方 zip 常带 `bin/`、`bin/lib/` 这类条目，旧实现把它们整包判死）。
    ['bin/', 'bin/'],
    ['bin/lib/', 'bin/lib/'],
    ['agy-acp-server-1.4.0-windows-x86_64/bin/', 'agy-acp-server-1.4.0-windows-x86_64/bin/'],
  ])('接受安全相对路径 %s', (input, expected) => {
    expect(validateZipEntryPath(input)).toBe(expected)
  })

  it.each([
    ['绝对路径', '/etc/passwd'],
    ['Windows 盘符（反斜杠）', 'C:\\Windows\\evil.exe'],
    ['Windows 盘符（正斜杠）', 'C:/Windows/evil.exe'],
    ['反斜杠分隔', 'dir\\evil.exe'],
    ['.. 穿越段', '../evil.exe'],
    ['嵌套 .. 穿越段', 'ok/../../evil.exe'],
    ['当前目录段', './evil.exe'],
    ['空路径', ''],
    // 目录条目只在末尾允许一个空段；穿越、绝对、重复斜杠一律照旧拒绝。
    ['目录条目穿越 ..', '../evil/'],
    ['目录条目绝对路径', '/etc/'],
    ['目录条目盘符', 'C:/evil/'],
    ['目录条目反斜杠', 'dir\\evil\\'],
    ['目录条目当前段', './bin/'],
    ['目录条目重复斜杠', 'bin//'],
    ['目录条目仅尾随斜杠后仍有内容', 'bin/../'],
  ])('拒绝不安全条目：%s', (_label, input) => {
    expect(() => validateZipEntryPath(input as string)).toThrowError(AgyBinaryError)
    try {
      validateZipEntryPath(input as string)
    } catch (error) {
      expect((error as AgyBinaryError).code).toBe(AGY_BINARY_ERROR.UNSAFE_ENTRY)
    }
  })
})

describe('pickExecutablePath', () => {
  const windowsEntries = ['agy-acp-server-1.4.0-windows-x86_64/', 'agy-acp-server-1.4.0-windows-x86_64/agy-acp-server.exe', 'docs/readme.txt']

  it('windows：挑出唯一 .exe', () => {
    expect(pickExecutablePath(windowsEntries, 'windows')).toBe('agy-acp-server-1.4.0-windows-x86_64/agy-acp-server.exe')
  })

  it('posix：挑出 agy-acp-server 无扩展名文件', () => {
    const entries = ['agy-acp-server-1.4.0-linux-x86_64/agy-acp-server', 'notes.txt']
    expect(pickExecutablePath(entries, 'posix')).toBe('agy-acp-server-1.4.0-linux-x86_64/agy-acp-server')
  })

  it('找不到可执行文件抛 AGY_ARCHIVE_LAYOUT', () => {
    expect(() => pickExecutablePath(['docs/readme.txt'], 'windows')).toThrowError(
      expect.objectContaining({ code: AGY_BINARY_ERROR.ARCHIVE_LAYOUT }),
    )
  })

  it('多个候选时确定性取最浅深度', () => {
    const entries = ['a/b/server.exe', 'server.exe']
    expect(pickExecutablePath(entries, 'windows')).toBe('server.exe')
  })
})

describe('extractZipSafely', () => {
  it('拒绝含穿越条目的 zip 并不写出越界文件', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'agy-extract-'))
    try {
      const malicious = await zipToFile(
        [
          { name: 'ok.txt', data: Buffer.from('fine') },
          { name: '../escape.txt', data: Buffer.from('bad') },
        ],
        join(dest, 'malicious.zip'),
      )
      await expect(extractZipSafely(malicious, dest)).rejects.toMatchObject({ code: AGY_BINARY_ERROR.UNSAFE_ENTRY })
      // ok.txt 可能在出错前已写出，但越界文件绝不允许存在。
      const dir = await readdir(dest)
      expect(dir).not.toContain('escape.txt')
    } finally {
      await rm(dest, { recursive: true, force: true })
    }
  })

  it('正常 zip 全部解出并返回相对条目', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'agy-extract-'))
    try {
      const safe = await zipToFile(
        [
          { name: 'agy-acp-server-1.4.0-windows-x86_64/agy-acp-server.exe', data: Buffer.from('MZ fake exe') },
          { name: 'agy-acp-server-1.4.0-windows-x86_64/README.txt', data: Buffer.from('hi') },
        ],
        join(dest, 'safe.zip'),
      )
      const extracted = await extractZipSafely(safe, dest)
      expect(extracted).toContain('agy-acp-server-1.4.0-windows-x86_64/agy-acp-server.exe')
      expect(extracted).toContain('agy-acp-server-1.4.0-windows-x86_64/README.txt')
    } finally {
      await rm(dest, { recursive: true, force: true })
    }
  })

  it('含目录条目（bin/、bin/lib/）的 zip 解压成功并真的建出目录', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'agy-extract-'))
    try {
      const archive = await zipToFile(
        [
          { name: 'bin/', data: Buffer.alloc(0) },
          { name: 'bin/lib/', data: Buffer.alloc(0) },
          { name: 'bin/agy-acp-server.exe', data: Buffer.from('MZ fake exe') },
        ],
        join(dest, 'dirs.zip'),
      )
      const extracted = await extractZipSafely(archive, dest)
      // 目录条目只负责建目录（返回值沿用既有语义：只列文件条目）。
      expect(extracted).toEqual(['bin/agy-acp-server.exe'])
      const entries = await readdir(join(dest, 'bin'))
      expect(entries.sort()).toEqual(['agy-acp-server.exe', 'lib'])
      expect(pickExecutablePath(extracted, 'windows')).toBe('bin/agy-acp-server.exe')
    } finally {
      await rm(dest, { recursive: true, force: true })
    }
  })

  it('目录条目形式的穿越（../evil/）仍被拒绝且不建出越界目录', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'agy-extract-'))
    const escapeName = 'agy-zip-escape-dir'
    try {
      const malicious = await zipToFile(
        [
          { name: 'ok/', data: Buffer.alloc(0) },
          { name: `../${escapeName}/`, data: Buffer.alloc(0) },
        ],
        join(dest, 'evil-dir.zip'),
      )
      await expect(extractZipSafely(malicious, dest)).rejects.toMatchObject({ code: AGY_BINARY_ERROR.UNSAFE_ENTRY })
      expect(await readdir(dest)).not.toContain(escapeName)
      expect(await readdir(join(dest, '..'))).not.toContain(escapeName)
    } finally {
      await rm(dest, { recursive: true, force: true })
      await rm(join(dest, '..', escapeName), { recursive: true, force: true })
    }
  })
})

describe('ensureAgentBinary 临时文件清理', () => {
  it('下载失败后版本目录不留临时残留', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'agy-cache-'))
    try {
      await expect(
        ensureAgentBinary({
          autoDownload: true,
          version: '1.4.0',
          cacheDir,
          fetchImpl: fakeFetch(302),
        }),
      ).rejects.toMatchObject({ code: AGY_BINARY_ERROR.REDIRECT_REFUSED })
      // 版本目录可以存在，但 staging 临时目录必须被清理。
      const versionDir = join(cacheDir, '1.4.0')
      const leftovers = (await readdir(versionDir)).filter((name) => name.startsWith('.staging-'))
      expect(leftovers).toEqual([])
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  it('autoDownload=false 且无缓存时报 AGY_BINARY_MISSING', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'agy-cache-'))
    try {
      await expect(ensureAgentBinary({ autoDownload: false, version: '1.4.0', cacheDir })).rejects.toMatchObject({
        code: AGY_BINARY_ERROR.BINARY_MISSING,
      })
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  it('含目录条目的官方式 zip 能整链下载解压并挑出可执行文件', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'agy-cache-'))
    try {
      const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
      const executableName = process.platform === 'win32' ? 'agy-acp-server.exe' : 'agy-acp-server'
      const archiveRoot = `agy-acp-server-1.4.0-${platform}-x86_64`
      const archive = zip([
        { name: `${archiveRoot}/`, data: Buffer.alloc(0) },
        { name: `${archiveRoot}/bin/`, data: Buffer.alloc(0) },
        { name: `${archiveRoot}/bin/${executableName}`, data: Buffer.from('fake executable') },
        { name: `${archiveRoot}/README.txt`, data: Buffer.from('hi') },
      ])
      const resolution = await ensureAgentBinary({
        autoDownload: true,
        version: '1.4.0',
        cacheDir,
        fetchImpl: fakeFetch(200, Uint8Array.from(archive)),
      })
      expect(resolution.source).toBe('download')
      expect(resolution.executablePath.replaceAll('\\', '/')).toContain(
        `1.4.0/extract-1.4.0/${archiveRoot}/bin/${executableName}`,
      )
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})
