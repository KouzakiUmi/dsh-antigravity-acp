/**
 * Browser settings section for the Antigravity ACP bundle.
 * Loaded by DSH ModuleLoader; React is provided by the shell (do not bundle Node).
 *
 * Transport notes (verified against the installed shell contract, not guessed):
 * - `remote.settings.describe()` returns `{ writable, namespaces: [{ ns, value, revision }] }`.
 * - `remote.settings.mutate(entryId, ops, revision)` writes; ops are `{ op: 'set', path, value }`.
 * - `remote.llm.listProviders()` exists. There is **no** `remote.llm.listModels` in the
 *   shell, so the model catalogue cannot be fetched from here; it is surfaced through
 *   the host adapter (see src/adapter/antigravity-adapter.ts) and the plugin's own
 *   settings form instead.
 */
window.__ModuleLoader__.load({
  id: 'dsh-bundle-antigravity-host',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const PROVIDER = 'antigravity-acp'
    /** Settings namespace injected by `settings.configure({ auto: true })` in src/index.ts. */
    const ENTRY_ID = 'llm-antigravity-acp'
    /** Editable fields surfaced in this card; everything else stays in the host form. */
    const FIELDS = [
      { key: 'preferredModel', label: '首选模型 id', placeholder: 'gemini-3.8-flash-high', hint: '选择器里的 Antigravity 默认项会映射到它；留空则用官方会话默认模型。' },
      { key: 'proxyUrl', label: '出网代理', placeholder: 'http://127.0.0.1:7890', hint: '官方进程自己连 Google，所以代理只能配在这里；留空则直连。' },
      { key: 'proxyBypass', label: '代理排除列表', placeholder: '10.0.0.0/8,*.internal', hint: 'localhost/127.0.0.1/::1 始终自动排除（私有 MCP 桥在 loopback）。' },
    ]

    function unwrap(result) {
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok) return result.value
        throw new Error(result.error?.message || '未知错误')
      }
      return result
    }

    function AntigravitySettingsCard(props) {
      const remote = props.remote
      const [view, setView] = React.useState(undefined)
      const [registered, setRegistered] = React.useState(undefined)
      const [draft, setDraft] = React.useState({})
      const [status, setStatus] = React.useState(null)
      const [loading, setLoading] = React.useState(true)

      const reload = React.useCallback(() => {
        if (!remote?.settings?.describe) {
          setStatus({ kind: 'error', text: '宿主未提供 settings.describe，无法在此编辑配置' })
          setLoading(false)
          return
        }
        setLoading(true)
        const described = Promise.resolve(remote.settings.describe()).then(unwrap)
        const providers = Promise.resolve(remote.llm?.listProviders?.())
          .then((value) => unwrap(value))
          .catch(() => [])
          .then((rows) => (Array.isArray(rows) ? rows : []))
        Promise.all([described, providers])
          .then(([settings, rows]) => {
            const namespaces = Array.isArray(settings?.namespaces) ? settings.namespaces : []
            // 只按精确 namespace 匹配：按字段回退会命中别人的配置，而保存用的
            // revision 也必须来自同一份文档（同 profile 的 dsh-proxy 即如此）。
            const found = namespaces.find((item) => item?.ns === ENTRY_ID)
            setView(found ?? null)
            const current = found?.value && typeof found.value === 'object' ? found.value : {}
            setDraft(Object.fromEntries(FIELDS.map((field) => [field.key, current[field.key] ?? ''])))
            setRegistered(rows.some((row) => row?.id === PROVIDER))
            setStatus(null)
          })
          .catch((cause) => {
            setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
          })
          .finally(() => setLoading(false))
      }, [remote])

      const save = React.useCallback(() => {
        if (!view) return
        setStatus({ kind: 'busy', text: '保存中…' })
        // 所有字段都写回（含空串），否则用户无法清掉已保存的 proxyUrl / preferredModel。
        // 宿主侧把空串视为未配置：normalizeProxyUrl 与 preferredModel?.trim() 都会
        // 把它折叠成「用默认值」。
        const ops = FIELDS.map((field) => ({ op: 'set', path: [field.key], value: draft[field.key] ?? '' }))
        Promise.resolve(remote.settings.mutate(ENTRY_ID, ops, view.revision))
          .then((result) => {
            unwrap(result)
            setStatus({
              kind: 'ok',
              text: '已保存。代理类改动需要完全退出并重开 Desktop 才会生效（环境变量在官方进程启动时读取）。',
            })
            reload()
          })
          .catch((cause) => {
            setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
          })
      }, [draft, remote, reload, view])

      React.useEffect(() => {
        reload()
        const off = remote?.$on?.('settings/document-updated', (ns) => {
          if (!ns || ns === ENTRY_ID) reload()
        })
        return () => {
          if (typeof off === 'function') off()
        }
      }, [reload, remote])

      return h(
        'div',
        { style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '40rem' } },
        h('h2', { style: { margin: 0, fontSize: '1.1rem' } }, 'Antigravity ACP'),
        h('p', { style: { margin: 0, opacity: 0.8 } }, 'Provider 路由：', h('code', null, PROVIDER)),
        h(
          'p',
          { style: { margin: 0, opacity: 0.8 } },
          registered === true
            ? '路由已注册，可在模型选择器里选 Antigravity。首次对话会启动官方进程并可能打开 Google 登录。'
            : registered === false
              ? '未在已注册 provider 中找到本路由，请完全退出并重开 Desktop 后再刷新。'
              : '正在确认路由注册状态…',
        ),
        ...FIELDS.map((field) => h(
          'label',
          { key: field.key, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('span', null, field.label),
          h('input', {
            type: 'text',
            value: draft[field.key] ?? '',
            placeholder: field.placeholder,
            onChange: (event) => setDraft((previous) => ({ ...previous, [field.key]: event.target.value })),
          }),
          h('small', { style: { opacity: 0.7 } }, field.hint),
        )),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('button', { type: 'button', onClick: save, disabled: loading || !view }, '保存'),
          h('button', { type: 'button', onClick: reload }, loading ? '刷新中…' : '刷新'),
        ),
        status ? h('p', { style: { margin: 0, color: status.kind === 'error' ? '#e5534b' : undefined } }, status.text) : null,
        h(
          'p',
          { style: { margin: 0, opacity: 0.7 } },
          '模型目录由官方会话声明，无法在未登录时读取：首次发一条消息完成登录后，选择器会显示官方真实的模型列表。',
        ),
      )
    }

    return {
      name: 'dsh-bundle-antigravity-host',
      inject: ['slots', 'remote'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'antigravity-acp',
                  order: 42,
                  label: () => 'Antigravity ACP',
                  inject: () => ({ remote: ctx.remote }),
                },
                AntigravitySettingsCard,
              ),
            ),
          'antigravity-acp: settings section',
        )
      },
    }
  },
})
