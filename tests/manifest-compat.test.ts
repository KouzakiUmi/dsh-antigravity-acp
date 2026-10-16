/**
 * 宿主兼容性声明的防回归测试（原创）。
 *
 * 背景：宿主 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility` 会在安装/启用时
 * 校验 manifest——只校验名为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的
 * `peerDependencies`（`engines.dsh` 存在时它单独决定、peer 被忽略），比较对象是
 * `dsh-app-boot` 自身的版本，按 `includePrerelease: true` 匹配；不通过即
 * `incompatible-version` 拒绝安装。
 *
 * 0.1.10 曾把三个 `dsh-*` peer 写成逐 alpha 枚举（止于 `0.2.1-alpha.3`），宿主升到
 * `0.2.1-alpha.4` 后就被判为不兼容。这里把「必须写成覆盖 0.2.x 整个 alphas 段的宽范围」
 * 固化成断言，避免同一个坑再踩一次。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  version: string
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

  it('至少声明了本包真正依赖的宿主服务（dsh-llm / dsh-subprocess / dsh-typert-protocol）', () => {
    const names = peers.map(([name]) => name)
    expect(names).toContain('@deepseek-ai/dsh-llm')
    expect(names).toContain('@deepseek-ai/dsh-subprocess')
    expect(names).toContain('@deepseek-ai/dsh-typert-protocol')
  })

  it('每个受校验 peer 都覆盖 0.2.x 的整个 alpha 段（不得逐 alpha 枚举）', () => {
    for (const [name, range] of peers) {
      for (const version of ['0.2.1-alpha.4', '0.2.1-alpha.9', '0.2.1-alpha.10', '0.2.1', '0.2.2']) {
        expect(satisfies(version, range), `${name} 应满足 ${version}`).toBe(true)
      }
      for (const version of ['0.3.0-0', '0.3.0', '1.0.0']) {
        expect(satisfies(version, range), `${name} 不应满足 ${version}`).toBe(false)
      }
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
    // 收窄到 0.2.0 线的区间写法。
    const narrowed = '>=0.2.0-rc.1 <0.2.1-0'
    expect(satisfies('0.2.1-alpha.4', narrowed)).toBe(false) // 会被「覆盖 0.2.x alpha 段」击中
  })

  it('客户端注入清单覆盖本包实际用到的客户端包', () => {
    const inject = manifest.dsh?.client?.inject ?? []
    for (const pkg of [
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-model-selection',
      '@deepseek-ai/dsh-api-remotes',
    ]) {
      expect(inject).toContain(pkg)
    }
  })
})
