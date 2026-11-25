import { describe, expect, it } from 'vitest'
import { HistoryNoticeLog } from '../src/runtime/history-notices.js'

describe('历史裁剪事件日志（issue #16）', () => {
  it('最新在前、有界丢弃最旧，list 返回副本不被外部修改', () => {
    const log = new HistoryNoticeLog({ limit: 2, now: () => Date.parse('2026-11-26T00:00:00Z') })
    log.push({ omittedCount: 1, omittedBytes: 1000, totalBytes: 170_000 })
    log.push({ omittedCount: 2, omittedBytes: 2000, totalBytes: 171_000 })
    log.push({ omittedCount: 3, omittedBytes: 3000, totalBytes: 172_000 })
    const list = log.list()
    expect(list.map(entry => entry.omittedCount)).toEqual([3, 2])
    expect(list[0]!.at).toBe('2026-11-26T00:00:00.000Z')
    ;(list as unknown as unknown[]).length = 0
    expect(log.list()).toHaveLength(2)
  })

  it('空日志返回空数组，limit 至少为 1', () => {
    const log = new HistoryNoticeLog({ limit: 0 })
    expect(log.list()).toEqual([])
    log.push({ omittedCount: 1, omittedBytes: 1, totalBytes: 1 })
    log.push({ omittedCount: 2, omittedBytes: 2, totalBytes: 2 })
    expect(log.list().map(entry => entry.omittedCount)).toEqual([2])
  })
})
