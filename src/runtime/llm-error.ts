import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmErrorOptions } from '@deepseek-ai/dsh-llm'

type LegacyLlmErrorConstructor = new (message: string, code: string, options?: LlmErrorOptions) => LlmError

/**
 * 以本包自定义码构造 `LlmError`。
 *
 * dsh-llm 0.2.2-rc.3 起 `LlmError` 的 constructor 只接受
 * `BuiltinLlmFailureCode`；本包是转发型适配器，`AGY_*`、`PROTOCOL_DRIFT`、
 * `CANCELLED` 等码是用户与日志依赖的排查词汇，必须按原样抛出而不是改写为
 * 通用内置码。`LlmError.fromFailure` 是官方为「凭外部码重新抛出」预留的
 * 通道。较早的宿主没有该工厂，其构造函数直接接收字符串码。
 *
 * `options` 沿用 `LlmErrorOptions`：`cause` 转交 `fromFailure` 的第二参，
 * `status` / `providerRetryAfterMs` / `requestId` / `offloadImages` 作为
 * failure 的字段随原样保留。
 */
export function llmError(message: string, code: string, options?: LlmErrorOptions): LlmError {
  if (typeof LlmError.fromFailure !== 'function') {
    const LegacyLlmError: LegacyLlmErrorConstructor = LlmError as LegacyLlmErrorConstructor
    return new LegacyLlmError(message, code, options)
  }
  if (options === undefined) return LlmError.fromFailure({ message, code })
  const { cause, ...facts } = options
  return LlmError.fromFailure({ message, code, ...facts }, cause === undefined ? {} : { cause })
}
