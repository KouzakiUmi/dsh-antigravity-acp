import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const INCLUDE = /^[ \t]*\/\* @include (client-i18n\/[\w./-]+\.js) \*\/[ \t]*$/gm
const POLICY = '/* @include-catalog-policy */'

/** 浏览器只能加载单个脚本：把 src/client.js 里的 `@include` 指令展开为对应片段。 */
export function buildClientSource() {
  const client = readFileSync(join(srcDir, 'client.js'), 'utf8')
  const catalogPolicy = ts.transpileModule(readFileSync(join(srcDir, 'adapter/model-catalog-policy.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/^export /gm, '')
  return client.replace(POLICY, () => catalogPolicy)
    .replace(INCLUDE, (_whole, file) => readFileSync(join(srcDir, file), 'utf8'))
}
