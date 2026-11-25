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
    /* @include client-i18n/en-ui.js */
    /* @include client-i18n/en-host.js */
    /* @include client-i18n/core.js */
    const PROVIDER = 'antigravity-acp'
    const PROXY_PROVIDER = 'antigravity-proxy'
    /** Settings namespace projected from Config's volatile fields in src/settings.ts. */
    const ENTRY_ID = 'llm-antigravity-acp'
    /** Live fields owned by this card; ordinary fields stay in the host config editor. */
    const FIELDS = [
      { key: 'proxyMode', group: 'mode', checkbox: true, label: msg('使用代理模式'), hint: msg('直连上游；需启用代理路由并连接代理账户。') },
      { key: 'cliQuotaEnabled', group: 'quota', checkbox: true, label: msg('使用 agy CLI 补充额度'), hint: msg('默认不启动 agy；开启后才读取 AI Credits。') },
      { key: 'autoWarmup', group: 'general', checkbox: true, defaultChecked: true, acpOnly: true, label: msg('启动时自动预热'), hint: msg('不发送消息；下次启用插件时生效。') },
      { key: 'reuseSessions', group: 'general', checkbox: true, defaultChecked: true, acpOnly: true, label: msg('复用 ACP 会话'), hint: msg('只发送新增消息；上下文不一致时自动重建。') },
      { key: 'proxyUrl', group: 'network', label: msg('出网代理'), placeholder: 'http://127.0.0.1:7890', hint: msg('留空继承宿主代理环境。') },
      { key: 'agyCliPath', group: 'network', label: msg('官方 CLI 路径'), placeholder: msg('留空自动查找 agy'), hint: msg('仅用于模型目录和可选的 CLI 额度查询。') },
      { key: 'resumeSessions', group: 'advanced', checkbox: true, acpOnly: true, label: msg('重启后恢复 ACP 会话'), hint: msg('需开启会话复用；恢复失败时自动重建。') },
      { key: 'keepProcessAfterCancel', group: 'advanced', checkbox: true, acpOnly: true, label: msg('取消后保留进程'), hint: msg('仅在官方进程确认停止后保留。') },
      { key: 'cancelGraceMs', group: 'advanced', numeric: true, defaultValue: 30000, min: 0, max: 60000, acpOnly: true, label: msg('取消确认宽限（毫秒）'), hint: msg('0 表示立即回收。') },
      { key: 'idleRecycleMs', group: 'advanced', numeric: true, defaultValue: 300000, min: 0, max: 3600000, acpOnly: true, label: msg('进程空闲回收（毫秒）'), hint: msg('默认 5 分钟；0 表示禁用。') },
    ]

    /**
     * 普通（非 volatile）配置：并发、二进制与各段超时。
     *
     * 宿主只把 volatile 字段投影进 `settings.describe()`，并拒绝用 `mutate` 写非
     * volatile 路径（`Config field "X" is not volatile`）。把它们渲染成可编辑输入
     * 框只会得到「值不是真值、保存整批失败」，所以这里只在卡片上给出指引，实际
     * 修改走插件的普通配置编辑器，保存后由宿主重载生效。
     */
    const PLAIN_FIELD_LABELS = [
      msg('最大 ACP 连接数（maxConcurrentSessions）'),
      msg('连接排队超时（queueTimeoutMs）'),
      msg('普通请求超时（requestTimeoutMs）'),
      msg('握手超时（handshakeTimeoutMs）'),
      msg('浏览器登录超时（authTimeoutMs）'),
      msg('单轮生成超时（promptTimeoutMs）'),
      msg('工具调用聚合窗口（bridgeParkSettleMs）'),
      msg('ACP Server 路径（binaryPath）'),
      msg('自动下载 ACP Server（autoDownload）'),
      msg('ACP Server 版本（acpVersion）'),
      msg('ACP 额外启动参数（extraArgs）'),
    ]

    /** 逐模型设置：键是 DSH 选择器里的模型 ID，值是开关、默认档位、显示名与官方 ID 映射。 */
    const OVERRIDES_KEY = 'modelOverrides'
    const OVERRIDES_LABEL = msg('模型列表设置')
    const EFFORT_OPTIONS = [
      { value: '', label: msg('跟随官方') },
      { value: 'low', label: msg('低') },
      { value: 'medium', label: msg('中') },
      { value: 'high', label: msg('高') },
    ]
    const EFFORT_IDS = new Set(EFFORT_OPTIONS.map((entry) => entry.value).filter(Boolean))
    const MODALITY_LABELS = { text: msg('文本'), image: msg('图片'), audio: msg('音频'), video: msg('视频'), file: msg('文件') }

    /**
     * 官方公告即将下线的模型家族，须与 src/adapter/model-retirement.ts 保持一致
     * （一致性由 tests/client-loader.test.ts 锁定）。client 不能 import TS，内置同份表。
     */
    const MODEL_RETIREMENTS = [
      { familyId: 'gemini-4-argon', name: 'Gemini 4 Argon', retireAt: '2026-11-30', migration: 'Gemini 4 Hydrogen' },
      { familyId: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', retireAt: '2026-11-30', migration: 'Gemini 4 Hydrogen' },
      { familyId: 'gpt-oss-120b', name: 'GPT-OSS 120B', retireAt: '2026-11-18' },
    ]
    const RETIREMENT_BY_FAMILY = new Map(MODEL_RETIREMENTS.map((entry) => [entry.familyId, entry]))
    function retirementFamilyKey(id) {
      return String(id ?? '').trim().replace(/^antigravity-/, '').replace(/-(?:low|medium|high|xhigh|minimal)$/, '')
    }
    function retirementForModel(id) {
      return RETIREMENT_BY_FAMILY.get(retirementFamilyKey(id))
    }
    /** 生效启用态：显式配置优先；未配置时退役家族默认关闭。 */
    function effectiveEnabled(overrides, id) {
      const stored = overrideFor(overrides, id).enabled
      return stored !== undefined ? stored : !retirementForModel(id)
    }

    /** 只保留有意义的字段：启用是默认值，空串等于未设置；退役家族的显式启用需要落盘。 */
    function canonicalOverride(id, row) {
      const source = row && typeof row === 'object' ? row : {}
      const result = {}
      if (source.enabled === false) result.enabled = false
      else if (source.enabled === true && retirementForModel(id)) result.enabled = true
      if (EFFORT_IDS.has(source.effort)) result.effort = source.effort
      const name = typeof source.name === 'string' ? source.name.trim() : ''
      if (name) result.name = name
      const target = typeof source.target === 'string' ? source.target.trim() : ''
      if (target) result.target = target
      return result
    }
    /** 稳定序列化：键序不影响脏值判断。 */
    function canonicalOverrides(value) {
      const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      const result = {}
      for (const key of Object.keys(source).sort()) {
        const row = canonicalOverride(key, source[key])
        if (Object.keys(row).length > 0) result[key] = row
      }
      return result
    }
    function sameOverrides(a, b) {
      return JSON.stringify(canonicalOverrides(a)) === JSON.stringify(canonicalOverrides(b))
    }
    function overrideFor(overrides, id) {
      const row = overrides && typeof overrides === 'object' ? overrides[id] : undefined
      return row && typeof row === 'object' ? row : {}
    }

    /** 编排设置：整份对象作为一个字段参与脏值与冲突判断（与 modelOverrides 同模式）。 */
    const ORCHESTRATOR_KEY = 'orchestrator'
    const ORCHESTRATOR_LABEL = msg('编排（Orchestrator）')
    const ORCHESTRATOR_EXECUTOR_MODEL = 'gemini-4-hydrogen'
    const ORCHESTRATOR_PLANNER_OPTIONS = [
      { value: 'gemini-4-neon', label: 'Gemini 4 Neon' },
      { value: 'gemini-4-argon', label: 'Gemini 4 Argon' },
      { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    ]
    const ORCHESTRATOR_PLANNER_IDS = new Set(ORCHESTRATOR_PLANNER_OPTIONS.map((entry) => entry.value))
    const ORCHESTRATOR_EXECUTOR_OPTIONS = [
      { value: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
      { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    ]
    const ORCHESTRATOR_EXECUTOR_IDS = new Set(ORCHESTRATOR_EXECUTOR_OPTIONS.map((entry) => entry.value))
    const ORCHESTRATOR_EFFORT_OPTIONS = EFFORT_OPTIONS.filter((entry) => Boolean(entry.value))
    const ORCHESTRATOR_DEFAULTS = {
      enabled: true,
      plannerModel: 'claude-opus-5-5',
      plannerEffort: 'medium',
      executorModel: ORCHESTRATOR_EXECUTOR_MODEL,
      executorEffort: 'medium',
      maxPlansPerTurn: 2,
      plannerTimeoutMs: 20000,
      showPlan: false,
    }
    const ORCHESTRATOR_FIELDS = {
      enabled: { key: 'orchestratorEnabled', checkbox: true, label: msg('启用编排'), hint: msg('关闭后不生成编排模型条目，也不执行规划编排。') },
      plannerModel: { key: 'orchestratorPlannerModel', options: ORCHESTRATOR_PLANNER_OPTIONS, label: msg('规划模型（Planner）'), hint: msg('从预设规划模型中选择（默认 Claude Opus 5.5）；Gemini 4 Argon 将于 11-30 下线。') },
      plannerEffort: { key: 'orchestratorPlannerEffort', options: ORCHESTRATOR_EFFORT_OPTIONS, label: msg('规划思考档位'), hint: msg('规划阶段使用的思考档位（low / medium / high）。') },
      executorModel: { key: 'orchestratorExecutorModel', options: ORCHESTRATOR_EXECUTOR_OPTIONS, label: msg('执行模型（Executor）'), hint: msg('从预设执行模型中选择（默认 Gemini 4 Hydrogen）；仅当前账户目录可见时生效。') },
      executorEffort: { key: 'orchestratorExecutorEffort', options: ORCHESTRATOR_EFFORT_OPTIONS, label: msg('执行思考档位'), hint: msg('执行阶段使用的思考档位（low / medium / high）。') },
      maxPlansPerTurn: { key: 'orchestratorMaxPlans', numeric: true, min: 1, max: 4, label: msg('每轮最多规划次数'), hint: msg('单次用户回合内的规划次数上限（1–4）。') },
      showPlan: { key: 'orchestratorShowPlan', checkbox: true, label: msg('在对话中显示计划'), hint: msg('开启后在对话中以文本块展示规划结果。') },
    }
    function isValidOrchestratorMaxPlans(value) {
      return Number.isSafeInteger(value) && value >= 1 && value <= 4
    }
    /** 规范化编排配置：固定键序、省略默认值，非法值回落默认。 */
    function canonicalOrchestrator(value) {
      const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      const result = {}
      if (source.enabled === false) result.enabled = false
      const plannerModel = typeof source.plannerModel === 'string' ? source.plannerModel.trim() : ''
      if (ORCHESTRATOR_PLANNER_IDS.has(plannerModel) && plannerModel !== ORCHESTRATOR_DEFAULTS.plannerModel) result.plannerModel = plannerModel
      const executorModel = typeof source.executorModel === 'string' ? source.executorModel.trim() : ''
      if (ORCHESTRATOR_EXECUTOR_IDS.has(executorModel) && executorModel !== ORCHESTRATOR_DEFAULTS.executorModel) result.executorModel = executorModel
      if (EFFORT_IDS.has(source.plannerEffort) && source.plannerEffort !== ORCHESTRATOR_DEFAULTS.plannerEffort) result.plannerEffort = source.plannerEffort
      if (EFFORT_IDS.has(source.executorEffort) && source.executorEffort !== ORCHESTRATOR_DEFAULTS.executorEffort) result.executorEffort = source.executorEffort
      if (isValidOrchestratorMaxPlans(source.maxPlansPerTurn) && source.maxPlansPerTurn !== ORCHESTRATOR_DEFAULTS.maxPlansPerTurn) result.maxPlansPerTurn = source.maxPlansPerTurn
      if (Number.isSafeInteger(source.plannerTimeoutMs) && source.plannerTimeoutMs >= 5000 && source.plannerTimeoutMs <= 300000 && source.plannerTimeoutMs !== ORCHESTRATOR_DEFAULTS.plannerTimeoutMs) {
        result.plannerTimeoutMs = source.plannerTimeoutMs
      }
      if (source.showPlan === true) result.showPlan = true
      return result
    }
    function sameOrchestrator(a, b) {
      return JSON.stringify(canonicalOrchestrator(a)) === JSON.stringify(canonicalOrchestrator(b))
    }
    function orchestratorDraftFrom(value) {
      const canonical = canonicalOrchestrator(value)
      return {
        enabled: canonical.enabled ?? ORCHESTRATOR_DEFAULTS.enabled,
        plannerModel: canonical.plannerModel ?? ORCHESTRATOR_DEFAULTS.plannerModel,
        plannerEffort: canonical.plannerEffort ?? ORCHESTRATOR_DEFAULTS.plannerEffort,
        executorModel: canonical.executorModel ?? ORCHESTRATOR_DEFAULTS.executorModel,
        executorEffort: canonical.executorEffort ?? ORCHESTRATOR_DEFAULTS.executorEffort,
        maxPlansPerTurn: canonical.maxPlansPerTurn ?? ORCHESTRATOR_DEFAULTS.maxPlansPerTurn,
        showPlan: canonical.showPlan ?? ORCHESTRATOR_DEFAULTS.showPlan,
        ...(canonical.plannerTimeoutMs !== undefined ? { plannerTimeoutMs: canonical.plannerTimeoutMs } : {}),
      }
    }
    function isOrchestratorDraftValid(value) {
      return Boolean(value && typeof value === 'object' && isValidOrchestratorMaxPlans(value.maxPlansPerTurn))
    }
    /**
     * 目录条目 + 已配置但当前目录没有的 ID + 退役表内置家族，都要能在此编辑。
     * proxyMode 必须由调用方按当前链路显式传入：不能用目录里是否出现 antigravity-
     * 前缀来猜（ACP 模式的编排合成条目同样带该前缀，会导致补行写错 ID 风格）。
     */
    function modelRows(models, overrides, proxyMode = false) {
      const rows = models.map(({ id, name, inputModalities, contextWindow, maxOutputTokens }) => {
        const retiring = retirementForModel(id)
        return { id, name, inputModalities, contextWindow, maxOutputTokens, inCatalog: true, ...(retiring ? { retiring } : {}) }
      })
      const known = new Set(rows.map((row) => row.id))
      // 按家族去重：同一退役家族只要已有任意档位/前缀的观测行在场，就不再补行，
      // 避免 gpt-oss（真实键 antigravity-gpt-oss-120b-medium）出现重复死行。
      const presentFamilies = new Set(rows.map((row) => retirementFamilyKey(row.id)))
      for (const retiring of MODEL_RETIREMENTS) {
        if (presentFamilies.has(retiring.familyId)) continue
        // ACP 目录键是裸家族 id；代理目录键带 antigravity- 前缀。
        const id = proxyMode ? `antigravity-${retiring.familyId}` : retiring.familyId
        if (!known.has(id)) {
          rows.push({ id, name: retiring.name, inCatalog: false, retiring })
          known.add(id)
        }
      }
      for (const id of Object.keys(canonicalOverrides(overrides))) {
        if (!known.has(id)) rows.push({ id, name: id, inCatalog: false })
      }
      return rows
    }

    function unwrap(result) {
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok) return result.value
        throw new Error(t(result.error?.message) || t('未知错误'))
      }
      return result
    }

    const RUNTIME_PHASES = {
      idle: msg('尚未启动'), binary: msg('准备运行文件'), credentials: msg('准备登录态'), spawn: msg('启动进程'),
      initialize: msg('等待握手'), authenticate: msg('等待登录'), ready: msg('连接就绪'), connection: msg('准备连接'),
      session: msg('建立会话'), model: msg('选择模型'), prompt: msg('等待模型首块'), streaming: msg('正在输出'),
      'waiting-tools': msg('等待 DSH 工具结果'), continuing: msg('等待工具后的回复'), recycling: msg('回收进程'),
      stopped: msg('已停止'), error: msg('连接异常'), disposed: msg('插件已卸载'),
    }
    const phaseName = (phase) => t(RUNTIME_PHASES[phase] ?? phase)
    function runtimeBusy(runtime) {
      if (runtime?.queue && (runtime.queue.active > 0 || runtime.queue.parked > 0 || runtime.queue.waiting > 0)) return true
      return runtime && !['idle', 'ready', 'stopped', 'error', 'disposed'].includes(runtime.phase)
    }
    function duration(ms) {
      if (!Number.isFinite(ms)) return '—'
      if (ms < 1000) return Math.round(ms) + ' ms'
      if (ms < 60000) return (ms / 1000).toFixed(2) + ' s'
      return t('{minutes} 分 {seconds} 秒', { minutes: Math.floor(ms / 60000), seconds: Math.floor(ms % 60000 / 1000) })
    }
    /** 连接中且进程仍在启动时，给出阶段、已用时间与冷启动提示（官方进程冷启动可达 1 分钟）。 */
    function startupHint(account) {
      const runtime = account?.runtime
      if (account?.state !== 'connecting' || !runtime || !['binary', 'credentials', 'spawn', 'initialize', 'authenticate', 'session'].includes(runtime.phase)) return undefined
      const slow = ['spawn', 'initialize'].includes(runtime.phase) ? t('；官方进程冷启动首次可能需要约 1 分钟，请耐心等待') : ''
      return t('{phase}… 已用 {time}{slow}', { phase: phaseName(runtime.phase), time: duration(runtime.phaseElapsedMs), slow })
    }
    function connectionStatus(account, registered) {
      const runtime = account?.runtime
      const ready = runtime?.phase === 'ready'
      const busy = runtimeBusy(runtime) || ['connecting', 'cancelling'].includes(account?.state)
      const error = account?.state === 'error' || runtime?.phase === 'error' || registered === false
      const label = t(registered === false ? 'Provider 未注册'
        : error ? '连接需要检查'
          : busy ? account?.state === 'cancelling' ? '正在取消连接' : '正在准备连接'
            : ready ? account?.state === 'connected' ? '账户已验证' : 'ACP 已预热'
              : account?.state === 'cancelled' || runtime?.phase === 'stopped' ? '连接已停止'
                : account?.state === 'connected' ? '账户已验证' : '尚未验证连接')
      const description = account?.runtime?.phase === 'stopped'
        ? t('ACP 连接已停止，可以重新预热。')
        : account?.runtime?.phase === 'error'
          ? t(account.runtime.error ?? account?.message ?? 'ACP 连接异常，请重试。')
          : registered === false ? t('请确认插件已启用，Host 与 Client 均已加载。')
            : startupHint(account) ?? t(account?.message ?? '连接后可读取模型目录，不发送聊天消息。')
      return { label, description, ready, busy, error, color: error ? '#ef4444' : ready ? '#22c55e' : busy ? '#eab308' : '#94a3b8' }
    }
    function StatusDot({ color }) {
      return h('span', { 'aria-hidden': true, style: { width: '7px', height: '7px', flex: '0 0 auto', borderRadius: '50%', background: color } })
    }
    function StatusNotice({ status }) {
      if (!status) return null
      const error = status.kind === 'error'
      const tone = error ? '#ef4444' : status.kind === 'busy' ? '#eab308' : '#22c55e'
      return h('p', { role: error ? 'alert' : 'status', style: { margin: 0, padding: '8px 12px', borderRadius: '10px', border: '1px solid ' + tone + '47', fontSize: '12px', lineHeight: 1.5, overflowWrap: 'anywhere', color: error ? '#ef4444' : 'inherit', background: tone + '1a' } }, t(status.text))
    }
    function RuntimeDetails({ runtime }) {
      if (!runtime) return null
      const row = (label, value) => h('div', { key: label, style: { display: 'flex', justifyContent: 'space-between', gap: '16px' } },
        h('span', { style: { opacity: .65 } }, label), h('span', { style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' } }, value))
      const round = runtime.round
      const queue = runtime.queue
      return h('div', { 'aria-label': t('ACP 生命周期与计时'), style: { display: 'grid', gap: '8px', fontSize: '12px', lineHeight: 1.5 } },
        row(t('当前状态'), phaseName(runtime.phase) + ' · ' + duration(runtime.phaseElapsedMs)),
        queue ? row(t('会话调度'), t('运行 {active} · 等待工具 {parked} · 排队 {waiting}', queue)) : null,
        queue ? row(t('并发连接'), queue.workers + ' / ' + queue.capacity) : null,
        runtime.processRunning ? row(t('进程已运行'), duration(runtime.uptimeMs)) : null,
        row(t('进程统计'), t('启动 {starts} · 复用 {reuses} · 回收 {recycles}', runtime)),
        runtime.startup ? row(t('最近启动总耗时'), duration(runtime.startup.elapsedMs)) : null,
        ...Object.entries(runtime.startup?.timings ?? {}).map(([name, ms]) => row(phaseName(name), duration(ms))),
        round ? row(t('当前 / 最近回合'), round.model + ' · ' + duration(round.elapsedMs)) : null,
        ...Object.entries(round?.timings ?? {}).map(([name, ms]) => row(phaseName(name), duration(ms))),
        round?.firstChunkMs !== undefined ? row(t('发送 prompt → 首块'), duration(round.firstChunkMs)) : null,
        round?.firstToolMs !== undefined ? row(t('发送 prompt → 首个工具'), duration(round.firstToolMs)) : null,
        round?.continuations ? row(t('工具续轮'), t('{count} 次 · 最近 {last}', { count: round.continuations, last: duration(round.lastContinuationMs) })) : null,
        runtime.error ? h('p', { role: 'alert', style: { margin: '4px 0 0', color: '#ef4444', overflowWrap: 'anywhere' } }, t(runtime.error)) : null)
    }
    function SectionHeading({ eyebrow, title, description, action }) {
      return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px', minHeight: '24px' } },
        h('div', { style: { flex: 1, minWidth: 0 } },
          eyebrow ? h('div', { style: { fontSize: '10px', fontWeight: 600, letterSpacing: '.06em', opacity: .55, marginBottom: '2px' } }, eyebrow) : null,
          h('h3', { style: { fontSize: '12px', lineHeight: 1.4, fontWeight: 600, letterSpacing: '.01em', opacity: .72, margin: 0 } }, title),
          description ? h('p', { style: { fontSize: '11.5px', lineHeight: 1.45, opacity: .62, margin: '2px 0 0' } }, description) : null),
        action ?? null)
    }
    function TextField({ field, value, disabled, invalid, onChange }) {
      const inputId = 'agy-setting-' + (React.useId?.() ?? field.key) + '-' + field.key
      return h('div', { style: { display: 'grid', gap: '4px', minWidth: 0 } },
        h('label', { htmlFor: inputId, style: { fontSize: '12.5px', fontWeight: 550 } }, t(field.label)),
        h(field.lines ? 'textarea' : 'input', {
          id: inputId, name: field.key, type: field.numeric ? 'number' : 'text',
          ...(field.numeric ? { min: field.min, max: field.max, step: 1 } : {}),
          ...(field.lines ? { rows: 2 } : {}),
          disabled, value: value ?? '', placeholder: t(field.placeholder),
          'aria-invalid': invalid || undefined, 'aria-describedby': field.hint ? inputId + '-hint' : undefined,
          style: { ...ACTION, cursor: disabled ? 'not-allowed' : 'text', width: '100%', minHeight: '32px', boxSizing: 'border-box', background: 'transparent', opacity: disabled ? .55 : 1 },
          onChange: (event) => onChange(field.numeric && event.target.value !== '' ? Number(event.target.value) : event.target.value),
        }),
        field.hint ? h('small', { id: inputId + '-hint', style: { fontSize: '11px', lineHeight: 1.45, opacity: .6 } }, t(field.hint)) : null)
    }
    function SwitchField({ field, checked, disabled, onChange }) {
      return h('label', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', cursor: disabled ? 'default' : 'pointer', padding: '4px 0', opacity: disabled ? .55 : 1 } },
        h('span', { style: { display: 'grid', gap: '2px', minWidth: 0, flex: 1 } },
          h('span', { style: { fontSize: '13px', fontWeight: 550 } }, t(field.label)),
          field.hint ? h('small', { style: { fontSize: '11.5px', lineHeight: 1.45, opacity: .6 } }, t(field.hint)) : null),
        h('input', { className: 'agy-switch', name: field.key, type: 'checkbox', checked: checked === true, disabled, style: { accentColor: '#3b82f6' }, onChange: (event) => onChange(event.target.checked) }))
    }
    function SelectField({ field, value, disabled, onChange }) {
      const inputId = 'agy-setting-' + (React.useId?.() ?? field.key) + '-' + field.key
      return h('div', { style: { display: 'grid', gap: '4px', minWidth: 0 } },
        h('label', { htmlFor: inputId, style: { fontSize: '12.5px', fontWeight: 550 } }, t(field.label)),
        h('select', {
          id: inputId, name: field.key, disabled, value: value ?? '',
          'aria-describedby': field.hint ? inputId + '-hint' : undefined,
          style: { ...ACTION, cursor: disabled ? 'not-allowed' : 'pointer', width: '100%', minHeight: '32px', boxSizing: 'border-box', background: 'transparent', colorScheme: 'inherit', opacity: disabled ? .55 : 1 },
          onChange: (event) => onChange(event.target.value),
        }, ...(field.options ?? []).map((option) => h('option', { key: option.value, value: option.value, style: { color: 'CanvasText', backgroundColor: 'Canvas' } }, t(option.label)))),
        field.hint ? h('small', { id: inputId + '-hint', style: { fontSize: '11px', lineHeight: 1.45, opacity: .6 } }, t(field.hint)) : null)
    }
    function OrchestratorSection({ value, dirty, disabled, onEdit }) {
      const current = value && typeof value === 'object' ? value : orchestratorDraftFrom(undefined)
      const maxPlansInvalid = dirty && !isValidOrchestratorMaxPlans(current.maxPlansPerTurn)
      const pairGrid = { display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }
      return h('section', { 'aria-label': t(ORCHESTRATOR_LABEL) },
        h(SectionHeading, { title: t(ORCHESTRATOR_LABEL), description: t('先由 Planner 生成计划，再由 Executor 按步骤执行；ACP 模式下 Planner 在工作区运行内置只读命令，不经过 DSH 审批。') }),
        h('div', { style: PANEL },
          h('div', { style: { display: 'grid', gap: '10px' } },
            h(SwitchField, { field: ORCHESTRATOR_FIELDS.enabled, checked: current.enabled, disabled, onChange: (checked) => onEdit({ enabled: checked }) }),
            h('div', { style: pairGrid },
              h(SelectField, { field: ORCHESTRATOR_FIELDS.plannerModel, value: current.plannerModel, disabled, onChange: (next) => onEdit({ plannerModel: next }) }),
              h(SelectField, { field: ORCHESTRATOR_FIELDS.plannerEffort, value: current.plannerEffort, disabled, onChange: (next) => onEdit({ plannerEffort: next }) })),
            h('div', { style: pairGrid },
              h(SelectField, { field: ORCHESTRATOR_FIELDS.executorModel, value: current.executorModel, disabled, onChange: (next) => onEdit({ executorModel: next }) }),
              h(SelectField, { field: ORCHESTRATOR_FIELDS.executorEffort, value: current.executorEffort, disabled, onChange: (next) => onEdit({ executorEffort: next }) })),
            h(TextField, { field: ORCHESTRATOR_FIELDS.maxPlansPerTurn, value: current.maxPlansPerTurn, disabled, invalid: maxPlansInvalid, onChange: (next) => onEdit({ maxPlansPerTurn: next }) }),
            h(SwitchField, { field: ORCHESTRATOR_FIELDS.showPlan, checked: current.showPlan, disabled, onChange: (checked) => onEdit({ showPlan: checked }) }))))
    }
    function SettingsFields({ fields, draft, dirtyKeys, conflicts, disabled, editField }) {
      const numericGrid = fields.length > 1 && fields.every((field) => field.numeric)
      return h('div', { style: { display: 'grid', gap: '10px', gridTemplateColumns: numericGrid ? 'repeat(auto-fit, minmax(180px, 1fr))' : undefined } }, ...fields.map((field) => {
        const onChange = (value) => editField(field.key, value)
        return field.checkbox
          ? h(SwitchField, { key: field.key, field, checked: draft[field.key], disabled, onChange })
          : h(TextField, { key: field.key, field, value: draft[field.key], disabled, invalid: dirtyKeys.includes(field.key) && field.numeric && !Number.isSafeInteger(draft[field.key]), onChange })
      }))
    }
    function PlainConfigDisclosure({ labels }) {
      const [open, setOpen] = React.useState(false)
      return h('div', { className: 'agy-fold', role: 'group', 'aria-label': t('普通配置说明'), style: { border: '1px solid var(--agy-line)', borderRadius: '10px', background: 'color-mix(in srgb, currentColor 3%, transparent)', padding: '8px 12px', fontSize: '12px', lineHeight: 1.6 } },
        h('button', { type: 'button', 'aria-expanded': open, onClick: () => setOpen((v) => !v), style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', width: '100%', padding: 0, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left' } },
          h('span', { style: { fontSize: '12.5px', fontWeight: 550 } }, (open ? '▾ ' : '▸ ') + t('普通配置（并发 / 二进制 / 超时）')),
          h('small', { style: { fontSize: '11px', opacity: .58 } }, t('{count} 项', { count: labels.length }))),
        h('div', { style: { display: open ? 'block' : 'none', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--agy-line)' } },
          h('div', { style: { opacity: .75, fontSize: '11.5px' } }, t('这些不是即时配置：宿主只把即时字段投影到本卡片，也会拒绝在这里写入普通字段。请在插件的普通配置编辑器里修改，保存后由宿主重载生效。字段清单：')),
          h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px', opacity: .75, fontSize: '11.5px' } },
            ...labels.map((label) => h('li', { key: label }, t(label))))))
    }
    function SettingsGroup({ title, fields, fieldProps, open = false }) {
      return h('details', { className: 'agy-fold', style: { border: '1px solid var(--agy-line)', borderRadius: '10px', background: 'color-mix(in srgb, currentColor 3%, transparent)', padding: '8px 12px' }, 'aria-label': t('{title}设置', { title }), open: open || undefined },
        h('summary', { style: SUMMARY },
          h('span', { style: { fontSize: '12.5px', fontWeight: 550 } }, title),
          h('small', { style: { fontSize: '11px', opacity: .58 } }, t('{count} 项', { count: fields.length }))),
        h('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--agy-line)' } },
          h(SettingsFields, { ...fieldProps, fields })))
    }

    /** 紧凑列表行；完整 ID、输入能力、改名和映射集中在单条详情里。 */
    function RetirementBadge({ retiring }) {
      const monthDay = retiring.retireAt.slice(5)
      const retired = Date.parse(`${retiring.retireAt}T23:59:59`) < Date.now()
      const title = retiring.migration
        ? t('官方将于 {date} 下线，建议改用 {migration}', { date: retiring.retireAt, migration: retiring.migration })
        : t('官方将于 {date} 下线', { date: retiring.retireAt })
      return h('span', {
        title,
        'aria-label': title,
        style: { flex: '0 0 auto', padding: '1px 7px', borderRadius: '99px', fontSize: '10.5px', fontWeight: 600, color: '#b45309', background: 'rgba(234,179,8,.16)', border: '1px solid rgba(234,179,8,.35)', whiteSpace: 'nowrap' },
      }, retired ? t('已下线 {date}', { date: monthDay }) : t('即将下线 {date}', { date: monthDay }))
    }
    function ModelOverrideRow({ row, override, disabled, onEdit }) {
      const retiring = row.retiring ?? retirementForModel(row.id)
      const enabled = override.enabled !== undefined ? override.enabled : !retiring
      const inputId = 'agy-model-' + row.id.replace(/[^\w.-]/g, '_')
      const labelStyle = { fontSize: '11.5px', opacity: .66 }
      const inputStyle = { ...ACTION, width: '100%', minWidth: 0, minHeight: '32px', boxSizing: 'border-box', background: 'transparent', cursor: disabled ? 'not-allowed' : 'text' }
      const displayName = override.name?.trim() || row.name
      const toggleId = inputId + '-enabled'
      return h('div', { role: 'listitem', style: { padding: '10px 14px', borderTop: '1px solid var(--agy-line)', opacity: enabled ? 1 : .54 } },
        h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', alignItems: 'center', gap: '10px' } },
          h('label', { htmlFor: toggleId, title: displayName, style: { minWidth: 0, cursor: disabled ? 'default' : 'pointer' } },
            h('div', { title: displayName, style: { display: 'flex', alignItems: 'center', gap: '7px', overflow: 'hidden' } },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px', fontWeight: 560 } }, displayName),
              retiring ? h(RetirementBadge, { retiring }) : null),
            h('div', { style: { fontSize: '11px', opacity: .55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.id)),
          h('label', { htmlFor: inputId + '-effort', style: { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11.5px' } },
            h('span', { style: { opacity: .62 } }, t('思考')),
            h('select', { id: inputId + '-effort', name: 'model-effort-' + row.id, disabled, value: EFFORT_IDS.has(override.effort) ? override.effort : '',
              'aria-label': t('{name} 默认思考档位', { name: displayName }),
              onChange: (event) => onEdit(row.id, { effort: event.target.value }),
              style: { ...inputStyle, width: 'auto', minHeight: '26px', padding: '2px 7px', fontSize: '12px', colorScheme: 'inherit', cursor: disabled ? 'not-allowed' : 'pointer' } },
              ...EFFORT_OPTIONS.map((option) => h('option', { key: option.value, value: option.value, style: { color: 'CanvasText', backgroundColor: 'Canvas' } }, t(option.label))))),
          h('input', { id: toggleId, className: 'agy-switch', name: 'model-enabled-' + row.id, type: 'checkbox', checked: enabled, disabled,
            'aria-label': displayName, style: { accentColor: '#3b82f6' },
            onChange: (event) => onEdit(row.id, { enabled: event.target.checked }) })),
        h('details', { style: { marginTop: '6px' } },
          h('summary', { style: { ...SUMMARY, justifyContent: 'flex-start', fontSize: '11px', opacity: .62 } }, t('模型设置')),
          h('div', { style: { display: 'grid', gap: '10px', marginTop: '8px', paddingLeft: '12px', borderLeft: '2px solid color-mix(in srgb, #3b82f6 55%, transparent)' } },
            h('div', { style: { display: 'grid', gap: '3px' } },
              h('span', { style: labelStyle }, t('模型 ID')),
              h('code', { style: { fontSize: '11px', overflowWrap: 'anywhere', opacity: .78 } }, row.id),
              row.inCatalog ? h('span', { style: labelStyle }, Number.isSafeInteger(row.contextWindow)
                ? t('上下文窗口 {tokens} tokens（上游容量）', { tokens: row.contextWindow.toLocaleString() })
                : t('上下文窗口：尚未观测')) : null,
              Number.isSafeInteger(row.maxOutputTokens) ? h('span', { style: labelStyle }, t('输出上限 {tokens} tokens', { tokens: row.maxOutputTokens.toLocaleString() })) : null),
            h('div', { style: { display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' } },
              h('div', { style: { display: 'grid', gap: '4px', minWidth: 0 } },
                h('label', { htmlFor: inputId + '-name', style: labelStyle }, t('显示名')),
                h('input', { id: inputId + '-name', name: 'model-name-' + row.id, type: 'text', disabled, value: override.name ?? '',
                  placeholder: row.name, onChange: (event) => onEdit(row.id, { name: event.target.value }), style: inputStyle })),
              h('div', { style: { display: 'grid', gap: '4px', minWidth: 0 } },
                h('label', { htmlFor: inputId + '-target', style: labelStyle }, t('官方模型 ID')),
                h('input', { id: inputId + '-target', name: 'model-target-' + row.id, type: 'text', disabled, value: override.target ?? '',
                  placeholder: t('留空自动路由'), onChange: (event) => onEdit(row.id, { target: event.target.value }), style: inputStyle }))),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: '11px', opacity: .62 } },
              h('span', null, t(row.inCatalog ? '当前目录' : '不在当前目录')),
              Array.isArray(row.inputModalities) && row.inputModalities.length
                ? h('span', null, row.inputModalities.map((modality) => t(MODALITY_LABELS[modality] ?? modality)).join(' · ')) : null))))
    }

    function ModelOverrideList({ rows, overrides, disabled, onEdit }) {
      const [query, setQuery] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      if (rows.length === 0) {
        return h('p', { role: 'status', style: { margin: 0, fontSize: '12px', lineHeight: 1.5, opacity: .6 } }, t('暂无模型。请先连接当前账户，再刷新目录。'))
      }
      const hidden = rows.filter((row) => !effectiveEnabled(overrides, row.id)).length
      const keyword = query.trim().toLowerCase()
      const visible = rows.filter((row) => {
        if (filter === 'enabled' && !effectiveEnabled(overrides, row.id)) return false
        if (filter === 'hidden' && effectiveEnabled(overrides, row.id)) return false
        const override = overrideFor(overrides, row.id)
        return !keyword || (row.name + ' ' + row.id + ' ' + (override.name ?? '')).toLowerCase().includes(keyword)
      })
      const setVisible = (enabled) => { for (const row of visible) onEdit(row.id, { enabled }) }
      return h('div', { style: { display: 'grid', gap: '8px' } },
        h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '8px' } },
          h('input', { type: 'search', value: query, onChange: (event) => setQuery(event.target.value), placeholder: t('搜索模型'), 'aria-label': t('搜索模型'),
            style: { ...ACTION, width: '100%', minWidth: 0, boxSizing: 'border-box', cursor: 'text' } }),
          h('select', { value: filter, onChange: (event) => setFilter(event.target.value), 'aria-label': t('筛选模型'), style: ACTION },
            h('option', { value: 'all' }, t('全部 {count}', { count: rows.length })),
            h('option', { value: 'enabled' }, t('已启用 {count}', { count: rows.length - hidden })),
            h('option', { value: 'hidden' }, t('已隐藏 {count}', { count: hidden })))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', opacity: .7 } },
          h('span', { style: { marginRight: 'auto' } }, t('显示 {shown} / {total}', { shown: visible.length, total: rows.length })),
          h('button', { type: 'button', disabled: disabled || visible.length === 0, onClick: () => setVisible(true), style: { ...ACTION, minHeight: '26px', padding: '2px 7px', fontSize: '10px' } }, t('全部启用')),
          h('button', { type: 'button', disabled: disabled || visible.length === 0, onClick: () => setVisible(false), style: { ...ACTION, minHeight: '26px', padding: '2px 7px', fontSize: '10px' } }, t('全部隐藏'))),
        hidden === rows.length
          ? h('p', { role: 'status', style: { margin: 0, fontSize: '11px', lineHeight: 1.5, color: '#946200' } }, t('全部隐藏后，Antigravity 将从模型选择器消失。'))
          : null,
        visible.length
          ? h('div', { role: 'list', className: 'agy-list' }, ...visible.map((row) => h(ModelOverrideRow, {
            key: row.id, row, override: overrideFor(overrides, row.id), disabled, onEdit,
          })))
          : h('p', { role: 'status', style: { margin: 0, fontSize: '12px', opacity: .6 } }, t('没有符合条件的模型。')))
    }

    /**
     * 代理账户面板：代理模式的独立登录态（与 ACP / 官方 CLI 登录相互独立）。
     * 状态与授权 URL 经 Host 的 remote.agyProxyAccount 读取；授权 URL 只在
     * 点击「连接代理账户」后返回一次，展示为可打开的链接。
     */
    function ProxyAccountPanel({ control, disabled, connectDisabled, onAccountChanged }) {
      const [snapshot, setSnapshot] = React.useState(undefined)
      const [authUrl, setAuthUrl] = React.useState(undefined)
      const [message, setMessage] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const alive = React.useRef(true)
      const version = React.useRef(0)
      const polling = React.useRef(false)
      const actionVersion = React.useRef(0)
      const status = React.useCallback(async () => {
        if (!control || polling.current) return
        polling.current = true
        const current = ++version.current
        try {
          const value = unwrap(await control('account', { action: 'status' }))
          if (alive.current && current === version.current) setSnapshot(value.snapshot)
        } catch (error) {
          if (alive.current && current === version.current) setSnapshot({ phase: 'signed-out', message: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() })
        } finally { polling.current = false }
      }, [control])
      React.useEffect(() => {
        alive.current = true
        void status()
        const timer = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void status()
        }, 3000)
        return () => { alive.current = false; ++version.current; clearInterval(timer) }
      }, [status])
      React.useEffect(() => {
        if (!snapshot) return
        setMessage('')
        if (snapshot.phase !== 'pending-login') setAuthUrl(undefined)
        onAccountChanged?.(snapshot)
      }, [snapshot?.phase, snapshot?.connectionStage, snapshot?.message, snapshot?.revision, onAccountChanged])
      const act = async (action) => {
        if (!control || (busy && action === 'login')) return
        const operation = ++actionVersion.current
        ++version.current
        setBusy(true)
        setMessage(action === 'login' ? t('正在准备授权…') : '')
        try {
          const value = unwrap(await control('account', { action }))
          if (!alive.current || operation !== actionVersion.current) return
          setSnapshot(value.snapshot)
          setMessage(value.message ?? '')
          if (value.authorizationUrl) setAuthUrl(value.authorizationUrl)
          else if (action !== 'login') setAuthUrl(undefined)
        } catch (error) {
          if (alive.current && operation === actionVersion.current) setMessage(error instanceof Error ? error.message : String(error))
        } finally { if (alive.current && operation === actionVersion.current) setBusy(false) }
      }
      const phase = snapshot?.phase
      const stage = snapshot?.connectionStage
      const connecting = busy || stage === 'preparing' || stage === 'finishing' || phase === 'pending-login'
      const dotColor = phase === 'signed-in' ? '#22c55e' : connecting ? '#eab308' : phase === 'login-failed' ? '#ef4444' : '#94a3b8'
      const phaseLabel = t(phase === 'signed-in' ? '代理账户已连接' : stage === 'finishing' ? '正在完成登录…' : stage === 'preparing' ? '正在检查登录态…' : phase === 'pending-login' ? '等待浏览器授权…' : phase === 'login-failed' ? '登录失败' : busy ? '正在连接…' : '未连接')
      return h('div', { style: { display: 'grid', gap: '12px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', borderRadius: '12px', background: dotColor + '1a', border: '1px solid ' + dotColor + '47' } },
          h('span', { 'aria-hidden': true, style: { width: '30px', height: '30px', borderRadius: '50%', background: dotColor, color: phase === 'pending-login' ? '#1f1300' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 700, flex: 'none' } }, phase === 'signed-in' ? '✓' : phase === 'login-failed' ? '×' : '!'),
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('div', { style: { fontSize: '14px', fontWeight: 700, lineHeight: 1.25 } }, phaseLabel + (snapshot?.email ? ` (${snapshot.email})` : '') + (snapshot?.source === 'cli-import' ? t(' · 导入自官方 CLI') : '')),
            h('p', { role: 'status', style: { fontSize: '11.5px', lineHeight: 1.45, opacity: .75, margin: '2px 0 0', overflowWrap: 'anywhere' } }, t(message || snapshot?.message || '')))),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
          h('button', { type: 'button', style: phase === 'signed-in' ? ACTION : PRIMARY, disabled: disabled || connectDisabled || connecting || phase === 'signed-in', onClick: () => act('login') }, t(connecting ? '连接中…' : '连接代理账户')),
          connecting ? h('button', { type: 'button', style: ACTION, disabled, onClick: () => act('cancel') }, t('取消登录')) : null,
          phase === 'signed-in' ? h('button', { type: 'button', style: ACTION, disabled: disabled || busy, onClick: () => act('logout') }, t('退出登录')) : null),
        authUrl && stage !== 'finishing' ? h('div', { style: { display: 'grid', gap: '6px', justifyItems: 'start' } },
          h('a', { href: authUrl, target: '_blank', rel: 'noopener noreferrer', style: { ...PRIMARY, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' } }, t('打开 Google 授权页')),
          h('small', { style: { fontSize: '11px', opacity: .65, lineHeight: 1.5 } }, t('请在运行 DSH 的设备上完成授权（5 分钟内有效）。'))) : null,
        phase === 'pending-login' && stage !== 'finishing' && !authUrl && !busy ? h('p', { role: 'status', style: { fontSize: '11.5px', margin: 0, opacity: .7 } }, t('授权页已打开；找不到时请取消后重试。')) : null,
        h('p', { style: { opacity: .6, fontSize: '11.5px', lineHeight: 1.5, margin: 0 } }, t('生成与套餐额度使用此账户 · 无需 agy CLI · ACP 已停用')))
    }

    function AntigravitySettingsCard(props) {
      const remote = props.remote
      const [account, setAccount] = React.useState(undefined)
      const [models, setModels] = React.useState([])
      const [modelBusy, setModelBusy] = React.useState(false)
      const [modelMessage, setModelMessage] = React.useState('')
      const alive = React.useRef(true)
      const modelVersion = React.useRef(0)
      const accountVersion = React.useRef(0)
      const polling = React.useRef(false)
      const manualModelPull = React.useRef(false)
      const pullModels = React.useCallback(async (force = false) => {
        if (!props.control || manualModelPull.current) return
        if (force) manualModelPull.current = true
        const version = ++modelVersion.current
        setModelBusy(true)
        if (force) setModelMessage(t('正在拉取模型目录…'))
        try {
          const value = unwrap(await props.control('models', force ? { force: true } : undefined))
          if (!alive.current || version !== modelVersion.current) return
          setModels(value.models ?? [])
          setModelMessage(value.status === 'error' ? t(value.message) : '')
        } catch (error) { if (alive.current && version === modelVersion.current) setModelMessage(error instanceof Error ? error.message : String(error)) }
        finally {
          if (force) manualModelPull.current = false
          if (alive.current && version === modelVersion.current) setModelBusy(false)
        }
      }, [props.control])
      const accountAction = React.useCallback(async (action = 'status') => {
        if (!props.control) return
        if (action === 'status' && polling.current) return
        polling.current = true
        const version = ++accountVersion.current
        try {
          const value = unwrap(await props.control('account', { action }))
          if (alive.current && version === accountVersion.current) setAccount(value)
        } catch (error) { if (alive.current && version === accountVersion.current) setAccount({ state: 'error', message: error instanceof Error ? error.message : String(error) }) }
        finally { polling.current = false }
      }, [props.control])
      React.useEffect(() => {
        alive.current = true
        void accountAction('status')
        void pullModels(false)
        return () => { alive.current = false; ++modelVersion.current; ++accountVersion.current }
      }, [accountAction, pullModels])
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void accountAction('status')
        }, 2000)
        return () => clearInterval(timer)
      }, [accountAction])
      React.useEffect(() => {
        if (account?.state === 'connected' || account?.runtime?.modelCatalogRevision !== undefined) void pullModels(false)
      }, [account?.state, account?.runtime?.modelCatalogRevision, pullModels])
      const [view, setView] = React.useState(undefined)
      const [registered, setRegistered] = React.useState(undefined)
      const [draft, setDraft] = React.useState({})
      const [status, setStatus] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [writable, setWritable] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [dirtyKeys, setDirtyKeys] = React.useState([])
      const [conflicts, setConflicts] = React.useState([])
      const [savedProxyMode, setSavedProxyMode] = React.useState(false)
      // 设置分页。非活动页只隐藏、不卸载：草稿、保存与控件覆盖测试都依赖字段始终挂载。
      const [settingsPage, setSettingsPage] = React.useState('connection')
      const settingsVersion = React.useRef(0)
      const savingRef = React.useRef(false)
      const refreshAfterSave = React.useRef(false)
      const baseline = React.useRef({})
      const dirty = React.useRef(new Set())
      const draftRef = React.useRef(draft)
      draftRef.current = draft
      const effectiveProxyMode = account?.generationMode ? account.generationMode.requested === 'proxy' : savedProxyMode
      const activeModeRef = React.useRef(effectiveProxyMode)
      activeModeRef.current = effectiveProxyMode
      React.useEffect(() => { props.readQuota?.observeMode?.(effectiveProxyMode ? PROXY_PROVIDER : PROVIDER) }, [effectiveProxyMode, props.readQuota])
      const proxyUnavailable = savedProxyMode && account?.generationMode?.proxyRouterReady === false
      const previousProxyAccount = React.useRef(undefined)
      const onProxyAccountChanged = React.useCallback((snapshot) => {
        const previous = previousProxyAccount.current
        previousProxyAccount.current = snapshot
        const identityChanged = previous?.revision !== snapshot.revision
        const connected = snapshot.phase === 'signed-in' && previous?.phase !== 'signed-in'
        const signedOut = snapshot.phase === 'signed-out' && previous?.phase === 'signed-in'
        props.readQuota?.observeProxyAccount?.(snapshot)
        if (savedProxyMode && (connected || signedOut || (identityChanged && !snapshot.connectionStage))) void pullModels(true)
        void accountAction('status')
      }, [savedProxyMode, pullModels, accountAction, props.readQuota])
      React.useEffect(() => {
        let current = true
        Promise.resolve().then(() => remote?.llm?.listProviders?.()).then(unwrap).then((providers) => {
          if (current && alive.current && Array.isArray(providers)) setRegistered(providers.some((row) => row?.id === (effectiveProxyMode ? PROXY_PROVIDER : PROVIDER)))
        }).catch(() => { if (current && alive.current) setRegistered(false) })
        return () => { current = false }
      }, [effectiveProxyMode, remote])

      const editField = React.useCallback((key, value) => {
        if (savingRef.current) return
        const next = { ...draftRef.current, [key]: value }
        draftRef.current = next
        if (value === baseline.current[key]) dirty.current.delete(key)
        else dirty.current.add(key)
        setDirtyKeys([...dirty.current])
        setConflicts((previous) => previous.filter((field) => field !== key))
        setDraft(next)
      }, [])

      /**
       * 单条模型设置：合并成整份 modelOverrides 再交给通用编辑路径，
       * 这样草稿、冲突与只提交改动项的行为和其它字段完全一致。
       */
      const editOverride = React.useCallback((id, patch) => {
        if (savingRef.current) return
        const current = overrideFor(draftRef.current[OVERRIDES_KEY], id)
        const merged = canonicalOverride(id, { ...current, ...patch })
        const overrides = canonicalOverrides(draftRef.current[OVERRIDES_KEY])
        if (Object.keys(merged).length === 0) delete overrides[id]
        else overrides[id] = merged
        const value = overrides
        const next = { ...draftRef.current, [OVERRIDES_KEY]: value }
        draftRef.current = next
        if (sameOverrides(value, baseline.current[OVERRIDES_KEY])) dirty.current.delete(OVERRIDES_KEY)
        else dirty.current.add(OVERRIDES_KEY)
        setDirtyKeys([...dirty.current])
        setConflicts((previous) => previous.filter((field) => field !== OVERRIDES_KEY))
        setDraft(next)
      }, [])

      /** 编排设置：合并成整份 orchestrator 对象再参与脏值、冲突与通用保存路径。 */
      const editOrchestrator = React.useCallback((patch) => {
        if (savingRef.current) return
        const current = draftRef.current[ORCHESTRATOR_KEY] && typeof draftRef.current[ORCHESTRATOR_KEY] === 'object'
          ? draftRef.current[ORCHESTRATOR_KEY]
          : orchestratorDraftFrom(undefined)
        const value = { ...current, ...patch }
        const next = { ...draftRef.current, [ORCHESTRATOR_KEY]: value }
        draftRef.current = next
        if (isOrchestratorDraftValid(value) && sameOrchestrator(value, baseline.current[ORCHESTRATOR_KEY])) {
          dirty.current.delete(ORCHESTRATOR_KEY)
        } else {
          dirty.current.add(ORCHESTRATOR_KEY)
        }
        setDirtyKeys([...dirty.current])
        setConflicts((previous) => previous.filter((field) => field !== ORCHESTRATOR_KEY))
        setDraft(next)
      }, [])

      const reload = React.useCallback(async (preserveStatus = false) => {
        const version = ++settingsVersion.current
        // 同步段整体兜底：remote.<ns> 是代理属性，缺 inject 时连「读属性」都会抛；
        // 这里降级为卡片内可读错误，绝不让异常穿出组件击穿 settings.section。
        try {
          if (!remote?.settings?.describe) {
            setStatus({ kind: 'error', text: t('宿主未提供 settings.describe，无法在此编辑配置') })
            setLoading(false)
            return
          }
          setLoading(true)
          const described = Promise.resolve(remote.settings.describe()).then(unwrap)
          const providers = Promise.resolve(remote.llm?.listProviders?.())
            .then((value) => unwrap(value))
            .catch(() => [])
            .then((rows) => (Array.isArray(rows) ? rows : []))
          const [settings, rows] = await Promise.all([described, providers])
          if (!alive.current || version !== settingsVersion.current) return
          const namespaces = Array.isArray(settings?.namespaces) ? settings.namespaces : []
          // 只按精确 namespace 匹配：按字段回退会命中别人的配置，而保存用的
          // revision 也必须来自同一份文档（同 profile 的 dsh-proxy 即如此）。
          const found = namespaces.find((item) => item?.ns === ENTRY_ID)
          setView(found ?? null)
          const current = found?.value && typeof found.value === 'object' ? found.value : {}
          const activeProvider = activeModeRef.current ? PROXY_PROVIDER : PROVIDER
          setSavedProxyMode(current.proxyMode === true)
          const server = Object.fromEntries(FIELDS.map((field) => [field.key, field.checkbox
            ? (field.defaultChecked ? current[field.key] !== false : current[field.key] === true)
            : field.lines ? (Array.isArray(current[field.key]) ? current[field.key].join('\n') : current[field.key] ?? '')
              : current[field.key] ?? field.defaultValue ?? '']))
          // 整份 map 作为一个字段参与脏值比较；规范化后再比，避免键序或
          // 「显式写回默认值」被误判为未保存修改。
          server[OVERRIDES_KEY] = canonicalOverrides(current[OVERRIDES_KEY])
          server[ORCHESTRATOR_KEY] = orchestratorDraftFrom(current[ORCHESTRATOR_KEY])
          const changed = []
          const next = { ...server }
          for (const key of dirty.current) {
            const same = key === OVERRIDES_KEY
              ? sameOverrides(draftRef.current[key], server[key])
              : key === ORCHESTRATOR_KEY
                ? isOrchestratorDraftValid(draftRef.current[key]) && sameOrchestrator(draftRef.current[key], server[key])
                : draftRef.current[key] === server[key]
            if (same) dirty.current.delete(key)
            else {
              next[key] = draftRef.current[key]
              const beforeSame = key === OVERRIDES_KEY
                ? sameOverrides(baseline.current[key], server[key])
                : key === ORCHESTRATOR_KEY
                  ? sameOrchestrator(baseline.current[key], server[key])
                  : baseline.current[key] === server[key]
              if (!beforeSame) changed.push(key)
            }
          }
          baseline.current = server
          draftRef.current = next
          setDraft(next)
          setDirtyKeys([...dirty.current])
          setConflicts((previous) => [...new Set([...previous.filter((key) => dirty.current.has(key)), ...changed])])
          setWritable(settings?.writable === true)
          setRegistered(rows.some((row) => row?.id === activeProvider))
          if (!found) setStatus({ kind: 'error', text: t('宿主尚未提供 Antigravity ACP 的可编辑设置。请确认 Host 与 Client 插件版本一致，并重新加载插件后刷新配置。') })
          else if (!preserveStatus) setStatus(null)
        } catch (cause) {
          if (alive.current && version === settingsVersion.current) setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
        } finally {
          if (alive.current && version === settingsVersion.current) setLoading(false)
        }
      }, [remote])

      const save = React.useCallback(async () => {
        if (!view || !writable || loading || savingRef.current || dirty.current.size === 0) return
        const invalid = FIELDS.find((field) => field.numeric && dirty.current.has(field.key)
          && (!Number.isSafeInteger(draftRef.current[field.key]) || draftRef.current[field.key] < (field.min ?? 0) || (field.max !== undefined && draftRef.current[field.key] > field.max)))
        if (invalid) {
          setStatus({ kind: 'error', text: invalid.max === undefined
            ? t('{label}必须是不小于 {min} 的整数。', { label: t(invalid.label), min: invalid.min ?? 0 })
            : t('{label}必须是 {min}–{max} 的整数。', { label: t(invalid.label), min: invalid.min, max: invalid.max }) })
          return
        }
        if (dirty.current.has(ORCHESTRATOR_KEY) && !isOrchestratorDraftValid(draftRef.current[ORCHESTRATOR_KEY])) {
          const maxField = ORCHESTRATOR_FIELDS.maxPlansPerTurn
          setStatus({ kind: 'error', text: t('{label}必须是 {min}–{max} 的整数。', { label: t(maxField.label), min: maxField.min, max: maxField.max }) })
          return
        }
        savingRef.current = true
        setSaving(true)
        setStatus({ kind: 'busy', text: t('保存中…') })
        // 只提交用户改动过的字段，空串也是有效改动；未编辑字段遵循最新服务端值。
        // modelOverrides 与 orchestrator 均为整份对象字段，按同样方式提交。
        const ops = [...FIELDS.map((field) => field.key), OVERRIDES_KEY, ORCHESTRATOR_KEY]
          .filter((key) => dirty.current.has(key))
          .map((key) => {
            const field = FIELDS.find((entry) => entry.key === key)
            const value = key === ORCHESTRATOR_KEY
              ? canonicalOrchestrator(draftRef.current[key])
              : field?.lines ? String(draftRef.current[key] ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : draftRef.current[key]
            return { op: 'set', path: [key], value }
          })
        try {
          unwrap(await remote.settings.mutate(ENTRY_ID, ops, view.revision))
          if (!alive.current) return
          for (const operation of ops) {
            const key = operation.path[0]
            const field = FIELDS.find((entry) => entry.key === key)
            const currentValue = key === ORCHESTRATOR_KEY
              ? canonicalOrchestrator(draftRef.current[key])
              : field?.lines ? String(draftRef.current[key] ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : draftRef.current[key]
            if (JSON.stringify(currentValue) === JSON.stringify(operation.value)) dirty.current.delete(key)
          }
          setDirtyKeys([...dirty.current])
          setConflicts([])
          setStatus({ kind: 'ok', text: ops.some((operation) => operation.path[0] === 'proxyMode')
            ? t('已保存并切换模式，请在会话中选择对应模型。')
            : t('已保存；进行中的会话不会被中断。') })
          await reload(true)
          void accountAction('status')
          void pullModels(true)
        } catch (cause) {
          if (!alive.current) return
          setStatus({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
          // 修订号冲突时同步新基线，仍保留本地草稿，供用户检查后再次保存。
          await reload(true)
        } finally {
          savingRef.current = false
          if (alive.current) {
            setSaving(false)
            if (refreshAfterSave.current) { refreshAfterSave.current = false; void reload(true) }
          }
        }
      }, [loading, writable, remote, reload, view, accountAction, pullModels])

      React.useEffect(() => {
        reload()
        const off = remote?.$on?.('settings/document-updated', (ns) => {
          if (!ns || ns === ENTRY_ID) {
            if (savingRef.current) refreshAfterSave.current = true
            else void reload()
          }
        })
        return () => {
          ++settingsVersion.current
          if (typeof off === 'function') off()
        }
      }, [reload, remote])

      // 目录条目 + 已配置但目录里暂时没有的 ID：正在编辑的映射不能因为目录刷新而消失。
      const rows = modelRows(models, draft[OVERRIDES_KEY], effectiveProxyMode)
      const editingDisabled = loading || saving || !view || !writable
      const connectionSettingsDirty = dirtyKeys.some(key => key === 'proxyUrl' || key === 'proxyBypass')
      const discardDraft = () => {
        if (savingRef.current) return
        dirty.current.clear()
        draftRef.current = { ...baseline.current }
        setDraft(draftRef.current)
        setDirtyKeys([])
        setConflicts([])
        setStatus({ kind: 'ok', text: t('已撤销未保存修改。') })
      }

      const connection = connectionStatus(account, registered)
      const fieldsFor = (group) => FIELDS.filter((field) => field.group === group
        && (!effectiveProxyMode || !field.acpOnly)
        && (effectiveProxyMode || !field.proxyOnly))
      const fieldProps = { draft, dirtyKeys, conflicts, disabled: editingDisabled, editField }
      const pageStyle = (id) => ({ display: settingsPage === id ? 'flex' : 'none', flexDirection: 'column', gap: '14px' })
      const pageButton = (id, label) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': settingsPage === id, 'aria-controls': 'agy-settings-page-' + id,
        className: 'agy-tab',
        onClick: () => setSettingsPage(id),
      }, label)
      const busy = ['connecting', 'cancelling'].includes(account?.state) || runtimeBusy(account?.runtime)
      const readonly = !loading && view && !writable
      const saveVisible = dirtyKeys.length > 0 || loading || readonly || conflicts.length > 0 || Boolean(status)
      const modeColor = registered === false ? '#ef4444' : effectiveProxyMode ? '#eab308' : connection.color

      return h('div', { className: 'antigravity-settings-card', style: { padding: '6px 2px 24px', display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '760px', margin: '0 auto', boxSizing: 'border-box', lineHeight: 1.5 } },
        h('header', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 } },
            h('h2', { style: { margin: 0, fontSize: '20px', fontWeight: 700, lineHeight: 1.2, letterSpacing: '-.02em' } }, 'Antigravity ACP'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '12px', opacity: .68 } },
              h(StatusDot, { color: modeColor }),
              h('span', null, t(registered === false ? '路由未注册' : effectiveProxyMode ? '代理模式' : 'ACP 模式')),
              !effectiveProxyMode ? h('span', null, '· ' + connection.label) : null))),
        h('div', { role: 'region', 'aria-label': t('设置保存操作'), style: { position: 'sticky', top: 0, zIndex: 20, flexShrink: 0, margin: '-6px -6px 0', padding: '6px 0', display: saveVisible ? 'grid' : 'none', gap: '6px', background: 'var(--dsh-surface, Canvas)' } },
          h('div', { style: { display: 'grid', gap: '6px', padding: '10px 14px', borderRadius: '12px', backdropFilter: 'blur(12px)', border: dirtyKeys.length ? '1px solid rgba(59,130,246,.35)' : '1px solid var(--agy-line)', background: dirtyKeys.length ? 'rgba(59,130,246,.12)' : 'color-mix(in srgb, currentColor 6%, transparent)' } },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
            h('button', { type: 'button', onClick: save, disabled: editingDisabled || dirtyKeys.length === 0, style: { ...PRIMARY, minHeight: '30px', padding: '4px 12px' } }, t(saving ? '保存中…' : '保存')),
            dirtyKeys.length ? h('button', { type: 'button', disabled: loading || saving, onClick: discardDraft, style: { ...ACTION, minHeight: '30px', padding: '4px 10px' } }, t('撤销')) : null,
            h('span', { role: 'status', 'aria-live': 'polite', style: { fontSize: '12px', opacity: .72 } }, dirtyKeys.length ? t('{count} 项未保存', { count: dirtyKeys.length }) : loading ? t('正在读取…') : readonly ? t('只读设置') : ''),
            h('button', { type: 'button', title: t('重新读取配置并保留草稿'), disabled: loading || saving, onClick: () => reload(), style: { ...ACTION, minHeight: '30px', padding: '4px 9px', borderColor: 'transparent', background: 'transparent', opacity: .72, marginLeft: 'auto' } }, t(loading ? '刷新中…' : '刷新'))),
          conflicts.length ? h('p', { role: 'alert', style: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--agy-warn-text, #ca8a04)' } }, t('以下内容已在其他位置更新，已保留你的输入：') + conflicts.map((key) => t(key === OVERRIDES_KEY ? OVERRIDES_LABEL : key === ORCHESTRATOR_KEY ? ORCHESTRATOR_LABEL : FIELDS.find((field) => field.key === key)?.label ?? key)).join(t('、'))) : null,
          h(StatusNotice, { status }))),

        connectionSettingsDirty ? h(StatusNotice, { status: { kind: 'busy', text: t('请先保存网络设置，再连接或登录。') } }) : null,
        proxyUnavailable ? h(StatusNotice, { status: { kind: 'error', text: t('代理路由未就绪，ACP 保持停用。请启用 Antigravity Proxy Router 组件。') } }) : null,
        h('div', { role: 'tablist', 'aria-label': t('设置分页'), className: 'agy-tabs' },
          pageButton('connection', t('连接')),
          pageButton('models', t('模型')),
          pageButton('quota', t('额度')),
          pageButton('advanced', t('高级'))),

        h('div', { id: 'agy-settings-page-connection', role: 'tabpanel', style: pageStyle('connection') },
          h('section', { 'aria-label': t('运行模式') },
            h(SectionHeading, { title: t('运行模式') }),
            h('div', { style: PANEL },
              h(SettingsFields, { ...fieldProps, fields: fieldsFor('mode') }),
              dirtyKeys.includes('proxyMode') ? h('p', { role: 'status', style: { margin: '8px 0 0', fontSize: '11.5px', color: 'var(--agy-warn-text, #ca8a04)' } }, t('保存后切换到{mode}', { mode: t(draft.proxyMode ? '代理模式' : 'ACP 模式') })) : null)),
          effectiveProxyMode
            ? h('section', { 'aria-label': t('代理账户') },
              h(SectionHeading, { title: t('代理账户') }),
              h('div', { style: PANEL },
                h(ProxyAccountPanel, { control: props.proxyControl, onAccountChanged: onProxyAccountChanged, disabled: !props.proxyControl || !view || !writable, connectDisabled: editingDisabled || connectionSettingsDirty })))
            : h('section', { 'aria-label': t('账户连接') },
              h(SectionHeading, { title: t('ACP 账户与连接') }),
              h('div', { style: PANEL },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', borderRadius: '12px', background: connection.color + '1a', border: '1px solid ' + connection.color + '47', marginBottom: '12px' } },
                  h('span', { 'aria-hidden': true, style: { width: '30px', height: '30px', borderRadius: '50%', background: connection.color, color: connection.busy ? '#1f1300' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 700, flex: 'none' } }, connection.ready ? '✓' : connection.error ? '×' : '!'),
                  h('div', { style: { minWidth: 0, flex: 1 } },
                    h('div', { style: { fontSize: '14px', fontWeight: 700, lineHeight: 1.25 } }, connection.label),
                    h('p', { role: 'status', style: { fontSize: '11.5px', lineHeight: 1.45, opacity: .75, overflowWrap: 'anywhere', margin: '2px 0 0' } }, connection.description))),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
                  h('button', { type: 'button', style: PRIMARY, disabled: !props.control || busy || connectionSettingsDirty, onClick: () => accountAction('login') }, t(account?.state === 'connecting' ? '正在连接…' : '连接 / 登录 ACP')),
                  h('button', { type: 'button', style: ACTION, disabled: !props.control || busy || connection.ready || connectionSettingsDirty, onClick: () => accountAction('warmup') }, t(connection.ready ? '已预热' : '立即预热')),
                  ['connecting', 'cancelling'].includes(account?.state) ? h('button', { type: 'button', style: ACTION, disabled: account?.state === 'cancelling', onClick: () => accountAction('cancel') }, t(account?.state === 'cancelling' ? '正在取消…' : '取消连接')) : null)))),

        h('div', { id: 'agy-settings-page-models', role: 'tabpanel', style: pageStyle('models') },
          h('section', { 'aria-label': t('模型列表') },
            h(SectionHeading, { title: t('模型'),
              action: h('button', { type: 'button', title: t('刷新模型目录'), 'aria-label': t('刷新模型目录'), 'aria-busy': modelBusy || undefined, style: { ...ACTION, minHeight: '26px', padding: '3px 10px', flex: '0 0 auto', whiteSpace: 'nowrap' }, disabled: modelBusy || !props.control, onClick: () => pullModels(true) }, t(modelBusy ? '正在刷新…' : '刷新')) }),
            h(ModelOverrideList, { rows, overrides: draft[OVERRIDES_KEY], disabled: editingDisabled, onEdit: editOverride }),
            modelMessage ? h('p', { role: 'status', style: { fontSize: '11.5px', lineHeight: 1.5, opacity: .66, margin: '6px 0 0', overflowWrap: 'anywhere' } }, t(modelMessage)) : null)),

        h('div', { id: 'agy-settings-page-quota', role: 'tabpanel', style: pageStyle('quota') },
          h(SettingsQuotaPanel, { readQuota: props.readQuota, source: effectiveProxyMode ? PROXY_PROVIDER : PROVIDER,
            accountRevision: effectiveProxyMode ? previousProxyAccount.current?.revision : undefined,
            cliQuotaOn: (dirtyKeys.includes('cliQuotaEnabled') ? baseline.current.cliQuotaEnabled : draft.cliQuotaEnabled) === true,
            cliQuotaDirty: dirtyKeys.includes('cliQuotaEnabled') }),
          h('section', { 'aria-label': t('额度取数方式') },
            h(SectionHeading, { title: t('CLI 额度（可选）') }),
            h('div', { style: PANEL },
              h(SettingsFields, { ...fieldProps, fields: fieldsFor('quota') })))),

        h('div', { id: 'agy-settings-page-advanced', role: 'tabpanel', style: pageStyle('advanced') },
          !effectiveProxyMode ? h('section', { 'aria-label': t('常用设置') },
            h(SectionHeading, { title: t('会话偏好') }),
            h('div', { style: PANEL },
              h(SettingsFields, { ...fieldProps, fields: fieldsFor('general') }))) : null,
          h(OrchestratorSection, { value: draft[ORCHESTRATOR_KEY], dirty: dirtyKeys.includes(ORCHESTRATOR_KEY), disabled: editingDisabled, onEdit: editOrchestrator }),
          h(SettingsGroup, { title: t('网络与 CLI'), fields: fieldsFor('network'), fieldProps, open: effectiveProxyMode }),
          !effectiveProxyMode ? h(SettingsGroup, { title: t('会话与进程'), fields: fieldsFor('advanced'), fieldProps }) : null,
          !effectiveProxyMode ? h(PlainConfigDisclosure, { labels: PLAIN_FIELD_LABELS }) : null,
          !effectiveProxyMode ? h('details', { className: 'agy-fold', style: { border: '1px solid var(--agy-line)', borderRadius: '10px', background: 'color-mix(in srgb, currentColor 3%, transparent)', padding: '8px 12px' }, 'aria-label': t('连接诊断') },
            h('summary', { style: SUMMARY },
              h('span', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                h(StatusDot, { color: connection.color }),
                h('span', { style: { fontSize: '12.5px', fontWeight: 550 } }, t('连接诊断'))),
              h('small', { style: { fontSize: '11px', opacity: .58 } }, t('状态、并发与耗时'))),
            h('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--agy-line)' } },
              account?.runtime ? RuntimeDetails({ runtime: account.runtime }) : h('p', { style: { margin: 0, fontSize: '12px', opacity: .6 } }, t('连接后显示运行详情。')))) : null))
    }

    /**
     * 额度药丸：只在当前会话模型属于 antigravity-acp 时出现，位置是
     * `conversation.input.right`（宿主 InputBar 里它渲染在模型选择器之前，
     * 即「Provider 选择器左边」）。取数经 Host 的 remote.agyQuota.read。
     */
    const PILL_ID = 'antigravity-quota'

    const TRACK = 'rgba(128,128,128,.22)'
    const CARD = { padding: '10px 12px', borderRadius: '10px', background: 'rgba(128,128,128,.07)' }
    const PANEL = { padding: '12px 14px', borderRadius: '12px', border: '1px solid color-mix(in srgb, currentColor 12%, transparent)', background: 'color-mix(in srgb, currentColor 4%, transparent)' }
    const SUMMARY = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', cursor: 'pointer', listStyle: 'none' }
    const ACTION = { padding: '4px 12px', minHeight: '30px', borderRadius: '8px', border: '1px solid color-mix(in srgb, currentColor 20%, transparent)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12.5px', fontWeight: 500, cursor: 'pointer' }
    const PRIMARY = { ...ACTION, background: '#3b82f6', border: '1px solid #3b82f6', color: '#fff', fontWeight: 500 }
    // 上游额度池已合并为 Gemini / Claude·GPT 两组；不再预建 Argon 空组，
    // 未匹配名称的分组仍由 quotaGroups 的 other-* 兜底展示。
    const GROUPS = [{ key: 'gemini', name: 'Gemini' }, { key: 'claude', name: 'Claude / GPT' }]
    function groupKey(name) {
      const text = String(name ?? '').toLowerCase()
      // 额度池合并后无独立 Argon 组：上游若仍按旧结构返回，并入 Gemini 展示。
      if (/\bargon\b/.test(text)) return 'gemini'
      if (/\bgemini\b/.test(text)) return 'gemini'
      if (/\b(claude|gpt)\b/.test(text)) return 'claude'
      return undefined
    }
    function modelGroup(model) {
      const id = String(model ?? '').toLowerCase().replace(/^antigravity-/, '')
      // 额度池合并后无独立 Argon 组，Argon 型号与其他 Gemini 共用 Gemini 组。
      if (/^gemini-/.test(id)) return 'gemini'
      if (/^(claude|gpt)-/.test(id)) return 'claude'
      return undefined
    }
    function quotaGroups(data) {
      const groups = Array.isArray(data?.groups) ? data.groups : []
      // 池合并后同一 key 只取首个匹配组：同 key 的后续组被静默并入首个（取舍：
      // 上游已合并为两组，重复 key 只可能是旧结构残留；未识别组名仍由 other-* 兜底）。
      return GROUPS.map((entry) => {
        const matched = groups.find((g) => groupKey(g.name) === entry.key)
        return { ...entry, buckets: matched?.buckets ?? [] }
      }).concat(groups.filter((g) => !groupKey(g.name)).map((g, i) => ({ ...g, key: 'other-' + i })))
    }
    function percentage(bucket) {
      return Number.isFinite(bucket?.remainingPct) ? Math.max(0, Math.min(100, bucket.remainingPct)) : undefined
    }
    function tone(bucket, stale) {
      const value = percentage(bucket)
      if (bucket?.disabled || value === undefined) return '#94a3b8'
      if (value <= 10) return '#ef4444'
      if (value <= 25) return '#f97316'
      if (value <= 50 || stale) return '#eab308'
      return '#22c55e'
    }
    function windowName(bucket) {
      return t(({ '5h': '5 小时', weekly: '每周', '7d': '每周' })[bucket.window] ?? bucket.window ?? bucket.name ?? '额度窗口')
    }
    /** 额度窗口短周期在上：5h → 每周 → 未知窗口兜底置后；不修改原数组。 */
    const WINDOW_ORDER = { '5h': 1, daily: 2, weekly: 3, '7d': 3 }
    function orderedBuckets(buckets) {
      return [...buckets].sort((a, b) => (WINDOW_ORDER[a?.window] ?? 99) - (WINDOW_ORDER[b?.window] ?? 99))
    }
    function resetCountdown(value) {
      const seconds = Math.ceil((Date.parse(value) - Date.now()) / 1000)
      if (!Number.isFinite(seconds)) return t('未提供重置时间')
      if (seconds <= 0) return t('重置时间已到，待刷新')
      const minutes = Math.ceil(seconds / 60)
      if (minutes >= 1440) return t('{days}天 {hours}小时后重置', { days: Math.floor(minutes / 1440), hours: Math.floor(minutes % 1440 / 60) })
      if (minutes >= 60) return t('{hours}小时 {minutes}分钟后重置', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
      return t('{minutes}分钟后重置', { minutes })
    }
    function remainingBar(bucket, compact, stale, label, compactHeight = 4) {
      const pct = percentage(bucket)
      const unknown = pct === undefined || bucket.disabled
      return h('span', {
        role: 'progressbar', 'aria-label': label,
        'aria-valuemin': 0, 'aria-valuemax': 100,
        ...(unknown ? { 'aria-valuetext': t(bucket.disabled ? '已停用' : '额度未知') } : { 'aria-valuenow': pct }),
        style: { display: 'block', width: compact ? '34px' : '100%', height: compact ? compactHeight + 'px' : '4px', borderRadius: '99px', overflow: 'hidden', background: TRACK },
      }, h('span', { style: { display: 'block', height: '100%', width: unknown ? '100%' : pct + '%', opacity: unknown ? .35 : 1, borderRadius: '99px', background: tone(bucket, stale) } }))
    }
    function useQuota(readQuota, enabled = true, source, model, accountRevision) {
      const [data, setData] = React.useState(null)
      const [refreshing, setRefreshing] = React.useState(false)
      const version = React.useRef(0)
      const currentSource = React.useRef(source)
      const currentModel = React.useRef(model)
      const manual = React.useRef(false)
      currentModel.current = model
      const update = React.useCallback((value) => setData(value), [])
      const load = React.useCallback((force = false) => {
        if (!enabled || !readQuota || manual.current) return Promise.resolve()
        const current = ++version.current
        manual.current = force
        if (force) setRefreshing(true)
        return Promise.resolve().then(() => readQuota(force, source, model)).then(unwrap).then((value) => {
          if (current === version.current) update(value)
        }).catch((error) => {
          if (current === version.current) {
            const message = error instanceof Error ? error.message : String(error)
            setData((previous) => previous?.status === 'ok'
              ? { ...previous, stale: true, staleReason: message }
              : { status: 'error', groups: [], error: { message } })
          }
        }).finally(() => { if (current === version.current) { manual.current = false; setRefreshing(false) } })
      }, [readQuota, enabled, update, source, model])
      React.useEffect(() => {
        currentSource.current = source
        manual.current = false
        setData(null)
        setRefreshing(false)
        if (!enabled || !readQuota) { setData(null); return undefined }
        void load(false)
        const off = readQuota.subscribe?.((value, origin) => {
          if (origin !== undefined && origin !== source) return
          if (value?.requestedModel !== undefined && value.requestedModel !== currentModel.current) return
          if (value === null) {
            ++version.current; manual.current = false; update(null); setRefreshing(false)
            void load(false)
            return
          }
          if (manual.current) return
          ++version.current; update(value); setRefreshing(false)
        })
        const timer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void load(false) }, 15_000)
        return () => { ++version.current; clearInterval(timer); off?.() }
      }, [load, enabled, readQuota, update, source, model, accountRevision])
      return { data: currentSource.current === source ? data : null, refreshing, load }
    }
    function CreditsDetails({ credits, pending }) {
      // 只隐藏「未开启」这一种主动关闭状态；开关已开但 CLI 缺失/不支持/上游无数据
      // 都是可排查故障，必须显示，不能静默吞掉。
      if (credits?.error?.code === 'cli-disabled') return null
      const valid = credits?.status === 'ok' && Number.isSafeInteger(credits.remainingCredits) && credits.remainingCredits >= 0
      const label = valid ? credits.remainingCredits.toLocaleString() : t(pending ? '正在读取…' : credits?.status === 'error' ? '查询失败' : '未提供')
      return h('section', { style: { padding: '9px 0', borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }, 'aria-label': t('AI Credits 余额') },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' } },
          h('strong', { style: { fontSize: '12px' } }, 'AI Credits'),
          h('strong', { style: { fontSize: valid ? '17px' : '12px', fontVariantNumeric: 'tabular-nums', color: credits?.stale ? 'var(--agy-warn-text, #ca8a04)' : 'inherit' } }, label)),
        credits?.planName || credits?.updatedAt ? h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '3px 10px', fontSize: '10.5px', opacity: .6, marginTop: '3px' } },
          credits?.planName ? h('span', null, credits.planName) : null,
          credits?.updatedAt ? h('span', null, t(valid ? '余额更新于 {time}' : '最近查询 {time}', { time: new Date(credits.updatedAt).toLocaleString() })) : null) : null,
        credits?.stale ? h('p', { role: 'status', style: { margin: '4px 0 0', fontSize: '10.5px', color: 'var(--agy-warn-text, #ca8a04)' } }, t('余额缓存 · {reason}', { reason: t(credits.staleReason ?? '余额刷新失败') })) : null,
        credits?.error?.message ? h('p', { role: credits.status === 'error' ? 'alert' : 'status', style: { margin: '4px 0 0', fontSize: '10.5px', overflowWrap: 'anywhere' } }, t(credits.error.message)) : null)
    }
    function SettingsQuotaPanel({ readQuota, source, accountRevision, cliQuotaOn, cliQuotaDirty }) {
      const { data, refreshing, load } = useQuota(readQuota, true, source, undefined, accountRevision)
      return h('section', { 'aria-label': t('套餐额度查询') },
        h(SectionHeading, { title: t('套餐额度'), description: t(source === PROXY_PROVIDER ? '代理账户' : 'ACP 账户') + (cliQuotaDirty ? t(' · CLI 开关未保存') : cliQuotaOn ? t(' · CLI 补充取数') : ''),
          action: h('button', { type: 'button', style: { ...ACTION, minHeight: '26px', padding: '3px 10px' }, disabled: !readQuota || refreshing, 'aria-busy': refreshing || undefined, onClick: () => load(true) }, t(refreshing ? '正在拉取…' : '拉取额度')) }),
        h('div', { style: PANEL },
          data && (data.error?.code !== 'not-fetched' || data.credits?.status === 'ok') ? QuotaDetails({ data, refreshing, source }) : h('p', { role: 'status', style: { margin: 0, fontSize: '12px', lineHeight: 1.5, opacity: .65 } }, t(refreshing ? '正在拉取…' : '暂无额度快照'))))
    }
    function QuotaDetails({ data, refreshing, load, model, source, onClose }) {
      const groups = quotaGroups(data)
      const allBuckets = groups.flatMap((g) => g.buckets ?? [])
      const worstPill = quotaPillStatus(data, allBuckets)
      const bannerColor = data?.status === 'error' ? (data.error?.code === 'not-fetched' ? '#94a3b8' : '#ef4444') : data?.stale ? '#eab308' : worstPill.color
      const headerStyle = onClose
        ? { position: 'sticky', top: -14, zIndex: 2, margin: '-14px -14px 0', padding: '14px 14px 8px', background: 'var(--dsh-surface, var(--dsw-alias-bg-layer-1, Canvas))', display: 'flex', gap: '8px', alignItems: 'center', borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }
        : { display: 'flex', gap: '8px', alignItems: 'center', paddingBottom: '10px', borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }
      return h('div', { style: { display: 'grid', gap: 0 } },
        h('div', { style: headerStyle },
          h('strong', { style: { fontSize: '14px', flex: 1 } }, t('Antigravity · 套餐额度')),
          data?.plan ? h('span', { style: { fontSize: '11px', padding: '2px 8px', background: 'rgba(128,128,128,.12)', borderRadius: '99px' } }, data.plan) : null,
          onClose ? h('button', { type: 'button', 'aria-label': t('关闭额度详情'), onClick: onClose, style: { ...ACTION, padding: '2px 7px', minHeight: '26px', minWidth: '26px', borderColor: 'transparent' } }, '×') : null),
        data?.stale ? h('p', { role: 'status', style: { margin: '8px 0 0', padding: '8px 10px', borderRadius: '10px', background: 'rgba(234,179,8,.10)', border: '1px solid rgba(234,179,8,.28)', color: 'var(--agy-warn-text, #ca8a04)', fontSize: '11.5px' } }, t('缓存数据 · {reason}', { reason: t(data.staleReason ?? '刷新失败') })) : null,
        data?.status === 'error' ? h('p', { role: data.error?.code === 'not-fetched' ? 'status' : 'alert', style: { margin: '8px 0 0', padding: '8px 10px', borderRadius: '10px', background: bannerColor + '1a', border: '1px solid ' + bannerColor + '47', color: data.error?.code === 'not-fetched' ? 'inherit' : '#ef4444', fontSize: '11.5px', overflowWrap: 'anywhere' } }, t(data.error?.message ?? data.error?.text ?? '额度读取失败')) : null,
        ...groups.map((group) => h('section', { key: group.key, style: { padding: '9px 0', borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }, 'aria-label': t('{name}额度', { name: group.name }) },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '7px' } },
            h('strong', { style: { fontSize: '12px' } }, group.name),
            group.key === modelGroup(model) ? h('span', { style: { fontSize: '10px', padding: '1px 6px', borderRadius: '99px', color: '#22c55e', background: 'rgba(34,197,94,.12)', fontWeight: 560 } }, t('当前模型')) : null),
          group.buckets.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px' } }, ...orderedBuckets(group.buckets).map((bucket, index) => {
            const pct = percentage(bucket)
            return h('div', { key: index, style: CARD },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '6px', marginBottom: '4px' } },
                h('span', { style: { fontSize: '11.5px', fontWeight: 600 } }, windowName(bucket)),
                h('strong', { style: { fontSize: bucket.disabled ? '12px' : '16px', fontVariantNumeric: 'tabular-nums' } }, bucket.disabled ? t('已停用') : pct === undefined ? t('未知') : Math.round(pct) + '%')),
              remainingBar(bucket, false, data?.stale, t('{name} {window}剩余额度', { name: group.name, window: windowName(bucket) })),
              h('div', { title: bucket.disabled ? bucket.description : bucket.resetTime, style: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: '10.5px', lineHeight: 1.35, opacity: .62, marginTop: '5px' } }, bucket.disabled ? t(bucket.description ?? '此窗口不可用') : resetCountdown(bucket.resetTime)))
          })) : h('span', { style: { opacity: .55, fontSize: '11px' } }, t(data ? '未提供额度数据' : '正在读取…')))),
        CreditsDetails({ credits: data?.credits, pending: !data }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '10px' } },
          h('small', { style: { flex: 1, opacity: .55, minWidth: 0, fontSize: '11px' } }, data?.status === 'ok' && data.updatedAt ? t('更新于 {time}', { time: new Date(data.updatedAt).toLocaleString() }) : t('尚无成功快照')),
          load ? h('button', { type: 'button', disabled: refreshing, onClick: () => load(true), style: { padding: '4px 12px', borderRadius: '8px', border: 'none', background: 'rgba(59,130,246,.14)', color: '#3b82f6', font: 'inherit', fontSize: '12px', fontWeight: 500, cursor: 'pointer' } }, t(refreshing ? '刷新中…' : '刷新额度')) : null))
    }
    /** 紧凑余量条与单词状态的交互参考 dsh-subusage；取数仍由本插件负责。 */
    function quotaPillStatus(data, buckets) {
      if (!data) return { short: '', icon: '…', color: '#94a3b8' }
      if (data.error?.code === 'not-fetched') return { short: t('暂无'), icon: '?', color: '#94a3b8' }
      if (data.status === 'error') return { short: t('失败'), icon: '!', color: '#ef4444', tint: true }
      if (data.stale) return { short: t('缓存'), icon: '!', color: '#eab308', tint: true }
      const usable = buckets.filter(bucket => !bucket.disabled && percentage(bucket) !== undefined)
      if (!usable.length) return { short: t(buckets.some(bucket => bucket.disabled) ? '受限' : '未知'), icon: '?', color: '#94a3b8' }
      const minimum = Math.min(...usable.map(percentage))
      if (minimum === 0) return { short: t('已用尽'), color: '#ef4444', tint: true }
      if (minimum <= 10) return { short: t('紧张'), color: '#ef4444', tint: true }
      if (minimum <= 25) return { short: t('偏少'), color: '#f97316', tint: true }
      return { short: '', color: '#22c55e' }
    }
    function AgYQuotaPill({ store, readQuota, proxyControl }) {
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const isAcp = state?.current?.provider === PROVIDER
      const isProxy = state?.current?.provider === PROXY_PROVIDER
      const enabled = isAcp || isProxy
      const model = state?.current?.model
      const quota = useQuota(readQuota, enabled, state?.current?.provider, model)
      const [expanded, setExpanded] = React.useState(false)
      const [position, setPosition] = React.useState(null)
      const root = React.useRef(null)
      const button = React.useRef(null)
      React.useEffect(() => {
        if (!isProxy || !proxyControl) return
        let active = true
        let pending = false
        const check = async () => {
          if (pending) return
          pending = true
          try {
            const value = unwrap(await proxyControl('account', { action: 'status' }))
            if (active) readQuota?.observeProxyAccount?.(value.snapshot)
          } catch { /* 账户轮询失败不覆盖额度查询自身的结果。 */ }
          finally { pending = false }
        }
        void check()
        const timer = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void check()
        }, 3000)
        return () => { active = false; clearInterval(timer) }
      }, [isProxy, proxyControl, readQuota])
      React.useEffect(() => { setExpanded(false) }, [enabled])
      React.useLayoutEffect(() => {
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
      const groups = quotaGroups(quota.data)
      const family = modelGroup(quota.data?.routeModel ?? model)
      const group = groups.find((g) => g.key === family)
      const buckets = orderedBuckets(group?.buckets ?? [])
      const pillStatus = quotaPillStatus(quota.data, buckets)
      const miniBuckets = buckets.slice(0, 5)
      const miniHeight = miniBuckets.length <= 1 ? 6 : miniBuckets.length === 2 ? 5 : miniBuckets.length === 3 ? 4 : miniBuckets.length === 4 ? 3 : 2
      const modeTag = t(isProxy ? '代理' : 'ACP')
      const label = quota.data?.error?.code === 'not-fetched' ? t('暂无额度快照') : quota.data?.status === 'error' ? t('额度读取失败') : !quota.data ? t('正在读取额度') : !group ? t('额度未匹配，请选择具体模型') : !buckets.length ? t('额度未知') : buckets.map((b) => windowName(b) + ' ' + (b.disabled ? t('已停用') : percentage(b) === undefined ? t('额度未知') : t('{pct}% 剩余', { pct: Math.round(percentage(b)) }))).join(' · ')
      const title = modeTag + ' · ' + String(model ?? t('未选择模型')) + ' · ' + label + (quota.data?.stale ? t(' · 缓存数据') : '')
      return h('span', { ref: root, className: 'antigravity-usage-pill', 'data-expanded': String(expanded), style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h('button', { ref: button, type: 'button', title, 'aria-label': title, 'aria-expanded': expanded, 'aria-haspopup': 'dialog', onClick: () => setExpanded((value) => !value),
          style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: pillStatus.short ? '4px 11px 4px 9px' : '5px 10px', minHeight: '26px', boxSizing: 'border-box', borderRadius: '99px', border: '1px solid ' + (pillStatus.tint ? pillStatus.color + '73' : 'rgba(128,128,128,.3)'), background: pillStatus.tint ? pillStatus.color + '1a' : 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap', maxWidth: 'min(46vw, 240px)' } },
          miniBuckets.length ? h('span', { style: { display: 'grid', gap: miniBuckets.length <= 2 ? '3px' : '2px', opacity: quota.data?.stale ? .5 : 1 } }, ...miniBuckets.map((b, i) => h('span', { key: i }, remainingBar(b, true, quota.data?.stale, t('{name} {window}剩余额度', { name: group.name, window: windowName(b) }), miniHeight))))
            : h('span', { 'aria-hidden': true, style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '16px', height: '16px', borderRadius: '50%', background: pillStatus.color, color: '#fff', fontSize: '11px' } }, pillStatus.icon),
          pillStatus.short ? h('span', null, pillStatus.short) : null),
        expanded ? h('div', { className: 'antigravity-quota-popover', role: 'dialog', 'aria-label': t('Antigravity 额度详情'), style: { zIndex: 50, width: 'min(340px, calc(100vw - 24px))', maxHeight: 'min(70vh, calc(100vh - 72px))', overflowY: 'auto', boxSizing: 'border-box', overflowWrap: 'anywhere', padding: '14px', borderRadius: '14px', background: 'var(--dsh-surface, var(--dsw-alias-bg-layer-1, Canvas))', color: 'var(--dsh-text, var(--dsw-alias-label-primary, CanvasText))', border: '1px solid rgba(128,128,128,.28)', boxShadow: '0 12px 32px rgba(0,0,0,.28)', font: '12px/1.5 sans-serif',
          // 坐标全部由 useLayoutEffect 的 fixed 定位给出；首帧未算好时放屏外，
          // 不再用相对药丸的 absolute/right:0，避免贴左边缘时弹出层超出视口。
          ...(position ?? { position: 'fixed', left: -9999, top: 0 }) } },
          QuotaDetails({ ...quota, model, source: state?.current?.provider, onClose: () => { setExpanded(false); button.current?.focus?.() } })) : null)
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
      const epochs = new Map()
      const modelsBySource = new Map()
      let proxyAccountKey
      let mode
      const read = async (force, source, model) => {
        const deadline = Date.now() + 20_000
        for (;;) {
          // **只能用 `get()`**：`scope.remote.agyQuota` 这种属性访问在未 inject 的
          // 命名空间上会由 cordis 直接抛「cannot get property "remote.<ns>" without
          // inject」，而这正是本药丸的处境（贡献型 remote 由 $mount 挂载、不进 inject）。
          // 参考实现 dsh-subusage 同样是 `ctx.get("remote.subUsage")`。
          const service = scope.get('remote.agyQuota')
          const method = force ? 'refresh' : 'read'
          if (service && typeof service[method] === 'function') {
            return await withTimeout(
              service[method]({
                ...(source === PROVIDER ? { source: 'acp' } : source === PROXY_PROVIDER ? { source: 'proxy' } : {}),
                ...(model ? { model } : {}),
              }),
              force ? 60_000 : 5_000,
              t(force ? '额度拉取超时' : '额度快照读取超时'),
            )
          }
          if (Date.now() >= deadline) {
            throw new Error(t('额度服务未就绪（Host 端 remote.agyQuota 未挂载）'))
          }
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
      const reader = async (force, source, model) => {
        if (model) modelsBySource.set(source, model)
        const requestedModel = model ?? modelsBySource.get(source)
        const epoch = epochs.get(source) ?? 0
        const value = unwrap(await read(force, source, requestedModel))
        if (epoch !== (epochs.get(source) ?? 0)) throw new Error(t('账户已变化，请重新拉取额度'))
        for (const listener of listeners) {
          if (source === undefined) listener(value)
          else listener(value, source)
        }
        return value
      }
      reader.subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener) }
      reader.invalidate = (source) => {
        epochs.set(source, (epochs.get(source) ?? 0) + 1)
        for (const listener of listeners) listener(null, source)
      }
      reader.observeProxyAccount = (snapshot) => {
        if (!snapshot) return
        const key = JSON.stringify([snapshot.revision, snapshot.phase === 'signed-in', snapshot.email])
        if (proxyAccountKey !== undefined && key !== proxyAccountKey) {
          proxyAccountKey = key
          reader.invalidate(PROXY_PROVIDER)
        } else proxyAccountKey = key
      }
      reader.observeMode = (source) => {
        if (mode !== undefined && mode !== source) {
          mode = source
          reader.invalidate(PROVIDER)
          reader.invalidate(PROXY_PROVIDER)
        } else mode = source
      }
      return reader
    }

    function makeControlReader(scope) {
      return async (method, request) => {
        if (!['account', 'models'].includes(method)) throw new Error(t('不支持的设置操作'))
        const deadline = Date.now() + 20_000
        for (;;) {
          const service = scope.get('remote.agyQuota')
          if (typeof service?.[method] === 'function') {
            const pending = service[method](request)
            // 目录发现可能包含冷启动；各阶段超时由 Host 管理，客户端不另设更短的总期限。
            return method === 'models' ? await pending : await withTimeout(pending, 60_000, t('设置操作超时，请重试'))
          }
          if (Date.now() >= deadline) throw new Error(t('设置控制服务未就绪，请确认 Host 与 Client 版本一致'))
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
    }

    /** 代理账户控制读取器：remote.agyProxyAccount 由 Host 的代理行注册。 */
    function makeProxyControlReader(scope) {
      return async (method, request) => {
        if (method !== 'account') throw new Error(t('不支持的代理账户操作'))
        const deadline = Date.now() + 20_000
        for (;;) {
          const service = scope.get('remote.agyProxyAccount')
          if (typeof service?.account === 'function') {
            return await withTimeout(service.account(request), 60_000, t('代理账户操作超时，请重试'))
          }
          if (Date.now() >= deadline) throw new Error(t('代理账户服务未就绪：请确认已启用本插件的代理路由组件（antigravity-proxy-router）'))
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
    const AGY_PROXY_ACCOUNT_SERVICE = 'agyProxyAccount'

    function strictCodec(typeSymbol, parse) {
      const schema = { parse }
      return { mode: 'strict', typeSymbol, create: () => schema }
    }

    function parseProxyAccountRequest(value) {
      if (value === undefined || value === null) return {}
      if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid AgYProxyAccountRequest')
      if (value.action !== undefined && !['status', 'login', 'cancel', 'logout'].includes(value.action)) throw new TypeError('Invalid AgYProxyAccountRequest.action')
      return value
    }

    function parseProxyAccountResult(value) {
      if (!value || typeof value !== 'object' || typeof value.message !== 'string' || !value.snapshot || typeof value.snapshot !== 'object') throw new TypeError('Invalid AgYProxyAccountResult')
      return value
    }

    function parseQuotaRequest(value) {
      if (value === undefined || value === null) return undefined
      if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid AgYQuotaRequest')
      if (value.force !== undefined && typeof value.force !== 'boolean') throw new TypeError('Invalid AgYQuotaRequest.force')
      if (value.source !== undefined && !['acp', 'proxy'].includes(value.source)) throw new TypeError('Invalid AgYQuotaRequest.source')
      if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim())) throw new TypeError('Invalid AgYQuotaRequest.model')
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
        ...['read', 'refresh'].map((method) => ({
          id: `${AGY_QUOTA_PACKAGE}#${AGY_QUOTA_SERVICE}/${method}`,
          service: AGY_QUOTA_SERVICE,
          namespace: AGY_QUOTA_SERVICE,
          method,
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
        })),
        ...['account', 'models'].map((method) => ({
          id: `${AGY_QUOTA_PACKAGE}#${AGY_QUOTA_SERVICE}/${method}`, service: AGY_QUOTA_SERVICE, namespace: AGY_QUOTA_SERVICE, method,
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true,
            codec: method === 'models' ? strictCodec(`${AGY_QUOTA_PACKAGE}#AgYQuotaRequest`, parseQuotaRequest)
              : strictCodec(`${AGY_QUOTA_PACKAGE}#AgYAccountRequest`, (value) => {
                if (value === undefined) return { action: 'status' }
                if (!value || typeof value !== 'object' || !['status', 'login', 'warmup', 'cancel'].includes(value.action)) throw new TypeError('Invalid AgYAccountRequest')
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

    const AGY_PROXY_REMOTE = {
      package: AGY_QUOTA_PACKAGE,
      descriptors: [
        {
          id: `${AGY_QUOTA_PACKAGE}#${AGY_PROXY_ACCOUNT_SERVICE}/account`,
          service: AGY_PROXY_ACCOUNT_SERVICE,
          namespace: AGY_PROXY_ACCOUNT_SERVICE,
          method: 'account',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: strictCodec(`${AGY_QUOTA_PACKAGE}#AgYProxyAccountRequest`, parseProxyAccountRequest) }],
          result: strictCodec(`${AGY_QUOTA_PACKAGE}#AgYProxyAccountResult`, parseProxyAccountResult),
        },
      ],
    }

    return {
      name: 'dsh-bundle-antigravity-host',
      // remote.settings / remote.llm 必须逐个声明：remote 各命名空间是独立服务，
      // 漏声明会在读取属性时抛「without inject」并击穿 settings.section 卡片。
      inject: ['slots', 'remote', 'remote.settings', 'remote.llm'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined' || !document.head || !document.createElement) return () => {}
          const style = document.createElement('style')
          style.textContent = [
            ':where(.antigravity-settings-card,.antigravity-usage-pill,.antigravity-quota-popover){--agy-accent:#3b82f6;--agy-warn-text:#ca8a04;--agy-line:color-mix(in srgb,currentColor 12%,transparent);--agy-line-strong:color-mix(in srgb,currentColor 20%,transparent);--agy-surface:color-mix(in srgb,currentColor 4%,transparent);--agy-surface-2:color-mix(in srgb,currentColor 7%,transparent);color-scheme:light}',
            ':where(body[data-ds-dark-theme],.dark,[data-theme=dark],[data-color-scheme=dark]) :is(.antigravity-settings-card,.antigravity-quota-popover),:is(.antigravity-settings-card,.antigravity-quota-popover):where(.dark,[data-theme=dark],[data-color-scheme=dark]){--agy-warn-text:#eab308;color-scheme:dark}',
            '@media (prefers-color-scheme:dark){:where(:root:not(.light,[data-theme=light],[data-color-scheme=light],[data-ds-theme-source=light],[data-ds-dark-theme=false])) :is(.antigravity-settings-card,.antigravity-quota-popover){--agy-warn-text:#eab308;color-scheme:dark}}',
            '.antigravity-settings-card select option,.antigravity-quota-popover select option{color:CanvasText;background:Canvas}',
            '.antigravity-settings-card .agy-tabs{display:flex;gap:2px;overflow-x:auto;border-bottom:1px solid var(--agy-line)}',
            '.antigravity-settings-card .agy-tab{flex:none;min-height:34px;padding:6px 12px;margin-bottom:-1px;border:0;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;background:transparent;color:inherit;opacity:.68;font:inherit;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap}',
            '.antigravity-settings-card .agy-tab:hover{opacity:.95;background:var(--agy-surface)}',
            '.antigravity-settings-card .agy-tab[aria-selected=true]{opacity:1;font-weight:600;border-bottom-color:var(--agy-accent)}',
            '.antigravity-settings-card .agy-list{display:flex;flex-direction:column;border:1px solid var(--agy-line);border-radius:12px;background:var(--agy-surface);overflow:hidden}',
            '.antigravity-settings-card .agy-list>[role=listitem]:first-child{border-top:0!important}',
            '.antigravity-settings-card .agy-switch{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:36px;height:20px;margin:0;border:0;border-radius:999px;background:var(--agy-line-strong);cursor:pointer;transition:background .15s ease}',
            '.antigravity-settings-card .agy-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease}',
            '.antigravity-settings-card .agy-switch:checked{background:var(--agy-accent)}',
            '.antigravity-settings-card .agy-switch:checked::after{transform:translateX(16px)}',
            '.antigravity-settings-card .agy-switch:disabled{opacity:.85;cursor:not-allowed}',
            '.antigravity-settings-card .agy-fold summary::-webkit-details-marker{display:none}',
            '.antigravity-settings-card .agy-fold summary::before{content:"▸";font-size:11px;margin-right:6px;display:inline-block;transition:transform .15s ease}',
            '.antigravity-settings-card .agy-fold[open] summary::before{transform:rotate(90deg)}',
            '.antigravity-usage-pill>button:hover{background:color-mix(in srgb,currentColor 7%,transparent)}',
            '.antigravity-usage-pill button:focus-visible,.antigravity-settings-card button:focus-visible,.antigravity-settings-card input:focus-visible,.antigravity-settings-card select:focus-visible,.antigravity-settings-card a:focus-visible{outline:2px solid var(--agy-accent,#3b82f6);outline-offset:2px}',
            '.antigravity-settings-card button:disabled{cursor:not-allowed;opacity:.45}',
            'html[data-dsh-go-island][data-dsh-go-island-form="panel"] .antigravity-quota-popover{position:static!important;top:auto!important;bottom:auto!important;left:auto!important;right:auto!important;width:100%!important;max-height:none!important;overflow:visible!important;margin-top:8px;box-shadow:none!important;background:transparent!important;border-color:rgba(128,128,128,.2)!important}',
          ].join('')
          document.head.appendChild(style)
          return () => style.remove()
        }, 'antigravity: scoped control styles')
        const readQuota = makeQuotaReader(ctx)
        const control = makeControlReader(ctx)
        const proxyControl = makeProxyControlReader(ctx)
        // 挂载本包贡献的 remote（幂等，随 fiber 一起 dispose）。挂载失败不影响其它卡片：
        // 药丸会自行超时并显示「额度服务未就绪」的原因。
        try {
          const mounted = ctx.remote.$mount({
            package: AGY_QUOTA_PACKAGE,
            descriptors: [...AGY_QUOTA_REMOTE.descriptors, ...AGY_PROXY_REMOTE.descriptors],
          })
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
                  inject: () => ({ remote: ctx.remote, control, proxyControl, readQuota }),
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
                      proxyControl,
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
