import { buildClientSource } from '../scripts/client-bundle.mjs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** 组件返回的元素树节点（createElement 桩的产物）；条件渲染时可能返回 null。 */
interface StubElement {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

type StubComponent = (props: Record<string, unknown>) => StubElement | null

interface SlotRegistration {
  row: {
    id: string
    name?: string
    order?: number
    inject?: (sessionId: string) => Record<string, unknown>
  }
  component: StubComponent
}

/** 在带最小 React 桩的上下文里加载 client.js，取出它注册的全部槽条目。 */
/** 最近一次 `loadRegistrations` 期间，组件写 state 时传入的值（按顺序）。 */
let lastStateCalls: unknown[] = []
const effectCleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of effectCleanups.splice(0)) cleanup() })
afterEach(() => { vi.useRealTimers() })

/** 最近一次 `loadRegistrations` 期间，各处 `ctx.inject([...])` 声明的依赖列表。 */
let lastInjectDeps: string[][] = []
let latestStateValues: unknown[] = []

/** 最近一次 `loadRegistrations` 期间，`ctx.remote.$mount(...)` 收到的 remote 声明。 */
let lastMountCalls: Array<{ package?: string; descriptors?: Array<{ id?: string; method?: string }> }> = []

/** 注入的额度 remote 替身：药丸会 `scope.get('remote.agyQuota')` 后再 `.read()`。 */
interface QuotaStubOptions {
  /** 返回 remote 的原始回包（**未拆信封**），与真实网关一致。 */
  quotaRead?: () => Promise<unknown>
  models?: (request?: { force?: boolean }) => Promise<unknown>
  /**
   * 注入会话模型目录的当前 provider。药丸只在 provider 匹配时取数，因此要驱动
   * 取数链路就必须把它设成 `antigravity-acp`；缺省保持空快照（渲染即 null）。
   */
  quotaProvider?: string
  quotaSnapshot?: unknown
  stateOverrides?: Record<number, unknown>
  immediateUnmount?: boolean
  refOverrides?: Record<number, unknown>
  refStateBindings?: Record<number, number>
  listeners?: Map<string, (event: { key?: string; target?: unknown }) => void>
}

function loadRegistrations(options: QuotaStubOptions = {}): Map<string, SlotRegistration> {
  lastStateCalls = []
  latestStateValues = []
  lastInjectDeps = []
  lastMountCalls = []
  let registration: {
    factory: (require: (id: string) => unknown) => { apply: (ctx: Record<string, unknown>) => void }
  } | undefined
  runInNewContext(buildClientSource(), {
    window: { __ModuleLoader__: { load: (value: unknown) => { registration = value as typeof registration } }, innerHeight: 844,
      addEventListener: (type: string, fn: (event: { key?: string; target?: unknown }) => void) => options.listeners?.set(type, fn),
      removeEventListener: (type: string) => options.listeners?.delete(type),
    },
    // vm 上下文没有浏览器/Node 宿主 API；药丸的轮询定时器需要显式注入。
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    // 沿用测试进程的 Date：vi.setSystemTime 才能固定 client 的退役判定（vm 上下文默认有自己的内建 Date）。
    Date,
    document: {
      documentElement: { clientWidth: 375 },
      addEventListener: (type: string, fn: (event: { key?: string; target?: unknown }) => void) => options.listeners?.set(type, fn),
      removeEventListener: (type: string) => options.listeners?.delete(type),
    },
  })
  if (!registration) throw new Error('client.js 未向 __ModuleLoader__ 注册')

  let stateIndex = 0
  let refIndex = 0
  const react = {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): StubElement {
      if (typeof type === 'function') {
        const rendered = (type as StubComponent)({ ...(props ?? {}), children: children.flat() })
        return rendered ?? { type: 'fragment', props: {}, children: [] }
      }
      return { type, props: props ?? {}, children: children.flat() }
    },
    // 记录 setState 的入参：额度链路「拆信封」的回归就靠它断言。
    useState: (initial: unknown) => {
      const index = stateIndex++
      const value = options.stateOverrides && index in options.stateOverrides ? options.stateOverrides[index]
        : initial === null && options.quotaSnapshot !== undefined ? options.quotaSnapshot : initial
      latestStateValues[index] = value
      return [value, (next: unknown) => {
        const resolved = typeof next === 'function' ? (next as (previous: unknown) => unknown)(latestStateValues[index]) : next
        latestStateValues[index] = resolved
        lastStateCalls.push(resolved)
      }]
    },
    useCallback: <T,>(fn: T) => fn,
    // 维持挂载直到 afterEach；立即卸载必须显式选择，不能期待卸载后仍 setState。
    useEffect: (fn: () => void | (() => void)) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') {
        if (options.immediateUnmount) cleanup()
        else effectCleanups.push(cleanup)
      }
    },
    // 测试环境无真实绘制阶段，layout effect 与普通 effect 同口径执行。
    useLayoutEffect: (fn: () => void | (() => void)) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') {
        if (options.immediateUnmount) cleanup()
        else effectCleanups.push(cleanup)
      }
    },
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useId: () => 'test',
    useMemo: <T,>(fn: () => T) => fn(),
    useRef: <T,>(initial: T) => {
      const index = refIndex++
      const stateIndex = options.refStateBindings?.[index]
      let value: unknown = options.refOverrides?.[index] ?? initial
      return { get current() { return stateIndex === undefined ? value : latestStateValues[stateIndex] }, set current(next: unknown) { value = next } }
    },
  }

  const registrations = new Map<string, SlotRegistration>()
  const mountedPackages = new Set<string>()
  const slots = {
    inject: (_name: string, factory: () => unknown) => {
      factory()
      return () => {}
    },
    register: (row: SlotRegistration['row'], target: StubComponent) => {
      registrations.set(row.id, { row, component: (props) => { stateIndex = 0; refIndex = 0; return target(props) } })
      return () => {}
    },
  }
  const scope = {
    slots,
    effect: (fn: () => () => void) => {
      fn()
      return () => {}
    },
    inject: (deps: unknown, fn: (child: unknown) => void) => {
      lastInjectDeps.push(Array.isArray(deps) ? (deps as string[]) : [])
      fn(scope)
      return () => {}
    },
    get: (name: string) =>
      name === 'remote.agyQuota' && (options.quotaRead || options.models)
        ? { read: options.quotaRead, refresh: options.quotaRead, models: options.models } : undefined,
    // 忠实模拟 cordis 的 ReflectService：读取**未 inject** 的 `remote.<ns>` 属性会抛
    // 「cannot get property "remote.<ns>" without inject」。贡献型 remote 不进 inject，
    // 因此组件只能走 `ctx.get('remote.<ns>')`；这条替身行为让写错的一行在测试里就暴露。
    remote: new Proxy(
      {
        $mount: (declaration: unknown) => {
            const descriptor = declaration as (typeof lastMountCalls)[number]
            if (!descriptor.package || mountedPackages.has(descriptor.package)) throw new Error('typert: Remote package is already registered')
            mountedPackages.add(descriptor.package)
            lastMountCalls.push(descriptor)
          return Promise.resolve(() => {})
        },
      },
      {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && prop in target) return Reflect.get(target, prop, receiver)
          throw new Error(`cannot get property "remote.${String(prop)}" without inject`)
        },
      },
    ),
    modelDirectories: {
      directoryFor: () => ({
        store: {
          subscribe: () => () => {},
          getSnapshot: () => (options.quotaProvider ? { current: { provider: options.quotaProvider } } : {}),
        },
      }),
    },
  }
  const plugin = registration.factory(() => react)
  plugin.apply(scope)
  return registrations
}

