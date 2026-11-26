/**
 * agy CLI 登录态跨版本来源（issue #23）的回归测试：
 * 钥匙串值解码（go-keyring-base64 前缀 / 原样 JSON / 坏值）、旧 Gemini CLI
 * 平铺形态的 expiry_date 换算，以及经宿主 subprocess 的只读 `security` 读取。
 * 全部依赖注入，不碰真实钥匙串、真实 home 与真实凭据。
 */
import { describe, expect, it } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  CLI_KEYCHAIN_ACCOUNT,
  CLI_KEYCHAIN_SERVICE,
  GO_KEYRING_BASE64_PREFIX,
  parseKeychainTokenDocument,
  parseLegacyGeminiToken,
  readCliKeychainToken,
} from '../src/runtime/cli-login.js'

const KEYCHAIN_JSON = {
  token: { access_token: 'ya29.kc-access', token_type: 'Bearer', refresh_token: '1//kc-refresh', expiry: '2099-01-01T00:00:00Z', expires_in: 3599 },
  auth_method: 'consumer',
  id_token_email: 'user@example.com',
}

/** 假的 `security` 子进程：记录 spawn spec，按脚本回 stdout 与退出码。 */
function fakeSecurity(options: { stdout?: string; exitCode?: number; spawnThrows?: boolean }): {
  runtime: SubprocessRuntime
  specs: Array<{ argv: string[]; env?: Record<string, string> }>
} {
  const specs: Array<{ argv: string[]; env?: Record<string, string> }> = []
  const runtime = {
    spawn: (spec: { argv: string[]; env?: Record<string, string> }) => {
      if (options.spawnThrows) throw new Error('spawn failed')
      specs.push(spec)
      const text = options.stdout ?? ''
      return {
        collected: { stdout: { readFrom: (offset: number) => ({ text: text.slice(offset), nextOffset: text.length, lossy: false }) } },
        done: Promise.resolve({ exitCode: options.exitCode ?? 0, signal: null }),
        terminate: () => undefined,
      }
    },
  } as unknown as SubprocessRuntime
  return { runtime, specs }
}

describe('parseKeychainTokenDocument', () => {
  it('剥掉 go-keyring-base64: 前缀并 base64 解码出同构 JSON', () => {
    const encoded = GO_KEYRING_BASE64_PREFIX + Buffer.from(JSON.stringify(KEYCHAIN_JSON), 'utf8').toString('base64')
    expect(parseKeychainTokenDocument(encoded)).toEqual(KEYCHAIN_JSON)
  })

  it('短值原样存 JSON 时直接解析', () => {
    expect(parseKeychainTokenDocument(`  ${JSON.stringify(KEYCHAIN_JSON)}\n`)).toEqual(KEYCHAIN_JSON)
  })

  it('坏值返回 undefined，不抛错也不回显值', () => {
    expect(parseKeychainTokenDocument('not-json ya29.SENSITIVE')).toBeUndefined()
    expect(parseKeychainTokenDocument(GO_KEYRING_BASE64_PREFIX + '!!!not-base64-json')).toBeUndefined()
    expect(parseKeychainTokenDocument('')).toBeUndefined()
  })
})

describe('parseLegacyGeminiToken', () => {
  it('平铺字段 + expiry_date（epoch 毫秒）换算成 ISO expiry', () => {
    const state = parseLegacyGeminiToken({ access_token: 'A', refresh_token: 'R', expiry_date: 4102444800000 })
    expect(state).toEqual({ accessToken: 'A', refreshToken: 'R', expiry: '2100-01-01T00:00:00.000Z' })
  })

  it('已有字符串 expiry 时不覆盖；非法输入返回空态', () => {
    expect(parseLegacyGeminiToken({ refresh_token: 'R', expiry: '2099-01-01T00:00:00Z', expiry_date: 1 }).expiry)
      .toBe('2099-01-01T00:00:00Z')
    expect(parseLegacyGeminiToken(null)).toEqual({ accessToken: undefined, refreshToken: undefined, expiry: undefined })
    expect(parseLegacyGeminiToken({ expiry_date: Number.NaN }).expiry).toBeUndefined()
  })
})

describe('readCliKeychainToken', () => {
  it('用 gemini/antigravity 只读读取 security 并解析登录态', async () => {
    const encoded = GO_KEYRING_BASE64_PREFIX + Buffer.from(JSON.stringify(KEYCHAIN_JSON), 'utf8').toString('base64')
    const { runtime, specs } = fakeSecurity({ stdout: `${encoded}\n` })
    const state = await readCliKeychainToken(runtime)
    expect(state).toEqual({ accessToken: 'ya29.kc-access', refreshToken: '1//kc-refresh', expiry: '2099-01-01T00:00:00Z' })
    expect(specs).toHaveLength(1)
    expect(specs[0]!.argv).toEqual(['/usr/bin/security', 'find-generic-password', '-s', CLI_KEYCHAIN_SERVICE, '-a', CLI_KEYCHAIN_ACCOUNT, '-w'])
    // 只读命令：不含 add-generic-password / -U 等写参数。
    expect(specs[0]!.argv.some((arg) => arg.includes('add-generic-password') || arg === '-U')).toBe(false)
  })

  it('条目不存在（非零退出）返回 undefined', async () => {
    const { runtime } = fakeSecurity({ exitCode: 44 })
    expect(await readCliKeychainToken(runtime)).toBeUndefined()
  })

  it('spawn 失败或值不可解析时降级为 undefined，不抛穿', async () => {
    expect(await readCliKeychainToken(fakeSecurity({ spawnThrows: true }).runtime)).toBeUndefined()
    expect(await readCliKeychainToken(fakeSecurity({ stdout: 'garbage' }).runtime))
      .toEqual({ accessToken: undefined, refreshToken: undefined, expiry: undefined })
  })
})