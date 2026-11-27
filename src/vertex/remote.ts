import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { isVertexPublisherModel } from './endpoints.js'

const PACKAGE_NAME = 'dsh-bundle-antigravity-host'
export const AGY_VERTEX_SERVICE = 'agyVertex'

interface VertexCatalog {
  models(): Promise<readonly string[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    antigravityVertexCatalog?: VertexCatalog
  }
}

type Result = { status: 'ok'; ids: string[] } | { status: 'error'; message: string }
interface SavedScope { project: string; location: string }

function parseScope(value: unknown): SavedScope {
  if (!value || typeof value !== 'object' || !('project' in value) || !('location' in value)
    || typeof value.project !== 'string' || typeof value.location !== 'string'
    || value.project.length > 128 || value.location.length > 128) throw new TypeError('Invalid AgYVertexModelsRequest')
  return { project: value.project.trim(), location: value.location.trim() }
}

function parseResult(value: unknown): Result {
  if (value !== null && typeof value === 'object' && 'status' in value) {
    if (value.status === 'ok' && 'ids' in value && Array.isArray(value.ids) && value.ids.length <= 512
      && value.ids.every(id => typeof id === 'string' && isVertexPublisherModel(id))) return { status: 'ok', ids: [...new Set(value.ids as string[])] }
    if (value.status === 'error' && 'message' in value && typeof value.message === 'string' && value.message.length <= 300) {
      return { status: 'error', message: value.message }
    }
  }
  throw new TypeError('Invalid AgYVertexModelsResult')
}

export const AGY_VERTEX_INVOCATIONS: readonly InvocationDescriptor[] = [{
  id: `${PACKAGE_NAME}#${AGY_VERTEX_SERVICE}/models`, service: AGY_VERTEX_SERVICE, namespace: AGY_VERTEX_SERVICE,
  method: 'models', invocation: { kind: 'direct' }, parameters: [{
    name: 'scope', wire: 'scope', source: 'json',
    codec: { mode: 'strict', typeSymbol: `${PACKAGE_NAME}#AgYVertexModelsRequest`, create: () => ({ parse: parseScope }) },
  }],
  result: { mode: 'strict', typeSymbol: `${PACKAGE_NAME}#AgYVertexModelsResult`, create: () => ({ parse: parseResult }) },
}]

export class AgYVertexService extends TypertRemoteService {
  constructor(ctx: Context, private readonly _options: { catalog(): VertexCatalog | undefined; savedScope(): SavedScope }) {
    super(ctx, AGY_VERTEX_SERVICE)
  }

  async models(expected: SavedScope): Promise<Result> {
    const scope = parseScope(expected)
    const matches = () => {
      const current = this._options.savedScope()
      return current.project === scope.project && current.location === scope.location
    }
    const changed = { status: 'error', message: 'Vertex AI 配置已变更，请重新拉取模型。' } as const
    if (!matches()) return changed
    const catalog = this._options.catalog()
    if (!catalog) return { status: 'error', message: 'Vertex AI 目录服务未就绪，请确认 Vertex AI 组件已启用。' }
    try {
      const ids = await catalog.models()
      return matches() ? parseResult({ status: 'ok', ids }) : changed
    } catch (error) {
      if (!matches()) return changed
      const code = error instanceof LlmError ? error.code : undefined
      const messages = new Map<string, string>(Object.entries({
        AUTH: '无法读取 Vertex AI 目录，请检查 Google Cloud CLI 与应用默认凭据（ADC）。',
        FORBIDDEN: '当前凭据无权读取 Vertex AI 目录，请检查 Vertex AI API 和项目权限（含 serviceusage.services.use）。',
        INVALID_ARGS: '请保存有效的 Vertex AI 项目与区域，或设置宿主环境变量。',
        CANCELLED: 'Vertex AI 配置已变更，请重新拉取模型。',
        NO_ADAPTER: 'Vertex AI 已停用，请先启用并保存。',
        TIMEOUT: '拉取 Vertex AI 模型超时，请重试。',
        REQUEST_LIMIT: 'Vertex AI 目录超出读取限制，请稍后重试或手动添加模型。',
        RATE_LIMIT: 'Vertex AI 目录请求过于频繁，请稍后重试。',
        AGY_INVALID_PROXY: 'Vertex AI 的代理配置无效，请检查代理地址。',
      }))
      return { status: 'error', message: (code === undefined ? undefined : messages.get(code)) ?? '无法拉取 Vertex AI 模型，请检查连接或手动添加模型。' }
    }
  }
}
