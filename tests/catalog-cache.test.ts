import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCachedCatalog, writeCachedCatalog } from '../src/runtime/catalog-cache.js'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agy-catalog-'))
}

const MODELS = [
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', description: 'fast' },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro' },
]

describe('catalog cache', () => {
  it('写入后可读回同形状目录', async () => {
    const dir = await tempDir()
    try {
      await writeCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0', models: MODELS })
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toEqual(MODELS)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ACP 版本变化即失效（官方换版后不展示旧档位）', async () => {
    const dir = await tempDir()
    try {
      await writeCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0', models: MODELS })
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.5.0' })).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('空目录不写盘（避免把空缓存当成有效目录）', async () => {
    const dir = await tempDir()
    try {
      await writeCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0', models: [] })
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('缺失 / 损坏 / 格式不符的文件一律静默降级为无缓存', async () => {
    const dir = await tempDir()
    try {
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toBeUndefined()
      await writeFile(join(dir, 'catalog.json'), 'not json at all', 'utf8')
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toBeUndefined()
      await writeFile(join(dir, 'catalog.json'), JSON.stringify({ format: 999, acpVersion: '1.4.0', models: MODELS }), 'utf8')
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toBeUndefined()
      await writeFile(join(dir, 'catalog.json'), JSON.stringify({ format: 1, acpVersion: '1.4.0', models: [{ id: 1 }] }), 'utf8')
      await expect(readCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0' })).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('落盘内容只有模型元数据，不含凭据字段', async () => {
    const dir = await tempDir()
    try {
      await writeCachedCatalog({ cacheDir: dir, acpVersion: '1.4.0', models: MODELS })
      const raw = await readFile(join(dir, 'catalog.json'), 'utf8')
      expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['acpVersion', 'format', 'models'])
      expect(raw).not.toMatch(/token|secret|code_challenge|oauth/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
