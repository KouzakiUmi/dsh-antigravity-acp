/** 官方 CLI 的只读 AI Credits 报告；不实现私有余额 HTTP、不修改付费开关。 */
import { AGY_CLI_TIMEOUT_MS, AgyCliError } from './agy-cli.js'
import type { CliRun } from './agy-cli.js'
import type { CreditsSnapshot } from './quota.js'
import { redactSensitiveText } from './redact.js'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 按实际无头回包读取 command.data；金额缺失、负数和精度溢出都不是零。 */
export function parseAgyCredits(value: unknown): Pick<CreditsSnapshot, 'remainingCredits' | 'planName'> {
  const envelope = record(value)
  const command = record(envelope.command)
  const data = record(command.data)
  if (envelope.status !== 'SUCCESS' || command.name !== 'credits' || envelope.num_turns !== 0) {
    throw new AgyCliError('cli-bad-output', 'agy /credits 未返回成功的本地余额报告')
  }
  const remaining = data.remaining_credits
  if (typeof remaining !== 'number' || !Number.isSafeInteger(remaining) || remaining < 0) {
    throw new AgyCliError('cli-bad-output', 'agy /credits 缺少有效的 remaining_credits 非负整数')
  }
  return {
    remainingCredits: remaining,
    ...(typeof data.plan_name === 'string' && data.plan_name.trim() ? { planName: data.plan_name.trim() } : {}),
  }
}

export async function fetchAgyCredits(run: CliRun, cliPath: string): Promise<CreditsSnapshot> {
  const updatedAt = new Date().toISOString()
  try {
    const result = await run({ argv: [cliPath, '-p', '/credits', '--output-format', 'json'], timeoutMs: AGY_CLI_TIMEOUT_MS })
    if (result.exitCode !== 0) {
      const message = redactSensitiveText(result.stderr.slice(-500))
      if (/no credits? info(?:rmation)? (?:is available|found)/i.test(message)) {
        return { status: 'unavailable', updatedAt, error: { code: 'no-credit-info', message: '官方 CLI 未提供此账户的 AI Credits 信息' } }
      }
      if (/(?:unknown|unsupported|unrecognized|not supported)[^\n]*\/?credits|\/?credits[^\n]*(?:unknown|unsupported|not supported)/i.test(message)) {
        return { status: 'unavailable', updatedAt, error: { code: 'unsupported', message: '当前官方 CLI 不支持无头 /credits 查询' } }
      }
      return { status: 'error', updatedAt, error: { code: 'request-failed', message: `agy /credits 退出码 ${result.exitCode}${message ? `：${message}` : ''}` } }
    }
    let payload: unknown
    try { payload = JSON.parse(result.stdout) }
    catch { throw new AgyCliError('cli-bad-output', 'agy /credits 输出不是合法 JSON') }
    return { status: 'ok', updatedAt, ...parseAgyCredits(payload) }
  } catch (error) {
    return { status: 'error', updatedAt, error: {
      code: error instanceof AgyCliError && error.code === 'cli-bad-output' ? 'bad-response' : 'request-failed',
      message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    } }
  }
}
