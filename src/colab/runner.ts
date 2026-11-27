import { isAbsolute } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

export const OUTPUT_BYTES = 16 * 1024
const GRACE_MS = 750
const DRAIN_MS = 5_000

export class ColabRunError extends Error {
  constructor(message: string, readonly retainTemp = false) {
    super(message)
  }
}

export interface CliRequest {
  executable: string
  args: readonly string[]
  cwd: string
  stdin?: string
  budgetMs: number
  signal: AbortSignal
  remoteExecution?: boolean
}

export interface CliResult {
  stdout: string
  truncated: boolean
}

export type CliRunner = (request: CliRequest) => Promise<CliResult>

function readStdout(handle: SubprocessHandle) {
  const output = handle.collected.stdout?.readFrom(0)
  const text = Buffer.from(output?.text ?? '').subarray(0, OUTPUT_BYTES).toString('utf8')
  return { text: stripVTControlCharacters(text).replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, ''), lossy: output?.lossy === true }
}

function waitForOutcome(handle: SubprocessHandle, signal: AbortSignal) {
  let onAbort: () => void
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([handle.done, aborted]).finally(() => signal.removeEventListener('abort', onAbort))
}

async function quiesce(handle: SubprocessHandle, terminate: boolean, remote: string) {
  try {
    if (terminate) handle.terminate()
    if (await handle.waitForExit(AbortSignal.timeout(DRAIN_MS))) return
    handle.terminate()
  } catch { /* No confirmation from the provider; do not clean up under the process. */ }
  throw new ColabRunError('Colab local process exit could not be confirmed; temporary files were retained.' + remote, true)
}

export function createCliRunner(subprocess: Pick<SubprocessRuntime, 'spawn'>): CliRunner {
  return async (request) => {
    const deadline = AbortSignal.timeout(request.budgetMs)
    const signal = AbortSignal.any([request.signal, deadline])
    if (!isAbsolute(request.executable)) throw new ColabRunError('Configure the absolute path to the installed Colab CLI.')
    signal.throwIfAborted()
    let handle: SubprocessHandle | undefined
    let exit: Awaited<SubprocessHandle['done']> | undefined
    try {
      handle = subprocess.spawn({
        argv: [request.executable, ...request.args], cwd: request.cwd, signal, graceMs: GRACE_MS,
        stdio: { stdin: request.stdin === undefined ? 'ignore' : { data: request.stdin },
          stdout: { maxBytes: OUTPUT_BYTES }, stderr: { maxBytes: OUTPUT_BYTES } },
        env: { TMPDIR: request.cwd, TMP: request.cwd, TEMP: request.cwd,
          GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: '0', PYTHONPATH: undefined, PYTHONHOME: undefined,
          PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1', NO_COLOR: '1' },
      })
      exit = await waitForOutcome(handle, signal)
    } catch { /* Below: typed, non-diagnostic error; CLI errors can include private paths. */ }
    const remote = request.remoteExecution && handle ? ' Remote execution may still be running.' : ''
    if (handle) await quiesce(handle, !exit || signal.aborted, remote)
    if (signal.aborted) throw new ColabRunError((deadline.aborted && !request.signal.aborted
      ? 'Colab CLI reached the local time limit.' : 'Colab CLI was cancelled locally.') + remote)
    if (exit?.exitCode !== 0) throw new ColabRunError(
      (exit ? `Colab CLI failed (${exit.exitCode ?? 'process terminated'}). Check the configured session and existing ADC sign-in.`
        : 'Could not start or complete the Colab CLI. Check the configured executable.') + remote)
    if (!handle) throw new ColabRunError('Colab CLI returned no process handle.')
    const stdout = readStdout(handle)
    return { stdout: stdout.text, truncated: stdout.lossy }
  }
}
