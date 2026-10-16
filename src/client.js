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

    /**
     * 额度药丸：只在当前会话模型属于 antigravity-acp 时出现，位置是
     * `conversation.input.right`（宿主 InputBar 里它渲染在模型选择器之前，
     * 即「Provider 选择器左边」）。取数经 Host 的 remote.agyQuota.read。
     */
    const PILL_ID = 'antigravity-quota'

    /** 选最紧的额度窗：Gemini 组优先取 5h 窗，否则取剩余最少的窗。 */
    function pickTightestBucket(groups) {
      const buckets = []
      for (const group of groups ?? []) {
        for (const bucket of group?.buckets ?? []) {
          if (!bucket || bucket.disabled) continue
          buckets.push({ ...bucket, group: group?.name ?? '' })
        }
      }
      if (buckets.length === 0) return null
      const gemini = buckets.filter((bucket) => /gemini/i.test(bucket.group))
      const pool = gemini.length > 0 ? gemini : buckets
      const fiveHour = pool.find((bucket) => String(bucket.window ?? '').toLowerCase() === '5h')
      if (fiveHour) return fiveHour
      const scored = pool.filter((bucket) => typeof bucket.remainingPct === 'number')
      if (scored.length > 0) return scored.reduce((a, b) => (a.remainingPct <= b.remainingPct ? a : b))
      return pool[0]
    }

    /** 重置倒计时（如 `3h12m` / `7m`）；无重置时间返回空串。 */
    function resetCountdown(resetTime) {
      if (!resetTime) return ''
      const at = Date.parse(resetTime)
      if (Number.isNaN(at)) return ''
      const seconds = Math.floor((at - Date.now()) / 1000)
      if (seconds <= 0) return ''
      const minutes = Math.floor(seconds / 60)
      if (minutes >= 24 * 60) return `${Math.floor(minutes / 1440)}d${Math.floor((minutes % 1440) / 60)}h`
      if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`
      return `${minutes}m`
    }

    function AgYQuotaPill({ store, readQuota }) {
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const provider = state?.current?.provider
      const [data, setData] = React.useState(null)
      const [expanded, setExpanded] = React.useState(false)

      const load = React.useCallback((force) => {
        Promise.resolve(readQuota(force))
          // Typert remote 的回包是 `{ ok, value }` 信封（设置卡片、以及同宿主上
          // 正常工作的 dsh-subusage 都先拆再读）。不拆的话 `data.status` 恒为
          // undefined：药丸永远停在「额度…」，面板正文渲染成空。
          .then((result) => setData(unwrap(result)))
          .catch((cause) => setData({
            status: 'error',
            updatedAt: new Date().toISOString(),
            groups: [],
            error: { code: 'request-failed', text: cause instanceof Error ? cause.message : String(cause) },
          }))
      }, [readQuota])

      React.useEffect(() => {
        if (provider !== PROVIDER) return undefined
        load(false)
        const timer = setInterval(() => load(false), 300_000)
        return () => clearInterval(timer)
      }, [load, provider])

      // 所有 Hook 先于条件返回：切换模型时 provider 会短暂为空。
      if (provider !== PROVIDER) return null

      const bucket = data?.status === 'ok' ? pickTightestBucket(data.groups) : null
      const label = bucket
        ? `${Math.round(bucket.remainingPct ?? 0)}%${bucket.window ? ` · ${bucket.window}` : ''}`
        : data?.status === 'error'
          ? '额度读取失败'
          : '额度…'
      const title = bucket
        ? `${bucket.group ? `${bucket.group} · ` : ''}${bucket.name}：剩余 ${bucket.remainingPct ?? '?'}%${resetCountdown(bucket.resetTime) ? `，${resetCountdown(bucket.resetTime)} 后重置` : ''}`
        : data?.status === 'error'
          ? (data.error?.text ?? data.error?.message ?? '额度读取失败')
          : '正在读取 Antigravity 套餐额度…'

      return h(
        'div',
        { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h(
          'button',
          {
            type: 'button',
            title,
            onClick: () => setExpanded((value) => !value),
            style: {
              display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer',
              padding: '2px 8px', borderRadius: '999px', fontSize: '0.75rem', lineHeight: 1.6,
              border: '1px solid var(--border, rgba(127,127,127,0.35))',
              background: 'transparent', color: 'inherit', opacity: 0.85,
            },
          },
          h('span', {
            style: {
              width: '8px', height: '8px', borderRadius: '50%', flex: 'none',
              background: data?.status === 'error' ? '#e5534b'
                : bucket && typeof bucket.remainingPct === 'number'
                  ? (bucket.remainingPct >= 70 ? '#3fb950' : bucket.remainingPct >= 40 ? '#d29922' : '#e5534b')
                  : '#8b949e',
            },
          }),
          h('span', null, label),
        ),
        expanded ? h(
          'div',
          {
            style: {
              position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 30, width: '20rem',
              maxWidth: '80vw', padding: '12px', borderRadius: '8px',
              border: '1px solid var(--border, rgba(127,127,127,0.35))',
              background: 'var(--background, #1e1e1e)', color: 'inherit',
              boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
            },
          },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, `Antigravity 套餐额度${data?.plan ? ` · ${data.plan}` : ''}`),
          data?.status === 'error'
            ? h('p', { style: { margin: 0, color: '#e5534b' } }, data.error?.text ?? data.error?.message ?? '额度读取失败')
            : (data?.groups ?? []).map((group) => h(
              'div',
              { key: group.name, style: { marginBottom: '8px' } },
              h('div', { style: { opacity: 0.75, fontSize: '0.78rem' } }, group.name),
              (group.buckets ?? []).map((item) => h(
                'div',
                { key: `${group.name}-${item.name}`, style: { display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '0.8rem', opacity: item.disabled ? 0.5 : 1 } },
                h('span', null, item.name),
                h('span', { style: { opacity: 0.8 } },
                  item.disabled ? '已停用'
                    : typeof item.remainingPct === 'number'
                      ? `${item.remainingPct}%${resetCountdown(item.resetTime) ? ` · ${resetCountdown(item.resetTime)}后重置` : ''}`
                      : '未知'),
              )),
            )),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' } },
            h('button', { type: 'button', onClick: () => load(true), style: { fontSize: '0.78rem', cursor: 'pointer' } }, '刷新'),
            h('small', { style: { opacity: 0.6 } }, '数据来自官方额度接口；token 只读不写。'),
          ),
        ) : null,
      )
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
      return async (force) => {
        const deadline = Date.now() + 20_000
        for (;;) {
          const service = scope.get('remote.agyQuota')
          if (service && typeof service.read === 'function') {
            // Host 侧会起官方 agy CLI 取数（其启动含登录刷新）。万一它挂在网络上，
            // 也要让药丸显示「读取失败 + 原因」，而不是一直停在「额度…」。
            return await withTimeout(
              service.read(force ? { force: true } : undefined),
              60_000,
              '额度读取超时（Host 侧 agy CLI 60 秒内没有返回；常见原因是该子进程没走代理）',
            )
          }
          if (Date.now() >= deadline) {
            throw new Error('额度服务未就绪（Host 端 remote.agyQuota 未挂载）')
          }
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
    }

    return {
      name: 'dsh-bundle-antigravity-host',
      // remote.settings / remote.llm 必须逐个声明：remote 各命名空间是独立服务，
      // 漏声明会在读取属性时抛「without inject」并击穿 settings.section 卡片。
      inject: ['slots', 'remote', 'remote.settings', 'remote.llm'],
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
        // 额度药丸：紧邻模型选择器左侧（宿主把 conversation.input.right 渲染在
        // conversation.input.model 之前）。modelDirectories 是会话模型目录服务。
        ctx.inject(['slots', 'modelDirectories'], (scope) => {
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
                      readQuota: makeQuotaReader(scope),
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
