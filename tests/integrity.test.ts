/**
 * Windows 强制完整性标签的只读诊断（原创回归测试）。
 *
 * 样本取自 2026-10-16 的真实 `icacls` 输出（中文系统，但该字段不本地化）。
 */
import { describe, expect, it } from 'vitest'
import {
  describeLowIntegrity,
  isLowIntegrityTarget,
  parseLowIntegrityLabel,
  LOW_INTEGRITY_MARKER,
} from '../src/runtime/integrity.js'

/** 真实样本：位于 ~/.dsh 下的二进制，继承了 Low 标签。 */
const LOW_SAMPLE = [
  'C:\\Users\\Fractal\\.dsh\\cache\\antigravity-acp\\1.4.0\\extract-1.4.0\\agy_acp_server.exe FRACTAL-WS\\Fractal:(I)(F)',
  '',
  '                                                                Mandatory Label\\Low Mandatory Level:(I)(NW)',
  '',
  '已成功处理 1 个文件; 处理 0 个文件时失败',
].join('\n')

/** 真实样本：位于 %LOCALAPPDATA% 下的同一份二进制，无标签（等效中等完整性）。 */
const MEDIUM_SAMPLE = [
  'C:\\Users\\Fractal\\AppData\\Local\\dsh-antigravity-host\\1.4.0\\agy_acp_server.exe FRACTAL-WS\\Fractal:(F)',
  '',
  '已成功处理 1 个文件; 处理 0 个文件时失败',
].join('\n')

/** 真实样本：目录本身带 Low 标签（`(OI)(CI)` 模板继承）。 */
const LOW_DIR_SAMPLE = 'C:\\Users\\Fractal\\.dsh Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)'

describe('parseLowIntegrityLabel', () => {
  it('识别 Low 标签（文件与目录两种形态）', () => {
    expect(parseLowIntegrityLabel(LOW_SAMPLE)).toBe(true)
    expect(parseLowIntegrityLabel(LOW_DIR_SAMPLE)).toBe(true)
  })

  it('无标签即中等完整性，不误报', () => {
    expect(parseLowIntegrityLabel(MEDIUM_SAMPLE)).toBe(false)
    expect(parseLowIntegrityLabel('Medium Mandatory Level')).toBe(false)
    expect(parseLowIntegrityLabel('')).toBe(false)
  })

  it('标记常量与实际输出一致（大小写不敏感）', () => {
    expect(LOW_INTEGRITY_MARKER).toBe('Mandatory Label\\Low Mandatory Level')
    expect(parseLowIntegrityLabel(LOW_INTEGRITY_MARKER.toLowerCase())).toBe(true)
  })
})

describe('isLowIntegrityTarget', () => {
  it('只在 windows 上探测，其他平台直接放行且不调用 runner', async () => {
    let called = 0
    const run = async () => {
      called += 1
      return LOW_SAMPLE
    }
    expect(await isLowIntegrityTarget('x', run, 'linux')).toBe(false)
    expect(called).toBe(0)
  })

  it('runner 抛错或返回 undefined 时 fail-open（探测失败不得阻断启动）', async () => {
    expect(await isLowIntegrityTarget('x', async () => undefined, 'win32')).toBe(false)
    expect(
      await isLowIntegrityTarget(
        'x',
        async () => {
          throw new Error('icacls 不可用')
        },
        'win32',
      ),
    ).toBe(false)
  })

  it('windows 上命中 Low 标签返回 true', async () => {
    expect(await isLowIntegrityTarget('x', async () => LOW_SAMPLE, 'win32')).toBe(true)
    expect(await isLowIntegrityTarget('x', async () => MEDIUM_SAMPLE, 'win32')).toBe(false)
  })
})

describe('describeLowIntegrity', () => {
  it('给出路径、机制与可执行的修法，且提到两个覆盖入口', () => {
    const text = describeLowIntegrity('C:\\x\\agy_acp_server.exe')
    expect(text).toContain('C:\\x\\agy_acp_server.exe')
    expect(text).toContain('AGY_ACP_HOME')
    expect(text).toContain('binaryPath')
    expect(text).toContain('低完整性')
  })
})
