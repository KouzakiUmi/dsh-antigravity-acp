import { createHmac, randomBytes } from 'node:crypto'

const MINUTE_MS = 60_000
const CREDENTIAL_TTL_MS = 48 * 60 * MINUTE_MS
export const AISTUDIO_MINUTE_CAP = 4096
export const AISTUDIO_MODEL_CAP = 64
const pacificDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })

export interface AistudioUsageCounts {
  requests: number
  inputTokens: number | null
  reportedRequests: number
}
export interface AistudioRateLimitDetails {
  retryAfterMs?: number
  quotaFailure?: true
}
export interface AistudioRateLimit extends AistudioRateLimitDetails {
  at: string
  source: 'http' | 'sse'
  model: string | null
}
export interface AistudioUsageRow {
  model: string | null
  minute: AistudioUsageCounts
  today: AistudioUsageCounts
}
export interface AistudioUsageSnapshot {
  status: 'ok'
  pacificDay: string
  minute: AistudioUsageCounts
  today: AistudioUsageCounts
  /** Omitted early-minute records after high traffic; daily totals remain intact. */
  minuteTruncated: boolean
  models: AistudioUsageRow[]
  last429?: AistudioRateLimit
}
export type AistudioUsageResult = AistudioUsageSnapshot | { status: 'unconfigured' | 'error' }

interface Attempt {
  sequence: number
  epoch: number
  at: number
  model: string | null
  day: string
  input?: number
}

const counts = (): AistudioUsageCounts => ({ requests: 0, inputTokens: null, reportedRequests: 0 })
const safeAdd = (a: number, b: number): number => Math.min(Number.MAX_SAFE_INTEGER, a + b)
function add(target: AistudioUsageCounts, input?: number): void {
  target.requests = safeAdd(target.requests, 1)
  if (input === undefined) return
  target.reportedRequests = safeAdd(target.reportedRequests, 1)
  target.inputTokens = safeAdd(target.inputTokens ?? 0, input)
}
function update(target: AistudioUsageCounts, previous: number | undefined, input: number): void {
  if (previous === undefined) target.reportedRequests = safeAdd(target.reportedRequests, 1)
  target.inputTokens = safeAdd(Math.max(0, (target.inputTokens ?? 0) - (previous ?? 0)), input)
}

/** The active credential owns all aggregate state. Old attempts hold only scalar handles. */
export class AistudioUsageStore {
  private readonly secret = randomBytes(32)
  private digest: string | undefined
  private epoch = 0
  private sequence = 0
  private lastActivity = 0
  private latest429: AistudioRateLimit | undefined
  private day = ''
  private total = counts()
  private readonly byModel = new Map<string | null, AistudioUsageCounts>()
  private readonly minute = new Map<number, Attempt>()
  private minuteDroppedAt = -Infinity

  constructor(private readonly now: () => number = Date.now) {}

  fingerprint(key: string): string {
    return createHmac('sha256', this.secret).update(key).digest('hex')
  }

  activate(digest: string | undefined): void {
    const now = this.now()
    if (this.digest === digest && (digest === undefined || now - this.lastActivity < CREDENTIAL_TTL_MS)) return
    this.epoch += 1
    this.digest = digest
    this.lastActivity = now
    this.latest429 = undefined
    this.total = counts()
    this.byModel.clear()
    this.minute.clear()
    this.minuteDroppedAt = -Infinity
  }

  /** Insert only at the actual HTTP client dispatch boundary. */
  start(digest: string, wireModel: string | null): Attempt | undefined {
    if (digest !== this.digest) return undefined
    const at = this.now()
    this.roll(at)
    this.lastActivity = at
    let model = wireModel !== null && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(wireModel) ? wireModel : null
    if (model !== null && !this.byModel.has(model) && this.byModel.size - Number(this.byModel.has(null)) >= AISTUDIO_MODEL_CAP) model = null
    const attempt: Attempt = { sequence: ++this.sequence, epoch: this.epoch, at, model, day: this.day }
    add(this.total)
    add(this.modelCounts(model))
    this.minute.set(attempt.sequence, attempt)
    if (this.minute.size > AISTUDIO_MINUTE_CAP) {
      const oldest = this.minute.values().next().value!
      this.minute.delete(oldest.sequence)
      this.minuteDroppedAt = Math.max(this.minuteDroppedAt, oldest.at)
    }
    return attempt
  }

  reportInput(attempt: Attempt, input: number): void {
    const now = this.now()
    if (!this.isCurrent(attempt, now) || !Number.isSafeInteger(input) || input < 0) return
    this.rollDay(now)
    if (attempt.day === this.day) {
      update(this.total, attempt.input, input)
      update(this.modelCounts(attempt.model), attempt.input, input)
    }
    attempt.input = input
  }

  record429(attempt: Attempt, source: AistudioRateLimit['source'], details: AistudioRateLimitDetails, observedAt = this.now()): void {
    if (!this.isCurrent(attempt, this.now())) return
    const at = new Date(observedAt).toISOString()
    if (this.latest429 !== undefined && this.latest429.at > at) return
    this.latest429 = { at, source, model: attempt.model, ...details }
    this.lastActivity = this.now()
  }

  private isCurrent(attempt: Attempt, now: number): boolean {
    return attempt.epoch === this.epoch && now - this.lastActivity < CREDENTIAL_TTL_MS
  }

  snapshot(): AistudioUsageSnapshot {
    const now = this.now()
    this.roll(now)
    const minute = counts()
    const recent = new Map<string | null, AistudioUsageCounts>()
    for (const event of this.minute.values()) {
      add(minute, event.input)
      let row = recent.get(event.model)
      if (row === undefined) { row = counts(); recent.set(event.model, row) }
      add(row, event.input)
    }
    const models = [...new Set([...this.byModel.keys(), ...recent.keys()])].map(model => ({
      model, minute: recent.get(model) ?? counts(), today: { ...(this.byModel.get(model) ?? counts()) },
    })).sort((a, b) => b.today.requests - a.today.requests || b.minute.requests - a.minute.requests || (a.model ?? '').localeCompare(b.model ?? ''))
    return { status: 'ok', pacificDay: this.day, minute, today: { ...this.total }, models,
      minuteTruncated: this.minuteDroppedAt > now - MINUTE_MS,
      ...(this.latest429 === undefined ? {} : { last429: { ...this.latest429 } }),
    }
  }

  private roll(now: number): void {
    this.rollDay(now)
    for (const [id, event] of this.minute) {
      if (event.at > now - MINUTE_MS) break
      this.minute.delete(id)
    }
  }

  private rollDay(now: number): void {
    const day = pacificDate.format(now)
    if (day !== this.day) {
      this.day = day
      this.total = counts()
      this.byModel.clear()
    }
  }

  private modelCounts(model: string | null): AistudioUsageCounts {
    let value = this.byModel.get(model)
    if (value === undefined) { value = counts(); this.byModel.set(model, value) }
    return value
  }
}
