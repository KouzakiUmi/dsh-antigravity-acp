/**
 * 官方登录态导入（原创回归测试）。
 *
 * 覆盖用户明确要求的免登录路径：从本机官方 CLI 的登录态换发出一颗 access token，
 * 落成 ACP server 认的 `acp_token.json` + `settings.json`。全部依赖注入，不碰真实
 * 网络、真实 home 与真实凭据。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  ACP_AUTH_TYPE,
  ACP_SETTINGS_FILENAME,
  ACP_TOKEN_FILENAME,
  ACP_TOKEN_URI,
  buildAcpCredentialDocument,
  buildAcpSettingsDocument,
  ensureAcpCredentials,
  readAcpCredentialState,
  readSettingsAuthType,
} from '../src/runtime/credentials.js'
import type { AcpCredentialDeps } from '../src/runtime/credentials.js'
import type { OAuthClientMeta, QuotaTokenState } from '../src/runtime/quota.js'

const HOME = '/home/tester'
// 路径用宿主 join 构造：插件在真实平台上也是这么拼的（Windows 上是反斜杠）。
const ACP_DIR = join(HOME, '.gemini', 'antigravity-acp')
const TOKEN_PATH = join(ACP_DIR, ACP_TOKEN_FILENAME)
const SETTINGS_PATH = join(ACP_DIR, ACP_SETTINGS_FILENAME)
const CLI_TOKEN_PATH = join(HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')

const CLIENT: OAuthClientMeta = { clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' }
const REFRESHED: QuotaTokenState = {
  accessToken: 'ya29.fresh-access-token',
  refreshToken: '1//refresh-token',
  expiry: '2026-10-16T12:00:00.000Z',
}
const EXISTING_DOC = {
  client_id: CLIENT.clientId,
  client_secret: CLIENT.clientSecret,
  refresh_token: '1//refresh-token',
  token_uri: ACP_TOKEN_URI,
  scopes: ['scope'],
  project_id: 'inherited-project',
}

/** 内存文件系统替身：记录写入，便于断言「写了什么、有没有覆盖」。 */
function createFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const writes: string[] = []
  const dirs: string[] = []
  return {
    files,
    writes,
    dirs,
    readFileImpl: async (path: string) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`ENOENT: ${path}`)
      return value
    },
    writeFileImpl: async (path: string, data: string) => {
      files.set(path, data)
      writes.push(path)
    },
    mkdirImpl: async (path: string) => {
      dirs.push(path)
    },
  }
}

function makeDeps(fs: ReturnType<typeof createFs>, overrides: Partial<AcpCredentialDeps> = {}): AcpCredentialDeps {
  return {
    homedir: () => HOME,
    env: {},
    readFileImpl: fs.readFileImpl,
    writeFileImpl: fs.writeFileImpl,
    mkdirImpl: fs.mkdirImpl,
    resolveClient: async () => CLIENT,
    refresh: async () => REFRESHED,
    now: () => Date.parse('2026-10-16T11:00:00.000Z'),
    ...overrides,
  }
}

describe('buildAcpCredentialDocument', () => {
  it('产出官方 CredentialInfo 六字段 + access token/expiry', () => {
    const doc = buildAcpCredentialDocument({ client: CLIENT, state: REFRESHED })
    expect(doc).toEqual({
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
      refresh_token: '1//refresh-token',
      token_uri: ACP_TOKEN_URI,
      scopes: expect.arrayContaining(['https://www.googleapis.com/auth/cloud-platform']),
      token: 'ya29.fresh-access-token',
      expiry: REFRESHED.expiry,
    })
  })

  it('未知 project_id 时省略该字段（不硬编码账号标识）', () => {
    expect(buildAcpCredentialDocument({ client: CLIENT, state: REFRESHED })).not.toHaveProperty('project_id')
    expect(buildAcpCredentialDocument({ client: CLIENT, state: REFRESHED, projectId: 'p-1' })).toHaveProperty('project_id', 'p-1')
  })

  it('没有 refresh_token 直接报错，不产出半成品', () => {
    expect(() => buildAcpCredentialDocument({ client: CLIENT, state: { accessToken: 'x' } })).toThrow(/refresh_token/)
  })

  it('settings 文档只声明认证方式', () => {
    expect(buildAcpSettingsDocument()).toEqual({ auth: { type: ACP_AUTH_TYPE } })
  })
})

