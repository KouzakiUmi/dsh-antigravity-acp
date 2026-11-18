import { LlmError } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { llmError } from '../src/runtime/llm-error.js'

describe('DSH LlmError compatibility', () => {
  function expectCustomFailure(): void {
    const cause = new Error('fixture cause')
    const error = llmError('fixture message', 'AGY_LINK_CLOSED', { status: 503, providerRetryAfterMs: 50, cause })
    expect(error).toBeInstanceOf(LlmError)
    expect(error.code).toBe('AGY_LINK_CLOSED')
    expect(error.failure).toEqual({ message: 'fixture message', code: 'AGY_LINK_CLOSED', status: 503, providerRetryAfterMs: 50 })
    expect(error.cause).toBe(cause)
  }

  it('keeps custom codes and provider facts on the factory contract', expectCustomFailure)

  it('keeps the original error on pre-factory hosts', () => {
    const factory = Object.getOwnPropertyDescriptor(LlmError, 'fromFailure')!
    Object.defineProperty(LlmError, 'fromFailure', { ...factory, value: undefined })
    try { expectCustomFailure() }
    finally { Object.defineProperty(LlmError, 'fromFailure', factory) }
  })
})
