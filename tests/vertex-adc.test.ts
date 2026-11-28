import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { readVertexAccessToken } from '../src/vertex/adc.js'

function mockProcess(text = 'fixture-access-token\r\n', exitCode = 0, lossy = false) {
  const handle: SubprocessHandle = {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: { stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy }) } },
    done: Promise.resolve({ exitCode, signal: null }), terminate: vi.fn(), waitForExit: async () => true,
  }
  return { spawn: vi.fn<SubprocessRuntime['spawn']>().mockReturnValue(handle), resolveExecutable: vi.fn<SubprocessRuntime['resolveExecutable']>() }
}

describe('Vertex ADC subprocess', () => {
  it('uses fixed executable argv and bounded, in-memory collection', async () => {
    const service = mockProcess()
    service.resolveExecutable.mockResolvedValue('/usr/local/bin/gcloud')
    await expect(readVertexAccessToken(service, new AbortController().signal, undefined, { platform: 'linux', home: '/home/fixture', env: {} })).resolves.toBe('fixture-access-token')
    expect(service.spawn).toHaveBeenCalledWith(expect.objectContaining({
      argv: ['/usr/local/bin/gcloud', 'auth', 'application-default', 'print-access-token'], cwd: '/home/fixture',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 16_384 }, stderr: { maxBytes: 2_048 } },
    }))
  })

  it('on Windows resolves only absolute PATH entries and invokes the validated shim with fixed cmd argv', async () => {
    const service = mockProcess()
    const bin = 'C:\\Program Files\\Google Cloud SDK\\bin'
    const cmd = 'C:\\Windows\\System32\\cmd.exe'
    service.resolveExecutable.mockResolvedValueOnce(`${bin}\\gcloud.cmd`).mockResolvedValueOnce(cmd)
    const env = { Path: `;.;relative;${bin};E:\\%bad%`, SystemRoot: 'C:\\Windows' }
    await expect(readVertexAccessToken(service, new AbortController().signal, undefined, { platform: 'win32', home: 'C:\\Users\\Fixture', env })).resolves.toBe('fixture-access-token')
    expect(service.resolveExecutable).toHaveBeenNthCalledWith(1, 'gcloud.cmd', { PATH: bin }, expect.any(AbortSignal))
    expect(service.resolveExecutable).toHaveBeenNthCalledWith(2, cmd, undefined, expect.any(AbortSignal))
    expect(service.spawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: bin, argv: [cmd, '/d', '/v:off', '/c', '.\\gcloud.cmd', 'auth', 'application-default', 'print-access-token'] }))
  })

  it.each([['not a token\nfixture', 0, false], ['fixture-secret', 1, false], ['fixture-secret', 0, true]])('does not expose failed stdout (%s)', async (text, exitCode, lossy) => {
    const service = mockProcess(text, exitCode, lossy)
    service.resolveExecutable.mockResolvedValue('/usr/local/bin/gcloud')
    await expect(readVertexAccessToken(service, new AbortController().signal, undefined, { platform: 'linux', home: '/home/fixture', env: {} })).rejects.toMatchObject({ code: 'AUTH', message: expect.not.stringContaining('fixture') })
  })
})
