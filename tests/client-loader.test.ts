import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

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

/** 注入的额度 remote 替身：药丸会 `scope.get('remote.agyQuota')` 后再 `.read()`。 */
interface QuotaStubOptions {
  /** 返回 remote 的原始回包（**未拆信封**），与真实网关一致。 */
  quotaRead?: () => Promise<unknown>
  /**
   * 注入会话模型目录的当前 provider。药丸只在 provider 匹配时取数，因此要驱动
   * 取数链路就必须把它设成 `antigravity-acp`；缺省保持空快照（渲染即 null）。
   */
  quotaProvider?: string
}

function loadRegistrations(options: QuotaStubOptions = {}): Map<string, SlotRegistration> {
  lastStateCalls = []
  let registration: {
    factory: (require: (id: string) => unknown) => { apply: (ctx: Record<string, unknown>) => void }
  } | undefined
  runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (value: unknown) => { registration = value as typeof registration } } },
    // vm 上下文没有浏览器/Node 宿主 API；药丸的轮询定时器需要显式注入。
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  })
  if (!registration) throw new Error('client.js 未向 __ModuleLoader__ 注册')

  const react = {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): StubElement {
      return { type, props: props ?? {}, children: children.flat() }
    },
    // 记录 setState 的入参：额度链路「拆信封」的回归就靠它断言。
    useState: (initial: unknown) => [initial, (value: unknown) => { lastStateCalls.push(value) }],
    useCallback: <T,>(fn: T) => fn,
    // 卡片只在首次渲染时挂载，effect 立即执行即可触发首次取数；
    // 清理函数随即执行（等价于挂载后立刻卸载），避免测试留下活动定时器。
    useEffect: (fn: () => void | (() => void)) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanup()
    },
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useMemo: <T,>(fn: () => T) => fn(),
    useRef: <T,>(initial: T) => ({ current: initial }),
  }

  const registrations = new Map<string, SlotRegistration>()
  const slots = {
    inject: (_name: string, factory: () => unknown) => {
      factory()
      return () => {}
    },
    register: (row: SlotRegistration['row'], target: StubComponent) => {
      registrations.set(row.id, { row, component: target })
      return () => {}
    },
  }
  const scope = {
    slots,
    effect: (fn: () => () => void) => {
      fn()
      return () => {}
    },
    inject: (_deps: unknown, fn: (child: unknown) => void) => {
      fn(scope)
      return () => {}
    },
    get: (name: string) =>
      name === 'remote.agyQuota' && options.quotaRead ? { read: () => options.quotaRead!() } : undefined,
    remote: {},
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

/** 构造模型目录 store 快照（决定药丸是否出现）。 */
function modelStore(provider: string | null) {
  return {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: provider ? 'ready' : 'loading', current: provider ? { provider } : null }),
  }
}

describe('browser client module', () => {
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

    runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
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
                { ns: 'llm-antigravity-acp', revision: 7, value: { preferredModel: 'gemini-3-pro', proxyUrl: '' } },
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
    expect(texts(tree).join('\n')).toContain('Antigravity ACP')
  })

  it('宿主缺少 settings.describe 时降级为可读提示而不是崩溃', () => {
    const Card = loadCard()
    const tree = Card({ remote: {} })
    expect(texts(tree).join('\n')).toContain('Antigravity ACP')
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
    expect(texts(tree).join('\n')).toContain('Antigravity ACP')
  })
})

describe('额度药丸（conversation.input.right）', () => {
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
    expect(texts(tree).join('')).toContain('额度')
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
    const written = lastStateCalls.at(-1) as Record<string, unknown>
    expect(written.status).toBe('ok')
    expect(written.groups).toEqual(snapshot.groups)
    expect(written).not.toHaveProperty('ok')
  })

  it('失败信封：转成可读错误状态（不再静默 pending）', async () => {
    const entry = loadRegistrations({
      quotaRead: async () => ({ ok: false, error: { message: 'remote denied' } }),
      quotaProvider: 'antigravity-acp',
    }).get('antigravity-quota')
    if (!entry) throw new Error('未注册额度药丸')
    const inject = entry.row.inject
    if (typeof inject !== 'function') throw new Error('额度药丸槽位未声明 inject')
    const props = inject('session-1') as {
      store: unknown
      readQuota: (force?: boolean) => Promise<unknown>
    }
    entry.component(props)
    await settle()
    const written = lastStateCalls.at(-1) as { status?: string; error?: { text?: string } }
    expect(written.status).toBe('error')
    expect(written.error?.text).toContain('remote denied')
  })
})
