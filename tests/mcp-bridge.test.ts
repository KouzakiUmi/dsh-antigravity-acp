/**
 * 私有 loopback MCP 桥的多会话回归测试（原创）。
 *
 * 覆盖 B2：每个 ACP `session/new` 都会让 agent 新建一条 MCP 连接，因此桥必须
 * 能同时服务多个 MCP 会话，而不是只认第一个 initialize。全部用真实
 * 127.0.0.1 HTTP 端点 + SDK 官方 Client/Transport，不起任何子进程。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  AGY_BRIDGE_ERROR,
  BRIDGE_AUTH_HEADER,
  BRIDGE_MCP_SERVER_NAME,
  BRIDGE_SESSION_HEADER,
  McpToolBridge,
} from '../src/bridge/mcp-bridge.js'

const TOOLS: ToolSchema[] = [
  {
    name: 'read_file',
    description: '读取宿主上的一个文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
]

interface Endpoint {
  url: string
  headers: Record<string, string>
}

/** ACP session/new 注册的 http 型 MCP server 的形状（按 SDK 运行期数据窄化）。 */
interface HttpMcpRegistration {
  type: string
  url: string
  headers: Array<{ name: string; value: string }>
}

const bridges: McpToolBridge[] = []
const clients: Client[] = []

afterEach(async () => {
  while (clients.length > 0) await clients.pop()?.close().catch(() => undefined)
  while (bridges.length > 0) await bridges.pop()?.close()
})

function makeBridge(): McpToolBridge {
  const bridge = new McpToolBridge()
  bridge.publishTools(TOOLS)
  bridges.push(bridge)
  return bridge
}

/** 取桥的 loopback 端点与鉴权头（等价于 ACP session/new 注册给 agent 的内容）。 */
function endpointOf(bridge: McpToolBridge): Endpoint {
  const registration = bridge.acpRegistration()[0] as HttpMcpRegistration | undefined
  if (!registration || registration.type !== 'http') throw new Error('桥未注册 http 型 MCP server')
  return {
    url: registration.url,
    headers: Object.fromEntries(registration.headers.map((header) => [header.name, header.value])),
  }
}

/** 以 agent 的身份连上桥端点（每个 Client 代表一条独立 MCP 会话）。 */
async function connectClient(endpoint: Endpoint, name: string): Promise<Client> {
  const client = new Client({ name, version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: endpoint.headers },
  }))
  clients.push(client)
  return client
}

/** 取 MCP tool 结果的文本（callTool 的返回类型是联合体，测试里按需窄化）。 */
function textOf(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ text?: string }> }).content
  return content?.[0]?.text
}

