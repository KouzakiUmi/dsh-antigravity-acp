/**
 * 按会话隔离的编排状态存储（LRU 上限 64）。
 */
import type { OrchestratorState } from './types.js'

const DEFAULT_MAX_SESSIONS = 64

function initialState(): OrchestratorState {
  return { stage: 'idle', plansThisTurn: 0 }
}

export function orchestratorSessionKey(sessionId?: string): string | undefined {
  return sessionId || undefined
}

export class OrchestratorStore {
  private readonly entries = new Map<string, OrchestratorState>()
  private readonly maxEntries: number

  constructor(maxEntries = DEFAULT_MAX_SESSIONS) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries))
  }

  get size(): number {
    return this.entries.size
  }

  get(sessionId?: string): OrchestratorState {
    const key = orchestratorSessionKey(sessionId)
    if (key === undefined) return initialState()
    const existing = this.entries.get(key)
    if (existing === undefined) return initialState()
    // 刷新 LRU 位置
    this.entries.delete(key)
    this.entries.set(key, existing)
    return existing
  }

  update(
    sessionId: string | undefined,
    updater: Partial<OrchestratorState> | ((prev: OrchestratorState) => OrchestratorState),
  ): OrchestratorState {
    const key = orchestratorSessionKey(sessionId)
    const prev = (key === undefined ? undefined : this.entries.get(key)) ?? initialState()
    const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater }
    if (key === undefined) return next
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, next)
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) break
      this.entries.delete(oldestKey)
    }
    return next
  }

  resetTurn(sessionId?: string, turnKey?: string): OrchestratorState {
    return this.update(sessionId, (prev) => ({
      ...prev,
      plansThisTurn: 0,
      ...(turnKey === undefined ? {} : { turnKey }),
    }))
  }

  delete(sessionId?: string): boolean {
    const key = orchestratorSessionKey(sessionId)
    return key !== undefined && this.entries.delete(key)
  }

  dispose(): void {
    this.entries.clear()
  }
}
