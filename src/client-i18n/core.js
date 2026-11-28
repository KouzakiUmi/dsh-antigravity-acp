/**
 * 客户端 i18n 内核（由 scripts/client-bundle.mjs 内联进 client.js 的 factory 作用域）。
 *
 * 约定：源语言是简体中文，`t('中文原文', { 占位符 })` 的原文即键。
 * - zh 直接返回原文；en 查 EN_MESSAGES，缺失时回落原文（宁可显示中文也不显示空白）。
 * - 模块级常量不能在加载期翻译，用 `msg()` 标记（恒等函数，供覆盖测试提取），渲染处再 `t()`。
 * - Host 回传的状态文本也走 `t()`：命中字典则翻译，未命中原样透传。
 */
const EN_MESSAGES = { ...EN_UI, ...EN_HOST }
let dshLocale
function subscribeLocale(listener) { return dshLocale?.subscribe(listener) ?? (() => {}) }
function resolveLocale() {
  const tag = dshLocale?.getSnapshot().active
    || (typeof document !== 'undefined' && document.documentElement?.lang)
    || (typeof navigator !== 'undefined' && (navigator.languages?.[0] || navigator.language))
    || ''
  return !tag || /^zh(?:-|$)/i.test(tag) ? 'zh' : 'en'
}
function msg(source) { return source }
function t(source, params) {
  if (typeof source !== 'string') return source
  const template = resolveLocale() === 'en' ? EN_MESSAGES[source] ?? source : source
  return params ? template.replace(/\{(\w+)\}/g, (whole, key) => (key in params ? String(params[key]) : whole)) : template
}
