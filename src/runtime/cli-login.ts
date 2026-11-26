/**
 * agy CLI 登录态的跨版本只读来源（issue #23）。
 *
 * agy 1.5.17 起 macOS 上 CLI 把 Google OAuth 登录态迁进钥匙串
 * （`gemini`/`antigravity`），不再写 `~/.gemini/antigravity-cli/antigravity-oauth-token`。
 * 本模块提供三类来源的统一读取，供 ACP 凭据导入（credentials.ts）、额度取数
 * （quota.ts）与快照身份（snapshot-store.ts）共用：
 *
 * 1. CLI 登录文件（嵌套 `token.{...}` 或平铺）；
 * 2. macOS 钥匙串条目（值为 `go-keyring-base64:` + base64(JSON)，结构与文件同构）；
 * 3. 旧 Gemini CLI 的 `~/.gemini/oauth_creds.json`（平铺，过期时间为 epoch 毫秒
 *    的 `expiry_date`）。
 *
 * 红线：全部**只读**，绝不写文件或钥匙串；token 材料不进日志与错误消息；
 * 子进程一律经宿主 `ctx.subprocess`（本模块不 import child_process）。
 */
import { homedir } from 'node:os'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { parseTokenState } from './quota.js'
import type { QuotaTokenState } from './quota.js'

/** agy CLI 在 macOS 钥匙串里的 service / account（与 ACP server 的条目刻意分开）。 */
export const CLI_KEYCHAIN_SERVICE = 'gemini'
export const CLI_KEYCHAIN_ACCOUNT = 'antigravity'
/** go-keyring 对长值的编码前缀；剥掉后 base64 解码即登录态 JSON。 */
export const GO_KEYRING_BASE64_PREFIX = 'go-keyring-base64:'

/**
 * 解析钥匙串条目值为登录态 JSON：长值带 `go-keyring-base64:` 前缀，短值可能
 * 原样存 JSON。解码/解析失败返回 undefined——值本身绝不进入错误消息
 * （可能整段就是 token 材料）。
 */
export function parseKeychainTokenDocument(raw: string): unknown {
  const text = raw.trim()
  const candidate = text.startsWith(GO_KEYRING_BASE64_PREFIX)
    ? Buffer.from(text.slice(GO_KEYRING_BASE64_PREFIX.length), 'base64').toString('utf8')
    : text
  try {
    return JSON.parse(candidate) as unknown
  } catch {
    return undefined
  }
}

/** 旧 Gemini CLI 平铺形态：expiry_date（epoch 毫秒）换算成 ISO expiry。 */
export function parseLegacyGeminiToken(raw: unknown): QuotaTokenState {
  const state = parseTokenState(raw)
  if (!state.expiry && isRecord(raw) && typeof raw.expiry_date === 'number' && Number.isFinite(raw.expiry_date)) {
    state.expiry = new Date(raw.expiry_date).toISOString()
  }
  return state
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 只读跑一次 `security find-generic-password -w` 读 macOS 钥匙串里的 CLI 登录态。
 * 任何失败（条目不存在、拒绝访问、超时）返回 undefined 走既有降级；绝不写钥匙串。
 */
export async function readCliKeychainToken(subprocess: SubprocessRuntime): Promise<QuotaTokenState | undefined> {
  try {
    const handle = subprocess.spawn({
      argv: ['/usr/bin/security', 'find-generic-password', '-s', CLI_KEYCHAIN_SERVICE, '-a', CLI_KEYCHAIN_ACCOUNT, '-w'],
      cwd: homedir(),
      env: { HOME: homedir() },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 4 * 1024 } },
      graceMs: 3_000,
      signal: AbortSignal.timeout(10_000),
    })
    const exit = await handle.done.catch(() => undefined)
    if (!exit || exit.exitCode !== 0) return undefined
    const raw = handle.collected.stdout?.readFrom(0).text ?? ''
    return parseTokenState(parseKeychainTokenDocument(raw))
  } catch {
    return undefined
  }
}