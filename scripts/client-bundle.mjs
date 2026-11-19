import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const INCLUDE = /^[ \t]*\/\* @include (client-i18n\/[\w./-]+\.js) \*\/[ \t]*$/gm

/** 浏览器只能加载单个脚本：把 src/client.js 里的 `@include` 指令展开为对应片段。 */
export function buildClientSource() {
  return readFileSync(join(srcDir, 'client.js'), 'utf8').replace(INCLUDE, (_whole, file) => readFileSync(join(srcDir, file), 'utf8'))
}
