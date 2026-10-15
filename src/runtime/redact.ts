/**
 * 诊断文本脱敏（纯函数，无 IO）。
 *
 * 为什么需要：官方 `agy_acp_server` 会把**完整的 Google OAuth 授权 URL** 打到
 * stderr，其中含 `state`、`code_challenge`、`code_verifier` 等本次登录流程的
 * 一次性凭据片段。宿主 `subprocess` 以 collect 模式收 stderr，而插件此前把
 * stderr 尾部直接拼进 `LlmError.message`，再经 `normalizeLlmFailure` 进入
 * finish chunk —— 于是授权 URL 会出现在用户界面、agent 日志与任何下游日志里。
 *
 * 策略：只做**结构化、可证明**的替换，不做关键词猜测：
 * 1. URL userinfo（`scheme://user:pass@host`）→ `scheme://***@`；
 * 2. URL query 中命中敏感键名的参数值 → `***`；
 * 3. 形如 `code_challenge=…` / `state=…` 的裸键值对（不在 URL 里的）→ `***`。
 *
 * 刻意不做：不删除整行（会丢掉「凭据缺失或无效，需要浏览器登录」这类真正有用
 * 的诊断信息）；不猜测未列入的键名（如泛化的 `key` 极易误伤正常日志），宁可漏脱敏
 * 也不误伤正常文案。
 */

/** query 中一律打码的键（小写比较）。 */
const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'client_secret',
  'code',
  'code_challenge',
  'code_verifier',
  'id_token',
  'password',
  'refresh_token',
  'secret',
  'state',
  'token',
])

/** URL 里的 userinfo：`scheme://user:pass@host` → `scheme://***@host`。 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi

/** 单个 query 参数：`name=value`，name 需命中敏感键表（值可含 URL 编码字符）。 */
const SENSITIVE_QUERY_PARAM = new RegExp(
  `([?&;](?:${[...SENSITIVE_QUERY_KEYS].join('|')})=)([^&#\\s"']*)`,
  'gi',
)

/** 不在 URL 里的裸键值对，例如日志里的 `code_challenge: XXX` 或 `state=YYY` 片段。 */
const BARE_SENSITIVE_PAIR = new RegExp(
  `\\b(${[...SENSITIVE_QUERY_KEYS].join('|')})(\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&)"']+)`,
  'gi',
)

/** 打码占位符；刻意不可反推原值。 */
const MASK = '***'

/** 对任意文本做脱敏。空值与空串原样返回，便于直接包在模板字符串里。 */
export function redactSensitiveText(text: string | undefined | null): string {
  if (!text) return ''
  return text
    .replace(URL_USERINFO, `$1${MASK}@`)
    .replace(SENSITIVE_QUERY_PARAM, `$1${MASK}`)
    .replace(BARE_SENSITIVE_PAIR, `$1$2${MASK}`)
}

/**
 * 把「等了很久还没拿到登录结果」翻译成人能行动的提示。
 *
 * 官方 stderr 在等待授权时的关键行是 `Launching browser login flow...`；其余部分
 * 对用户无意义且含凭据片段，因此只回传这一行加固定指引。
 */
export function describeAuthWait(text: string | undefined | null): string | undefined {
  const body = text ?? ''
  if (!/launching browser login flow/i.test(body)) return undefined
  return '官方进程已打开 Google 登录页，请在浏览器里完成授权；完成后本轮会自动继续。'
}
