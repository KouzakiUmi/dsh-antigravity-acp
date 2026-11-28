/**
 * AI Studio 设置控制 remote：目录读取 / 手动 key 写入（只写不回显）/ 掩码状态。
 *
 * 经真实 Cordis Context 调用（Service 方法经 Proxy，this 是代理而非真实实例，
 * 与 AgYQuotaService 同口径）。key 安全：setKey 结果不回显值，keyStatus 只返回
 * describe 的掩码视图，错误消息经 redactSensitiveText 脱敏。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { AgYAistudioService, AGY_AISTUDIO_SERVICE, AGY_AISTUDIO_INVOCATIONS } from '../src/aistudio/remote.js'
import type { AistudioAdapter } from '../src/aistudio/adapter.js'
import type { AistudioUsageResult } from '../src/aistudio/usage.js'

const CATALOG = [
  { id: 'aistudio-gemini-3.8-flash', name: 'Gemini 3.8 Flash', inputModalities: ['text'], contextWindow: 1048576, maxOutputTokens: 65536, contextWindowSource: 'upstream' },
  { id: 'aistudio-gemini-3-pro', name: 'Gemini 3 Pro', inputModalities: ['text'] },
]

interface HostOptions {
  discoverModels?: (force?: boolean) => Promise<unknown[]>
  credentials?: () => CredentialProvider | undefined
  credentialRef?: () => string
  readUsage?: () => Promise<AistudioUsageResult>
}

async function openHost(options: HostOptions = {}) {
  const host = new Context()
  const fiber = await host.plugin(AgYAistudioService, {
    adapter: { discoverModels: options.discoverModels ?? (async () => CATALOG), readUsage: options.readUsage } as unknown as Pick<AistudioAdapter, 'discoverModels'>,
    credentials: options.credentials ?? (() => undefined),
    credentialRef: options.credentialRef ?? (() => 'AISTUDIO_API_KEY'),
  })
  return {
    service: host.get(AGY_AISTUDIO_SERVICE) as AgYAistudioService,
    close: async () => { await fiber.dispose(); await host.fiber.dispose() },
  }
}

describe('AgYAistudioService 经 Cordis Proxy 调用', () => {
  it('models 投影目录行并透传 force；只保留设置页所需字段', async () => {
    const discoverModels = vi.fn(async () => CATALOG)
    const { service, close } = await openHost({ discoverModels })
    try {
      const result = await service.models({ force: true })
      expect(result.status).toBe('ok')
      expect(result.models.map(model => model.id)).toEqual(['aistudio-gemini-3.8-flash', 'aistudio-gemini-3-pro'])
      expect(discoverModels).toHaveBeenCalledWith(true)
      expect(result.models[0]).toMatchObject({ name: 'Gemini 3.8 Flash', contextWindow: 1048576, maxOutputTokens: 65536, inputModalities: ['text'], contextWindowSource: 'upstream' })
      // 无容量的条目不臆造字段。
      expect(result.models[1]).toEqual({ id: 'aistudio-gemini-3-pro', name: 'Gemini 3 Pro', inputModalities: ['text'] })
    } finally { await close() }
  })

  it('models 失败折叠成 error + 脱敏消息，不抛、不泄露结构化密钥', async () => {
    const { service, close } = await openHost({ discoverModels: async () => { throw new Error('Request had invalid API key: api_key=AIzaSySECRET123456') } })
    try {
      const result = await service.models()
      expect(result.status).toBe('error')
      expect(result.models).toEqual([])
      expect(result.message).toContain('api_key=***')
      expect(result.message).not.toContain('AIzaSySECRET123456')
    } finally { await close() }
  })

  it('setKey 经 credentials.set 写入引用名（trim 后），结果只写不回显', async () => {
    const set = vi.fn(async () => {})
    const credentials = { set } as unknown as CredentialProvider
    const { service, close } = await openHost({ credentials: () => credentials })
    try {
      const result = await service.setKey({ value: '  AIzaSyTESTKEY987  ' })
      expect(result).toEqual({ status: 'ok' })
      expect(set).toHaveBeenCalledOnce()
      expect(set).toHaveBeenCalledWith(credentialRef('AISTUDIO_API_KEY'), 'AIzaSyTESTKEY987')
      expect(JSON.stringify(result)).not.toContain('AIzaSyTESTKEY987')
    } finally { await close() }
  })

  it('setKey 写入失败报 error 并脱敏，不抛', async () => {
    const set = vi.fn(async () => { throw new Error('disk write failed: api_key=AIzaSySECRET123456') })
    const warn = vi.fn()
    const credentials = { set } as unknown as CredentialProvider
    const host = new Context()
    const fiber = await host.plugin(AgYAistudioService, {
      adapter: { discoverModels: async () => CATALOG } as unknown as Pick<AistudioAdapter, 'discoverModels'>,
      credentials: () => credentials, credentialRef: () => 'AISTUDIO_API_KEY', log: { warn },
    })
    try {
      const service = host.get(AGY_AISTUDIO_SERVICE) as AgYAistudioService
      const result = await service.setKey({ value: 'AIzaSyTESTKEY987' })
      expect(result.status).toBe('error')
      expect(result.message).toContain('api_key=***')
      expect(result.message).not.toContain('AIzaSySECRET123456')
      expect(warn).toHaveBeenCalledOnce()
    } finally { await fiber.dispose(); await host.fiber.dispose() }
  })

  it('setKey 凭据服务缺席 / 引用名无效 / 空值都报可读 error', async () => {
    const absent = await openHost({ credentials: () => undefined })
    expect((await absent.service.setKey({ value: 'x' })).status).toBe('error')
    await absent.close()

    const invalidRef = await openHost({ credentials: () => ({ set: vi.fn() }) as unknown as CredentialProvider, credentialRef: () => 'bad-name!' })
    expect((await invalidRef.service.setKey({ value: 'x' })).status).toBe('error')
    await invalidRef.close()

    const empty = await openHost({ credentials: () => ({ set: vi.fn() }) as unknown as CredentialProvider })
    expect((await empty.service.setKey({ value: '   ' })).status).toBe('error')
    await empty.close()
  })

  it('keyStatus 返回 describe 掩码视图，绝不返回全值', async () => {
    const describeRef = vi.fn(async () => ({ configured: true, writable: true, source: 'file', masked: 'AIza…xxxx' }))
    const credentials = { describe: describeRef } as unknown as CredentialProvider
    const { service, close } = await openHost({ credentials: () => credentials })
    try {
      const result = await service.keyStatus()
      expect(result).toEqual({ status: 'ok', configured: true, writable: true, source: 'file', masked: 'AIza…xxxx' })
      expect(describeRef).toHaveBeenCalledWith(credentialRef('AISTUDIO_API_KEY'))
    } finally { await close() }
  })

  it('keyStatus 未配置时 configured:false；凭据缺席报 error', async () => {
    const emptyCredentials = { describe: async () => ({ configured: false, writable: true }) } as unknown as CredentialProvider
    const unconfigured = await openHost({ credentials: () => emptyCredentials })
    expect(await unconfigured.service.keyStatus()).toEqual({ status: 'ok', configured: false, writable: true })
    await unconfigured.close()

    const absent = await openHost({ credentials: () => undefined })
    const result = await absent.service.keyStatus()
    expect(result.status).toBe('error')
    expect(result.configured).toBe(false)
    expect(result.writable).toBe(false)
    await absent.close()
  })

  it('usage 读取注入 adapter 的本地状态，无需生成或写凭据', async () => {
    const readUsage = vi.fn(async () => ({ status: 'unconfigured' as const }))
    const { service, close } = await openHost({ readUsage })
    try {
      expect(await service.usage()).toEqual({ status: 'unconfigured' })
      expect(readUsage).toHaveBeenCalledOnce()
    } finally { await close() }
  })

  it('invocations 描述符 service/namespace/method/id 与客户端声明对齐', () => {
    expect(AGY_AISTUDIO_INVOCATIONS.map(item => item.method)).toEqual(['models', 'setKey', 'keyStatus', 'usage'])
    for (const invocation of AGY_AISTUDIO_INVOCATIONS) {
      expect(invocation.service).toBe('agyAistudio')
      expect(invocation.namespace).toBe('agyAistudio')
      expect(invocation.id).toBe(`dsh-bundle-antigravity-host#agyAistudio/${invocation.method}`)
      expect(invocation.invocation).toEqual({ kind: 'direct' })
    }
    // setKey 的请求参数必填（无 acceptsUndefined），models/keyStatus 可缺省。
    const setKey = AGY_AISTUDIO_INVOCATIONS.find(item => item.method === 'setKey')!
    expect(setKey.parameters[0]?.acceptsUndefined).toBeUndefined()
    const models = AGY_AISTUDIO_INVOCATIONS.find(item => item.method === 'models')!
    expect(models.parameters[0]?.acceptsUndefined).toBe(true)
  })
})
