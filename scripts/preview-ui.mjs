/** 离线视觉夹具：从真实 client 组件生成模拟数据的静态 HTML；无登录/联网/宿主访问。 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const quota = { status: 'ok', updatedAt: '2026-10-22T03:00:00+08:00', plan: '示例套餐', groups: [
  { name: 'Gemini Models', buckets: [{ window: '5h', remainingPct: 86, resetTime: new Date(Date.now() + 2 * 3600_000).toISOString() }, { window: 'weekly', remainingPct: 72 }] },
  { name: 'Claude and GPT models', buckets: [{ window: '5h', remainingPct: 42 }, { window: 'weekly', remainingPct: 24 }] },
  { name: 'Gemini 4 Argon', buckets: [{ window: '5h', remainingPct: 8 }, { window: 'weekly', remainingPct: 31 }] },
], credits: { status: 'ok', remainingCredits: 1234, planName: '示例套餐', updatedAt: '2026-10-22T03:00:00+08:00' } }
let plugin
runInNewContext(source, { window: { __ModuleLoader__: { load(value) { plugin = value } } } })
let index = 0
let states = {}
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useState: (initial) => [index in states ? states[index++] : (index++, initial), () => {}],
  useRef: (value) => ({ current: value }), useCallback: (fn) => fn, useEffect() {},
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const components = new Map()
const ctx = {
  effect(fn) { fn(); return () => {} }, inject(_deps, fn) { fn(ctx) }, get() {},
  remote: { $mount() { return () => {} } },
  slots: { inject(_name, fn) { fn(); return () => {} }, register(row, component) { components.set(row.id, component); return () => {} } },
}
plugin.factory(() => React).apply(ctx)
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const booleanAttributes = new Set(['disabled', 'checked', 'selected', 'multiple', 'readOnly', 'required'])
const unitlessStyles = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order'])
function html(node) {
  if (node === undefined || node === null || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return escape(node)
  const { type, props, children } = node
  let attrs = ''
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || key === 'ref' || key === 'key' || key.startsWith('on')) continue
    if (key === 'style') {
      attrs += ' style="' + escape(Object.entries(value).map(([k, v]) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + ':' + (typeof v === 'number' && v !== 0 && !unitlessStyles.has(k) ? v + 'px' : v)).join(';')) + '"'
    } else if (booleanAttributes.has(key)) { if (value) attrs += ' ' + key.toLowerCase(); }
    else attrs += ' ' + key + '="' + escape(value) + '"'
  }
  const content = type === 'select' ? children.map((child) => child?.type === 'option' && child.props.value === props.value ? { ...child, props: { ...child.props, selected: true } } : child) : children
  return '<' + type + attrs + '>' + content.map(html).join('') + '</' + type + '>'
}
function render(id, values, props) { index = 0; states = values; return html(components.get(id)(props)) }
function pill(model, open = false) {
  return render('antigravity-quota', { 0: quota, 2: open, 4: { state: 'connected', runtime: { phase: 'ready', phaseElapsedMs: 1600, processRunning: true } } },
    { store: { subscribe() {}, getSnapshot: () => ({ current: { provider: 'antigravity-acp', model } }) }, control() {} })
}
const models = [{ id: 'gemini-3.8-flash', name: 'Gemini Flash', inputModalities: ['text', 'image'] }, { id: 'claude-sonnet-5-5', name: 'Claude Sonnet', inputModalities: ['text'] }, { id: 'gemini-4-argon', name: 'Gemini 4 Argon', inputModalities: ['text', 'image'] }]
const settings = render('antigravity-acp', {
  0: quota, 2: { state: 'connected', message: 'ACP 已预热，连接将保留供聊天复用（模拟）', runtime: {
    phase: 'ready', phaseElapsedMs: 800, processRunning: true, uptimeMs: 183400,
    starts: 1, reuses: 4, recycles: 0,
    queue: { active: 0, parked: 0, waiting: 0, workers: 1, capacity: 2 },
    startup: { elapsedMs: 7120, timings: { binary: 20, credentials: 2100, spawn: 10, initialize: 4990 } },
    round: { model: 'gemini-3.8-flash-low', elapsedMs: 4800, timings: { connection: 1, session: 1200, model: 10 }, firstChunkMs: 1800, firstToolMs: 2100, continuations: 2, lastContinuationMs: 1200 },
  } }, 3: models,
  6: { revision: 1 }, 7: true, 8: { autoWarmup: true, preferredModel: 'gemini-3.8-flash', proxyUrl: '', proxyBypass: '', agyCliPath: '' }, 10: false, 11: true,
}, { remote: {}, control() {} })
const previews = ['light', 'dark'].map((theme) => '<section class="theme ' + theme + '"><div class="pill-demo"><h2>' + theme + ' · 模型对应额度条</h2>' + models.map((model) => '<div class="model">' + escape(model.name) + pill(model.id) + '</div>').join('') + '<div class="popup">' + pill('claude-sonnet-5-5', true) + '</div></div><div class="settings">' + settings + '</div></section>').join('')
const page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Antigravity UI · 离线预览</title><style>body{margin:0;background:#e8eaef;font-family:system-ui,sans-serif}header{padding:18px;font-size:14px}.theme{padding:24px;display:grid;grid-template-columns:390px minmax(0,650px);gap:32px}.light{--dsh-surface:#fff;--dsh-text:#222936;background:#f6f7f9;color:#222936;color-scheme:light}.dark{--dsh-surface:#20252e;--dsh-text:#e6e9ef;background:#141820;color:#e6e9ef;color-scheme:dark}.model{padding:12px;display:flex;justify-content:space-between;border-bottom:1px solid #8883}.popup{height:760px;display:flex;align-items:flex-end;justify-content:flex-end;padding:20px}.settings{border:1px solid #8883;border-radius:18px;background:var(--dsh-surface)}input,select{padding:9px;border:1px solid #8885;border-radius:8px;background:transparent;color:inherit}h2{font-size:16px}@media(max-width:750px){.theme{grid-template-columns:minmax(0,1fr);padding:12px}.pill-demo{min-width:0}.popup{padding:8px}}</style><header>离线静态预览 · 全部数字为模拟数据 · 按钮不执行操作 · 不是当前 DSH 页面</header>' + previews + '</html>'
const out = new URL('../.local-preview/', import.meta.url)
mkdirSync(out, { recursive: true })
writeFileSync(new URL('quota-ui.html', out), page)
console.log('Generated .local-preview/quota-ui.html (mock data, no network)')
