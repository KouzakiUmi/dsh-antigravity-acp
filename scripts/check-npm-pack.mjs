import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const [report] = JSON.parse(readFileSync(0, 'utf8'))
assert.equal(report?.name, manifest.name)
assert.equal(report?.version, manifest.version)

const files = new Set(report.files.map(({ path }) => path))
const expected = new Set(['package.json', 'README.md', 'LICENSE', 'docs/colab.md', manifest.main, manifest.types, manifest.dsh.bundle.patch])
for (const [entry, target] of Object.entries(manifest.exports)) {
  if (entry === './colab/locale/*.json') {
    for (const lang of ['en', 'zh']) expected.add(target.replace('*', lang))
  } else {
    expected.add(target)
  }
}
for (const name of expected) assert(files.has(name.replace(/^\.\//, '')), `${name} is missing from the npm package`)
for (const name of files) {
  assert(!name.split('/').some(part => part.startsWith('.') || part === 'node_modules'), `Unexpected packaged file: ${name}`)
  assert(/^(?:dist\/|docs\/|locale\/colab\/|package\.json$|cordis\.patch\.yml$|README\.md$|LICENSE$)/.test(name), `Unexpected packaged file: ${name}`)
  if (name.startsWith('dist/') && name !== 'dist/client.js') {
    const source = /^dist\/([\w/-]+)\.(?:js(?:\.map)?|d\.ts)$/.exec(name)?.[1]
    assert(source && existsSync(new URL(`../src/${source}.ts`, import.meta.url)), `Stale build output: ${name}; build in a clean checkout`)
  }
}
assert(!Object.keys(manifest.dependencies).some(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')), 'DSH core modules must not be private dependencies')
console.log(`Verified ${report.name}@${report.version} (${files.size} files)`)
