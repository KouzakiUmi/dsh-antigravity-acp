/**
 * 快照身份（cliQuotaIdentity）与取数来源链的一致性（issue #23）：
 * 登录文件优先，macOS 钥匙串只兜底；身份与 fetchQuotaSnapshot 认的必须是
 * 同一颗凭据，否则按账户隔离的快照会被错认。全部依赖注入，不碰真实凭据。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { cliQuotaIdentity, quotaIdentity } from '../src/quota/snapshot-store.js'

const HOME = '/home/tester'
const CLI_TOKEN_PATH = join(HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
const ACP_TOKEN_PATH = join(HOME, '.gemini', 'antigravity-acp', 'acp_token.json')

describe('cliQuotaIdentity', () => {
  it('登录文件优先于钥匙串', async () => {
    const key = await cliQuotaIdentity({
      homedir: () => HOME,
      readFileImpl: async (path) => {
        if (path === CLI_TOKEN_PATH) return JSON.stringify({ token: { refresh_token: '1//from-file' } })
        throw new Error('ENOENT')
      },
      readKeychainToken: async () => ({ refreshToken: '1//from-keychain' }),
    })
    expect(key).toBe(quotaIdentity('1//from-file'))
  })

  it('文件都缺席时用钥匙串凭据确定身份', async () => {
    const key = await cliQuotaIdentity({
      homedir: () => HOME,
      readFileImpl: async () => { throw new Error('ENOENT') },
      readKeychainToken: async () => ({ refreshToken: '1//from-keychain' }),
    })
    expect(key).toBe(quotaIdentity('1//from-keychain'))
  })

  it('ACP 凭据文件仍先于钥匙串（与取数来源链同序）', async () => {
    const key = await cliQuotaIdentity({
      homedir: () => HOME,
      readFileImpl: async (path) => {
        if (path === ACP_TOKEN_PATH) return JSON.stringify({ refresh_token: '1//from-acp', token: 'ya29.x' })
        throw new Error('ENOENT')
      },
      readKeychainToken: async () => ({ refreshToken: '1//from-keychain' }),
    })
    expect(key).toBe(quotaIdentity('1//from-acp'))
  })

  it('钥匙串抛错或无凭据时返回 undefined，不外泄错误', async () => {
    expect(await cliQuotaIdentity({
      homedir: () => HOME,
      readFileImpl: async () => { throw new Error('ENOENT') },
      readKeychainToken: async () => { throw new Error('keychain denied') },
    })).toBeUndefined()
    expect(await cliQuotaIdentity({
      homedir: () => HOME,
      readFileImpl: async () => { throw new Error('ENOENT') },
      readKeychainToken: async () => ({}),
    })).toBeUndefined()
    expect(await cliQuotaIdentity({
      homedir: () => HOME,
      readFileImpl: async () => { throw new Error('ENOENT') },
    })).toBeUndefined()
  })
})