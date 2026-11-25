/**
 * 历史裁剪事件的内存日志（issue #16）。
 *
 * ACP 单次 prompt 有字节硬上限，超限时适配器从最旧消息整条裁剪。裁剪只写进
 * prompt 内的提示块时 DSH 侧完全不知情，用户看到上下文条仍显示很低占比。
 * 这里把每次裁剪记成有界的内存事件，经额度 remote 的 read 结果附带给浏览器
 * 药丸展示；不落盘、不进入额度快照存储，宿主重启即清空。
 */

/** 一次历史裁剪事件；只含计数与字节量，不含任何消息正文。 */
export interface HistoryTruncationNotice {
  /** 事件时间（ISO 8601）。 */
  at: string
  omittedCount: number
  omittedBytes: number
  /** 裁剪后实际发送的 prompt 总字节。 */
  totalBytes: number
}

export type HistoryTruncationInfo = Omit<HistoryTruncationNotice, 'at'>

/** 有界事件日志：保留最近 limit 条，最新在前。 */
export class HistoryNoticeLog {
  readonly #limit: number
  readonly #now: () => number
  #entries: HistoryTruncationNotice[] = []

  constructor(options: { limit?: number; now?: () => number } = {}) {
    this.#limit = Math.max(1, options.limit ?? 20)
    this.#now = options.now ?? Date.now
  }

  push(info: HistoryTruncationInfo): void {
    this.#entries.unshift({ at: new Date(this.#now()).toISOString(), ...info })
    if (this.#entries.length > this.#limit) this.#entries.length = this.#limit
  }

  /** 最新在前的只读副本。 */
  list(): readonly HistoryTruncationNotice[] {
    return [...this.#entries]
  }
}
