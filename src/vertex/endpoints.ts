import { llmError } from '../runtime/llm-error.js'
import { isNonChatModel } from '../adapter/model-catalog-policy.js'

export const VERTEX_PROVIDER_ID = 'vertex-ai'
export const VERTEX_MODEL_PREFIX = `${VERTEX_PROVIDER_ID}-`
export const VERTEX_LABEL = 'Vertex AI'

export interface VertexScope { readonly project: string; readonly location: string }
export interface VertexTarget extends VertexScope { readonly model: string; readonly wireModel: string }

export function isVertexProject(project: string): boolean {
  return /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,30})$/u.test(project)
}

export function isVertexLocation(location: string): boolean {
  return location === 'global' || location === 'us' || location === 'eu' || /^(?=.{1,40}$)[a-z]+(?:-[a-z]+)+[0-9]+$/u.test(location)
}

export function isVertexPublisherModel(model: string): boolean {
  return /^gemini-[a-z0-9](?:[a-z0-9.-]{0,119}[a-z0-9])?$/u.test(model) && !isNonChatModel(model)
}

export function validVertexScope(scope: VertexScope): boolean {
  return isVertexProject(scope.project) && isVertexLocation(scope.location)
}

export function vertexStreamUrl(target: VertexTarget): string {
  const { project, location, wireModel } = target
  if (!validVertexScope(target) || !isVertexPublisherModel(wireModel)) throw llmError('Vertex AI 项目、区域或模型 ID 无效', 'INVALID_ARGS')
  const host = location === 'global' ? 'aiplatform.googleapis.com'
    : location === 'us' || location === 'eu' ? `aiplatform.${location}.rep.googleapis.com`
      : `${location}-aiplatform.googleapis.com`
  return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${wireModel}:streamGenerateContent?alt=sse`
}
