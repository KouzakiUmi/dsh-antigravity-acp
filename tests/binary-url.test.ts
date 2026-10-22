/**
 * 下载 URL 纯函数与缓存路径解析的单元测试。
 * 关键回归：windows x86_64 1.4.0 的实测 200 URL 逐字保持 hyphen 形式；
 * underscore 变体（404）绝不允许出现。
 */
import { describe, expect, it } from 'vitest'
import {
  CACHE_SUBPATH,
  DEFAULT_ACP_SERVER_VERSION,
  assertDownloadUrl,
  mapNodePlatform,
  resolveCacheDir,
  resolveDownloadUrl,
  defaultAgentArgs,
  versionCachePaths,
} from '../src/runtime/binary.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('resolveDownloadUrl', () => {
  it('windows x86_64 1.4.0 产出实测可用的 hyphen URL（逐字）', () => {
    expect(resolveDownloadUrl('windows', 'x86_64', '1.4.0')).toBe(
      'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-x86_64.zip',
    )
  })

  it('默认版本常量为 1.4.0', () => {
    expect(DEFAULT_ACP_SERVER_VERSION).toBe('1.4.0')
    expect(resolveDownloadUrl('windows', 'x86_64')).toContain('agy-acp-server-1.4.0-windows-x86_64.zip')
  })

  it('darwin/linux 按官方 registry 发行命名拼接（不宣称旧版实机验证）', () => {
    expect(resolveDownloadUrl('darwin', 'aarch64', '1.4.0')).toBe(
      'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.0-darwin-arm64.zip',
    )
    expect(resolveDownloadUrl('linux', 'x86_64', '1.4.0')).toBe(
      'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.0-linux-x86_64.zip',
    )
  })

  it('Linux 官方启动参数保留 uid 空值，其他系统没有该参数', () => {
    expect(defaultAgentArgs('linux')).toEqual(['--uid='])
    expect(defaultAgentArgs('darwin')).toEqual([])
    expect(defaultAgentArgs('win32')).toEqual([])
  })

  it('版本号不能注入路径或查询参数', () => {
    for (const version of ['../outside', '1.4.0/../../elsewhere', '1.4.0?secret=x']) {
      expect(() => versionCachePaths('/cache', version)).toThrow(/版本号/)
      expect(() => resolveDownloadUrl('windows', 'x86_64', version)).toThrow(/版本号/)
    }
  })

  it('任何产物都不得包含 underscore 变体（实测 404 形式）', () => {
    for (const platform of ['windows', 'darwin', 'linux'] as const) {
      for (const arch of ['x86_64', 'aarch64'] as const) {
        expect(resolveDownloadUrl(platform, arch)).not.toMatch(/_(x86_64|aarch64)/)
      }
    }
  })
})

describe('assertDownloadUrl', () => {
  it('拒绝 http 与非白名单域', () => {
    expect(() => assertDownloadUrl('http://dl.google.com/agy-extensions/releases/windows/a.zip')).toThrow()
    expect(() => assertDownloadUrl('https://evil.example.com/a.zip')).toThrow()
    expect(() => assertDownloadUrl('ftp://dl.google.com/a.zip')).toThrow()
    expect(() => assertDownloadUrl('not a url')).toThrow()
  })

  it('接受 https + dl.google.com', () => {
    expect(assertDownloadUrl('https://dl.google.com/agy-extensions/releases/windows/a.zip').hostname).toBe('dl.google.com')
  })
})

describe('mapNodePlatform', () => {
  it('映射已知组合', () => {
    expect(mapNodePlatform('win32', 'x64')).toEqual({ platform: 'windows', arch: 'x86_64' })
    expect(mapNodePlatform('darwin', 'arm64')).toEqual({ platform: 'darwin', arch: 'aarch64' })
    expect(mapNodePlatform('linux', 'x64')).toEqual({ platform: 'linux', arch: 'x86_64' })
  })

  it('未知组合抛 AGY_PLATFORM_UNSUPPORTED（不做 URL 猜测）', () => {
    expect(() => mapNodePlatform('freebsd', 'x64')).toThrow(/AGY_PLATFORM_UNSUPPORTED|未知平台组合/)
  })
})

describe('resolveCacheDir', () => {
  it('DSH_HOME 存在时用 $DSH_HOME/cache/antigravity-acp', () => {
    const dir = resolveCacheDir({ DSH_HOME: '/data/dsh-home' }, () => '/home/user')
    expect(dir).toBe(join('/data/dsh-home', ...CACHE_SUBPATH))
  })

  it('DSH_HOME 缺失时回退到 homedir/.dsh', () => {
    const dir = resolveCacheDir({}, () => '/home/user')
    expect(dir).toBe(join('/home/user', '.dsh', ...CACHE_SUBPATH))
  })

  it('homedir 抛错时退到系统临时目录', () => {
    const dir = resolveCacheDir({}, () => {
      throw new Error('no home')
    })
    expect(dir.startsWith(tmpdir())).toBe(true)
    expect(dir).toContain('dsh-antigravity-cache')
  })
})
