/**
 * 宿主兼容性声明的防回归测试（原创）。
 *
 * 背景：宿主 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility` 会在安装/启用时
 * 校验 manifest——只校验名为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的
 * `peerDependencies`（`engines.dsh` 存在时它单独决定、peer 被忽略），比较对象是
 * `dsh-app-boot` 自身的版本，按 `includePrerelease: true` 匹配；不通过即
 * `incompatible-version` 拒绝安装。
 *
 * 同一发布线使用连续范围，但不接受早于实际开发基准的核心。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  version: string
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: { client?: { inject?: string[]; platform?: string } }
}

/** 宿主判定用到的 peer 名判定。 */
function isHostCheckedPeer(name: string): boolean {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

/** 版本解析：主/次/补丁 + 预发布标识串。 */
interface ParsedVersion {
  nums: [number, number, number]
  pre: string[]
}

function parseVersion(value: string): ParsedVersion {
  const [corePart = '', prePart = ''] = value.split('-', 2)
  const nums = corePart.split('.').map((part) => Number(part))
  if (nums.length !== 3 || nums.some((n) => Number.isNaN(n))) throw new Error(`版本无法解析: ${value}`)
  return { nums: [nums[0]!, nums[1]!, nums[2]!], pre: prePart === '' ? [] : prePart.split('.') }
}

/** semver 预发布比较：数值段按数值比，字符串段按字典序，数值段优先级低于字符串段。 */
function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1 // 正式版 > 预发布
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const ln = Number(left)
    const rn = Number(right)
    const numeric = !Number.isNaN(ln) && !Number.isNaN(rn)
    if (numeric && ln !== rn) return ln < rn ? -1 : 1
    if (!numeric && left !== right) return left < right ? -1 : 1
  }
  return 0
}

function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i]! < right.nums[i]! ? -1 : 1
  }
  return comparePre(left.pre, right.pre)
}

/**
 * 只实现本包声明使用的语法（`>=a <b` 以 `||` 连接）；范围写歪会在这里显式失败，
 * 而不是静默放行。
 */
function satisfies(version: string, range: string): boolean {
  const clauses = range.split('||').map((clause) => clause.trim())
  if (clauses.length === 0 || clauses.some((clause) => clause === '')) throw new Error(`范围无法解析: ${range}`)
  return clauses.some((clause) => {
    const comparators = clause.split(/\s+/).filter(Boolean)
    if (comparators.length === 0) throw new Error(`范围无法解析: ${range}`)
    return comparators.every((comparator) => {
      const match = /^(>=|<=|>|<)(.+)$/.exec(comparator)
      if (!match) throw new Error(`不支持的范围比较符（本包只声明区间形式）: ${comparator}`)
      const order = compareVersions(version, match[2]!)
      switch (match[1]) {
        case '>=': return order >= 0
        case '<=': return order <= 0
        case '>': return order > 0
        default: return order < 0
      }
    })
  })
}

describe('宿主兼容性声明', () => {
  const peers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => isHostCheckedPeer(name))
  const coreBaseline = manifest.devDependencies['@deepseek-ai/dsh-llm']!

  it('核心运行模块由宿主提供，不是插件私带的生产依赖', () => {
    const names = peers.map(([name]) => name)
    expect(names).toEqual(expect.arrayContaining(['dsh-attachment', 'dsh-credentials', 'dsh-llm', 'dsh-subprocess', 'dsh-typert-protocol'].map(name => `@deepseek-ai/${name}`)))
    expect(Object.keys(manifest.dependencies).filter(isHostCheckedPeer)).toEqual([])
    for (const name of names) expect(manifest.devDependencies[name], name).toBe(coreBaseline)
  })

  it('覆盖已对齐的 Core 与同一发布线，不接受旧核心和下一补丁预发布', () => {
    for (const [name, range] of peers) {
      for (const version of [coreBaseline, '0.2.2-rc.6', '0.2.2']) {
        expect(satisfies(version, range), `${name} 应满足 ${version}`).toBe(true)
      }
      for (const version of ['0.2.1', '0.2.2-rc.3', '0.2.2-rc.4', '0.2.3-alpha.2', '0.3.0']) {
        expect(satisfies(version, range), `${name} 不应满足 ${version}`).toBe(false)
      }
    }
  })

  it('锁文件里所有 DSH 核心包属于同一版本（包括传递依赖）', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version: string; dev?: boolean; peer?: boolean }>
    }
    const core = Object.entries(lock.packages).filter(([name]) => /(?:^|\/)node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/.test(name))
    expect(core.length).toBeGreaterThan(peers.length)
    for (const [path, pkg] of core) {
      expect(pkg.version, path).toBe(coreBaseline)
      expect(pkg.dev === true || pkg.peer === true, path).toBe(true)
    }
  })

  it('声明的是区间形式，而不是逐版本枚举', () => {
    for (const [name, range] of peers) {
      expect(range, `${name} 不应使用 || 枚举精确版本`).not.toMatch(/\|\|\s*\d/)
      expect(range).toMatch(/>=/)
      expect(range).toMatch(/</)
    }
  })

  it('该判定对本包历史写法有识别力（自检：证明上面两条断言不是恒真）', () => {
    // 0.1.10 实际使用的枚举写法。
    const historical = '0.2.0-rc.2 || 0.2.1-alpha.1 || 0.2.1-alpha.2 || 0.2.1-alpha.3'
    expect(historical).toMatch(/\|\|\s*\d/) // 会被「不应使用 || 枚举精确版本」击中
    // 旧的宽范围会放行本版已经不使用的 rc.3。
    expect(satisfies('0.2.2-rc.3', '>=0.2.2-0 <0.3.0-0')).toBe(true)
  })

  it('客户端注入清单覆盖本包实际用到的客户端包', () => {
    const inject = manifest.dsh?.client?.inject ?? []
    // 只声明实机存在的包：`@deepseek-ai/dsh-client-ui-slots` 不在 dsh 0.2.2-rc.1 的
    // 部署里（宿主对 graph 里找不到的 inject 名静默跳过），留着是死声明。
    for (const pkg of [
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-model-selection',
      '@deepseek-ai/dsh-api-remotes',
    ]) {
      expect(inject).toContain(pkg)
    }
    expect(inject).not.toContain('@deepseek-ai/dsh-client-ui-slots')
  })
})
