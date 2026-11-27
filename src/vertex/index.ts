import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'
import { createLiveProxiedFetch } from '../runtime/proxied-fetch.js'
import { resolveHttpsProxy } from '../runtime/proxy-env.js'
import { readVertexAccessToken } from './adc.js'
import { VertexAdapter } from './adapter.js'
import { VERTEX_PROVIDER_ID } from './endpoints.js'

export const name = 'antigravity-vertex-ai-router'
export const inject = ['llm', 'subprocess']

export function apply(ctx: Context): void {
  ctx.inject(['antigravityVertexSettings'], mount)
}

function mount(ctx: Context): void {
  const settings = ctx.antigravityVertexSettings
  const subprocess = ctx.subprocess
  const readProxy = () => {
    const { proxyUrl, proxyBypass } = settings.proxySettings()
    return resolveHttpsProxy({ url: proxyUrl, bypass: proxyBypass })
  }
  const fetch = createLiveProxiedFetch(readProxy)
  const adapter = new VertexAdapter({ settings, fetch, token: signal => readVertexAccessToken(subprocess, signal, readProxy()) })
  ctx.provide('antigravityVertexCatalog', { models: () => adapter.discoverModels() })
  let unregister: (() => void) | undefined
  const refresh = () => {
    adapter.syncScope()
    if (settings.enabled() && unregister === undefined) unregister = ctx.llm.registerAdapter([VERTEX_PROVIDER_ID], adapter)
    else if (!settings.enabled() && unregister !== undefined) { const remove = unregister; unregister = undefined; remove() }
    else if (unregister !== undefined) notify(ctx)
  }

  ctx.effect(function* () {
    const unsubscribe = settings.subscribe(() => {
      try { refresh() } catch { ctx.logger?.warn?.('antigravity-vertex-ai: 路由刷新失败') }
    })
    yield () => {
      adapter.dispose()
      unsubscribe()
      try { unregister?.() } finally {
        unregister = undefined
        void fetch.close().catch(() => ctx.logger?.warn?.('antigravity-vertex-ai: 代理连接回收失败'))
      }
    }
    refresh()
  }, 'Vertex AI 路由生命周期')
}

function notify(ctx: Context): void {
  try { ctx.emit('llm/models-updated', VERTEX_PROVIDER_ID) } catch { /* A listener cannot veto catalog changes. */ }
}
