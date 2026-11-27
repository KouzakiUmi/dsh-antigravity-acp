import { describe, expect, it, vi } from 'vitest'
import { VertexAdapter } from '../src/vertex/adapter.js'
import { validVertexScope } from '../src/vertex/endpoints.js'
import { resolveVertexScope } from '../src/vertex/environment.js'
import type { VertexSettingsBus } from '../src/vertex/settings-bus.js'

function setup() {
  const state = { enabled: true, project: 'fixture-project', location: 'eu' }
  const settings: VertexSettingsBus = {
    enabled: () => state.enabled, project: () => state.project, location: () => state.location, models: () => ['gemini-4-neon'],
    modelSettings: () => ({}), proxySettings: () => ({}), subscribe: () => () => {},
  }
  const fetch = vi.fn<typeof globalThis.fetch>()
  const token = vi.fn(async (_signal: AbortSignal) => 'fixture-adc-token')
  return { state, fetch, token, adapter: new VertexAdapter({ settings, fetch, token }) }
}

const model = (id: string) => ({ name: `publishers/google/models/${id}` })

describe('Model Garden publisher discovery', () => {
  it('uses the global Model Garden GET and saved quota project, returning deduplicated text Gemini candidates', async () => {
    const { adapter, fetch, token } = setup()
    fetch.mockResolvedValueOnce(Response.json({ publisherModels: [
      { ...model('gemini-4-hydrogen@001'), supportedActions: { openGenerationAiStudio: { references: {} } } },
      model('gemini-4-image'), model('gemini-4-live'), model('gemini-embedding-001'), model('gemma-fixture'),
      { name: 'publishers/other/models/gemini-fixture' }, model('gemini-path/next'),
      { ...model('gemini-fixture-b'), outputModalities: ['IMAGE'] },
      { ...model('gemini-fixture-c'), supportedGenerationMethods: ['embedContent'] },
    ], nextPageToken: 'page+two/?=' }))
    fetch.mockResolvedValueOnce(Response.json({ publisherModels: [model('gemini-4-hydrogen'), model('gemini-3.5-flash-lite-001')] }))
    await expect(adapter.discoverModels()).resolves.toEqual(['gemini-3.5-flash-lite-001', 'gemini-4-hydrogen'])
    expect(token).toHaveBeenCalledOnce()
    const [first, second] = fetch.mock.calls
    expect(first?.[0]).toBe('https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=100')
    expect(first?.[1]).toMatchObject({ method: 'GET', redirect: 'error', headers: { authorization: 'Bearer fixture-adc-token', 'x-goog-user-project': 'fixture-project' } })
    expect(first?.[1]).not.toHaveProperty('body')
    expect(new URL(String(second?.[0])).searchParams.get('pageToken')).toBe('page+two/?=')
    expect((await adapter.listModels('vertex-ai')).map(row => row.id)).toEqual(['vertex-ai-gemini-4-neon'])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([[401, 'AUTH'], [403, 'FORBIDDEN'], [429, 'RATE_LIMIT'], [503, 'UPSTREAM']])('classifies HTTP %d without leaking its body', async (status, code) => {
    const { adapter, fetch } = setup()
    fetch.mockResolvedValueOnce(new Response('sensitive-fixture-body', { status }))
    const request = adapter.discoverModels()
    await expect(request).rejects.toMatchObject({ code, failure: { status } })
    await expect(request).rejects.toThrow(/^(?!.*sensitive-fixture-body).*Vertex AI/u)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not publish partial results from over-limit or repeated cursor responses', async () => {
    const { adapter, fetch } = setup()
    fetch.mockResolvedValueOnce(Response.json({ publisherModels: Array.from({ length: 513 }, (_, i) => model(`gemini-fixture-${i}`)) }))
    await expect(adapter.discoverModels()).rejects.toMatchObject({ code: 'REQUEST_LIMIT' })
    fetch.mockImplementation(async () => Response.json({ nextPageToken: 'same-cursor' }))
    await expect(adapter.discoverModels()).rejects.toMatchObject({ code: 'PROTOCOL_DRIFT' })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('cancels old pagination when settings change and then change back', async () => {
    const { adapter, fetch, state } = setup()
    let complete!: (response: Response) => void
    fetch.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const pending = expect(adapter.discoverModels()).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    state.enabled = false; adapter.syncScope()
    state.enabled = true; adapter.syncScope()
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    complete(Response.json({ publisherModels: [model('gemini-4-hydrogen')], nextPageToken: 'next' }))
    await pending
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('refuses invalid scope and disabled routes before reading ADC', async () => {
    const { adapter, token, fetch, state } = setup()
    state.project = 'invalid/project'
    await expect(adapter.discoverModels()).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    state.enabled = false
    await expect(adapter.discoverModels()).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect(token).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})

it('resolves each Vertex field independently, retaining explicit invalid values for validation', () => {
  const env = { GOOGLE_CLOUD_PROJECT: ' google-project ', GOOGLE_CLOUD_LOCATION: 'us-central1', VERTEXAI_PROJECT: 'legacy-project', VERTEXAI_LOCATION: 'eu' }
  expect(resolveVertexScope('explicit-project', ' ', env)).toEqual({ project: 'explicit-project', location: 'us-central1' })
  expect(resolveVertexScope('', '', env)).toEqual({ project: 'google-project', location: 'us-central1' })
  expect(resolveVertexScope('', '', { ...env, GOOGLE_CLOUD_PROJECT: '', GOOGLE_CLOUD_LOCATION: ' ' })).toEqual({ project: 'legacy-project', location: 'eu' })
  expect(resolveVertexScope(undefined, undefined, {})).toEqual({ project: '', location: 'global' })
  expect(validVertexScope(resolveVertexScope('invalid/project', 'global', env))).toBe(false)
  expect(validVertexScope(resolveVertexScope('', 'invalid/location', env))).toBe(false)
})
