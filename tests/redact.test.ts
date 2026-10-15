import { describe, expect, it } from 'vitest'
import { describeAuthWait, redactSensitiveText } from '../src/runtime/redact.js'

describe('redactSensitiveText', () => {
  it('空值安全', () => {
    expect(redactSensitiveText(undefined)).toBe('')
    expect(redactSensitiveText(null)).toBe('')
    expect(redactSensitiveText('')).toBe('')
  })

  it('打码 OAuth 授权 URL 的一次性凭据参数，保留其余上下文', () => {
    const line = 'Open the following link to authenticate the ACP server:'
      + ' https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=1071.apps.googleusercontent.com'
      + '&redirect_uri=http%3A%2F%2F127.0.0.1%3A53391%2F&scope=a%20b&state=SEKRITSTATE'
      + '&access_type=offline&code_challenge=SEKRITCHALLENGE&code_challenge_method=S256'
    const redacted = redactSensitiveText(line)
    expect(redacted).not.toContain('SEKRITSTATE')
    expect(redacted).not.toContain('SEKRITCHALLENGE')
    // 非敏感参数保留，诊断信息仍然可用。
    expect(redacted).toContain('code_challenge=***')
    expect(redacted).toContain('client_id=1071.apps.googleusercontent.com')
    expect(redacted).toContain('redirect_uri=')
    expect(redacted).toContain('access_type=offline')
  })

  it('打码 URL userinfo 中的用户名密码', () => {
    expect(redactSensitiveText('dial via http://alice:hunter2@127.0.0.1:7890 failed'))
      .toBe('dial via http://***@127.0.0.1:7890 failed')
  })

  it('打码裸键值对（不在 URL 里的授权片段）', () => {
    expect(redactSensitiveText('state=SEKRITSTATE and code_challenge: SEKRITCHALLENGE'))
      .toBe('state=*** and code_challenge: ***')
  })

  it('不动与凭据无关的文本', () => {
    const line = 'I1015 12:57:06 main.py:118] Starting AGY ACP Server...\n'
      + 'settings: path=C:\\Users\\x\\.gemini\\antigravity-acp\\settings.json status=missing'
    expect(redactSensitiveText(line)).toBe(line)
  })

  it('真实观测到的官方 stderr 行样例不再泄露 state/code_challenge', () => {
    const stderr = [
      'google\\api_core\\_python_version_support.py:232: FutureWarning: ...',
      'I1015 13:01:19 credential_manager.py:561] Credentials missing or invalid. Launching browser login flow...',
      'Open the following link to authenticate the ACP server:'
        + ' https://accounts.google.com/o/oauth2/v2/auth?client_id=1071.apps.googleusercontent.com'
        + '&redirect_uri=http%3A%2F%2F127.0.0.1%3A53391%2F&state=YNR7UsA2SsdJmKSLcfTF6oRZrfZIkL'
        + '&access_type=offline&prompt=consent&code_challenge=XRXkT6wFekKwDpzepX6Ep4njpkHgEpyvEGsH4S88lpE'
        + '&code_challenge_method=S256',
    ].join('\n')
    const redacted = redactSensitiveText(stderr)
    expect(redacted).not.toContain('YNR7UsA2SsdJmKSLcfTF6oRZrfZIkL')
    expect(redacted).not.toContain('XRXkT6wFekKwDpzepX6Ep4njpkHgEpyvEGsH4S88lpE')
    expect(redacted).toContain('Launching browser login flow')
  })
})

describe('describeAuthWait', () => {
  it('识别官方登录等待提示并给出可行动文案', () => {
    expect(describeAuthWait('Credentials missing or invalid. Launching browser login flow...'))
      .toContain('请在浏览器里完成授权')
  })

  it('非登录场景返回 undefined', () => {
    expect(describeAuthWait('Starting AGY ACP Server...')).toBeUndefined()
    expect(describeAuthWait('')).toBeUndefined()
    expect(describeAuthWait(undefined)).toBeUndefined()
  })
})
