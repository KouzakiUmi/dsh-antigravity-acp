import { readProxyText } from '../proxy/transport.js'
import { redactSensitiveText } from '../runtime/redact.js'
import type { AistudioRateLimitDetails } from './usage.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text.trim().replace(/^\)\]\}'(?:\r?\n)?/u, '')) as unknown } catch { return undefined }
}

export function inspectAistudioEvent(data: string): { input?: number; limited?: AistudioRateLimitDetails } {
  const frame = parseJson(data)
  if (!isRecord(frame)) return {}
  const root = isRecord(frame.response) ? frame.response : frame
  const error = isRecord(frame.error) ? frame.error : root.error
  const usage = root.usageMetadata ?? frame.usageMetadata
  const input = isRecord(usage) ? usage.promptTokenCount : undefined
  return {
    ...(typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? { input } : {}),
    ...(isRecord(error) && (error.code === 429 || error.status === 429 || error.status === 'RESOURCE_EXHAUSTED' || error.code === 'RESOURCE_EXHAUSTED')
      ? { limited: rateLimitDetails(error) } : {}),
  }
}

export async function readAistudioError(response: Response, key: string, observedAt: number, signal?: AbortSignal): Promise<{ detail: string; rateLimit: AistudioRateLimitDetails }> {
  let text = ''
  try { text = await readProxyText(response, { maxBytes: 64 * 1024, idleTimeoutMs: 5_000, totalTimeoutMs: 5_000, ...(signal === undefined ? {} : { signal }) }) } catch { /* HTTP status and headers remain authoritative */ }
  const parsed = parseJson(text)
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined
  const rateLimit = rateLimitDetails(error)
  const headerDelay = retryAfter(response.headers.get('retry-after'), observedAt)
  if (headerDelay !== undefined) rateLimit.retryAfterMs = headerDelay
  return { detail: response.status === 429 ? '' : redactAistudioError(typeof error?.message === 'string' ? error.message : text, key), rateLimit }
}

export function redactAistudioError(text: string, key?: string): string {
  // Replace the complete known value before truncating, including JSON and URL spellings.
  if (key) {
    for (const value of new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])) text = text.replaceAll(value, '***')
  }
  return redactSensitiveText(text)
    .replace(/\bAIza[\w-]{20,}/gu, '***')
    .replace(/([?&]key=)[^&#\s"']+/giu, '$1***')
    .replace(/(x-goog-api-key["']?\s*[:=]\s*)["']?[^,\s"'}]+/giu, '$1***')
    .trim().slice(0, 300)
}

function rateLimitDetails(error: Record<string, unknown> | undefined): AistudioRateLimitDetails {
  const result: AistudioRateLimitDetails = {}
  if (!Array.isArray(error?.details)) return result
  for (const detail of error.details.slice(0, 32)) {
    if (!isRecord(detail)) continue
    if (detail['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure') result.quotaFailure = true
    if (detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo' && typeof detail.retryDelay === 'string' && /^\d{1,12}(?:\.\d{1,9})?s$/.test(detail.retryDelay)) {
      const ms = Math.ceil(Number(detail.retryDelay.slice(0, -1)) * 1000)
      if (Number.isSafeInteger(ms)) result.retryAfterMs = ms
    }
  }
  return result
}

function retryAfter(value: string | null, at: number): number | undefined {
  if (value === null || value.length > 64) return undefined
  if (/^\d{1,12}$/.test(value)) return Number(value) * 1000
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined
  const ms = Date.parse(value) - at
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : undefined
}
