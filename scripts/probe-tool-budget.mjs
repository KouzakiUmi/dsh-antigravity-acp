/**
 * 开发探针（issue #18）：定位「工具定义总长超约 60k 时官方 agent 丢工具」的发生层。
 *
 * 用本机缓存的官方 agy-acp-server + 既有登录态，经插件自己的 MCP 桥发布一组
 * 大小受控的合成工具，然后让模型逐行列出它可见的工具名。对比注册名与可见名，
 * 判断丢弃是否发生在官方 agent / 上游，以及是否与工具体积相关。
 *
 * 仅开发诊断用：不随包发布（scripts/ 不进 dist），直接 spawn 官方进程；
 * 插件运行时仍一律经 ctx.subprocess。消耗一次短生成请求。
 *
 * 用法：node scripts/probe-tool-budget.mjs [--version 1.5.2] [--total 24]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureAgentBinary, defaultAgentArgs } from '../dist/runtime/binary.js'
import { ensureAcpCredentials } from '../dist/runtime/credentials.js'
import { AgentLink, agentStreamFromSubprocess } from '../dist/protocol/agent-link.js'
import { McpToolBridge, BRIDGE_MCP_SERVER_NAME } from '../dist/bridge/mcp-bridge.js'
import { AGY_CLIENT_CAPABILITIES } from '../dist/index.js'

const args = process.argv.slice(2)
const version = args.includes('--version') ? args[args.indexOf('--version') + 1] : undefined
const total = args.includes('--total') ? Number(args[args.indexOf('--total') + 1]) : 24
const bigBytes = args.includes('--big-bytes') ? Number(args[args.indexOf('--big-bytes') + 1]) : 7_000

const resolution = await ensureAgentBinary({ autoDownload: false, ...(version ? { version } : {}) })
console.log('[probe] binary:', resolution.executablePath, 'source:', resolution.source)
await ensureAcpCredentials({})
console.log('[probe] credentials ensured')

// 合成工具：前 1/3 为大描述（约 7KB），其余小描述（约 300B）。
const bigCount = Math.max(1, Math.floor(total / 3))
const tools = []
for (let i = 0; i < total; i += 1) {
  const big = i < bigCount
  const name = big ? `probe_big_${i}` : `probe_small_${i}`
  const description = big
    ? `Large synthetic tool ${i}. ` + 'x'.repeat(bigBytes)
    : `Small synthetic tool ${i}. Returns a fixed string.`
  tools.push({ name, description, parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } })
}
const catalogBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8')
console.log('[probe] tools:', tools.length, 'catalog JSON bytes:', catalogBytes, 'big:', bigCount)

const bridge = new McpToolBridge({})
await bridge.start()
bridge.beginRound(tools, 'probe-owner')

const tmp = mkdtempSync(join(tmpdir(), 'agy-probe-'))
const child = spawn(resolution.executablePath, [...defaultAgentArgs()], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, TEMP: tmp, TMP: tmp },
})
let stderrTail = ''
child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + String(chunk)).slice(-2000) })

const texts = []
const link = new AgentLink({
  stream: agentStreamFromSubprocess(child),
  handlers: {
    onSessionUpdate: (notification) => {
      const update = notification.update
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') texts.push(update.content.text)
    },
  },
  requestTimeoutMs: 180_000,
})
link.start()

try {
  await link.initialize({ clientCapabilities: AGY_CLIENT_CAPABILITIES })
  console.log('[probe] initialized')
  await link.authenticate()
  console.log('[probe] authenticated')
  const session = await link.newSession({
    cwd: process.cwd(),
    mcpServers: bridge.acpRegistration(),
    _meta: { antigravity: { enabledTools: [], eagerMcpServers: [BRIDGE_MCP_SERVER_NAME] } },
  })
  console.log('[probe] session:', session.sessionId)
  const response = await link.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: '请逐行列出你当前可用的全部工具的名称（每行一个名称，不要解释、不要编号）。' }],
  })
  console.log('[probe] stopReason:', response.stopReason)
  const answer = texts.join('')
  const visible = new Set()
  for (const tool of tools) if (answer.includes(tool.name)) visible.add(tool.name)
  const missing = tools.filter((tool) => !visible.has(tool.name))
  console.log('[probe] visible:', visible.size, '/', tools.length)
  console.log('[probe] missing:', JSON.stringify(missing.map((tool) => ({ name: tool.name, descBytes: Buffer.byteLength(tool.description, 'utf8') }))))
  console.log('[probe] answer head:', answer.slice(0, 600).replace(/\n/g, ' | '))
} catch (error) {
  console.error('[probe] FAILED:', error?.message ?? error)
  console.error('[probe] stderr tail:', stderrTail.slice(-800))
  process.exitCode = 1
} finally {
  await link.close().catch(() => undefined)
  child.kill()
  // 等官方进程真正退出再清理 TEMP，否则 PyInstaller 残留句柄导致 EPERM。
  await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 10_000).unref() })
  await bridge.close().catch(() => undefined)
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }) } catch { /* 残留目录交由系统清理 */ }
}
