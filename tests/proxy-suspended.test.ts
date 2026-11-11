/** 上游「账号被停用」的识别：不能与普通 403 混为一谈。 */
import { describe, expect, it } from 'vitest'
import { isAccountSuspended } from '../src/proxy/adapter.js'

describe('上游账号停用识别', () => {
  it('识别 Google 的停用原话（大小写不敏感）', () => {
    const body = '{"error":{"code":403,"message":"This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.","status":"PERMISSION_DENIED"}}'
    expect(isAccountSuspended(body)).toBe(true)
    expect(isAccountSuspended(body.toUpperCase())).toBe(true)
  })

  it('普通 403 与空响应体不误判', () => {
    expect(isAccountSuspended('{"error":{"code":403,"message":"Permission denied"}}')).toBe(false)
    expect(isAccountSuspended('')).toBe(false)
  })
})
