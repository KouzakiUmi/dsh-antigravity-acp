import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

export const NOTEBOOK_INPUT = 'input.ipynb'
export const NOTEBOOK_OUTPUT = 'input_output.ipynb'
export const IMAGE_OUTPUT = 'colab-plot'
export const SOURCE_LIMIT = 2 * 1024 * 1024
export const ARTIFACT_LIMIT = 8 * 1024 * 1024

export function notebookParts(path: string): string[] {
  const parts = path.split(/[\\/]/)
  if (path.length > 512 || !path.endsWith('.ipynb') || parts.some((part) =>
    !part || part === '.' || part === '..' || /[\x00-\x1f\x7f:*?"<>|]|[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|(?:com|lpt)[0-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(part))) {
    throw new Error('Use a workspace-relative .ipynb path without links, traversal, or special path components.')
  }
  return parts
}

async function matchPath(root: string, parts: string[]): Promise<string> {
  let path = root
  for (const [index, part] of parts.entries()) {
    path = join(path, part)
    const info = await lstat(path)
    if (index === parts.length - 1 ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()) {
      throw new Error('Expected a regular single-link file below ordinary directories.')
    }
  }
  if (relative(root, await realpath(path)) !== parts.join(sep)) throw new Error('Notebook path changed or resolves outside the workspace.')
  return path
}

/** Pin the file descriptor and recheck containment/identity before reading any content. */
async function readRegular(path: string, limit: number, recheck: () => Promise<string>, signal: AbortSignal): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const info = await handle.stat({ bigint: true })
    const observed = await lstat(await recheck(), { bigint: true })
    if (!info.isFile() || !observed.isFile() || info.nlink !== 1n || observed.nlink !== 1n ||
        info.dev !== observed.dev || info.ino !== observed.ino || info.size > limit) throw new Error('File identity or size rejected.')
    const bytes = Buffer.allocUnsafe(limit + 1)
    let used = 0
    while (used < bytes.length) {
      signal.throwIfAborted()
      const result = await handle.read(bytes, used, bytes.length - used, used)
      if (!result.bytesRead) break
      used += result.bytesRead
    }
    const final = await handle.stat({ bigint: true })
    if (used > limit || used !== Number(info.size) || info.mtimeNs !== final.mtimeNs || info.ctimeNs !== final.ctimeNs) {
      throw new Error('File was too large or changed during read.')
    }
    return bytes.subarray(0, used)
  } finally { await handle.close() }
}

export async function readNotebook(cwd: string | undefined, parts: string[], signal: AbortSignal): Promise<string> {
  if (!cwd || !isAbsolute(cwd)) throw new Error('This DSH session has no absolute workspace directory.')
  try {
    const root = await realpath(cwd)
    const recheck = () => matchPath(root, parts)
    const data = await readRegular(await recheck(), SOURCE_LIMIT, recheck, signal)
    const notebook: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
    if (typeof notebook !== 'object' || notebook === null || !('nbformat' in notebook) || notebook.nbformat !== 4 ||
        !('cells' in notebook) || !Array.isArray(notebook.cells)) throw new Error('Not a v4 Notebook.')
    for (const cell of notebook.cells) {
      if (typeof cell !== 'object' || cell === null || !('cell_type' in cell)) throw new Error('Invalid notebook cell.')
      if (cell.cell_type === 'code') Object.assign(cell, { outputs: [], execution_count: null })
    }
    return JSON.stringify(notebook)
  } catch {
    signal.throwIfAborted()
    throw new Error('Could not read a regular workspace Notebook (v4 JSON, up to 2 MiB; symbolic and hard links are excluded).')
  }
}

export async function readArtifact(dir: string, filename: string, signal: AbortSignal): Promise<Buffer | undefined> {
  const path = join(dir, filename)
  try { await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const recheck = () => matchPath(dir, [filename])
  return readRegular(await recheck(), ARTIFACT_LIMIT, recheck, signal)
}

export function imageName(data: Buffer): string | undefined {
  if (data.length >= 8 && data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'colab-plot.png'
  if (data.length >= 3 && data.subarray(0, 3).toString('hex') === 'ffd8ff') return 'colab-plot.jpg'
  return undefined
}
