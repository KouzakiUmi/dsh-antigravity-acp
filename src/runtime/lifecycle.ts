/** ACP 运行时的内存状态与耗时；读取不触发连接，不保存聊天或工具参数。 */
import { redactSensitiveText } from './redact.js'

export interface AcpLifecycleSnapshot {
  phase: string
  phaseElapsedMs: number
  processRunning: boolean
  uptimeMs?: number
  starts: number
  reuses: number
  recycles: number
  startup?: { elapsedMs: number; timings: Record<string, number> }
  round?: {
    model: string
    elapsedMs: number
    timings: Record<string, number>
    firstChunkMs?: number
    firstToolMs?: number
    continuations: number
    lastContinuationMs?: number
    finish?: string
  }
  error?: string
  /** Shared provider scheduler state. No session identifiers or content leave the host. */
  queue?: { active: number; waiting: number; capacity: number; workers: number; parked: number }
  modelCatalogRevision?: number
}

export class AcpLifecycle {
  private phase = 'idle'
  private phaseAt: number
  private processAt?: number
  private startupAt?: number
  private startupEnd?: number
  private startupStep?: { name: string; at: number }
  private startupTimings: Record<string, number> = {}
  private roundAt?: number
  private roundEnd?: number
  private roundStep?: { name: string; at: number }
  private promptAt?: number
  private continuationAt?: number
  private snapshot: Omit<AcpLifecycleSnapshot, 'phase' | 'phaseElapsedMs'> = { processRunning: false, starts: 0, reuses: 0, recycles: 0 }

  constructor(private readonly now = () => performance.now()) { this.phaseAt = now() }

  phaseChanged(phase: string): void {
    this.phase = phase
    this.phaseAt = this.now()
  }

  starting(): void {
    this.snapshot.starts++
    delete this.snapshot.error
    this.startupAt = this.now()
    this.startupEnd = undefined
    this.startupTimings = {}
    this.startupStep = undefined
    this.startupPhase('binary')
  }

  startupPhase(name: string): void {
    this.finishStartupStep()
    this.startupStep = { name, at: this.now() }
    this.phaseChanged(name)
  }

  spawned(): void { this.snapshot.processRunning = true; this.processAt = this.now() }

  ready(): void {
    this.finishStartupStep()
    this.startupEnd = this.now()
    this.phaseChanged('ready')
  }

  reused(): void { this.snapshot.reuses++ }

  stopped(phase = 'stopped'): void {
    this.finishStartupStep()
    if (this.startupAt !== undefined && this.startupEnd === undefined) this.startupEnd = this.now()
    this.snapshot.processRunning = false
    this.processAt = undefined
    if (this.roundAt !== undefined && this.roundEnd === undefined) this.roundEnd = this.now()
    this.phaseChanged(phase)
  }

  recycling(): void { this.snapshot.recycles++; this.phaseChanged('recycling') }

  failed(error: unknown): void {
    this.snapshot.error = redactSensitiveText(error instanceof Error ? error.message : String(error))
    this.finishStartupStep()
    if (this.startupAt !== undefined && this.startupEnd === undefined) this.startupEnd = this.now()
    if (this.roundAt !== undefined && this.roundEnd === undefined) this.roundEnd = this.now()
    this.phaseChanged('error')
  }

  beginRound(model: string): void {
    delete this.snapshot.error
    this.roundAt = this.now()
    this.roundEnd = this.promptAt = this.continuationAt = undefined
    this.roundStep = undefined
    this.snapshot.round = { model, elapsedMs: 0, timings: {}, continuations: 0 }
    this.roundPhase('connection')
  }

  roundPhase(name: string): void {
    this.finishRoundStep()
    this.roundStep = { name, at: this.now() }
    this.phaseChanged(name)
  }

  promptSent(): void {
    this.finishRoundStep()
    this.promptAt = this.now()
    this.phaseChanged('prompt')
  }

  firstOutput(tool = false): void {
    const round = this.snapshot.round
    if (!round || this.promptAt === undefined) return
    if (round.firstChunkMs === undefined) round.firstChunkMs = this.now() - this.promptAt
    if (tool && round.firstToolMs === undefined) round.firstToolMs = this.now() - this.promptAt
    if (this.phase === 'prompt' || this.phase === 'continuing') this.phaseChanged('streaming')
  }

  continuing(): void {
    if (this.snapshot.round) this.snapshot.round.continuations++
    this.continuationAt = this.now()
    this.phaseChanged('continuing')
  }

  finish(kind: string): void {
    const round = this.snapshot.round
    if (!round) return
    this.finishRoundStep()
    if (this.continuationAt !== undefined) round.lastContinuationMs = this.now() - this.continuationAt
    if (kind === 'tool-calls') this.phaseChanged('waiting-tools')
    else {
      round.finish = kind
      this.roundEnd = this.now()
      this.phaseChanged(kind === 'error' ? 'error' : this.snapshot.processRunning ? 'ready' : 'stopped')
    }
  }

  read(): AcpLifecycleSnapshot {
    const at = this.now()
    const result: AcpLifecycleSnapshot = { ...this.snapshot, phase: this.phase, phaseElapsedMs: at - this.phaseAt }
    if (this.processAt !== undefined) result.uptimeMs = at - this.processAt
    if (this.startupAt !== undefined) {
      const timings = { ...this.startupTimings }
      if (this.startupStep) timings[this.startupStep.name] = at - this.startupStep.at
      result.startup = { elapsedMs: (this.startupEnd ?? at) - this.startupAt, timings }
    }
    if (this.snapshot.round && this.roundAt !== undefined) {
      const timings = { ...this.snapshot.round.timings }
      if (this.roundStep) timings[this.roundStep.name] = at - this.roundStep.at
      result.round = { ...this.snapshot.round, timings, elapsedMs: (this.roundEnd ?? at) - this.roundAt }
    }
    return result
  }

  private finishStartupStep(): void {
    if (this.startupStep) this.startupTimings[this.startupStep.name] = this.now() - this.startupStep.at
    this.startupStep = undefined
  }

  private finishRoundStep(): void {
    if (this.roundStep && this.snapshot.round) this.snapshot.round.timings[this.roundStep.name] = this.now() - this.roundStep.at
    this.roundStep = undefined
  }
}
