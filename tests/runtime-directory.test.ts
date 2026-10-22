import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupStaleRuntimeDirectories, createRuntimeDirectory, ensureAgentBinary,
  releaseRuntimeDirectory, resolveRuntimeRoot,
} from '../src/runtime/binary.js'

const roots: string[] = []
async function makeRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agy-runtime-test-'))
  roots.push(path)
  return path
}
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })

describe('isolated ACP runtime directory', () => {
  it('uses the executable installation root, never DSH_HOME', () => {
    const path = resolveRuntimeRoot({ LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local', DSH_HOME: 'C:\\low\\dsh' }, 'win32')
    expect(path).toContain('dsh-antigravity-host')
    expect(path).not.toContain('low')
  })

  it('allocates distinct leases and preserves unknown processes even when the owner PID is dead', async () => {
    const root = await makeRoot()
    const first = await createRuntimeDirectory({ root, ownerPid: 2147483647 })
    const second = await createRuntimeDirectory({ root })
    expect(first.path).not.toBe(second.path)
    expect(await cleanupStaleRuntimeDirectories(root)).toBe(0)
    expect(existsSync(first.path)).toBe(true)
    await releaseRuntimeDirectory(second)
    expect(existsSync(second.path)).toBe(false)
    expect(existsSync(first.path)).toBe(true)
  })

  it('cannot release a different lease or a path outside the designated root', async () => {
    const root = await makeRoot()
    const lease = await createRuntimeDirectory({ root })
    await releaseRuntimeDirectory({ ...lease, ownerId: 'unrelated' })
    await releaseRuntimeDirectory({ ...lease, root: join(root, 'elsewhere') })
    expect(existsSync(lease.path)).toBe(true)
  })

  it('scavenges only directories whose child exit was positively recorded', async () => {
    const root = await makeRoot()
    const exited = await createRuntimeDirectory({ root })
    const active = await createRuntimeDirectory({ root })
    const marker = join(exited.path, 'dsh-owner.json')
    const owner = JSON.parse(await readFile(marker, 'utf8'))
    await writeFile(marker, JSON.stringify({ ...owner, state: 'exited' }))
    expect(await cleanupStaleRuntimeDirectories(root)).toBe(1)
    expect(existsSync(exited.path)).toBe(false)
    expect(existsSync(active.path)).toBe(true)
  })
})

describe('manual executable escape hatch', () => {
  it('accepts an explicit binary before rejecting unknown download platforms', async () => {
    const root = await makeRoot()
    const path = join(root, 'custom-agent')
    await writeFile(path, 'test fixture')
    await expect(ensureAgentBinary({ binaryPath: path, platform: 'freebsd', arch: 'riscv64', env: {} })).resolves.toMatchObject({ source: 'config', executablePath: path })
    await expect(ensureAgentBinary({ platform: 'freebsd', arch: 'riscv64', env: { AGY_ACP_BIN: path } })).resolves.toMatchObject({ source: 'env', executablePath: path })
  })
})
