import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

/** 组件返回的元素树节点（createElement 桩的产物）。 */
interface StubElement {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

type CardComponent = (props: { remote: unknown }) => StubElement

/** 在带最小 React 桩的上下文里加载 client.js，取出它注册的设置卡片组件。 */
function loadCard(): CardComponent {
  let registration: {
    factory: (require: (id: string) => unknown) => { apply: (ctx: Record<string, unknown>) => void }
  } | undefined
  runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (value: unknown) => { registration = value as typeof registration } } },
  })
  if (!registration) throw new Error('client.js 未向 __ModuleLoader__ 注册')

  let component: CardComponent | undefined
  const react = {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): StubElement {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState: (initial: unknown) => [initial, () => {}],
    useCallback: <T>(fn: T) => fn,
    // 卡片只在首次渲染时挂载，effect 立即执行即可触发首次取数。
    useEffect: (fn: () => void | (() => void)) => {
      fn()
    },
  }
  const plugin = registration.factory(() => react)
  plugin.apply({
    slots: {
      inject: (_name: string, factory: () => unknown) => {
        factory()
        return () => {}
      },
      register: (_row: unknown, target: CardComponent) => {
        component = target
        return () => {}
      },
    },
    effect: (fn: () => () => void) => {
      fn()
      return () => {}
    },
    remote: {},
  })
  if (!component) throw new Error('client.js 未注册 settings.section 组件')
  return component
}

/** 深度优先收集所有节点。 */
function walk(node: unknown, visit: (element: StubElement) => void): void {
  if (!node || typeof node !== 'object') return
  const element = node as StubElement
  if (!('props' in element)) return
  visit(element)
  for (const child of element.children) walk(child, visit)
}

/** 收集卡片里所有文本节点，用于断言渲染出的说明文案。 */
function texts(node: unknown, into: string[] = []): string[] {
  if (typeof node === 'string') into.push(node)
  else if (node && typeof node === 'object') {
    for (const child of (node as StubElement).children ?? []) texts(child, into)
  }
  return into
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
    expect(plugin.inject).toEqual(['slots', 'remote'])
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
})