describe('readAcpCredentialState / readSettingsAuthType', () => {
  it('六字段齐备即视为可用，并读出 project_id 与 token 状态', () => {
    const state = readAcpCredentialState(EXISTING_DOC)
    expect(state.usable).toBe(true)
    expect(state.projectId).toBe('inherited-project')
    expect(state.state.refreshToken).toBe('1//refresh-token')
  })

  it('缺字段或非对象一律判为不可用', () => {
    expect(readAcpCredentialState({ refresh_token: 'x' }).usable).toBe(false)
    expect(readAcpCredentialState(undefined).usable).toBe(false)
    expect(readAcpCredentialState('nope').usable).toBe(false)
  })

  it('settings 认证方式解析', () => {
    expect(readSettingsAuthType({ auth: { type: 'oauth-personal' } })).toBe('oauth-personal')
    expect(readSettingsAuthType({ auth: {} })).toBeUndefined()
    expect(readSettingsAuthType({})).toBeUndefined()
    expect(readSettingsAuthType(null)).toBeUndefined()
  })
})

describe('ensureAcpCredentials', () => {
  it('无既有登录态时从 CLI 登录文件导入，并补写 settings.json', async () => {
    const fs = createFs({ [CLI_TOKEN_PATH]: JSON.stringify({ token: { refresh_token: '1//from-cli' } }) })
    const result = await ensureAcpCredentials(makeDeps(fs))
    expect(result).toMatchObject({ ready: true, status: 'imported', settingsWritten: true, authType: ACP_AUTH_TYPE })
    expect(fs.writes).toContain(SETTINGS_PATH)
    expect(fs.writes).toContain(TOKEN_PATH)
    const written = JSON.parse(fs.files.get(TOKEN_PATH)!) as Record<string, unknown>
    expect(written).toMatchObject({ token_uri: ACP_TOKEN_URI, token: 'ya29.fresh-access-token' })
    // 来源是 CLI 的 refresh_token，而客户端标识来自解析器。
    expect(written.client_id).toBe(CLIENT.clientId)
  })

  it('既有凭据的 refresh_token 优先于 CLI 登录文件', async () => {
    const fs = createFs({
      [TOKEN_PATH]: JSON.stringify(EXISTING_DOC),
      [CLI_TOKEN_PATH]: JSON.stringify({ token: { refresh_token: '1//from-cli' } }),
    })
    let seen: QuotaTokenState | undefined
    const result = await ensureAcpCredentials(
      makeDeps(fs, {
        refresh: async (state) => {
          seen = state
          return REFRESHED
        },
      }),
    )
    expect(result.status).toBe('refreshed')
    expect(seen?.refreshToken).toBe('1//refresh-token')
  })

  it('既有 token 仍新鲜时什么都不写（幂等，避免每次启动都打网络）', async () => {
    const fs = createFs({
      [TOKEN_PATH]: JSON.stringify(EXISTING_DOC),
      [SETTINGS_PATH]: JSON.stringify({ auth: { type: ACP_AUTH_TYPE } }),
    })
    const result = await ensureAcpCredentials(
      makeDeps(fs, {
        refresh: async () => {
          throw new Error('不该被调用')
        },
      }),
    )
    expect(result).toMatchObject({ ready: true, status: 'existing', settingsWritten: false })
    expect(fs.writes).toEqual([])
  })

  it('换发失败但磁盘上已有可用凭据：仍算就绪（官方 server 自己会静默换发）', async () => {
    const fs = createFs({ [TOKEN_PATH]: JSON.stringify(EXISTING_DOC) })
    const result = await ensureAcpCredentials(
      makeDeps(fs, {
        refresh: async () => {
          throw new Error('网络不可达')
        },
      }),
    )
    expect(result.ready).toBe(true)
    expect(result.note).toContain('网络不可达')
  })

  it('换发失败且磁盘上没有可用凭据：不就绪，交由调用方退回浏览器登录', async () => {
    const fs = createFs({ [CLI_TOKEN_PATH]: JSON.stringify({ token: { refresh_token: '1//from-cli' } }) })
    const result = await ensureAcpCredentials(
      makeDeps(fs, {
        refresh: async () => {
          throw new Error('网络不可达')
        },
      }),
    )
    expect(result).toMatchObject({ ready: false, status: 'unavailable' })
    expect(result.note).toContain('换发 access token 失败')
  })

  it('拿不到 client 元数据时不就绪，并指明覆盖入口', async () => {
    const fs = createFs({ [CLI_TOKEN_PATH]: JSON.stringify({ token: { refresh_token: '1//from-cli' } }) })
    const result = await ensureAcpCredentials(makeDeps(fs, { resolveClient: async () => undefined }))
    expect(result.ready).toBe(false)
    expect(result.note).toContain('AGY_OAUTH_CLIENT_ID')
  })

  it('连 refresh_token 都没有时不就绪', async () => {
    const fs = createFs({})
    const result = await ensureAcpCredentials(makeDeps(fs))
    expect(result).toMatchObject({ ready: false, status: 'unavailable' })
    expect(result.note).toContain('未找到可导入的官方登录态')
  })

  it('写盘失败：有既有凭据仍就绪，没有则不就绪', async () => {
    const failingWrite = {
      writeFileImpl: async () => {
        throw new Error('EACCES: 低完整性进程无法写入')
      },
    }
    const withExisting = await ensureAcpCredentials(
      makeDeps(
        createFs({
          [TOKEN_PATH]: JSON.stringify(EXISTING_DOC),
          [SETTINGS_PATH]: JSON.stringify({ auth: { type: ACP_AUTH_TYPE } }),
        }),
        failingWrite,
      ),
    )
    expect(withExisting.ready).toBe(true)
    expect(withExisting.note).toContain('无法写 acp_token.json')

    const withoutExisting = await ensureAcpCredentials(
      makeDeps(createFs({ [CLI_TOKEN_PATH]: JSON.stringify({ token: { refresh_token: '1//from-cli' } }) }), failingWrite),
    )
    expect(withoutExisting.ready).toBe(false)
  })

  it('尊重用户已配置的其他认证方式：不改写、也不由本插件负责凭据', async () => {
    const fs = createFs({ [SETTINGS_PATH]: JSON.stringify({ auth: { type: 'gemini-api-key' }, gcp: { project: 'keep-me' } }) })
    const result = await ensureAcpCredentials(makeDeps(fs))
    expect(result).toMatchObject({ ready: true, authType: 'gemini-api-key', settingsWritten: false })
    expect(fs.writes).toEqual([])
    expect(fs.files.get(SETTINGS_PATH)).toContain('keep-me')
  })

  it('project_id 从既有文件继承，不丢字段', async () => {
    const fs = createFs({ [TOKEN_PATH]: JSON.stringify(EXISTING_DOC) })
    await ensureAcpCredentials(makeDeps(fs))
    expect(JSON.parse(fs.files.get(TOKEN_PATH)!)).toHaveProperty('project_id', 'inherited-project')
  })

  it('换发成功时用注入的解析器补 project_id', async () => {
    const fs = createFs({ [CLI_TOKEN_PATH]: JSON.stringify({ token: { refresh_token: '1//from-cli' } }) })
    await ensureAcpCredentials(makeDeps(fs, { resolveProjectId: async () => 'resolved-project' }))
    expect(JSON.parse(fs.files.get(TOKEN_PATH)!)).toHaveProperty('project_id', 'resolved-project')
  })

  it('失败原因里不出现 access/refresh token 原文', async () => {
    const fs = createFs({ [TOKEN_PATH]: JSON.stringify(EXISTING_DOC) })
    const result = await ensureAcpCredentials(
      makeDeps(fs, {
        refresh: async () => {
          throw new Error(`refresh rejected {"refresh_token":"${EXISTING_DOC.refresh_token}","access_token":"ya29.SENSITIVE_TEST_VALUE"}`)
        },
      }),
    )
    expect(result.note ?? '').not.toContain('ya29.')
    expect(result.note ?? '').not.toContain(EXISTING_DOC.refresh_token)
    expect(result.note).toContain('***')
  })
})