/** 取设置卡片（settings.section 槽，id=antigravity-acp）。 */
function loadCard(): StubComponent {
  const card = loadRegistrations().get('antigravity-acp')?.component
  if (!card) throw new Error('client.js 未注册 settings.section 卡片')
  return card
}

/** 取额度药丸（conversation.input.right 槽，id=antigravity-quota）。 */
function loadPill(): { component: StubComponent; row: SlotRegistration['row'] } {
  const entry = loadRegistrations().get('antigravity-quota')
  if (!entry) throw new Error('client.js 未注册额度药丸')
  return entry
}

/** 收集卡片里所有文本节点，用于断言渲染出的说明文案。 */
function texts(node: unknown, into: string[] = []): string[] {
  if (typeof node === 'string') into.push(node)
  else if (node && typeof node === 'object') {
    for (const child of (node as StubElement).children ?? []) texts(child, into)
  }
  return into
}

function elements(node: unknown): StubElement[] {
  if (!node || typeof node !== 'object') return []
  const value = node as StubElement
  return [value, ...(value.children ?? []).flatMap(elements)]
}
function pillLabel(node: unknown): string {
  return String(elements(node).find((item) => item.type === 'button')?.props['aria-label'] ?? '')
}

/** 构造模型目录 store 快照（决定药丸是否出现）。 */
function modelStore(provider: string | null) {
  return {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: provider ? 'ready' : 'loading', current: provider ? { provider } : null }),
  }
}

