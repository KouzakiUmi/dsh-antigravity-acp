import { describe, expect, it } from 'vitest'
import {
  buildProxyEnv,
  normalizeProxyUrl,
  ProxyConfigError,
  resolveProxy,
  resolveProxyBypass,
} from '../src/runtime/proxy-env.js'

describe('normalizeProxyUrl', () => {
  it('空值视为不用代理', () => {
    expect(normalizeProxyUrl(undefined)).toBeUndefined()
    expect(normalizeProxyUrl('')).toBeUndefined()
    expect(normalizeProxyUrl('   ')).toBeUndefined()
  })

  it('缺 scheme 时按 http 处理', () => {
    expect(normalizeProxyUrl('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(normalizeProxyUrl(' localhost:1080 ')).toBe('http://localhost:1080')
  })

  it('保留显式 scheme 并统一小写，丢掉路径/查询等无关部分（默认端口按 URL 规范折叠）', () => {
    expect(normalizeProxyUrl('HTTP://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(normalizeProxyUrl('socks5://127.0.0.1:7891')).toBe('socks5://127.0.0.1:7891')
    expect(normalizeProxyUrl('https://proxy.internal:443/ignored?x=1')).toBe('https://proxy.internal')
    expect(normalizeProxyUrl('https://proxy.internal:8443/ignored')).toBe('https://proxy.internal:8443')
  })

  it('保留代理认证信息中的用户名密码', () => {
    expect(normalizeProxyUrl('http://user:pass@127.0.0.1:7890')).toBe('http://user:pass@127.0.0.1:7890')
    expect(normalizeProxyUrl('http://user@127.0.0.1:7890')).toBe('http://user@127.0.0.1:7890')
  })

  it('错误信息不回显代理密码', () => {
    try {
      normalizeProxyUrl('http://user:secret@')
      expect.unreachable('应当抛出 ProxyConfigError')
    } catch (error) {
      expect(error).toBeInstanceOf(ProxyConfigError)
      expect((error as Error).message).not.toContain('secret')
      expect((error as Error).message).toContain('***')
    }
  })

  it('不支持的协议与坏地址抛 ProxyConfigError', () => {
    expect(() => normalizeProxyUrl('ftp://127.0.0.1:21')).toThrow(ProxyConfigError)
    expect(() => normalizeProxyUrl('http://')).toThrow(ProxyConfigError)
    expect(() => normalizeProxyUrl('::::')).toThrow(ProxyConfigError)
  })
})

describe('resolveProxyBypass', () => {
  it('始终并入本机地址，且按顺序去重', () => {
    expect(resolveProxyBypass(undefined)).toBe('localhost,127.0.0.1,::1')
    expect(resolveProxyBypass('')).toBe('localhost,127.0.0.1,::1')
  })

  it('用户条目在前，本机条目即使已出现也不重复', () => {
    expect(resolveProxyBypass('10.0.0.0/8, 127.0.0.1 ,*.internal')).toBe('10.0.0.0/8,127.0.0.1,*.internal,localhost,::1')
  })
})

describe('resolveProxy', () => {
  it('无 url 时不产出配置', () => {
    expect(resolveProxy(undefined)).toBeUndefined()
    expect(resolveProxy({})).toBeUndefined()
    expect(resolveProxy({ bypass: '10.0.0.0/8' })).toBeUndefined()
  })

  it('规范化 url 并合并 bypass', () => {
    expect(resolveProxy({ url: '127.0.0.1:7890', bypass: '10.0.0.0/8' })).toEqual({
      url: 'http://127.0.0.1:7890',
      bypass: '10.0.0.0/8,localhost,127.0.0.1,::1',
    })
  })
})

describe('buildProxyEnv', () => {
  it('无代理时不注入任何变量', () => {
    expect(buildProxyEnv(undefined)).toBeUndefined()
    expect(buildProxyEnv({ url: '  ' })).toBeUndefined()
  })

  it('大小写两套 *_PROXY 全部写入同一个地址', () => {
    const env = buildProxyEnv({ url: 'socks5://127.0.0.1:7891' })
    expect(env).toEqual({
      HTTP_PROXY: 'socks5://127.0.0.1:7891',
      HTTPS_PROXY: 'socks5://127.0.0.1:7891',
      ALL_PROXY: 'socks5://127.0.0.1:7891',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      http_proxy: 'socks5://127.0.0.1:7891',
      https_proxy: 'socks5://127.0.0.1:7891',
      all_proxy: 'socks5://127.0.0.1:7891',
      no_proxy: 'localhost,127.0.0.1,::1',
    })
  })
})
