import type { VertexScope } from './endpoints.js'

/** Blank settings inherit host environment; invalid nonblank settings are validated by the caller. */
export function resolveVertexScope(project?: string, location?: string, env: NodeJS.ProcessEnv = process.env): VertexScope {
  return {
    project: project?.trim() || env.GOOGLE_CLOUD_PROJECT?.trim() || env.VERTEXAI_PROJECT?.trim() || '',
    location: location?.trim() || env.GOOGLE_CLOUD_LOCATION?.trim() || env.VERTEXAI_LOCATION?.trim() || 'global',
  }
}