describe('browser client module', () => {
  it('设置页点击即可预热或登录，可手动拉取模型目录', async () => {
    const control = vi.fn(async (method: string, request?: { action?: string; force?: boolean }) => method === 'account'
      ? { state: request?.action === 'login' ? 'connecting' : 'idle', message: 'test' }
      : { status: 'ok', models: [{ id: 'gemini-example', name: 'Gemini Example' }] })
    const readQuota = vi.fn(async () => ({ status: 'ok', groups: [] }))
    const card = loadRegistrations().get('antigravity-acp')!.component
    const tree = card({ remote: {}, control, readQuota })
    const text = texts(tree).join(' ')
    expect(text).toContain('ACP 账户与连接')
    expect(elements(tree).some(item => item.props['aria-label'] === '模型列表')).toBe(true)
    expect(text).not.toContain('首次')
    expect(control.mock.calls.some(([, request]) => request?.action === 'login')).toBe(false)
    const click = (label: string) => {
      const target = elements(tree).find((item) => item.type === 'button' && (texts(item).join('') === label || item.props['aria-label'] === label))
      expect(target, label).toBeDefined()
      ;(target!.props.onClick as () => void)()
    }
    click('立即预热')
    click('连接 / 登录 ACP')
    click('刷新模型目录')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(control).toHaveBeenCalledWith('account', { action: 'login' })
    expect(control).toHaveBeenCalledWith('account', { action: 'warmup' })
    expect(control).toHaveBeenCalledWith('models', { force: true })
    expect(readQuota).toHaveBeenCalledExactlyOnceWith(false, 'antigravity-acp', undefined)
    expect(texts(tree).join(' ')).not.toContain('AI Credits 余额')
  })

  it('设置页按任务分区，额度可手动拉取且不重复默认模型设置', () => {
    const tree = loadCard()({ remote: {} })
    const text = texts(tree).join(' ')
    for (const label of ['连接', '模型', '额度', '高级', '会话偏好', '网络与 CLI', '连接诊断']) expect(text).toContain(label)
    expect(text).toContain('拉取额度')
    expect(text).toContain('暂无额度快照')
    // 默认模型由 DSH 自己的模型选择器负责，设置页不再重复维护。
    expect(text).not.toContain('默认模型')
    expect(text).not.toContain('套餐额度管理')
    expect(elements(tree).filter((item) => item.props['aria-label'] === 'AI Credits 余额')).toHaveLength(0)
    // 普通配置（并发/二进制/超时）不是即时字段，宿主拒绝在本卡片写入，改为指引块。
    expect(text).toContain('普通配置（并发 / 二进制 / 超时）')
    expect(text).toContain('maxConcurrentSessions')
    // 带 aria-label 的 details 是高级页三个折叠组；模型行 details 无 aria-label，不计入。
    expect(elements(tree).filter((item) => item.type === 'details' && item.props['aria-label'])).toHaveLength(3)
  })

  it('目录冷启动超过 60 秒时客户端继续等待 Host，而不是提前报超时', async () => {
    vi.useFakeTimers()
    try {
      let complete!: (value: unknown) => void
      const models = vi.fn(() => new Promise<unknown>((resolve) => { complete = resolve }))
      const settings = loadRegistrations({ models }).get('antigravity-acp')!.row.inject!('')
      const control = settings.control as (method: string, request?: { force?: boolean }) => Promise<unknown>
      let settled = false
      const pending = control('models', { force: true }).then((value) => { settled = true; return value })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(settled).toBe(false)
      expect(models).toHaveBeenCalledWith({ force: true })
      const snapshot = { status: 'ok', models: [{ id: 'example', name: 'Example' }] }
      complete(snapshot)
      expect(await pending).toEqual(snapshot)
    } finally { vi.useRealTimers() }
  })

  it('设置页和药丸使用同一额度读取器，刷新可通知其它视图', async () => {
    const snapshot = { status: 'ok', groups: [] }
    const registrations = loadRegistrations({ quotaRead: async () => ({ ok: true, value: snapshot }) })
    const settings = registrations.get('antigravity-acp')!.row.inject!('')
    const pill = registrations.get('antigravity-quota')!.row.inject!('s')
    expect(settings.readQuota).toBe(pill.readQuota)
    const reader = pill.readQuota as ((force: boolean) => Promise<unknown>) & { subscribe(fn: (value: unknown) => void): () => void }
    const changed = vi.fn()
    const off = reader.subscribe(changed)
    await reader(true)
    expect(changed).toHaveBeenCalledWith(snapshot)
    off()
    await reader(true)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('代理说明明确留空继承宿主环境，不承诺强制直连', () => {
    const tree = loadCard()({ remote: {} })
    expect(texts(tree).join('')).toContain('留空继承宿主代理环境')
  })

  it('returns its plugin exports when the DSH loader supplies only require', () => {
    let registration: {
      id: string
      factory: (require: (id: string) => unknown) => {
        name: string
        inject: string[]
        apply: (ctx: unknown) => void
      }
    } | undefined
    const requireModule = (id: string) => {
      expect(id).toBe('react')
      return { createElement() {} }
    }

    runInNewContext(buildClientSource(), {
      window: {
        __ModuleLoader__: {
          load(value: NonNullable<typeof registration>) {
            registration = value
          },
        },
      },
    })

    expect(registration?.id).toBe('dsh-bundle-antigravity-host')
    const plugin = registration!.factory(requireModule)
    expect(plugin.name).toBe('dsh-bundle-antigravity-host')
    // remote.settings / remote.llm 必须逐个声明：缺任一项时读属性会抛
    // 「cannot get property "remote.<ns>" without inject」并击穿 settings.section。
    expect(plugin.inject).toEqual(['slots', 'remote', 'remote.settings', 'remote.llm'])
    expect(plugin.apply).toBeTypeOf('function')
  })

  it('设置卡片只经 settings.describe/listProviders 取数，绝不调用宿主不存在的 llm.listModels', async () => {
    const Card = loadCard()
    const calls = { describe: 0, listProviders: 0, listModels: 0, on: [] as string[] }
    const remote = {
      settings: {
        describe: async () => {
          calls.describe += 1
          return {
            ok: true,
            value: {
              writable: true,
              namespaces: [
                { ns: 'llm-antigravity-acp', revision: 7, value: { proxyUrl: '', modelOverrides: { 'gemini-3-pro': { effort: 'high' } } } },
              ],
            },
          }
        },
      },
      llm: {
        listProviders: async () => {
          calls.listProviders += 1
          return { ok: true, value: [{ id: 'antigravity-acp', name: 'Antigravity (ACP)' }] }
        },
        // 真实宿主没有这个方法；一旦卡片回退到它，这里会被调用并让断言失败。
        listModels: async () => {
          calls.listModels += 1
          return []
        },
      },
      $on: (name: string) => {
        calls.on.push(name)
        return () => {}
      },
    }

    Card({ remote })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(calls.describe).toBeGreaterThanOrEqual(1)
    expect(calls.listProviders).toBeGreaterThanOrEqual(1)
    expect(calls.listModels).toBe(0)
    // 配置变更后应自动刷新卡片。
    expect(calls.on).toContain('settings/document-updated')
  })

  it('provider 已注册时渲染出「已注册」提示', async () => {
    const Card = loadCard()
    const remote = {
      settings: { describe: async () => ({ ok: true, value: { writable: true, namespaces: [] } }) },
      llm: { listProviders: async () => ({ ok: true, value: [{ id: 'antigravity-acp' }] }) },
      $on: () => () => {},
    }

    const tree = Card({ remote })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // 没有真实目录来源时，卡片如实说明「未找到本路由」，而不是编造模型列表。
    expect(texts(tree).join('\n')).toContain('ACP 模式')
  })

  it('宿主缺少 settings.describe 时降级为可读提示而不是崩溃', () => {
    const Card = loadCard()
    const tree = Card({ remote: {} })
    expect(texts(tree).join('\n')).toContain('ACP 模式')
  })

  it('remote.<ns> 属性访问抛「without inject」时降级，绝不把异常抛出组件', () => {
    const Card = loadCard()
    // 复现宿主 ReflectService 的行为：缺 inject 时连读属性都会抛。
    const denied = (ns: string) => {
      throw new Error(`cannot get property "${ns}" without inject`)
    }
    const remote = {
      get settings() {
        return denied('remote.settings')
      },
      get llm() {
        return denied('remote.llm')
      },
      $on: () => () => {},
    }

    // 异常若穿出组件，React 侧会击穿 settings.section 卡片并弄坏设置页。
    expect(() => Card({ remote })).not.toThrow()
    const tree = Card({ remote })
    expect(texts(tree).join('\n')).toContain('ACP 模式')
  })

  it('设置卡片包含编排（Orchestrator）分组：7 个可编辑控件，Executor 可在 Hydrogen / Sonnet 间选择', () => {
    const tree = loadCard()({ remote: {} })
    const text = texts(tree).join(' ')
    expect(text).toContain('编排（Orchestrator）')
    expect(text).toContain('Gemini 4 Hydrogen')
    expect(text).toContain('Claude Sonnet 5.5')
    for (const name of [
      'orchestratorEnabled',
      'orchestratorPlannerModel',
      'orchestratorPlannerEffort',
      'orchestratorExecutorModel',
      'orchestratorExecutorEffort',
      'orchestratorMaxPlans',
      'orchestratorShowPlan',
    ]) {
      expect(elements(tree).filter((item) => item.props.name === name), name).toHaveLength(1)
    }
    const planner = elements(tree).find((item) => item.props.name === 'orchestratorPlannerModel')!
    expect(planner.type).toBe('select')
    expect(elements(planner).filter((item) => item.type === 'option').map((item) => item.props.value)).toEqual([
      'gemini-4-neon',
      'gemini-4-argon',
      'claude-opus-5-5',
    ])
    const executor = elements(tree).find((item) => item.props.name === 'orchestratorExecutorModel')!
    expect(executor.type).toBe('select')
    expect(elements(executor).filter((item) => item.type === 'option').map((item) => item.props.value)).toEqual([
      'gemini-4-hydrogen',
      'claude-sonnet-5-5',
    ])
  })
})

describe('AI Credits 展示', () => {
  it.each([
    [{ status: 'ok', remainingCredits: 0 }, '0'],
    [{ status: 'ok', remainingCredits: 42 }, '42'],
    // 开关已开但 CLI 缺失/上游无数据都是可排查故障，必须显示而不是静默隐藏。
    [{ status: 'unavailable', error: { code: 'cli-unavailable', message: '未找到官方 agy CLI' } }, '未提供'],
    [{ status: 'error', error: { code: 'request-failed', message: '查询超时' } }, '查询失败'],
    [{ status: 'ok' }, '未提供'],
  ])('余额状态独立呈现且不混淆零与未知', (credits, expected) => {
    const data = { status: 'ok', groups: [], credits }
    const tree = loadRegistrations({ quotaSnapshot: data, stateOverrides: { 2: true } }).get('antigravity-quota')!.component({ store: modelStore('antigravity-acp') })
    const card = elements(tree).find((item) => item.props['aria-label'] === 'AI Credits 余额')!
    expect(texts(card)).toContain(expected)
    if (expected !== '0') expect(texts(card)).not.toContain('0')
  })

  it('未开启 CLI 积分查询（cli-disabled）时隐藏 AI Credits 区块', () => {
    const data = { status: 'ok', groups: [], credits: { status: 'unavailable', error: { code: 'cli-disabled', message: '未开启 agy CLI 取数，不查询 AI Credits。' } } }
    const tree = loadRegistrations({ quotaSnapshot: data, stateOverrides: { 2: true } }).get('antigravity-quota')!.component({ store: modelStore('antigravity-acp') })
    expect(elements(tree).filter((item) => item.props['aria-label'] === 'AI Credits 余额')).toHaveLength(0)
    expect(texts(tree).join('')).not.toContain('未开启 agy CLI 取数')
  })

  it('开关已开但 CLI 缺失（cli-unavailable）时保留 AI Credits 区块便于排查', () => {
    const data = { status: 'ok', groups: [], credits: { status: 'unavailable', error: { code: 'cli-unavailable', message: '未找到官方 agy CLI，无法查询 AI Credits' } } }
    const tree = loadRegistrations({ quotaSnapshot: data, stateOverrides: { 2: true } }).get('antigravity-quota')!.component({ store: modelStore('antigravity-acp') })
    const card = elements(tree).find((item) => item.props['aria-label'] === 'AI Credits 余额')!
    expect(card).toBeTruthy()
    expect(texts(card).join('')).toContain('未找到官方 agy CLI')
  })

  it('缓存余额只在药丸详情显示旧值与独立错误', () => {
    const data = { status: 'ok', groups: [], credits: { status: 'ok', remainingCredits: 42, stale: true, staleReason: '余额刷新超时', updatedAt: '2026-01-01T00:00:00Z' } }
    const tree = loadRegistrations({ quotaSnapshot: data, stateOverrides: { 2: true } }).get('antigravity-quota')!.component({ store: modelStore('antigravity-acp') })
    const card = elements(tree).find((item) => item.props['aria-label'] === 'AI Credits 余额')!
    expect(texts(card)).toContain('42')
    expect(texts(card).join('')).toContain('余额缓存 · 余额刷新超时')
    expect(texts(card).join('')).toContain('余额更新于')
  })
})

describe('额度药丸（conversation.input.right）', () => {
  it('药丸只有单个紧凑额度按钮，不轮询或启动 ACP', () => {
    const control = vi.fn()
    const { component } = loadPill()
    const tree = component({ store: modelStore('antigravity-acp'), control })
    const buttons = elements(tree).filter((item) => item.type === 'button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.props.style).toMatchObject({ minHeight: '26px', maxWidth: 'min(46vw, 240px)' })
    expect(control).not.toHaveBeenCalled()
  })

  it('其他 provider 不显示预热按钮，也不读取 ACP 状态', () => {
    const control = vi.fn()
    expect(loadPill().component({ store: modelStore('deepseek-official'), control })).toBeNull()
    expect(control).not.toHaveBeenCalled()
  })

  it('药丸不注入 ACP 设置控制器', () => {
    const entries = loadRegistrations()
    expect(entries.get('antigravity-quota')!.row.inject!('session')).not.toHaveProperty('control')
  })

  // 上游额度池已合并为两个分组；保留三组建模用于验证旧独立 Argon 组并入 Gemini 展示。
  const completeQuota = { status: 'ok', groups: [
    { name: 'Gemini Models', buckets: [{ window: '5h', remainingPct: 82 }, { window: 'weekly', remainingPct: 71 }] },
    { name: 'Claude and GPT models', buckets: [{ window: '5h', remainingPct: 43 }] },
    { name: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remainingPct: 12 }] },
  ] }

  it('药丸只显示选中模型的迷你条与简短状态；展开完整额度组和余额', () => {
    const props = { store: { ...modelStore('antigravity-acp'), getSnapshot: () => ({ current: { provider: 'antigravity-acp', model: 'gemini-4-argon-high' } }) } }
    const closed = loadRegistrations({ quotaSnapshot: completeQuota }).get('antigravity-quota')!.component(props)
    // 并入 Gemini 共享组后余量充足，不再显示「偏少」短状态，只保留迷你条。
    expect(texts(closed)).toEqual([])
    // 池合并后 Argon 模型并入 Gemini 组：5h 与 weekly 两个窗口，短周期在上。
    const bars = elements(closed).filter((item) => item.props.role === 'progressbar')
    expect(bars).toHaveLength(2)
    expect(bars[0]?.props['aria-valuenow']).toBe(82)
    expect(bars[1]?.props['aria-valuenow']).toBe(71)
    const opened = loadRegistrations({ quotaSnapshot: completeQuota, stateOverrides: { 2: true } }).get('antigravity-quota')!.component(props)
    const text = texts(opened).join(' ')
    for (const label of ['Gemini', 'Claude / GPT', 'AI Credits', '未提供']) expect(text).toContain(label)
    // 旧结构里的独立 Argon 组不再单独成 section。
    expect(text).not.toContain('Gemini 4 Argon额度')
    expect(elements(opened).filter((item) => item.props.role === 'dialog')).toHaveLength(1)
    // 药丸按钮迷你条 2 条 + 弹层内 Gemini 组 2 条、Claude/GPT 组 1 条；旧独立 Argon 组不重复渲染。
    const openBars = elements(opened).filter((item) => item.props.role === 'progressbar')
    expect(openBars).toHaveLength(5)
    // 前两条是按钮迷你条（5px），其余为弹层进度条（4px）。
    expect(openBars.slice(2).every((item) => (item.props.style as { height?: string }).height === '4px')).toBe(true)
    const gemini = elements(opened).find((item) => item.props['aria-label'] === 'Gemini额度')!
    expect(gemini.props.style).toMatchObject({ padding: '9px 0' })
    expect(elements(gemini).some((item) => (item.props.style as { gridTemplateColumns?: string } | undefined)?.gridTemplateColumns === 'repeat(auto-fit, minmax(120px, 1fr))')).toBe(true)
  })

  it('未知自定义模型不借用其它模型额度；缓存状态与禁用窗口有明确语义', () => {
    const pill = loadRegistrations({ quotaSnapshot: { ...completeQuota, stale: true } }).get('antigravity-quota')!.component
    const tree = pill({ store: { ...modelStore('antigravity-acp'), getSnapshot: () => ({ current: { provider: 'antigravity-acp', model: 'custom-id' } }) } })
    expect(pillLabel(tree)).toContain('额度未匹配')
    expect(pillLabel(tree)).toContain('缓存数据')
    expect(elements(tree).filter((item) => item.props.role === 'progressbar')).toHaveLength(0)
  })

  it('展开后 Escape / 外部点击可关闭，卸载清理事件监听', () => {
    const listeners = new Map<string, (event: { key?: string; target?: unknown }) => void>()
    const pill = loadRegistrations({ quotaSnapshot: completeQuota, stateOverrides: { 2: true }, listeners }).get('antigravity-quota')!.component
    pill({ store: modelStore('antigravity-acp') })
    listeners.get('keydown')?.({ key: 'Escape' })
    expect(lastStateCalls.at(-1)).toBe(false)
    listeners.get('pointerdown')?.({ target: {} })
    expect(lastStateCalls.at(-1)).toBe(false)
    for (const cleanup of effectCleanups.splice(0)) cleanup()
    expect(listeners.size).toBe(0)
  })

  it('窄屏靠左的药丸：右缘对齐出界更多时翻转 left:0，向上展开', () => {
    // 右缘 75：右对齐溢出 277；左对齐（left=-25+340=315 < 363）不溢出 → left:0。
    const pill = loadRegistrations({ stateOverrides: { 2: true }, refStateBindings: { 4: 3 }, refOverrides: {
      5: { getBoundingClientRect: () => ({ left: -25, right: 75, top: 760, bottom: 786 }) },
    } }).get('antigravity-quota')!.component
    pill({ store: modelStore('antigravity-acp') })
    expect(lastStateCalls).toContainEqual(expect.objectContaining({ position: 'absolute', left: 0, right: 'auto', width: 340, bottom: 'calc(100% + 8px)' }))
  })

  it('视口内的药丸保持 absolute 右缘对齐锚点，不做视口钳位（0.1.51 遮挡回归）', () => {
    // 右缘 260：右对齐左端 -80 虽为负，仍比左对齐（260+... 右端 500 出界 137）更贴近
    // 视口 → 保持 right:0 锚定，不换算 fixed 坐标、不推离锚点。
    const pill = loadRegistrations({ stateOverrides: { 2: true }, refStateBindings: { 4: 3 }, refOverrides: {
      5: { getBoundingClientRect: () => ({ left: 160, right: 260, top: 760, bottom: 786 }) },
    } }).get('antigravity-quota')!.component
    pill({ store: modelStore('antigravity-acp') })
    expect(lastStateCalls).toContainEqual(expect.objectContaining({ position: 'absolute', right: 0, left: 'auto', width: 340, bottom: 'calc(100% + 8px)' }))
  })

  it('贴右缘的药丸右对齐无溢出；顶部空间不足且下方更宽裕才向下', () => {
    // 右缘 375：右对齐左端 35 ≥ 12 无溢出 → right:0；above=12 < below=788 → 向下。
    const pill = loadRegistrations({ stateOverrides: { 2: true }, refStateBindings: { 4: 3 }, refOverrides: {
      5: { getBoundingClientRect: () => ({ left: 315, right: 375, top: 32, bottom: 56 }) },
    } }).get('antigravity-quota')!.component
    pill({ store: modelStore('antigravity-acp') })
    expect(lastStateCalls).toContainEqual(expect.objectContaining({ position: 'absolute', right: 0, width: 340, bottom: 'auto', top: 'calc(100% + 8px)' }))
  })

  it('挂载后立即卸载不接收迟到的额度响应', async () => {
    const entry = loadRegistrations({ immediateUnmount: true }).get('antigravity-quota')!
    entry.component({ store: modelStore('antigravity-acp'), readQuota: async () => completeQuota })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lastStateCalls).not.toContainEqual(completeQuota)
  })

  it('同 provider 切换型号时仅显示对应家族的额度条，百分比留在无障碍标签', () => {
    const quotaSnapshot = { status: 'ok', groups: [
      { name: 'Gemini Models', buckets: [{ name: '5h', window: '5h', remainingPct: 90 }] },
      { name: 'Gemini 4 Argon', buckets: [{ name: '5h', window: '5h', remainingPct: 2 }] },
      { name: 'Claude / GPT Models', buckets: [
        { name: '5h', window: '5h', remainingPct: 60 },
        { name: 'weekly', window: '7d', remainingPct: 10 },
      ] },
    ] }
    const pill = loadRegistrations({ quotaSnapshot }).get('antigravity-quota')!.component
    let model = 'gemini-flash'
    const store = { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: 'antigravity-acp', model } }) }
    const props = { store, readQuota: async () => quotaSnapshot }
    expect(pillLabel(pill(props))).toContain('90%')
    model = 'claude-opus'
    const switched = pillLabel(pill(props))
    expect(switched).toContain('10%')
    expect(switched).not.toContain('90%')
    model = 'gemini-4-argon'
    // 池合并后 Argon 模型看 Gemini 组；旧独立 Argon 组（2%）不再单独匹配。
    expect(pillLabel(pill(props))).toContain('90%')
    expect(pillLabel(pill(props))).not.toContain('2%')
    model = 'server-default'
    expect(pillLabel(pill(props))).toContain('额度未匹配')
  })

  it('额度池合并后 Argon 模型始终使用 Gemini 组，旧独立 Argon 组并入展示', () => {
    const quotaSnapshot = { status: 'ok', groups: [
      { name: 'Gemini Models', buckets: [{ window: '5h', remainingPct: 82 }] },
      { name: 'Claude and GPT models', buckets: [{ window: '5h', remainingPct: 43 }] },
    ] }
    const store = { ...modelStore('antigravity-acp'), getSnapshot: () => ({ current: { provider: 'antigravity-acp', model: 'gemini-4-argon-high' } }) }
    const shared = loadRegistrations({ quotaSnapshot }).get('antigravity-quota')!.component({ store })
    expect(pillLabel(shared)).toContain('82%')
    expect(pillLabel(shared)).not.toContain('额度未知')
    // 上游若仍按旧结构返回独立 Argon 组，并入 Gemini 组而不是单独成组。
    const legacy = loadRegistrations({ quotaSnapshot: { ...quotaSnapshot, groups: [...quotaSnapshot.groups, { name: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remainingPct: 12 }] }] } }).get('antigravity-quota')!.component({ store })
    expect(pillLabel(legacy)).toContain('82%')
    expect(pillLabel(legacy)).not.toContain('43%')
  })

  it('额度百分比缺失不能显示为零额度', () => {
    const quotaSnapshot = { status: 'ok', groups: [{ name: 'Gemini', buckets: [{ name: '5h' }] }] }
    const pill = loadRegistrations({ quotaSnapshot }).get('antigravity-quota')!.component
    const store = { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: 'antigravity-acp', model: 'gemini-flash' } }) }
    const label = pillLabel(pill({ store, readQuota: async () => quotaSnapshot }))
    expect(label).toContain('额度未知')
    expect(label).not.toContain('0%')
  })

  it('额度窗口按短周期在上排序：上游 weekly 在前时药丸与详情都先显示 5 小时', () => {
    const quotaSnapshot = { status: 'ok', groups: [{
      name: 'Gemini Models',
      buckets: [
        { name: 'Weekly Limit Remaining', window: 'weekly', remainingPct: 68 },
        { name: 'Five Hour Limit Remaining', window: '5h', remainingPct: 51 },
      ],
    }] }
    const pill = loadRegistrations({ stateOverrides: { 2: true }, quotaSnapshot }).get('antigravity-quota')!.component
    const store = { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: 'antigravity-acp', model: 'gemini-flash' } }) }
    const label = pillLabel(pill({ store, readQuota: async () => quotaSnapshot }))
    const shortIndex = label.indexOf('5 小时')
    const weeklyIndex = label.indexOf('每周')
    expect(shortIndex).toBeGreaterThanOrEqual(0)
    expect(weeklyIndex).toBeGreaterThan(shortIndex)
  })

  it('注册在模型选择器左侧的槽位，带稳定 id 与 order', () => {
    const { row } = loadPill()
    expect(row.name).toBe('conversation.input.right')
    expect(row.id).toBe('antigravity-quota')
    expect(row.order).toBeTypeOf('number')
  })

  it('当前模型不是 antigravity-acp 时不渲染', () => {
    const { component } = loadPill()
    expect(component({ store: modelStore('deepseek-official'), readQuota: async () => ({}) })).toBeNull()
    expect(component({ store: modelStore(null), readQuota: async () => ({}) })).toBeNull()
  })

  it('选中 antigravity-acp 时渲染药丸并在挂载时取数', async () => {
    const { component } = loadPill()
    const calls: boolean[] = []
    const tree = component({
      store: modelStore('antigravity-acp'),
      readQuota: async (force?: boolean) => {
        calls.push(Boolean(force))
        return { status: 'ok', updatedAt: new Date().toISOString(), groups: [] }
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(tree).not.toBeNull()
    expect(pillLabel(tree)).toContain('额度')
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it('取数失败降级为可读文案，不把异常抛出组件', async () => {
    const { component } = loadPill()
    const boom = async () => {
      throw new Error('额度服务未就绪（Host 端 remote.agyQuota 未挂载）')
    }
    let tree: StubElement | null = null
    expect(() => {
      tree = component({ store: modelStore('antigravity-acp'), readQuota: boom })
    }).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(tree).not.toBeNull()
  })

  it('切到其它 provider 时清掉旧额度数据（切回不闪旧值）', async () => {
    const { component } = loadPill()
    const readQuota = async (): Promise<unknown> => ({
      status: 'ok',
      updatedAt: new Date().toISOString(),
      groups: [],
    })
    component({ store: modelStore('antigravity-acp'), readQuota })
    await Promise.resolve()
    await Promise.resolve()
    component({ store: modelStore('deepseek-official'), readQuota })
    // 清状态走 setData(null)；修复前旧快照会一直留到下一次取数。
    expect(lastStateCalls).toContain(null)
  })
})

/**
 * 额度药丸的 remote 回包拆信封（2026-10-17 回归）。
 *
 * 实测：Typert remote 的一元调用回包是 `{ ok, value }`（宿主上正常工作的
 * dsh-subusage 客户端同样先查 `response.ok` 再读 `response.value`）。药丸早先直接
 * `setData(结果)`，信封没拆 → `data.status` 恒为 undefined → 标签永远停在
 * 「额度…」、面板正文渲染成空。这里把「拆了」固化下来。
 */
describe('额度药丸：remote 回包拆信封', () => {
  const snapshot = {
    status: 'ok',
    updatedAt: '2026-10-17T00:00:00.000Z',
    plan: 'Antigravity',
    groups: [
      {
        name: 'Gemini Models',
        buckets: [{ name: 'Five Hour Limit Remaining', window: '5h', remainingPct: 98.55, disabled: false }],
      },
    ],
  }

  /** 等两轮微任务，让 readQuota → setData 链路跑完。 */
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('ok 信封：写入 state 的是 value 本身，而不是信封', async () => {
    const entry = loadRegistrations({ quotaRead: async () => ({ ok: true, value: snapshot }), quotaProvider: 'antigravity-acp' }).get('antigravity-quota')
    if (!entry) throw new Error('未注册额度药丸')
    // 药丸的 readQuota 来自槽位注入（与真实宿主一致）：先取注入面，再以它渲染。
    const inject = entry.row.inject
    if (typeof inject !== 'function') throw new Error('额度药丸槽位未声明 inject')
    const props = inject('session-1') as {
      store: unknown
      readQuota: (force?: boolean) => Promise<unknown>
    }
    entry.component(props)
    await settle()
    // 断言：写进 state 的是拆开后的快照（带 status/groups），而不是 { ok, value } 信封。
    const written = [...lastStateCalls].reverse().find((value) => value !== null && typeof value === 'object' && 'status' in value) as Record<string, unknown>
    expect(written.status).toBe('ok')
    expect(written.groups).toEqual(snapshot.groups)
    expect(written).not.toHaveProperty('ok')
  })

  it('失败信封：失败调用不通知其它药丸覆盖成功快照', async () => {
    const entry = loadRegistrations({
      quotaRead: async () => ({ ok: false, error: { message: 'remote denied' } }),
      quotaProvider: 'antigravity-acp',
    }).get('antigravity-quota')
    if (!entry) throw new Error('未注册额度药丸')
    const inject = entry.row.inject
    if (typeof inject !== 'function') throw new Error('额度药丸槽位未声明 inject')
    const props = inject('session-1') as {
      store: unknown
      readQuota: ((force?: boolean) => Promise<unknown>) & { subscribe(listener: (value: unknown) => void): () => void }
    }
    const listener = vi.fn()
    const off = props.readQuota.subscribe(listener)
    await expect(props.readQuota(false)).rejects.toThrow('remote denied')
    expect(listener).not.toHaveBeenCalled()
    off()
  })
})

/**
 * 贡献型 remote 的客户端挂载（2026-10-17 回归）。
 *
 * 实测契约（对照同宿主上正常工作的 dsh-subusage）：贡献型 remote 必须在客户端显式
 * `ctx.remote.$mount({ package, descriptors })`，之后 `ctx.get("remote.<ns>")` 才查得到。
 * 只做 Host 侧注册而漏挂载 → 药丸永远等不到服务（空着）；把 `remote.<ns>` 写进 inject
 * 等它出现 → 注入永不满足，**药丸彻底消失**。两条都踩过，这里把它们钉住。
 */
describe('额度药丸：remote 客户端挂载', () => {
  it('apply 时以本包名义 $mount，且 descriptor 指向 agyQuota/read', () => {
    loadRegistrations()
    expect(lastMountCalls).toHaveLength(1)
    const call = lastMountCalls[0]!
    expect(call.descriptors?.map(item => item.id)).toEqual([
      'dsh-bundle-antigravity-host#agyQuota/read',
      'dsh-bundle-antigravity-host#agyQuota/refresh',
      'dsh-bundle-antigravity-host#agyQuota/account',
      'dsh-bundle-antigravity-host#agyQuota/models',
      'dsh-bundle-antigravity-host#agyProxyAccount/account',
      'dsh-bundle-antigravity-host#agyAistudio/models',
      'dsh-bundle-antigravity-host#agyAistudio/setKey',
      'dsh-bundle-antigravity-host#agyAistudio/keyStatus',
      'dsh-bundle-antigravity-host#agyAistudio/usage',
      'dsh-bundle-antigravity-host#agyVertex/models',
    ])
    expect(call.package).toBe('dsh-bundle-antigravity-host')
    expect(call.descriptors?.[0]?.id).toBe('dsh-bundle-antigravity-host#agyQuota/read')
    expect(call.descriptors?.[0]?.method).toBe('read')
  })

  it('药丸的 inject 不得依赖 remote.agyQuota（否则注入永不满足、药丸消失）', () => {
    loadRegistrations()
    const requiresRemote = lastInjectDeps.some((deps) => deps.includes('remote.agyQuota'))
    expect(requiresRemote, `实际声明：${JSON.stringify(lastInjectDeps)}`).toBe(false)
    const registersPillWithoutRemote = lastInjectDeps.some(
      (deps) => deps.includes('slots') && deps.includes('modelDirectories'),
    )
    expect(registersPillWithoutRemote).toBe(true)
  })
})

describe('退役模型表：client 内置表与 host 单一规则源一致', () => {
  it('client bundle 内的退役家族与日期和 host MODEL_RETIREMENTS 完全相同', async () => {
    const { MODEL_RETIREMENTS: hostTable } = await import('../src/adapter/model-retirement.js')
    const source = buildClientSource()
    // 正则依赖 client.js 中字面量的 4 空格缩进；改表结构时同步本断言（client 无法直接导出常量）。
    const match = source.match(/const MODEL_RETIREMENTS = (\[[\s\S]*?\n    \])/)
    expect(match).not.toBeNull()
    // 截取的是纯对象字面量，隔离求值，不接触组件作用域。
    const clientTable = (new Function(`return ${match![1]}`)()) as Array<{
      familyId: string
      name: string
      retireAt: string
      migration?: string
    }>
    // 规则源核心字段（家族与下线日期）必须逐字一致；migration 两侧用途不同：
    // host 是可路由家族 ID，client 是徽章显示名。
    expect(clientTable.map(({ familyId, retireAt }) => ({ familyId, retireAt })))
      .toEqual(hostTable.map(({ familyId, retireAt }) => ({ familyId, retireAt })))
    expect(clientTable.every((entry) => entry.name.length > 0)).toBe(true)
    // 迁移目标是可路由的活跃家族 ID（不在退役表内），gpt-oss 无替代。
    expect(hostTable.find((entry) => entry.familyId === 'gemini-4-argon')?.migrationFamily).toBe('gemini-4-hydrogen')
    expect(hostTable.find((entry) => entry.familyId === 'gemini-3.8-flash')?.migrationFamily).toBe('gemini-4-hydrogen')
    expect(hostTable.find((entry) => entry.familyId === 'gpt-oss-120b')?.migrationFamily).toBeUndefined()
  })

  it('尚未下线的退役模型行带「即将下线」徽章且默认关闭；已过下线日的家族不补行', () => {
    // 退役判定按本地日历日：下线日次日零点起才算已退役。固定在 GPT-OSS 120B
    // （11-18）已过下线日、Argon / 3.8 Flash（11-30）尚未，断言不随真实日期漂移。
    vi.setSystemTime(new Date(2026, 10, 26, 12, 0, 0))
    const tree = loadCard()({ remote: {} })
    const text = texts(tree).join(' ')
    expect(text).toContain('即将下线 11-30')
    // gpt-oss 的下线日已过：不再补行，列表里没有它的名字与徽章。
    expect(text).not.toContain('GPT-OSS 120B')
    expect(text).not.toContain('已下线')
    const argonSwitch = elements(tree).find((item) => item.props.name === 'model-enabled-gemini-4-argon')
    expect(argonSwitch?.props.checked).toBe(false)
  })
})

describe('附属功能表：client 内置表与 host FEATURE_SPECS 一致', () => {
  it('client bundle 内的功能 id 与默认开关和 host FEATURE_SPECS 完全相同', async () => {
    const { FEATURE_SPECS: hostSpecs } = await import('../src/features/specs.js')
    const source = buildClientSource()
    // FEATURES 字面量含 msg() 调用，不能用 new Function 直接求值；正则依赖 client.js
    // 中字面量的 4 空格缩进，改表结构时同步本断言。
    const match = source.match(/const FEATURES = (\[[\s\S]*?\n    \])/)
    expect(match, 'client.js 缺少常量 FEATURES').not.toBeNull()
    const block = match![1] ?? ''
    const pairs: Array<{ id: string; defaultEnabled: boolean }> = []
    const itemRe = /id: '([^']+)'[^]*?defaultEnabled: (true|false)/g
    let item: RegExpExecArray | null
    while ((item = itemRe.exec(block)) !== null) pairs.push({ id: item[1]!, defaultEnabled: item[2] === 'true' })
    expect(pairs.map(({ id }) => id)).toEqual(hostSpecs.map((spec) => spec.id))
    expect(pairs.map(({ id, defaultEnabled }) => ({ id, defaultEnabled })))
      .toEqual(hostSpecs.map((spec) => ({ id: spec.id, defaultEnabled: spec.defaultEnabled })))
  })
})

describe('编排合成条目常量：client 内置值与 host 单一规则源一致', () => {
  it('client 内置的 ORCHESTRATOR_MODEL_ID / NAME 与 src/orchestrator/types.ts 完全相同', async () => {
    const host = await import('../src/orchestrator/types.js')
    const source = buildClientSource()
    const literal = (name: string): string => {
      const match = source.match(new RegExp(`const ${name} = ('(?:[^'\\\\]|\\\\.)*')`))
      expect(match, `client.js 缺少常量 ${name}`).not.toBeNull()
      return (new Function(`return ${match![1]}`)()) as string
    }
    expect(literal('ORCHESTRATOR_MODEL_ID')).toBe(host.ORCHESTRATOR_MODEL_ID)
    expect(literal('ORCHESTRATOR_MODEL_NAME')).toBe(host.ORCHESTRATOR_MODEL_NAME)
  })
})

describe('AI Studio 默认启用口径：client 内置函数与 host 单一规则源一致', () => {
  it('client aistudioDefaultEnabled 与 host endpoints.aistudioDefaultEnabled 逐 ID 同结论', async () => {
    const { aistudioDefaultEnabled: hostFn } = await import('../src/aistudio/endpoints.js')
    const source = buildClientSource()
    // 正则依赖 client.js 中函数的 4 空格缩进；改函数结构时同步本断言。
    const match = source.match(/function aistudioDefaultEnabled\(id\) \{([\s\S]*?)\n    \}/)
    expect(match, 'client.js 缺少函数 aistudioDefaultEnabled').not.toBeNull()
    const clientFn = new Function('id', match![1]!) as (id: string) => boolean
    const ids = [
      'aistudio-gemini-4-argon', 'aistudio-gemini-4.5-flash', 'gemini-4-hydrogen',
      'aistudio-gemini-3.8-flash', 'aistudio-gemini-3-pro', 'aistudio-gemini-2.5-flash',
      'aistudio-gemini-2.0-flash', 'aistudio-gemini-1.5-pro', 'aistudio-gemini-1.0-pro',
      'aistudio-gemma-3-27b-it', 'aistudio-learnlm-2.0-flash-experimental', '',
    ]
    for (const id of ids) expect(clientFn(id), id).toBe(hostFn(id))
  })
})
