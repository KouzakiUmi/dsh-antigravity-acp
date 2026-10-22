/** 设置页控制面：不自动登录，不向客户端返回凭据或授权 URL。 */
import { redactSensitiveText } from '../runtime/redact.js'
import type { AcpLifecycleSnapshot } from '../runtime/lifecycle.js'

export interface AccountSnapshot {
  state: 'idle' | 'connecting' | 'cancelling' | 'connected' | 'cancelled' | 'error'
  message: string
  updatedAt: string
  runtime?: AcpLifecycleSnapshot
}
export interface ModelSnapshot {
  status: 'ok' | 'error'
  models: Array<{ id: string; name: string; inputModalities?: readonly string[] }>
  message?: string
}
export interface ControlOptions {
  connect(signal: AbortSignal): Promise<void>
  warmup?(signal: AbortSignal): Promise<void>
  runtime?(): AcpLifecycleSnapshot
  models(force: boolean): Promise<readonly { id: string; name: string; inputModalities?: readonly string[] }[]>
}

export class SettingsControl {
  private controller?: AbortController
  private pending?: Promise<void>
  private closed = false
  private snapshot: AccountSnapshot = { state: 'idle', message: '尚未验证 ACP 连接', updatedAt: new Date().toISOString() }
  private rows: ModelSnapshot['models'] = []
  constructor(private readonly options: ControlOptions) {}

  account(action: 'status' | 'login' | 'warmup' | 'cancel' = 'status'): AccountSnapshot {
    if (this.closed) throw new Error('设置服务已卸载')
    if (action === 'cancel' && this.controller) {
      this.set('cancelling', '正在取消官方连接…')
      this.controller.abort()
    }
    if ((action === 'login' || action === 'warmup') && !this.pending) {
      const warmup = action === 'warmup'
      const controller = new AbortController()
      this.controller = controller
      this.set('connecting', warmup ? '正在预热 ACP 连接…' : '正在连接官方 ACP；如需授权，请在官方打开的浏览器中完成')
      const pending = Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        if (warmup && !this.options.warmup) throw new Error('当前 Host 不支持预热，请更新插件')
        return (warmup ? this.options.warmup! : this.options.connect)(controller.signal)
      })
        .then(() => {
          if (!this.closed) this.set(controller.signal.aborted ? 'cancelled' : 'connected', controller.signal.aborted ? '连接已取消' : warmup ? 'ACP 连接已预热并保留；模型与账户可用性将在建会话时验证' : 'ACP 会话已验证，模型目录已读取，可开始聊天')
        }, (error: unknown) => {
          if (!this.closed) this.set(controller.signal.aborted ? 'cancelled' : 'error', controller.signal.aborted ? '连接已取消' : redactSensitiveText(error instanceof Error ? error.message : String(error)))
        }).finally(() => {
          if (this.pending === pending) { this.pending = undefined; this.controller = undefined }
        })
      this.pending = pending
    }
    return { ...this.snapshot, ...(this.options.runtime ? { runtime: this.options.runtime() } : {}) }
  }

  async models(force = false): Promise<ModelSnapshot> {
    if (this.closed) throw new Error('设置服务已卸载')
    try {
      this.rows = (await this.options.models(force)).map(({ id, name, inputModalities }) => ({ id, name, ...(inputModalities ? { inputModalities } : {}) }))
      return { status: 'ok', models: this.rows }
    } catch (error) {
      return { status: 'error', models: this.rows, message: redactSensitiveText(error instanceof Error ? error.message : String(error)) }
    }
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.controller?.abort()
    await this.pending
  }

  private set(state: AccountSnapshot['state'], message: string): void {
    this.snapshot = { state, message, updatedAt: new Date().toISOString() }
  }
}
