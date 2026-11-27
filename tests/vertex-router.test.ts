import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { expect, it, vi } from 'vitest'
import * as row from '../src/vertex/index.js'
import type { VertexSettingsBus } from '../src/vertex/settings-bus.js'

class NoProcess extends SubprocessRuntime {
  override resolveExecutable = vi.fn<SubprocessRuntime['resolveExecutable']>()
  override spawn = vi.fn<SubprocessRuntime['spawn']>()
  override spawnTerminal = vi.fn<SubprocessRuntime['spawnTerminal']>()
  override terminalEnvironment = vi.fn<SubprocessRuntime['terminalEnvironment']>()
}

it('delays registration for dependencies, refreshes live models and cleans up when the settings service unloads', async () => {
  expect(row.name).toBe('antigravity-vertex-ai-router')
  const ctx = new Context()
  let enabled = false
  let models = ['gemini-4-hydrogen']
  const listeners = new Set<() => void>()
  const bus: VertexSettingsBus = {
    enabled: () => enabled, project: () => 'fixture-project', location: () => 'global', models: () => models,
    modelSettings: () => ({}), proxySettings: () => ({}),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const changes = vi.fn()
  try {
    await ctx.plugin(LlmRuntime)
    const host = await ctx.plugin(scope => { scope.provide('antigravityVertexSettings', bus) })
    ctx.plugin(row)
    ctx.on('llm/models-updated', changes)
    expect(ctx.llm.listProviders()).toEqual([])
    expect(listeners.size).toBe(0)
    const subprocess = await ctx.plugin(NoProcess)
    await vi.waitFor(() => expect(listeners.size).toBe(1))
    expect(ctx.llm.listProviders()).toEqual([])
    enabled = true; listeners.forEach(notify => notify())
    expect(ctx.llm.listProviders().map(p => p.id)).toEqual(['vertex-ai'])
    models = ['gemini-4-neon']; listeners.forEach(notify => notify())
    expect(changes).toHaveBeenCalledWith('vertex-ai')
    expect((await ctx.llm.listModels('vertex-ai')).map(m => m.id)).toEqual(['vertex-ai-gemini-4-neon'])
    enabled = false; listeners.forEach(notify => notify())
    expect(ctx.llm.listProviders()).toEqual([])
    enabled = true; listeners.forEach(notify => notify())
    expect(ctx.llm.listProviders()).toHaveLength(1)
    expect(ctx.subprocess.spawn).not.toHaveBeenCalled()
    await host.dispose()
    await vi.waitFor(() => expect(listeners.size).toBe(0))
    expect(ctx.llm.listProviders()).toEqual([])
    await subprocess.dispose()
  } finally { await ctx.fiber.dispose() }
})
