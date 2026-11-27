import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { assertSupportedJsonSchema, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { createTools } from '../src/colab/index.js'
import { parseUsage } from '../src/colab/usage.js'
import { ColabRunError, createCliRunner, OUTPUT_BYTES, type CliRequest } from '../src/colab/runner.js'
import { readNotebook } from '../src/colab/notebook.js'

const executable = join(tmpdir(), 'fake-colab')
const config = { executable, session: 'notebook-lab' }
const usageText = 'Current balance: 123.40 compute units\r\nUsage rate: 0.00/hr\r\nActive assignments: 2\r\n'
const nb = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
  { cell_type: 'code', id: 'one', metadata: {}, source: 'print(1)', execution_count: 1, outputs: [{ output_type: 'error' }] },
] }

function context(cwd?: string, signal = new AbortController().signal): ToolRunContext {
  return { agent: { session: { header: { cwd } } }, callId: 'fixture-call', signal } as unknown as ToolRunContext
}

function fixtures(outcome: ApprovalOutcome | undefined = 'allowed-once') {
  const request = vi.fn(async (): Promise<ApprovalOutcome> => outcome ?? 'unavailable')
  const approval = { request }
  const saveFile = vi.fn(async ({ data, name }: { data: Uint8Array; name: string }) =>
    ({ attachmentId: 'opaque', bytes: data.byteLength, name }) as FileAttachmentRef)
  const runner = vi.fn(async (call: CliRequest) => {
    if (call.args[1] === 'version') return { stdout: 'Version: 0.8.0\n', truncated: false }
    if (call.args[1] === 'usage') return { stdout: usageText, truncated: false }
    const marker = call.stdin?.match(/__DSH_COLAB_[0-9a-f]+__/)?.[0]
    return { stdout: marker ? `answer=42\n[Image saved to: /private/temp]\nAuthorization: secret\n${marker}ok\n` : '', truncated: false }
  })
  return { request, saveFile, runner, tools: createTools(config, { runner, approval: () => approval, attachments: () => ({ saveFile }) }) }
}

describe('Colab usage and approval', () => {
  it('declares supported canonical schemas for the actual DSH registry', () => {
    const { tools } = fixtures()
    for (const tool of [tools.usage, tools.execute]) {
      assertSupportedJsonSchema(tool.parameters)
      assertSupportedJsonSchema(tool.output.schema)
    }
  })

  it('parses exact tagged labels and distinguishes zero from missing or invalid fields', async () => {
    expect(parseUsage(usageText)).toEqual({ balanceCu: 123.4, rateCuPerHour: 0, activeAssignments: 2 })
    expect(parseUsage('Current balance: N/A compute units\nActive assignments: 0')).toEqual({ balanceCu: null, rateCuPerHour: null, activeAssignments: 0 })
    expect(parseUsage(`${usageText}Active assignments: 5`)).toMatchObject({ activeAssignments: null })
    const f = fixtures()
    expect(await f.tools.usage.execute({}, context())).toEqual(parseUsage(usageText))
    expect(f.runner.mock.calls.map(([x]) => x.args)).toEqual([['--auth=adc', 'version'], ['--auth=adc', 'usage']])
    expect(f.request).not.toHaveBeenCalled()
  })

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('spawns nothing for %s approval', async (outcome) => {
    const f = fixtures(outcome)
    await expect(f.tools.execute.execute({ code: 'print(1)' }, context())).rejects.toThrow('one-time DSH user approval')
    expect(f.runner).not.toHaveBeenCalled()
  })

  it('fails closed without an approval seam or without an agent', async () => {
    const f = fixtures()
    const missing = createTools(config, { runner: f.runner, approval: () => undefined, attachments: () => undefined })
    await expect(missing.execute.execute({ code: 'print(1)' }, context())).rejects.toThrow('no approval channel')
    await expect(f.tools.execute.execute({ code: 'print(1)' }, { ...context(), agent: undefined })).rejects.toThrow('no approval channel')
    expect(f.runner).not.toHaveBeenCalled()
  })

  it('does not accept unsafe configured runtime names or missing Notebook attachments', async () => {
    const f = fixtures()
    const approval = { request: f.request }
    const deps = { runner: f.runner, approval: () => approval, attachments: () => undefined }
    for (const session of ['', '-other', 'lab\n', 'lab/other', 'lab --flag']) {
      await expect(createTools({ ...config, session }, deps).execute.execute({ code: 'print(1)' }, context())).rejects.toThrow('existing named')
    }
    expect(f.request).not.toHaveBeenCalled()
    await expect(createTools(config, deps).execute.execute({ notebook: 'foo.ipynb' }, context())).rejects.toThrow('attachment service')
    expect(f.runner).not.toHaveBeenCalled()
  })

  it('rejects concurrent work and does not run after an aborted approval', async () => {
    const f = fixtures()
    const controller = new AbortController()
    let grant!: (value: ApprovalOutcome) => void
    f.request.mockImplementationOnce(() => new Promise((resolve) => { grant = resolve }))
    const call = f.tools.execute.execute({ code: 'print(1)' }, context(undefined, controller.signal))
    await Promise.resolve()
    await expect(f.tools.usage.execute({}, context())).rejects.toThrow('in progress')
    controller.abort()
    grant('allowed-once')
    await expect(call).rejects.toThrow('one-time DSH user approval')
    expect(f.runner).not.toHaveBeenCalled()
  })

  it('requires the exact version before usage', async () => {
    const f = fixtures()
    f.runner.mockResolvedValueOnce({ stdout: 'Version: 0.9.0', truncated: false })
    await expect(f.tools.usage.execute({}, context())).rejects.toThrow('requires Google Colab CLI 0.8.0')
    expect(f.runner).toHaveBeenCalledTimes(1)
  })
})

