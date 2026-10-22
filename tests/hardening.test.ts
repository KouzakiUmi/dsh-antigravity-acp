/**
 * 健壮性回归（全插件审查 2026-10-20 发现的缺陷）。
 *
 * 1. AgentLink：回调（session/update、非预期入站请求）抛错或 reject 不能杀链路、
 *    也不能变成 unhandledRejection（后者会终止宿主进程）。
 * 2. ensureAcpCredentials：已有 settings.json 但没有 auth.type 时必须合并而不是整份
 *    覆盖（文件头注释承诺「已有内容一律尊重」）；损坏的文件不覆盖。
 * 3. OAuth client 提取：官方 agy CLI 才带 client 元数据，必须先扫它；二进制按 latin1
 *    读（比 utf8 快一个数量级，且正则只匹配 ASCII，结果等价）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import { versionCachePaths } from '../src/runtime/binary.js'
import { AgentLink } from '../src/protocol/agent-link.js'
import { ensureAcpCredentials } from '../src/runtime/credentials.js'
import { resolveOAuthClient } from '../src/runtime/quota.js'

function fakePair(): {
  stream: Stream
  agentIn: ReadableStreamDefaultReader<AnyMessage>
  agentOut: WritableStreamDefaultWriter<AnyMessage>
} {
  const agentToClient = new TransformStream<AnyMessage, AnyMessage>()
  const clientToAgent = new TransformStream<AnyMessage, AnyMessage>()
  return {
    stream: { writable: clientToAgent.writable, readable: agentToClient.readable },
    agentIn: clientToAgent.readable.getReader(),
    agentOut: agentToClient.writable.getWriter(),
  }
}

type AgentView = AnyMessage & { method?: string; id?: string | number | null }

/** 假 agent：对 initialize 应答，其余请求交给 onRequest；返回「client→agent」消息记录。 */
function runAgent(
  pair: ReturnType<typeof fakePair>,
  onRequest: (message: AgentView) => AnyMessage | undefined = () => undefined,
): AgentView[] {
  const seen: AgentView[] = []
  void (async () => {
    for (;;) {
      const { done, value } = await pair.agentIn.read()
      if (done) break
      const message = value as AgentView
      seen.push(message)
      if (message.method === 'initialize') {
        await pair.agentOut.write({ jsonrpc: '2.0', id: message.id!, result: { protocolVersion: 1, agentCapabilities: {} } })
        continue
      }
      const reply = onRequest(message)
      if (reply) await pair.agentOut.write(reply)
    }
  })()
  return seen
}

const unhandled: unknown[] = []
process.on('unhandledRejection', (reason) => { unhandled.push(reason) })
afterEach(() => { unhandled.length = 0 })

const SESSION_UPDATE: AnyMessage = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk' } },
}

