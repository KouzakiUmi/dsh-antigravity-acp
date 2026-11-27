import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'

/**
 * 本插件是**转发型适配器**：请求选项由 DSH 构造后原样转给 ACP 会话或代理线，
 * 用途（`purpose`）的取值由需求方决定，不归本包声明。
 *
 * `dsh-llm` 0.2.2 起把 `GenerateOptions.purpose` 收敛为各生产者包声明进
 * `LlmRequestPurposeMap` 的字面量联合——本包不扩展该 map，默认泛型下
 * `purpose` 就是 `never`。同版本的类型注释明确允许转发型适配器放宽为
 * `string`，这里固定这一放宽，使宿主实际传入的 `compaction` /
 * `session-title` 等用途保持可表达、可比较。
 */
export type AdapterRequestOptions = GenerateOptions<string>

/** Pool mode guard applies before dispatch, not to an ACP prompt already in flight. */
export type AcpRequestOptions = AdapterRequestOptions & { admissionSignal?: AbortSignal }

/** 回合归属判定只需要请求的会话身份与用途。 */
export type AdapterRequestOwner = Pick<AdapterRequestOptions, 'sessionId' | 'purpose'>

/**
 * 准备结果的流入口按同一放宽口径声明。
 *
 * `PreparedAdapterCall.stream` 用的是 `GenerateOptions` 的默认泛型；本包只依赖
 * 五个契约包，`LlmRequestPurposeMap` 为空，该默认泛型下 `purpose` 会是 `never`，
 * 与实机上由生产者包声明合并给出的用途联合不符。方法参数双变允许这里放宽，
 * 使准备结果与 {@link AdapterRequestOptions} 口径一致。
 */
export type AdapterPreparedCall = Omit<PreparedAdapterCall, 'stream'> & {
  stream(options: AdapterRequestOptions): AsyncIterable<StreamChunk>
}
