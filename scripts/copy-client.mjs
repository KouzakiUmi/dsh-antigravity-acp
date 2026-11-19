import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClientSource } from './client-bundle.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(root, 'dist'), { recursive: true })
writeFileSync(join(root, 'dist', 'client.js'), buildClientSource())
