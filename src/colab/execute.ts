import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { imageName, IMAGE_OUTPUT, NOTEBOOK_INPUT, NOTEBOOK_OUTPUT, notebookParts, readArtifact, readNotebook } from './notebook.js'
import type { CliResult } from './runner.js'

const CODE_LIMIT = 32 * 1024
export type ExecutionInput = { code: string } | { notebook: string; parts: string[] }
export type ExecutionStatus = 'completed' | 'python-error' | 'unverified'
export type Artifacts = Record<string, FileAttachmentRef>

export function parseExecution(value: unknown): ExecutionInput {
  if (value && typeof value === 'object' && Reflect.ownKeys(value).length === 1) {
    if ('code' in value && typeof value.code === 'string' && Buffer.byteLength(value.code) <= CODE_LIMIT &&
        value.code.trim() && !value.code.includes('\0')) return { code: value.code }
    if ('notebook' in value && typeof value.notebook === 'string') {
      return { notebook: value.notebook, parts: notebookParts(value.notebook) }
    }
  }
  throw new Error('Provide exactly one input: Python source (up to 32 KiB) or the workspace-relative .ipynb path.')
}

export async function prepareExecution(input: ExecutionInput, dir: string, cwd: string | undefined, signal: AbortSignal) {
  if ('code' in input) {
    // Compile inside the remote kernel (including syntax errors), preserving globals across calls.
    // A nonce lets us distinguish an observed completion from CLI exit 0 alone.
    const marker = `__DSH_COLAB_${randomBytes(16).toString('hex')}__`
    const code = Buffer.from(input.code).toString('base64')
    const stdin = [
      'try:',
      `    exec(compile(__import__('base64').b64decode('${code}').decode('utf-8'), '<colab_execute>', 'exec'), globals())`,
      'except BaseException:',
      `    __import__('builtins').print('\\n${marker}error')`,
      '    raise',
      'else:',
      `    __import__('builtins').print('\\n${marker}ok')`,
      '',
    ].join('\n')
    return { stdin, marker }
  }
  const data = await readNotebook(cwd, input.parts, signal)
  await writeFile(join(dir, NOTEBOOK_INPUT), data, { flag: 'wx', mode: 0o600, signal })
  return { stdin: undefined, marker: undefined }
}

export function pythonOutcome(result: CliResult, marker: string) {
  const suffix = new RegExp(`(?:^|\\r?\\n)${marker}(ok|error)\\r?\\n?$`)
  const captured = suffix.exec(result.stdout)
  const status: ExecutionStatus = captured?.[1] === 'ok' ? 'completed' : captured?.[1] === 'error' ? 'python-error' : 'unverified'
  return { status, stdout: result.stdout.replace(suffix, '') }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function notebookStatus(data: Buffer): ExecutionStatus {
  const nb: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
  if (!object(nb) || nb.nbformat !== 4 || !Array.isArray(nb.cells)) throw new Error('Invalid Notebook artifact.')
  for (const cell of nb.cells) {
    if (object(cell) && cell.cell_type === 'code' && Array.isArray(cell.outputs) &&
        cell.outputs.some((output) => object(output) && output.output_type === 'error')) return 'python-error'
  }
  return 'completed'
}

export async function collectArtifacts(dir: string, notebook: boolean, attachments: Pick<AttachmentStore, 'saveFile'> | undefined, signal: AbortSignal) {
  const artifacts: Artifacts = {}
  let status: ExecutionStatus = 'unverified'
  let artifactIssue = false
  for (const filename of notebook ? [NOTEBOOK_OUTPUT, IMAGE_OUTPUT] : [IMAGE_OUTPUT]) {
    try {
      const data = await readArtifact(dir, filename, signal)
      if (!data) continue
      const isNotebook = filename === NOTEBOOK_OUTPUT
      if (isNotebook) status = notebookStatus(data)
      const name = isNotebook ? 'colab-output.ipynb' : imageName(data)
      signal.throwIfAborted()
      if (!attachments || !name) { artifactIssue = true; continue }
      artifacts[isNotebook ? 'notebook' : 'image'] = await attachments.saveFile({ data, name })
    } catch {
      signal.throwIfAborted()
      artifactIssue = true
    }
  }
  signal.throwIfAborted()
  return { artifacts: Object.values(artifacts), status, artifactIssue }
}
