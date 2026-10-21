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
 *
 * Inject contract (verified against the installed shell, 2026-10-16): each
 * `remote.<namespace>` face is its own injectable service. Reading it without a
 * matching entry in `inject` throws `cannot get property "remote.<ns>" without
 * inject` (Cordis ReflectService), which crashes this card inside the
 * `settings.section` slot and blanks the settings page. The shell's own client
 * plugins declare it the same way (`inject = ["remote", "remote.settings"]`).
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
      { key: 'preferredModel', label: '默认 / 自定义模型 ID', placeholder: '选择目录中的模型，或输入自定义 ID', hint: '保存后优先列出此模型；目录之外的 ID 标为自定义、未验证。不会替换当前会话已选模型。留空不指定默认项。' },
      { key: 'proxyUrl', label: '出网代理', placeholder: 'http://127.0.0.1:7890', hint: '此处配置优先；留空则继承宿主代理环境变量，宿主也未配置时才直连。' },
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
      const quota = useQuota(props.readQuota)
      const [account, setAccount] = React.useState(undefined)
      const [models, setModels] = React.useState([])
      const [modelBusy, setModelBusy] = React.useState(false)
      const [modelMessage, setModelMessage] = React.useState('')
      const [confirmLogin, setConfirmLogin] = React.useState(false)
      const alive = React.useRef(true)
      const modelVersion = React.useRef(0)
      const accountVersion = React.useRef(0)
      const pullModels = React.useCallback(async (force = false) => {
        if (!props.control) return
        const version = ++modelVersion.current
        setModelBusy(true)
        try {
          const value = unwrap(await props.control('models', force ? { force: true } : undefined))
          if (!alive.current || version !== modelVersion.current) return
          setModels(value.models ?? [])
          setModelMessage(value.status === 'error' ? value.message : (value.models?.length ? '目录已更新；不会自动替换当前会话的已选模型。' : '暂无模型目录，请点击一键拉取或连接 ACP。'))
        } catch (error) { if (alive.current && version === modelVersion.current) setModelMessage(error instanceof Error ? error.message : String(error)) }
        finally { if (alive.current && version === modelVersion.current) setModelBusy(false) }
      }, [props.control])
      const accountAction = React.useCallback(async (action = 'status') => {
        if (!props.control) return
        const version = ++accountVersion.current
        try {
          const value = unwrap(await props.control('account', { action }))
          if (alive.current && version === accountVersion.current) setAccount(value)
        } catch (error) { if (alive.current && version === accountVersion.current) setAccount({ state: 'error', message: error instanceof Error ? error.message : String(error) }) }
      }, [props.control])
      React.useEffect(() => {
        alive.current = true
        void accountAction('status')
        void pullModels(false)
        return () => { alive.current = false; ++modelVersion.current; ++accountVersion.current }
      }, [accountAction, pullModels])
      React.useEffect(() => {
        if (!['connecting', 'cancelling'].includes(account?.state)) return undefined
        const timer = setInterval(() => void accountAction('status'), 2000)
        return () => clearInterval(timer)
      }, [account?.state, accountAction])
      React.useEffect(() => { if (account?.state === 'connected') void pullModels(false) }, [account?.state, pullModels])
      const [view, setView] = React.useState(undefined)
      const [registered, setRegistered] = React.useState(undefined)
      const [draft, setDraft] = React.useState({})
      const [status, setStatus] = React.useState(null)
      const [loading, setLoading] = React.useState(true)

      const reload = React.useCallback(() => {
        // 同步段整体兜底：remote.<ns> 是代理属性，缺 inject 时连「读属性」都会抛；
        // 这里降级为卡片内可读错误，绝不让异常穿出组件击穿 settings.section。
        try {
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
        } catch (cause) {
          setLoading(false)
          setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
        }
      }, [remote])

      const save = React.useCallback(() => {
        if (!view) return
        setStatus({ kind: 'busy', text: '保存中…' })
        // 所有字段都写回（含空串），否则用户无法清掉已保存的 proxyUrl / preferredModel。
        // 宿主侧把空串视为未配置：normalizeProxyUrl 与 preferredModel?.trim() 都会
        // 把它折叠成「用默认值」。
        const ops = FIELDS.map((field) => ({ op: 'set', path: [field.key], value: draft[field.key] ?? '' }))
        let pending
        try {
          pending = Promise.resolve(remote.settings.mutate(ENTRY_ID, ops, view.revision))
        } catch (cause) {
          setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
          return
        }
        pending
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
            ? 'Provider 已注册，可在下方连接账户、拉取模型和查看额度。'
            : registered === false
              ? 'Provider 尚未注册，请检查插件是否已启用。'
              : '正在确认路由注册状态…',
        ),
        h('section', { style: CARD, 'aria-label': '账户连接' },
          h('h3', { style: { margin: '0 0 8px', fontSize: '14px' } }, '账户 · ACP 连接'),
          h('p', { role: 'status', style: { fontSize: '12px', margin: '0 0 10px' } }, account?.message ?? '尚未验证 ACP 连接'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
            h('button', { type: 'button', style: ACTION, disabled: !props.control || ['connecting', 'cancelling'].includes(account?.state), onClick: () => setConfirmLogin(true) }, '连接 / 登录 ACP'),
            ['connecting', 'cancelling'].includes(account?.state) ? h('button', { type: 'button', style: ACTION, disabled: account?.state === 'cancelling', onClick: () => accountAction('cancel') }, '取消连接') : null),
          confirmLogin ? h('div', { style: { ...CARD, marginTop: '10px' } },
            h('p', { style: { margin: '0 0 8px', fontSize: '12px' } }, '将复用本机官方登录态；必要时打开官方浏览器授权并更新 ACP 登录文件。不发送聊天消息，不切换 CLI 账户。'),
            h('button', { type: 'button', style: ACTION, onClick: () => { setConfirmLogin(false); void accountAction('login') } }, '确认连接'),
            h('button', { type: 'button', style: ACTION, onClick: () => setConfirmLogin(false) }, '返回')) : null,
          h('p', { style: { opacity: .6, fontSize: '11px', margin: '10px 0 0' } }, 'ACP 登录与 CLI 额度登录态分开。额度和一键拉取需在官方 agy 中完成 CLI 登录；这里不展示令牌、不管理多账户。')),
        h('section', { style: CARD, 'aria-label': '模型管理' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('h3', { style: { fontSize: '14px', margin: 0, flex: 1 } }, '模型管理'),
            h('button', { type: 'button', style: ACTION, disabled: modelBusy || !props.control, onClick: () => pullModels(true) }, modelBusy ? '拉取中…' : '一键拉取模型')),
          h('p', { role: 'status', style: { fontSize: '12px', opacity: .7 } }, modelMessage || '从官方 CLI 拉取目录，或通过 ACP 连接获取会话声明。'),
          h('label', { style: { display: 'grid', gap: '6px' } }, '从目录选择默认模型',
            h('select', { 'aria-label': '从目录选择默认模型', value: models.some((m) => m.id === draft.preferredModel) ? draft.preferredModel : '', onChange: (event) => { if (event.target.value) setDraft((previous) => ({ ...previous, preferredModel: event.target.value })) }, style: { ...ACTION, width: '100%' } },
              h('option', { value: '' }, models.length ? '选择一个模型，或在下方手填 ID' : '暂无目录，可手填模型 ID'),
              ...models.map((model) => h('option', { key: model.id, value: model.id }, model.name + ' · ' + model.id)))),
          h('small', { style: { display: 'block', marginTop: '8px', opacity: .6 } }, models.length + ' 个模型 · 选择后点击保存。思考强度仍由会话菜单设置。')),
        ...FIELDS.map((field) => h(
          'label',
          { key: field.key, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('span', null, field.label),
          h('input', {
            type: 'text',
            value: draft[field.key] ?? '',
            placeholder: field.placeholder,
            style: { ...ACTION, cursor: 'text', width: '100%', boxSizing: 'border-box' },
            onChange: (event) => setDraft((previous) => ({ ...previous, [field.key]: event.target.value })),
          }),
          h('small', { style: { opacity: 0.7 } }, field.hint),
        )),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('button', { type: 'button', onClick: save, disabled: loading || !view, style: ACTION }, '保存'),
          h('button', { type: 'button', onClick: reload, style: ACTION }, loading ? '刷新中…' : '刷新配置'),
        ),
        status ? h('p', { style: { margin: 0, color: status.kind === 'error' ? '#e5534b' : undefined } }, status.text) : null,
        h('section', { style: { marginTop: '8px' }, 'aria-label': '套餐额度管理' }, QuotaDetails({ ...quota, model: draft.preferredModel })),

      )
    }

    /**
     * 额度药丸：只在当前会话模型属于 antigravity-acp 时出现，位置是
     * `conversation.input.right`（宿主 InputBar 里它渲染在模型选择器之前，
     * 即「Provider 选择器左边」）。取数经 Host 的 remote.agyQuota.read。
     */
    const PILL_ID = 'antigravity-quota'

    const TRACK = 'rgba(128,128,128,.18)'
    const CARD = { padding: '12px', borderRadius: '12px', border: '1px solid rgba(128,128,128,.18)', background: 'rgba(128,128,128,.05)' }
    const ACTION = { padding: '6px 12px', borderRadius: '8px', border: '1px solid rgba(128,128,128,.25)', background: 'rgba(128,128,128,.08)', color: 'inherit', font: 'inherit', cursor: 'pointer' }
    const GROUPS = [{ key: 'gemini', name: 'Gemini' }, { key: 'claude', name: 'Claude / GPT' }, { key: 'argon', name: 'Gemini 4 Argon' }]
    function groupKey(name) {
      const text = String(name ?? '').toLowerCase()
      if (/\bargon\b/.test(text)) return 'argon'
      if (/\bgemini\b/.test(text)) return 'gemini'
      if (/\b(claude|gpt)\b/.test(text)) return 'claude'
      return undefined
    }
    function modelGroup(model) {
      const id = String(model ?? '').toLowerCase()
      if (/^gemini-/.test(id) && /(?:^|-)argon(?:-|$)/.test(id)) return 'argon'
      if (/^gemini-/.test(id)) return 'gemini'
      if (/^(claude|gpt)-/.test(id)) return 'claude'
      return undefined
    }
    function quotaGroups(data) {
      const groups = Array.isArray(data?.groups) ? data.groups : []
      return GROUPS.map((entry) => ({ ...entry, buckets: groups.filter((g) => groupKey(g.name) === entry.key).flatMap((g) => g.buckets ?? []) }))
        .concat(groups.filter((g) => !groupKey(g.name)).map((g, i) => ({ ...g, key: 'other-' + i })))
    }
    function percentage(bucket) {
      return Number.isFinite(bucket?.remainingPct) ? Math.max(0, Math.min(100, bucket.remainingPct)) : undefined
    }
    function tone(bucket, stale) {
      const value = percentage(bucket)
      if (bucket?.disabled || value === undefined) return '#8b909a'
      if (value <= 10) return '#ef4444'
      if (value <= 25 || stale) return '#d99b28'
      return '#25b879'
    }
    function windowName(bucket) {
      return ({ '5h': '5 小时', weekly: '每周', '7d': '每周' })[bucket.window] ?? bucket.window ?? bucket.name ?? '额度窗口'
    }
    function resetCountdown(value) {
      const seconds = Math.ceil((Date.parse(value) - Date.now()) / 1000)
      if (!Number.isFinite(seconds)) return '未提供重置时间'
      if (seconds <= 0) return '重置时间已到，待刷新'
      const minutes = Math.ceil(seconds / 60)
      if (minutes >= 1440) return Math.floor(minutes / 1440) + '天 ' + Math.floor(minutes % 1440 / 60) + '小时后重置'
      if (minutes >= 60) return Math.floor(minutes / 60) + '小时 ' + minutes % 60 + '分钟后重置'
      return minutes + '分钟后重置'
    }
    function remainingBar(bucket, compact, stale, label) {
      const pct = percentage(bucket)
      const unknown = pct === undefined || bucket.disabled
      return h('span', {
        role: 'progressbar', 'aria-label': label,
        'aria-valuemin': 0, 'aria-valuemax': 100,
        ...(unknown ? { 'aria-valuetext': bucket.disabled ? '已停用' : '额度未知' } : { 'aria-valuenow': pct }),
        style: { display: 'block', width: compact ? '30px' : '100%', height: compact ? '4px' : '6px', borderRadius: '99px', overflow: 'hidden', background: TRACK },
      }, h('span', { style: { display: 'block', height: '100%', width: unknown ? '100%' : pct + '%', opacity: unknown ? .35 : 1, borderRadius: '99px', background: tone(bucket, stale) } }))
    }
    function useQuota(readQuota, enabled = true) {
      const [data, setData] = React.useState(null)
      const [refreshing, setRefreshing] = React.useState(false)
      const version = React.useRef(0)
      const load = React.useCallback((force = false) => {
        if (!enabled || !readQuota) return Promise.resolve()
        const current = ++version.current
        setRefreshing(true)
        return Promise.resolve().then(() => readQuota(force)).then(unwrap).then((value) => {
          if (current === version.current) setData(value)
        }).catch((error) => {
          if (current === version.current) setData({ status: 'error', groups: [], error: { message: error instanceof Error ? error.message : String(error) } })
        }).finally(() => { if (current === version.current) setRefreshing(false) })
      }, [readQuota, enabled])
      React.useEffect(() => {
        if (!enabled || !readQuota) { setData(null); return undefined }
        void load(false)
        const off = readQuota.subscribe?.((value) => setData(value))
        const timer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void load(false) }, 300_000)
        return () => { ++version.current; clearInterval(timer); off?.() }
      }, [load, enabled, readQuota])
      return { data, refreshing, load }
    }
    function CreditsDetails({ credits, pending }) {
      const valid = credits?.status === 'ok' && Number.isSafeInteger(credits.remainingCredits) && credits.remainingCredits >= 0
      const label = valid ? credits.remainingCredits.toLocaleString() : pending ? '正在读取…' : credits?.status === 'error' ? '查询失败' : '未提供'
      return h('section', { style: CARD, 'aria-label': 'AI Credits 余额' },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' } },
          h('strong', null, 'AI Credits 余额'),
          h('strong', { style: { fontSize: valid ? '20px' : '13px', fontVariantNumeric: 'tabular-nums', color: credits?.stale ? '#d99b28' : 'inherit' } }, label)),
        credits?.planName ? h('div', { style: { fontSize: '11px', opacity: .7, marginTop: '6px' } }, '套餐：' + credits.planName) : null,
        credits?.stale ? h('p', { role: 'status', style: { margin: '6px 0 0', fontSize: '11px', color: '#d99b28' } }, '余额缓存 · ' + (credits.staleReason ?? '余额刷新失败')) : null,
        credits?.error?.message ? h('p', { role: credits.status === 'error' ? 'alert' : 'status', style: { margin: '6px 0 0', fontSize: '11px', overflowWrap: 'anywhere' } }, credits.error.message) : null,
        credits?.updatedAt ? h('div', { style: { marginTop: '6px', fontSize: '10px', opacity: .55 } }, (valid ? '余额更新于 ' : '最近查询 ') + new Date(credits.updatedAt).toLocaleString()) : null,
        h('p', { style: { margin: '6px 0 0', opacity: .55, fontSize: '11px' } }, '由官方 /credits 查询，与套餐额度独立；不会开启 AI Credits 付费。'))
    }
    function QuotaDetails({ data, refreshing, load, model }) {
      return h('div', { style: { display: 'grid', gap: '12px' } },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('strong', { style: { fontSize: '14px', flex: 1 } }, 'Antigravity · 套餐额度'),
          data?.plan ? h('span', { style: { fontSize: '11px', padding: '2px 8px', background: TRACK, borderRadius: '99px' } }, data.plan) : null),
        data?.stale ? h('p', { role: 'status', style: { ...CARD, margin: 0, color: '#d99b28', fontSize: '12px' } }, '缓存数据 · ' + (data.staleReason ?? '刷新失败')) : null,
        data?.status === 'error' ? h('p', { role: 'alert', style: { margin: 0, color: '#ef4444', overflowWrap: 'anywhere' } }, data.error?.message ?? data.error?.text ?? '额度读取失败') : null,
        ...quotaGroups(data).map((group) => h('section', { key: group.key, style: CARD, 'aria-label': group.name + '额度' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } },
            h('strong', { style: { fontSize: '13px' } }, group.name),
            group.key === modelGroup(model) ? h('span', { style: { fontSize: '10px', padding: '2px 6px', borderRadius: '6px', color: '#25b879', background: 'rgba(37,184,121,.12)' } }, '当前模型') : null),
          group.buckets.length ? h('div', { style: { display: 'grid', gap: '12px' } }, ...group.buckets.map((bucket, index) => {
            const pct = percentage(bucket)
            return h('div', { key: index },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '6px' } },
                h('span', { style: { fontSize: '12px', opacity: .75 } }, windowName(bucket)),
                h('strong', { style: { fontSize: '16px', fontVariantNumeric: 'tabular-nums' } }, bucket.disabled ? '已停用' : pct === undefined ? '未知' : Math.round(pct) + '%', h('small', { style: { fontSize: '10px', fontWeight: 400, opacity: .6, marginLeft: '4px' } }, '剩余'))),
              remainingBar(bucket, false, data?.stale, group.name + ' ' + windowName(bucket) + '剩余额度'),
              h('div', { title: bucket.resetTime, style: { fontSize: '10px', opacity: .6, marginTop: '5px' } }, bucket.disabled ? bucket.description ?? '此窗口不可用' : resetCountdown(bucket.resetTime)))
          })) : h('span', { style: { opacity: .55, fontSize: '12px' } }, data ? '未提供额度数据' : '正在读取…'))),
        CreditsDetails({ credits: data?.credits, pending: !data }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('small', { style: { flex: 1, opacity: .55, minWidth: 0 } }, data?.updatedAt ? '更新于 ' + new Date(data.updatedAt).toLocaleString() : '尚无成功快照'),
          h('button', { type: 'button', disabled: refreshing || !load, onClick: () => load(true), style: ACTION }, refreshing ? '刷新中…' : '刷新额度')))
    }
    function AgYQuotaPill({ store, readQuota }) {
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const enabled = state?.current?.provider === PROVIDER
      const model = state?.current?.model
      const quota = useQuota(readQuota, enabled)
      const [expanded, setExpanded] = React.useState(false)
      const [position, setPosition] = React.useState(null)
      const root = React.useRef(null)
      const button = React.useRef(null)
      React.useEffect(() => { setExpanded(false) }, [enabled])
      React.useEffect(() => {
        if (!expanded) { setPosition(null); return undefined }
        const reposition = () => {
          if (!button.current?.getBoundingClientRect) return
          const rect = button.current.getBoundingClientRect()
          const viewport = document.documentElement.clientWidth
          const height = window.innerHeight
          const width = Math.min(340, viewport - 24)
          const above = rect.top - 20
          const below = height - rect.bottom - 20
          setPosition({ position: 'fixed', right: 'auto', width,
            left: Math.max(12, Math.min(rect.right - width, viewport - width - 12)),
            ...(above >= Math.min(480, below)
              ? { bottom: height - rect.top + 8, maxHeight: Math.max(32, above) }
              : { bottom: 'auto', top: rect.bottom + 8, maxHeight: Math.max(32, below) }),
          })
        }
        reposition()
        window.addEventListener('resize', reposition)
        window.addEventListener('scroll', reposition, true)
        const outside = (event) => { if (!root.current?.contains(event.target)) setExpanded(false) }
        const key = (event) => { if (event.key === 'Escape') { setExpanded(false); button.current?.focus() } }
        document.addEventListener('pointerdown', outside)
        document.addEventListener('keydown', key)
        return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true) }
      }, [expanded])
      if (!enabled) return null
      const group = quotaGroups(quota.data).find((g) => g.key === modelGroup(model))
      const buckets = group?.buckets ?? []
      const label = quota.data?.status === 'error' ? '额度读取失败' : !quota.data ? '正在读取额度' : !group ? '额度未匹配，请选择具体模型' : !buckets.length ? '额度未知' : buckets.map((b) => windowName(b) + ' ' + (b.disabled ? '已停用' : percentage(b) === undefined ? '额度未知' : Math.round(percentage(b)) + '% 剩余')).join(' · ')
      const title = String(model ?? '未选择模型') + ' · ' + label + (quota.data?.stale ? ' · 缓存数据' : '')
      return h('span', { ref: root, style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h('button', { ref: button, type: 'button', title, 'aria-label': title, 'aria-expanded': expanded, 'aria-haspopup': 'dialog', onClick: () => setExpanded((value) => !value),
          style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '6px 10px', minHeight: '26px', borderRadius: '99px', border: '1px solid rgba(128,128,128,.28)', background: 'transparent', color: 'inherit', cursor: 'pointer' } },
          buckets.length ? h('span', { style: { display: 'grid', gap: '3px' } }, ...buckets.map((b, i) => h('span', { key: i }, remainingBar(b, true, quota.data?.stale, group.name + ' ' + windowName(b) + '剩余额度')))) : h('span', { 'aria-hidden': true }, quota.data?.status === 'error' ? '!' : quota.data ? '?' : '…')),
        expanded ? h('div', { role: 'dialog', 'aria-label': 'Antigravity 额度详情', style: { position: 'absolute', bottom: 'calc(100% + 8px)', right: 0, zIndex: 50, width: 'min(340px, calc(100vw - 48px))', maxHeight: 'min(75vh, calc(100vh - 72px))', overflowY: 'auto', boxSizing: 'border-box', overflowWrap: 'anywhere', padding: '16px', borderRadius: '16px', background: 'var(--dsh-surface, Canvas)', color: 'var(--dsh-text, CanvasText)', border: '1px solid rgba(128,128,128,.25)', boxShadow: '0 14px 40px rgba(0,0,0,.22)', fontSize: '12px', ...position } },
          QuotaDetails({ ...quota, model })) : null)
    }

    /** 给 promise 加超时：Host 侧异常时界面也要落到可读错误，而不是永远 pending。 */
    function withTimeout(promise, ms, message) {
      let timer
      return Promise.race([
        Promise.resolve(promise),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms)
        }),
      ]).finally(() => clearTimeout(timer))
    }

    /** 组装额度读取器：remote.agyQuota 由 Host 注册后才出现，短轮询等待就绪。 */
    function makeQuotaReader(scope) {
      const listeners = new Set()
      const read = async (force) => {
        const deadline = Date.now() + 20_000
        for (;;) {
          // **只能用 `get()`**：`scope.remote.agyQuota` 这种属性访问在未 inject 的
          // 命名空间上会由 cordis 直接抛「cannot get property "remote.<ns>" without
          // inject」，而这正是本药丸的处境（贡献型 remote 由 $mount 挂载、不进 inject）。
          // 参考实现 dsh-subusage 同样是 `ctx.get("remote.subUsage")`。
          const service = scope.get('remote.agyQuota')
          if (service && typeof service.read === 'function') {
            // Host 侧会起官方 agy CLI 取数（其启动含登录刷新）。万一它挂在网络上，
            // 也要让药丸显示「读取失败 + 原因」，而不是一直停在「额度…」。
            return await withTimeout(
              service.read(force ? { force: true } : undefined),
              60_000,
              '额度读取超时（Host 侧 agy CLI 60 秒内没有返回）',
            )
          }
          if (Date.now() >= deadline) {
            throw new Error('额度服务未就绪（Host 端 remote.agyQuota 未挂载）')
          }
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
      const reader = async (force) => {
        const value = unwrap(await read(force))
        for (const listener of listeners) listener(value)
        return value
      }
      reader.subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener) }
      return reader
    }

    function makeControlReader(scope) {
      return async (method, request) => {
        if (!['account', 'models'].includes(method)) throw new Error('不支持的设置操作')
        const deadline = Date.now() + 20_000
        for (;;) {
          const service = scope.get('remote.agyQuota')
          if (typeof service?.[method] === 'function') return await withTimeout(service[method](request), 60_000, '设置操作超时，请重试')
          if (Date.now() >= deadline) throw new Error('设置控制服务未就绪，请确认 Host 与 Client 版本一致')
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
    }

    /**
     * 客户端侧的额度 remote 声明。
     *
     * **贡献型 remote 必须在客户端显式挂载一次**（`ctx.remote.$mount(...)`），
     * `remote.agyQuota` 才会成为客户端可查的服务——同宿主上正常工作的
     * `dsh-subusage` 就是这么写的（`ctx.remote.$mount(subUsageRemote)` 之后再
     * `ctx.get("remote.subUsage")`）。只做 Host 侧注册而不挂载，客户端永远查不到服务。
     *
     * 声明必须与 Host 侧 `AGY_QUOTA_INVOCATIONS` 逐字段一致：id / service / namespace /
     * method / 参数与结果的 codec（客户端要按同一 codec 编解码）。
     */
    const AGY_QUOTA_PACKAGE = 'dsh-bundle-antigravity-host'
    const AGY_QUOTA_SERVICE = 'agyQuota'

    function strictCodec(typeSymbol, parse) {
      const schema = { parse }
      return { mode: 'strict', typeSymbol, create: () => schema }
    }

    function parseQuotaRequest(value) {
      if (value === undefined || value === null) return undefined
      if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid AgYQuotaRequest')
      if (value.force !== undefined && typeof value.force !== 'boolean') throw new TypeError('Invalid AgYQuotaRequest.force')
      return value
    }

    function parseQuotaResult(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid AgYQuotaResult')
      if (value.status !== 'ok' && value.status !== 'error') throw new TypeError('Invalid AgYQuotaResult.status')
      if (!Array.isArray(value.groups)) throw new TypeError('Invalid AgYQuotaResult.groups')
      return value
    }

    const AGY_QUOTA_REMOTE = {
      package: AGY_QUOTA_PACKAGE,
      descriptors: [
        {
          id: `${AGY_QUOTA_PACKAGE}#${AGY_QUOTA_SERVICE}/read`,
          service: AGY_QUOTA_SERVICE,
          namespace: AGY_QUOTA_SERVICE,
          method: 'read',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'request',
              wire: 'request',
              source: 'json',
              acceptsUndefined: true,
              codec: strictCodec(`${AGY_QUOTA_PACKAGE}#AgYQuotaRequest`, parseQuotaRequest),
            },
          ],
          result: strictCodec(`${AGY_QUOTA_PACKAGE}#AgYQuotaResult`, parseQuotaResult),
        },
        ...['account', 'models'].map((method) => ({
          id: `${AGY_QUOTA_PACKAGE}#${AGY_QUOTA_SERVICE}/${method}`, service: AGY_QUOTA_SERVICE, namespace: AGY_QUOTA_SERVICE, method,
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true,
            codec: method === 'models' ? strictCodec(`${AGY_QUOTA_PACKAGE}#AgYQuotaRequest`, parseQuotaRequest)
              : strictCodec(`${AGY_QUOTA_PACKAGE}#AgYAccountRequest`, (value) => {
                if (value === undefined) return { action: 'status' }
                if (!value || typeof value !== 'object' || !['status', 'login', 'cancel'].includes(value.action)) throw new TypeError('Invalid AgYAccountRequest')
                return value
              }) }],
          result: strictCodec(`${AGY_QUOTA_PACKAGE}#${method === 'models' ? 'AgYModelsResult' : 'AgYAccountResult'}`, (value) => {
            if (!value || typeof value !== 'object') throw new TypeError('Invalid settings result')
            if (method === 'models' ? !Array.isArray(value.models) || !['ok', 'error'].includes(value.status)
              : !['idle', 'connecting', 'cancelling', 'connected', 'cancelled', 'error'].includes(value.state) || typeof value.message !== 'string') throw new TypeError('Invalid settings result')
            return value
          }),
        })),
      ],
    }

    return {
      name: 'dsh-bundle-antigravity-host',
      // remote.settings / remote.llm 必须逐个声明：remote 各命名空间是独立服务，
      // 漏声明会在读取属性时抛「without inject」并击穿 settings.section 卡片。
      inject: ['slots', 'remote', 'remote.settings', 'remote.llm'],
      apply(ctx) {
        const readQuota = makeQuotaReader(ctx)
        const control = makeControlReader(ctx)
        // 挂载本包贡献的 remote（幂等，随 fiber 一起 dispose）。挂载失败不影响其它卡片：
        // 药丸会自行超时并显示「额度服务未就绪」的原因。
        try {
          const mounted = ctx.remote.$mount(AGY_QUOTA_REMOTE)
          ctx.effect(() => mounted, 'antigravity-acp: mount quota remote')
        } catch (error) {
          console.error('[dsh-bundle-antigravity-host] 额度 remote 客户端挂载失败:', error)
        }
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'antigravity-acp',
                  order: 42,
                  label: () => 'Antigravity ACP',
                  inject: () => ({ remote: ctx.remote, readQuota, control }),
                },
                AntigravitySettingsCard,
              ),
            ),
          'antigravity-acp: settings section',
        )
        // 额度药丸：紧邻模型选择器左侧（宿主把 conversation.input.right 渲染在
        // conversation.input.model 之前）。modelDirectories 是会话模型目录服务。
        //
        // 注意：这里**不能**把 `remote.agyQuota` 写进 inject。贡献型 remote 的客户端
        // 服务要等 `ctx.remote.$mount(...)`（见 apply 里那段）完成后才存在，写进 inject
        // 会让整个注册回调一直等待 —— 表现为**药丸彻底消失**（2026-10-17 实测踩过）。
        // 正确做法是照常注册 slot，由读取器短轮询等服务出现。
        ctx.inject(['slots', 'modelDirectories'], (scope) => {
          // 读取器按 scope 建一次：药丸的取数 effect 依赖 readQuota 的身份，若每次
          // inject 都新建函数，身份变化会让 effect 反复重跑、重复触发 Host 侧 CLI 取数。
          scope.effect(
            () =>
              scope.slots.inject('conversation.input.right', () =>
                scope.slots.register(
                  {
                    name: 'conversation.input.right',
                    id: PILL_ID,
                    order: 1002,
                    inject: (sessionId) => ({
                      store: scope.modelDirectories.directoryFor(sessionId).store,
                      readQuota,
                    }),
                  },
                  AgYQuotaPill,
                ),
              ),
            'antigravity-acp: quota pill',
          )
        })
      },
    }
  },
})