describe('MCP 桥多会话隔离', () => {
  it('未知或已撤销的工具调用立即拒绝，不产生 park', async () => {
    const bridge = makeBridge()
    await bridge.start()
    const client = await connectClient(endpointOf(bridge), 'catalog-check')
    const parked = vi.fn()
    bridge.onParked(parked)
    // 超时仅用来让缺失白名单校验的旧实现快速失败，不作为成功条件。
    const unknown = await client.callTool({ name: 'not_published', arguments: {} }, undefined, { timeout: 150 })
    expect(unknown.isError).toBe(true)
    expect(textOf(unknown)).toContain(AGY_BRIDGE_ERROR.UNKNOWN_TOOL)
    bridge.publishTools([])
    const revoked = await client.callTool({ name: 'read_file', arguments: { path: 'x' } }, undefined, { timeout: 150 })
    expect(revoked.isError).toBe(true)
    expect(parked).not.toHaveBeenCalled()
    expect(bridge.pendingCallIds()).toEqual([])
  })

  it('切换回合后旧通道不能向新回合投递调用，且凭证轮换', async () => {
    const bridge = makeBridge()
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    await bridge.attach(serverSide)
    const client = new Client({ name: 'old-round', version: '0.0.0' })
    clients.push(client)
    await client.connect(clientSide)
    const previousToken = bridge.token
    expect((await client.listTools()).tools).toHaveLength(1)
    bridge.beginRound(TOOLS)
    expect(bridge.token).not.toBe(previousToken)
    expect((await client.listTools()).tools).toEqual([])
    const result = await client.callTool({ name: 'read_file', arguments: { path: 'old.txt' } })
    expect(result.isError).toBe(true)
    expect(bridge.pendingCallIds()).toEqual([])
  })

  it('两个独立 MCP Client 都能 connect/initialize 到同一桥端点，回喂互不串扰', async () => {
    const bridge = makeBridge()
    await bridge.start()
    const endpoint = endpointOf(bridge)

    const first = await connectClient(endpoint, 'agent-session-1')
    // 旧实现：第二个 Client 的 initialize 撞上单一有状态 transport，被回
    // 400 "Server already initialized"，这里必须成功。
    const second = await connectClient(endpoint, 'agent-session-2')

    expect((await first.listTools()).tools.map((tool) => tool.name)).toEqual(['read_file'])
    expect((await second.listTools()).tools.map((tool) => tool.name)).toEqual(['read_file'])
    // 两条连接各自完成握手，服务端名字都来自同一个桥。
    expect(first.getServerVersion()?.name).toBe(BRIDGE_MCP_SERVER_NAME)
    expect(second.getServerVersion()?.name).toBe(BRIDGE_MCP_SERVER_NAME)

    let firstSettled: string | undefined
    let secondSettled: string | undefined
    const firstCall = first.callTool({ name: 'read_file', arguments: { path: 'first.txt' } })
    void firstCall.then((result) => { firstSettled = textOf(result) }, () => undefined)
    await vi.waitFor(() => expect(bridge.pendingCallIds()).toHaveLength(1))
    const secondCall = second.callTool({ name: 'read_file', arguments: { path: 'second.txt' } })
    void secondCall.then((result) => { secondSettled = textOf(result) }, () => undefined)
    await vi.waitFor(() => expect(bridge.pendingCallIds()).toHaveLength(2))

    const [firstId, secondId] = bridge.pendingCallIds() as [string, string]
    expect(firstId).not.toBe(secondId)

    await bridge.deliverResults([{ callId: firstId, text: '第一个会话的结果', isError: false }])
    await vi.waitFor(() => expect(firstSettled).toBe('第一个会话的结果'))
    // 回喂只结算它自己那条会话的调用，另一个会话仍在 park。
    expect(secondSettled).toBeUndefined()
    expect(bridge.pendingCallIds()).toEqual([secondId])

    await bridge.deliverResults([{ callId: secondId, text: '第二个会话的结果', isError: false }])
    await vi.waitFor(() => expect(secondSettled).toBe('第二个会话的结果'))
    expect(bridge.pendingCallIds()).toEqual([])
  })

  it('第一个会话 DELETE 结束后第二个会话不受影响，旧 session id 被拒', async () => {
    const bridge = makeBridge()
    await bridge.start()
    const endpoint = endpointOf(bridge)

    const first = await connectClient(endpoint, 'agent-session-1')
    const second = await connectClient(endpoint, 'agent-session-2')
    const firstSessionId = (first.transport as StreamableHTTPClientTransport).sessionId
    const secondSessionId = (second.transport as StreamableHTTPClientTransport).sessionId
    expect(firstSessionId).toBeTruthy()
    expect(secondSessionId).toBeTruthy()
    // 每个会话一条独立 transport（独立签发的 mcp-session-id）。
    expect(firstSessionId).not.toBe(secondSessionId)

    const firstTransport = first.transport as StreamableHTTPClientTransport
    await firstTransport.terminateSession()
    await first.close()

    // 旧会话 id 不再被接受（按 MCP 规范回 404），且清理只影响它自己。
    const stale = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        ...endpoint.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [BRIDGE_SESSION_HEADER]: firstSessionId as string,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(stale.status).toBe(404)
    expect(await stale.text()).toContain(AGY_BRIDGE_ERROR.UNKNOWN_SESSION)

    // 第二个会话继续可用：listTools 与 tools/call 全链路正常。
    expect((await second.listTools()).tools.map((tool) => tool.name)).toEqual(['read_file'])
    const call = second.callTool({ name: 'read_file', arguments: { path: 'still-works.txt' } })
    void call.catch(() => undefined)
    await vi.waitFor(() => expect(bridge.pendingCallIds()).toHaveLength(1))
    await bridge.deliverResults([{ callId: bridge.pendingCallIds()[0]!, text: '第二个会话仍然可用', isError: false }])
    expect(textOf(await call)).toBe('第二个会话仍然可用')
  })

  it('桥 close() 一并关闭所有会话通道', async () => {
    const bridge = makeBridge()
    await bridge.start()
    const endpoint = endpointOf(bridge)
    const first = await connectClient(endpoint, 'agent-session-1')
    const second = await connectClient(endpoint, 'agent-session-2')

    await bridge.close()

    expect(bridge.listening).toBe(false)
    expect(bridge.acpRegistration()).toEqual([])
    await expect(fetch(endpoint.url, { method: 'POST', body: '{}', headers: endpoint.headers })).rejects.toThrow()
    await expect(first.listTools()).rejects.toThrow()
    await expect(second.listTools()).rejects.toThrow()
  })

  it('重复 attach 被拒，in-memory 通道照常工作', async () => {
    const bridge = makeBridge()
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await bridge.attach(serverSide)
    expect(bridge.listening).toBe(true)
    await expect(bridge.attach(InMemoryTransport.createLinkedPair()[1]))
      .rejects.toThrow(AGY_BRIDGE_ERROR.ALREADY_ATTACHED)

    const client = new Client({ name: 'in-memory-client', version: '0.0.0' })
    await client.connect(clientSide)
    clients.push(client)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['read_file'])
  })

  it('缺少随机 token 时不建立任何会话', async () => {
    const bridge = makeBridge()
    await bridge.start()
    const endpoint = endpointOf(bridge)
    const unauthorized = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.text()).toContain(AGY_BRIDGE_ERROR.UNAUTHORIZED)
    // 401 之后仍能正常建立会话（拒绝不会污染桥状态）。
    const client = await connectClient(endpoint, 'agent-session-1')
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['read_file'])
    expect(endpointOf(bridge).headers[BRIDGE_AUTH_HEADER]).toBe(`Bearer ${bridge.token}`)
    expect(BRIDGE_MCP_SERVER_NAME).toBe('dsh-tools')
  })

  it('切换回合时关闭上一回合的 MCP 会话通道，旧 session id 被拒', async () => {
    const bridge = makeBridge()
    await bridge.start()
    const old = await connectClient(endpointOf(bridge), 'old-round')
    const oldSessionId = (old.transport as StreamableHTTPClientTransport).sessionId
    expect(oldSessionId).toBeTruthy()

    bridge.beginRound(TOOLS)
    const endpoint = endpointOf(bridge)
    // 修复前：通道只在 transport.onclose 时摘除，旧连接会按回合累积。
    const stale = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        ...endpoint.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [BRIDGE_SESSION_HEADER]: oldSessionId as string,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(stale.status).toBe(404)
    expect(await stale.text()).toContain(AGY_BRIDGE_ERROR.UNKNOWN_SESSION)

    // 新回合照常握手并可用。
    const fresh = await connectClient(endpoint, 'new-round')
    expect((await fresh.listTools()).tools.map((tool) => tool.name)).toEqual(['read_file'])
  })

  it('无 session 头且不是 initialize 的请求失败后不留下会话通道', async () => {
    const bridge = makeBridge()
    await bridge.start()
    const endpoint = endpointOf(bridge)
    const malformed = await fetch(endpoint.url, {
      method: 'POST',
      headers: { ...endpoint.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(malformed.status).toBe(400)

    // 畸形请求不污染桥：随后的正常 initialize 与列工具照常工作。
    const client = await connectClient(endpoint, 'after-malformed')
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['read_file'])
    // 运行期 HTTP 错误没有被静默丢弃（健康时应为 undefined）。
    expect(bridge.lastHttpError).toBeUndefined()
  })
})