describe('AgentLink 回调健壮性', () => {
  it('session/update 回调同步抛错：链路保持可用，后续请求仍可应答', async () => {
    const pair = fakePair()
    runAgent(pair, (message) => message.method === 'session/new'
      ? { jsonrpc: '2.0', id: message.id!, result: { sessionId: 's-1' } }
      : undefined)
    const link = new AgentLink({
      stream: pair.stream,
      handlers: { onSessionUpdate: () => { throw new Error('handler boom') } },
    })
    link.start()
    await link.initialize()
    await pair.agentOut.write(SESSION_UPDATE)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(link.closed).toBe(false)
    const session = await link.newSession({ cwd: '.', mcpServers: [] })
    expect(session.sessionId).toBe('s-1')
    await link.close()
  })

  it('session/update 回调异步 reject：不产生 unhandledRejection', async () => {
    const pair = fakePair()
    runAgent(pair)
    const link = new AgentLink({
      stream: pair.stream,
      handlers: { onSessionUpdate: async () => { throw new Error('async boom') } },
    })
    link.start()
    await link.initialize()
    await pair.agentOut.write(SESSION_UPDATE)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(unhandled).toEqual([])
    expect(link.closed).toBe(false)
    await link.close()
  })

  it('非预期入站请求的观测回调抛错：仍回 method-not-found，且无 unhandledRejection', async () => {
    const pair = fakePair()
    const seen = runAgent(pair)
    const link = new AgentLink({
      stream: pair.stream,
      handlers: { onUnexpectedAgentRequest: async () => { throw new Error('observer boom') } },
    })
    link.start()
    await link.initialize()
    await pair.agentOut.write({ jsonrpc: '2.0', id: 'agent-1', method: 'fs/read_text_file', params: { sessionId: 's', path: 'x' } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const answer = seen.find((message) => (message as { id?: unknown }).id === 'agent-1' && 'error' in message) as
      | { error?: { code: number } }
      | undefined
    expect(answer?.error?.code).toBe(-32601)
    expect(unhandled).toEqual([])
    await link.close()
  })
})

const HOME = '/home/tester'
const ACP_DIR = join(HOME, '.gemini', 'antigravity-acp')
const SETTINGS_PATH = join(ACP_DIR, 'settings.json')
const TOKEN_PATH = join(ACP_DIR, 'acp_token.json')
const FRESH_TOKEN_DOC = JSON.stringify({
  client_id: 'id',
  client_secret: 'secret',
  refresh_token: 'refresh',
  token_uri: 'https://x',
  token: 'access',
  expiry: '2099-01-01T00:00:00.000Z',
})

function memoryFs(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial))
  const writes: string[] = []
  return {
    files,
    writes,
    deps: {
      homedir: () => HOME,
      env: {},
      readFileImpl: async (path: string) => {
        const value = files.get(path)
        if (value === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
        return value
      },
      writeFileImpl: async (path: string, data: string) => {
        files.set(path, data)
        writes.push(path)
      },
      mkdirImpl: async () => undefined,
      now: () => Date.parse('2026-10-20T00:00:00.000Z'),
    },
  }
}

describe('ensureAcpCredentials 对既有 settings.json 的处理', () => {
  it('已有内容但没有 auth.type：合并写入，保留其它字段', async () => {
    const fs = memoryFs({
      [TOKEN_PATH]: FRESH_TOKEN_DOC,
      [SETTINGS_PATH]: JSON.stringify({ gcp: { project: 'my-project' }, theme: 'dark' }),
    })
    const result = await ensureAcpCredentials(fs.deps)
    expect(result.ready).toBe(true)
    const written = JSON.parse(fs.files.get(SETTINGS_PATH)!) as Record<string, unknown>
    expect(written).toMatchObject({ gcp: { project: 'my-project' }, theme: 'dark', auth: { type: 'oauth-personal' } })
  })

  it('损坏（无法解析）的 settings.json 不被覆盖，给出可行动的说明', async () => {
    const corrupt = '{ "gcp": { "project": "p" '
    const fs = memoryFs({ [TOKEN_PATH]: FRESH_TOKEN_DOC, [SETTINGS_PATH]: corrupt })
    const result = await ensureAcpCredentials(fs.deps)
    expect(fs.files.get(SETTINGS_PATH)).toBe(corrupt)
    expect(fs.writes).not.toContain(SETTINGS_PATH)
    expect(result.note ?? '').toMatch(/settings\.json/)
  })

  it('文件不存在时照旧新建', async () => {
    const fs = memoryFs({ [TOKEN_PATH]: FRESH_TOKEN_DOC })
    const result = await ensureAcpCredentials(fs.deps)
    expect(result).toMatchObject({ ready: true, settingsWritten: true })
    expect(JSON.parse(fs.files.get(SETTINGS_PATH)!)).toEqual({ auth: { type: 'oauth-personal' } })
  })
})

describe('resolveOAuthClient 的二进制扫描', () => {
  const CLIENT_TEXT = `junk 12345-abcdef.apps.googleusercontent.com junk GOCSPX-${'a'.repeat(28)}`

  it('OAuth 元数据使用新安装根与共享 CLI 发现，忽略旧 DSH 数据缓存', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agy-oauth-paths-'))
    const installRoot = join(root, 'install')
    const dataCache = join(root, 'old-dsh-cache')
    const extractDir = versionCachePaths(installRoot, '1.4.0').extractDir
    const serverName = process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par'
    const explicitCli = join(root, 'custom', process.platform === 'win32' ? 'agy.exe' : 'agy')
    try {
      await mkdir(extractDir, { recursive: true })
      await writeFile(join(extractDir, serverName), 'test fixture')
      const visited: string[] = []
      const client = await resolveOAuthClient({
        env: { AGY_ACP_HOME: installRoot, AGY_CLI_BIN: explicitCli, DSH_HOME: dataCache },
        cacheDir: dataCache,
        homedir: () => root,
        readFileImpl: async (path) => { visited.push(path); return path === join(extractDir, serverName) ? CLIENT_TEXT : 'no metadata' },
      })
      expect(client?.clientId).toBe('12345-abcdef.apps.googleusercontent.com')
      expect(visited[0]).toBe(explicitCli)
      expect(visited).toContain(join(extractDir, serverName))
      expect(visited.some((path) => path.startsWith(dataCache))).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('显式 binaryPaths 保持调用方给定的顺序并能解析出 client', async () => {
    const order: string[] = []
    const client = await resolveOAuthClient({
      env: {},
      binaryPaths: ['/cache/agy_acp_server', '/bin/agy'],
      readFileImpl: async (path: string) => {
        order.push(path)
        return path === '/bin/agy' ? CLIENT_TEXT : 'no client here'
      },
    })
    expect(client?.clientId).toBe('12345-abcdef.apps.googleusercontent.com')
    expect(order).toEqual(['/cache/agy_acp_server', '/bin/agy'])
  })

  it('默认候选里官方 agy CLI 排在 ACP server 之前（只有它携带 client 元数据）', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'agy-oauth-'))
    try {
      const extractDir = versionCachePaths(cacheDir, '1.4.0').extractDir
      await mkdir(extractDir, { recursive: true })
      const serverName = process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server'
      await writeFile(join(extractDir, serverName), 'x')
      const order: string[] = []
      await resolveOAuthClient({
        env: { LOCALAPPDATA: '/local' },
        homedir: () => '/home/u',
        installRoot: cacheDir,
        acpVersion: '1.4.0',
        readFileImpl: async (path: string) => {
          order.push(path)
          throw new Error('ENOENT')
        },
      })
      const serverIndex = order.findIndex((path) => path.includes('agy_acp_server'))
      const agyIndex = order.findIndex((path) => /[\\/]agy(\.exe)?$/.test(path))
      expect(serverIndex).toBeGreaterThanOrEqual(0)
      expect(agyIndex).toBeGreaterThanOrEqual(0)
      expect(agyIndex).toBeLessThan(serverIndex)
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})