describe('Colab execution contracts', () => {
  it('never accepts runtime, flags, absolute paths, traversal, or both input modes', async () => {
    const f = fixtures()
    for (const args of [{ code: 'print(1)', session: 'other' }, { notebook: '--session=other', code: 'x' },
      { notebook: '../outside.ipynb' }, { notebook: 'C:\\outside.ipynb' }, { notebook: '/outside.ipynb' },
      { notebook: 'notebook.ipynb:stream' }, { notebook: 'NUL.ipynb' }, { code: ' ' }]) {
      await expect(f.tools.execute.execute(args, context())).rejects.toThrow()
    }
    expect(f.request).not.toHaveBeenCalled()
    expect(f.runner).not.toHaveBeenCalled()
  })

  it('requests approval then sends Python on stdin with fixed argv and no raw diagnostics', async () => {
    const f = fixtures()
    const source = 'print(42) # --session other; $HOME'
    const output = await f.tools.execute.execute({ code: source }, context())
    expect(f.request.mock.invocationCallOrder[0]!).toBeLessThan(f.runner.mock.invocationCallOrder[0]!)
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'colab_execute', callId: 'fixture-call', reason: expect.stringContaining('notebook-lab') }))
    const call = f.runner.mock.calls[1]![0]
    expect(call.args).toEqual(['--auth=adc', 'exec', '--session=notebook-lab', '--timeout=90', '--output-image=colab-plot'])
    expect(call.stdin).toContain(Buffer.from(source).toString('base64'))
    expect(call.stdin).toMatch(/print\('\\n__DSH_COLAB_[0-9a-f]+__ok'\)/)
    expect(output).toMatchObject({ status: 'completed', stdout: 'answer=42\n[redacted]' })
    await expect(stat(call.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('distinguishes Python exceptions and missing markers from a normal CLI exit', async () => {
    const f = fixtures()
    f.runner.mockResolvedValueOnce({ stdout: 'Version: 0.8.0', truncated: false }).mockImplementationOnce(async ({ stdin }) => ({
      stdout: `${stdin?.match(/__DSH_COLAB_[0-9a-f]+__/)?.[0]}error\n`, truncated: false,
    }))
    await expect(f.tools.execute.execute({ code: 'raise ValueError()' }, context())).resolves.toMatchObject({ status: 'python-error' })
    f.runner.mockResolvedValueOnce({ stdout: 'Version: 0.8.0', truncated: false }).mockResolvedValueOnce({ stdout: 'no marker', truncated: true })
    await expect(f.tools.execute.execute({ code: 'print(1)' }, context())).resolves.toMatchObject({ status: 'unverified', truncated: true })
  })

  it('passes a clean private notebook copy, returns error/artifact facts, and preserves the original', async () => {
    const work = await mkdtemp(join(await realpath(tmpdir()), 'test-colab-workspace-'))
    try {
      await mkdir(join(work, 'nested'))
      const original = join(work, 'nested', 'space name.ipynb')
      const originalText = JSON.stringify(nb, null, 2)
      await writeFile(original, originalText)
      const f = fixtures()
      f.runner.mockResolvedValueOnce({ stdout: 'Version: 0.8.0', truncated: false }).mockImplementationOnce(async (call) => {
        expect(call.cwd).not.toBe(work)
        expect(call.args.at(-1)).toBe('--file=input.ipynb')
        expect(call.stdin).toBeUndefined()
        const uploaded = JSON.parse(await readFile(join(call.cwd, 'input.ipynb'), 'utf8'))
        expect(uploaded.cells[0]).toMatchObject({ outputs: [], execution_count: null })
        await writeFile(join(call.cwd, 'input_output.ipynb'), originalText)
        return { stdout: 'private local path is not returned', truncated: false }
      })
      const output = await f.tools.execute.execute({ notebook: 'nested/space name.ipynb' }, context(work))
      expect(output).toMatchObject({ status: 'python-error', stdout: '', artifacts: [{ name: 'colab-output.ipynb' }] })
      expect(await readFile(original, 'utf8')).toBe(originalText)
      expect(f.saveFile).toHaveBeenCalledTimes(1)
      await expect(stat(f.runner.mock.calls[1]![0].cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(work, { force: true, recursive: true }) }
  })

  it('rejects a workspace path traversing an external directory link', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'test-colab-link-'))
    try {
      const work = join(root, 'workspace')
      await mkdir(work)
      await mkdir(join(root, 'outside'))
      await writeFile(join(root, 'outside', 'exposed.ipynb'), JSON.stringify(nb))
      await symlink(join(root, 'outside'), join(work, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
      await expect(readNotebook(work, ['link', 'exposed.ipynb'], context().signal)).rejects.toThrow('regular workspace Notebook')
    } finally { await rm(root, { force: true, recursive: true }) }
  })
})

describe('Colab subprocess seam', () => {
  it('retains files and blocks subsequent calls when the local range cannot be confirmed', async () => {
    const f = fixtures()
    f.runner.mockResolvedValueOnce({ stdout: 'Version: 0.8.0', truncated: false })
      .mockRejectedValueOnce(new ColabRunError('Local exit could not be confirmed', true))
    try {
      await expect(f.tools.execute.execute({ code: 'print(1)' }, context())).rejects.toThrow('exit could not be confirmed')
      const dir = f.runner.mock.calls[1]![0].cwd
      expect((await stat(dir)).isDirectory()).toBe(true)
      await expect(f.tools.usage.execute({}, context())).rejects.toThrow('before reloading the bundle')
      expect(f.runner).toHaveBeenCalledTimes(2)
    } finally {
      const testOwnedDir = f.runner.mock.calls[1]?.[0].cwd
      if (testOwnedDir) await rm(testOwnedDir, { force: true, recursive: true })
    }
  })

  it.each(['caller cancellation', 'local timeout'])('drains and reports uncertain remote state on %s', async (cause) => {
    const controller = new AbortController()
    const terminate = vi.fn()
    const waitForExit = vi.fn(async () => true)
    const spawn = vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => ({
      done: new Promise((resolve) => spec.signal?.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })),
      waitForExit, terminate, collected: {},
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    }))
    const keepEventLoop = setTimeout(() => {}, 100)
    try {
      const run = createCliRunner({ spawn })({ executable, args: ['--auth=adc', 'exec'], cwd: tmpdir(),
        stdin: 'print(1)', budgetMs: cause === 'local timeout' ? 5 : 1_000, signal: controller.signal, remoteExecution: true })
      if (cause === 'caller cancellation') controller.abort()
      const prefix = cause === 'local timeout' ? 'local time limit' : 'cancelled locally'
      await expect(run).rejects.toThrow(new RegExp(`${prefix}.*Remote execution may still be running`))
      const [spec] = spawn.mock.calls[0]!
      expect(spec.argv).toEqual([executable, '--auth=adc', 'exec'])
      expect(spec.stdio).toEqual({ stdin: { data: 'print(1)' }, stdout: { maxBytes: OUTPUT_BYTES }, stderr: { maxBytes: OUTPUT_BYTES } })
      expect(terminate).toHaveBeenCalledOnce()
      expect(waitForExit).toHaveBeenCalledOnce()
    } finally { clearTimeout(keepEventLoop) }
  })
})
