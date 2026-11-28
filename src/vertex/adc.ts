import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { llmError } from '../runtime/llm-error.js'
import { buildProxyEnv } from '../runtime/proxy-env.js'
import type { ResolvedProxy } from '../runtime/proxy-env.js'

const ADC_ARGS = ['auth', 'application-default', 'print-access-token'] as const
const ADC_TIMEOUT_MS = 25_000
type ProcessPort = Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>

interface AdcEnvironment {
  platform: string
  home: string
  env: NodeJS.ProcessEnv
}

/** Resolve an already-configured ADC access token in memory; never print/copy subprocess output. */
export async function readVertexAccessToken(
  subprocess: ProcessPort,
  signal: AbortSignal,
  proxy?: ResolvedProxy,
  host: AdcEnvironment = { platform: process.platform, home: homedir(), env: process.env },
): Promise<string> {
  const deadline = AbortSignal.timeout(ADC_TIMEOUT_MS)
  const runSignal = AbortSignal.any([signal, deadline])
  try {
    runSignal.throwIfAborted()
    const command = await adcCommand(subprocess, host, runSignal)
    const credentialsFile = host.env.GOOGLE_APPLICATION_CREDENTIALS
    const handle = subprocess.spawn({
      argv: command.argv, cwd: command.cwd,
      env: {
        ...buildProxyEnv({ url: proxy?.url, bypass: proxy?.bypass }),
        ...command.env,
        CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
        ...(credentialsFile ? { GOOGLE_APPLICATION_CREDENTIALS: credentialsFile } : {}),
      },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 16_384 }, stderr: { maxBytes: 2_048 } },
      signal: runSignal, graceMs: 1_000,
    })
    const result = await handle.done
    runSignal.throwIfAborted()
    const stdout = result.exitCode === 0 ? handle.collected.stdout?.readFrom(0) : undefined
    const token = stdout?.lossy === false ? stdout.text.trim() : ''
    if (!/^[A-Za-z0-9._~+/-]+={0,2}$/u.test(token)) throw new Error('ADC unavailable')
    return token
  } catch {
    if (signal.aborted) throw llmError('Vertex AI 请求已取消', 'CANCELLED')
    if (deadline.aborted) throw llmError('Vertex AI ADC 获取访问令牌超时', 'TIMEOUT')
    throw llmError('Vertex AI 无法获取 ADC 访问令牌；请检查宿主 PATH 上的 Google Cloud CLI 和应用默认凭据', 'AUTH')
  }
}

async function adcCommand(subprocess: ProcessPort, host: AdcEnvironment, signal: AbortSignal): Promise<{ argv: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv }> {
  if (host.platform !== 'win32') {
    const gcloud = await subprocess.resolveExecutable('gcloud', undefined, signal)
    if (!posix.isAbsolute(gcloud)) throw new Error('Expected absolute gcloud path')
    return { argv: [gcloud, ...ADC_ARGS], cwd: host.home }
  }
  const path = Object.entries(host.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  const pathDirs = path.split(';').map(entry => entry.trim().replace(/^"(.*)"$/u, '$1')).filter(isLocalWindowsPath)
  if (pathDirs.length === 0) throw new Error('No absolute PATH entries')
  const gcloud = await subprocess.resolveExecutable('gcloud.cmd', { PATH: pathDirs.join(';') }, signal)
  if (!isLocalWindowsPath(gcloud) || win32.basename(gcloud).toLowerCase() !== 'gcloud.cmd') throw new Error('Expected absolute gcloud.cmd path')
  const systemRoot = Object.entries(host.env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1] ?? ''
  if (!isLocalWindowsPath(systemRoot)) throw new Error('Expected Windows SystemRoot')
  const cwd = win32.dirname(gcloud)
  const cmd = await subprocess.resolveExecutable(win32.join(systemRoot, 'System32', 'cmd.exe'), undefined, signal)
  if (cmd.toLowerCase() !== win32.join(systemRoot, 'System32', 'cmd.exe').toLowerCase()) throw new Error('Unexpected cmd.exe path')
  // Explicitly invoke the shim in the validated CLI directory (also first on PATH).
  // No filesystem path, project, region, or prompt is interpolated into the shell command.
  return { argv: [cmd, '/d', '/v:off', '/c', '.\\gcloud.cmd', ...ADC_ARGS], cwd, env: { PATH: [cwd, ...pathDirs].join(';') } }
}

function isLocalWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) && !/[\u0000-\u001f<>"|?*%&^!]/u.test(path)
}
