/**
 * 可执行文件安装根目录解析（原创回归测试）。
 *
 * 这是 2026-10-16 那次「Gemini 静默挂死」的修复核心：安装根必须落在带 Low 强制
 * 完整性标签的 DSH home 之外，否则 Windows 会按映像文件标签把官方进程降成 LOW，
 * 它便写不进中等完整性的 `~/.gemini/antigravity-acp`。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { resolveCacheDir, resolveInstallRoot, CACHE_SUBPATH, INSTALL_DIR_NAME, INSTALL_ROOT_ENV } from '../src/runtime/binary.js'

const homedir = () => 'C:\\Users\\tester'

describe('resolveInstallRoot', () => {
  it('windows 默认取 %LOCALAPPDATA%，且不落在 DSH home 之下', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }
    const root = resolveInstallRoot(env, 'win32', homedir)
    expect(root).toBe(`C:\\Users\\tester\\AppData\\Local\\${INSTALL_DIR_NAME}`)
    // 关键断言：安装根与 DSH 缓存根必须分处两棵树。
    expect(root.startsWith(resolveCacheDir({ DSH_HOME: 'C:\\Users\\tester\\.dsh' }, homedir))).toBe(false)
    expect(root.includes('\\.dsh')).toBe(false)
  })

  it('windows 缺少 LOCALAPPDATA 时退回 USERPROFILE 下的 AppData\\Local', () => {
    const root = resolveInstallRoot({ USERPROFILE: 'C:\\Users\\tester' }, 'win32', homedir)
    expect(root).toBe(`C:\\Users\\tester\\AppData\\Local\\${INSTALL_DIR_NAME}`)
  })

  it('环境变量覆盖优先级最高', () => {
    const env = { [INSTALL_ROOT_ENV]: 'D:\\agy\\home', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }
    expect(resolveInstallRoot(env, 'win32', homedir)).toBe('D:\\agy\\home')
  })

  it('posix 取 XDG_CACHE_HOME，其次 ~/.cache', () => {
    // 拼接用宿主 join（插件运行时同样如此），因此断言也按宿主分隔符拼。
    expect(resolveInstallRoot({ XDG_CACHE_HOME: '/home/tester/.cache' }, 'linux', () => '/home/tester')).toBe(
      join('/home/tester/.cache', INSTALL_DIR_NAME),
    )
    expect(resolveInstallRoot({}, 'darwin', () => '/Users/tester')).toBe(join('/Users/tester/.cache', INSTALL_DIR_NAME))
  })

  it('数据缓存仍留在 DSH home（只有可执行文件必须搬走）', () => {
    expect(resolveCacheDir({ DSH_HOME: 'C:\\Users\\tester\\.dsh' }, homedir).replaceAll('/', '\\')).toBe(
      ['C:\\Users\\tester\\.dsh', ...CACHE_SUBPATH].join('\\'),
    )
  })
})
