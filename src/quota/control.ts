/** 设置页控制面：不自动登录，不向客户端返回凭据或授权 URL。 */
import { redactSensitiveText } from '../runtime/redact.js'

export interface AccountSnapshot {
  state: 'idle' | 'connecting' | 'cancelling' | 'connected' | 'cancelled' | 'error'
  message: string
  updatedAt: string
}
export interface ModelSnapshot {
  status: 'ok' | 'error'
  models: Array<{ id: string; name: string }>
  message?: string
}
export interface ControlOptions {
  connect(signal: AbortSignal): Promise<void>
  models(force: boolean): Promise<readonly { id: string; name: string }[]>
}

export class SettingsControl {
  private controller?: AbortController
  private pending?: Promise<void>
  private closed = false
  private snapshot: AccountSnapshot = { state: 'idle', message: '尚未验证 ACP 连接', updatedAt: new Date().toISOString() }
  private rows: ModelSnapshot['models'] = []
  constructor(private readonly options: ControlOptions) {}

  account(action: 'status' | 'login' | 'cancel' = 'status'): AccountSnapshot {
    if (this.closed) throw new Error('设置服务已卸载')
    if (action === 'cancel' && this.controller) {
      this.set('cancelling', '正在取消官方连接…')
      this.controller.abort()
    }
    if (action === 'login' && !this.pending) {
      const controller = new AbortController()
      this.controller = controller
      this.set('connecting', '正在连接官方 ACP；如需授权，请在官方打开的浏览器中完成')
      const pending = Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return this.options.connect(controller.signal)
      })
        .then(() => {
          if (!this.closed) this.set(controller.signal.aborted ? 'cancelled' : 'connected', controller.signal.aborted ? '连接已取消' : 'ACP 连接验证成功')
        }, (error: unknown) => {
          if (!this.closed) this.set(controller.signal.aborted ? 'cancelled' : 'error', controller.signal.aborted ? '连接已取消' : redactSensitiveText(error instanceof Error ? error.message : String(error)))
        }).finally(() => {
          if (this.pending === pending) { this.pending = undefined; this.controller = undefined }
        })
      this.pending = pending
    }
    return { ...this.snapshot }
  }

  async models(force = false): Promise<ModelSnapshot> {
    if (this.closed) throw new Error('设置服务已卸载')
    try {
      this.rows = (await this.options.models(force)).map(({ id, name }) => ({ id, name }))
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
