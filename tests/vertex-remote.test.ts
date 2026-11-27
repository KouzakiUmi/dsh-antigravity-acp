import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { llmError } from '../src/runtime/llm-error.js'
import { AgYVertexService, AGY_VERTEX_INVOCATIONS } from '../src/vertex/remote.js'

describe('Vertex Typert catalog', () => {
  const scope = { project: '', location: '' }

  it('reads the currently attached Host catalog and returns only validated IDs', async () => {
    const ctx = new Context()
    let catalog: Context['antigravityVertexCatalog']
    await ctx.plugin(AgYVertexService, { catalog: () => catalog, savedScope: () => scope })
    try {
      const service = ctx.get('agyVertex') as AgYVertexService
      await expect(service.models(scope)).resolves.toMatchObject({ status: 'error' })
      const models = vi.fn(async () => ['gemini-4-neon', 'gemini-4-neon'])
      catalog = { models }
      await expect(service.models(scope)).resolves.toEqual({ status: 'ok', ids: ['gemini-4-neon'] })
      expect(models).toHaveBeenCalledOnce()
      catalog = undefined
      await expect(service.models(scope)).resolves.toMatchObject({ status: 'error' })
    } finally { await ctx.fiber.dispose() }
  })

  it('maps an upstream error without returning its message or normalized request metadata', async () => {
    const ctx = new Context()
    await ctx.plugin(AgYVertexService, { savedScope: () => scope, catalog: () => ({ models: async () => { throw llmError('synthetic sensitive upstream data', 'FORBIDDEN') } }) })
    try {
      const result = await (ctx.get('agyVertex') as AgYVertexService).models(scope)
      expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('serviceusage.services.use') })
      expect(JSON.stringify(result)).not.toContain('synthetic')
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects browser scope drift before sending and after a pending response', async () => {
    const ctx = new Context()
    const stale = { project: 'fixture-old', location: 'global' }
    const current = { project: 'fixture-new', location: 'global' }
    let saved = current
    let release!: (ids: string[]) => void
    const gate = new Promise<string[]>(resolve => { release = resolve })
    const models = vi.fn(() => gate)
    await ctx.plugin(AgYVertexService, { savedScope: () => saved, catalog: () => ({ models }) })
    try {
      const service = ctx.get('agyVertex') as AgYVertexService
      const expected = { status: 'error', message: expect.stringContaining('配置已变更') }
      await expect(service.models(stale)).resolves.toMatchObject(expected)
      expect(models).not.toHaveBeenCalled()
      const pending = service.models(current)
      expect(models).toHaveBeenCalledOnce()
      saved = stale
      release(['gemini-4-neon'])
      await expect(pending).resolves.toMatchObject(expected)
    } finally { release([]); await ctx.fiber.dispose() }
  })

  it('registers a strictly validated remote contract', () => {
    const [invocation] = AGY_VERTEX_INVOCATIONS
    expect(invocation).toMatchObject({ namespace: 'agyVertex', method: 'models', parameters: [{ name: 'scope', source: 'json' }] })
    const result = invocation!.result
    if (result.mode !== 'strict') throw new Error('Expected strict codec')
    const schema = result.create()
    expect(() => schema.parse({ status: 'ok', ids: ['https://example.invalid'] })).toThrow(TypeError)
    expect(() => schema.parse({ status: 'ok', ids: Array(513).fill('gemini-fixture') })).toThrow(TypeError)
  })
})
