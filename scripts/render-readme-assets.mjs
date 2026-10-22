/**
 * 生成 README 功能预览与市场截图（主页横幅是手写的 assets/banner.svg，不由本脚本生成）。
 * 画面由当前 src/client.js 的真实组件渲染，数据为虚构；不登录、不联网、不是运行中的 DSH 截图。
 * 本脚本只生成静态 HTML 与截图清单（.local-preview/render/manifest.json），再用 Playwright 按清单截图（2x）。
 *   node scripts/render-readme-assets.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pill, settings, models, escape } from './preview-kit.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(root, '.local-preview', 'render')
mkdirSync(work, { recursive: true })
mkdirSync(join(root, 'assets', 'readme'), { recursive: true })
mkdirSync(join(root, 'assets', 'screenshots'), { recursive: true })

const themes = {
  light: { surface: '#ffffff', text: '#222936', bg: '#f3f5f9', color: 'light' },
  dark: { surface: '#20252e', text: '#e6e9ef', bg: '#121720', color: 'dark' },
}
const baseCss = (theme) => `*{box-sizing:border-box}html,body{margin:0}body{--dsh-surface:${theme.surface};--dsh-text:${theme.text};color:${theme.text};color-scheme:${theme.color};font-family:'Segoe UI','Microsoft YaHei','PingFang SC','Noto Sans CJK SC',system-ui,sans-serif}*::-webkit-scrollbar{display:none}input,select{padding:9px;border:1px solid #8885;border-radius:8px;background:transparent;color:inherit}.card{border:1px solid #8883;border-radius:18px;background:var(--dsh-surface)}`

const manifest = []
function shot(name, html, width, height, out) {
  const file = join(work, name + '.html')
  writeFileSync(file, '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' + html + '</html>')
  manifest.push({ html: file, width, height, out })
}

const popup = (theme, model = 'claude-sonnet-5-5') => `<div style="position:relative;display:inline-block">${pill(model, true)}</div>`
const modelRows = (theme) => models.map((m) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 4px;border-bottom:1px solid #8883"><span style="font-size:15px">${escape(m.name)}</span>${pill(m.id)}</div>`).join('')

// ---- 市场截图 / 功能预览共用的面板 ----
function popoverPage(themeName) {
  const t = themes[themeName]
  return `<style>${baseCss(t)}body{background:${t.bg};width:420px;height:620px;display:flex;align-items:flex-end;justify-content:flex-end;padding:20px}</style><body>${popup(t)}</body>`
}
function pillsPage(themeName) {
  const t = themes[themeName]
  return `<style>${baseCss(t)}body{background:${t.bg};width:420px;padding:16px 24px}</style><body><div style="font-size:13px;opacity:.7;padding:4px">模型选择器旁的额度药丸</div>${modelRows(t)}</body>`
}
function settingsPage(themeName) {
  const t = themes[themeName]
  return `<style>${baseCss(t)}body{background:${t.bg};width:680px;padding:15px}</style><body><div class="card">${settings}</div></body>`
}

// 1) 市场截图（可由 screenshots.json 引用）
shot('settings-dark', settingsPage('dark'), 680, 1560, join(root, 'assets/screenshots/settings-dark.png'))
shot('settings-light', settingsPage('light'), 680, 1560, join(root, 'assets/screenshots/settings-light.png'))
shot('popover-light', popoverPage('light'), 420, 620, join(root, 'assets/screenshots/quota-popover-light.png'))
shot('popover-dark', popoverPage('dark'), 420, 620, join(root, 'assets/screenshots/quota-popover-dark.png'))
shot('pills-dark', pillsPage('dark'), 420, 220, join(root, 'assets/screenshots/model-pills-dark.png'))

// 2) 功能预览：额度弹层 + 药丸 + 设置页片段（亮 / 暗各一张）
for (const themeName of ['light', 'dark']) {
  const t = themes[themeName]
  const html = `<style>${baseCss(t)}body{background:${t.bg};width:1200px;height:1000px;padding:28px;display:grid;grid-template-columns:400px 1fr;gap:28px;overflow:hidden}
.col{display:flex;flex-direction:column;gap:20px;min-width:0}.cap{font-size:13px;opacity:.65;margin:0 0 8px 4px}.clip{height:940px;overflow:hidden;position:relative}.clip:after{content:'';position:absolute;left:0;right:0;bottom:0;height:70px;background:linear-gradient(transparent,${t.bg})}</style>
<body><div class="col"><div><p class="cap">模型选择器旁：额度随当前模型切换</p><div class="card" style="padding:4px 14px">${modelRows(t)}</div></div>
<div style="height:720px;display:flex;align-items:flex-end;justify-content:flex-end;margin-top:auto">${popup(t)}</div></div>
<div><p class="cap">设置 → Antigravity ACP</p><div class="clip"><div class="card">${settings}</div></div></div></body>`
  shot('features-' + themeName, html, 1200, 1000, join(root, `assets/readme/features-${themeName}.png`))
}

writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log('已生成 ' + manifest.length + ' 个页面：.local-preview/render/manifest.json；用 Playwright 按清单以 deviceScaleFactor=2 截图')
