/**
 * 官方 agy CLI 只读取数通道（src/runtime/agy-cli.ts）的单元测试：
 * 假 CliRun，不 spawn 任何进程。夹具取自 2026-10-16 真实探针输出的**形态**，
 * 数值为虚构，不含任何凭据。
 */
import { describe, expect, it } from 'vitest'
import {
  agyCliCandidates,
  AgyCliError,
  AGY_CLI_TIMEOUT_MS,
  AGY_MODEL_EXCLUDED_FAMILIES,
  cliEnv,
  fetchAgyModels,
  fetchAgyUsage,
  foldAgyModelFamilies,
  modelFamilyId,
  parseAgyModels,
  parseAgyUsage,
  routeTieredModelId,
  tierForModelId,
} from '../src/runtime/agy-cli.js'
import type { CliRun, CliRunResult } from '../src/runtime/agy-cli.js'

/** 真实 `agy models` 输出形态（id<TAB>名称）。 */
const MODELS_TSV = [
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n')

/** 真实 `-p /usage --output-format json` 输出形态（字段名与官方一致）。 */
const USAGE_JSON = {
  conversation_id: '',
  status: 'SUCCESS',
  response: 'Gemini Models\tWeekly Limit Remaining\t99%\t2026-10-23T04:27:25Z',
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      description: 'Within each group, models share a weekly limit and a 5-hour limit.',
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              description: 'it will fully refresh in 6 days, 23 hours.',
              window: 'weekly',
              remaining_fraction: 0.9914575219154358,
              reset_time: '2026-10-23T04:27:25Z',
            },
            {
              id: 'gemini-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 0.9883878827095032,
              reset_time: '2026-10-16T09:27:25Z',
            },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '2026-10-23T04:29:48Z' },
          ],
        },
      ],
    },
  },
}

/** 取数组元素；测试里缺位即失败，避免 noUncheckedIndexedAccess 噪声。 */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index]
  if (value === undefined) throw new Error(`索引 ${index} 不存在`)
  return value
}

function fakeRun(responses: Record<string, Partial<CliRunResult>>): { run: CliRun; calls: string[][] } {
  const calls: string[][] = []
  const run: CliRun = async ({ argv }) => {
    calls.push([...argv])
    const key = argv.slice(1).join(' ')
    const hit = responses[key] ?? Object.entries(responses).find(([k]) => key.startsWith(k))?.[1]
    return { exitCode: 0, stdout: '', stderr: '', ...hit }
  }
  return { run, calls }
}

describe('agy models 解析', () => {
  it('解析 id/名称并去重，缺名称时用 id 兜底', () => {
    const models = parseAgyModels(`${MODELS_TSV}\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\nno-tab-id\n`)
    expect(models.map((m) => m.id)).toEqual([
      'gemini-4-argon-medium',
      'gemini-4-argon-high',
      'claude-opus-5-5-low',
      'claude-sonnet-5-5-medium',
      'gpt-oss-120b-medium',
      'no-tab-id',
    ])
    expect(models.at(2)?.name).toBe('Claude Opus 5.5 (Low)')
    expect(models.at(-1)?.name).toBe('no-tab-id')
  })

  it('Opus 5.5 / Sonnet 5.5 / Argon 都在官方清单里（用户点名要进选择器的型号）', () => {
    const ids = parseAgyModels(MODELS_TSV).map((m) => m.id)
    expect(ids).toContain('claude-opus-5-5-low')
    expect(ids).toContain('claude-sonnet-5-5-medium')
    expect(ids).toContain('gemini-4-argon-high')
  })

  it('空输出返回空数组', () => {
    expect(parseAgyModels('')).toEqual([])
    expect(parseAgyModels('\n  \n')).toEqual([])
  })
})

describe('agy /usage 解析', () => {
  it('从 command.data.groups 映射分组/额度窗', () => {
    const groups = parseAgyUsage(USAGE_JSON)
    expect(groups).toHaveLength(2)
    expect(at(groups, 0).name).toBe('Gemini Models')
    const weekly = at(at(groups, 0).buckets, 0)
    expect(weekly).toMatchObject({ name: 'Weekly Limit Remaining', window: 'weekly', resetTime: '2026-10-23T04:27:25Z' })
    expect(weekly.remainingPct).toBe(99.15)
    expect(at(at(groups, 0).buckets, 1).window).toBe('5h')
  })

  it('remaining_fraction 越界/缺失时不编造百分比', () => {
    const groups = parseAgyUsage({
      command: { data: { groups: [{ name: 'G', buckets: [{ id: 'a', remaining_fraction: 1.5 }, { id: 'b' }] }] } },
    })
    expect(at(at(groups, 0).buckets, 0).remainingPct).toBeUndefined()
    expect(at(at(groups, 0).buckets, 1).remainingPct).toBeUndefined()
  })

  it('非法负载返回空组而不是抛错', () => {
    expect(parseAgyUsage(null)).toEqual([])
    expect(parseAgyUsage({})).toEqual([])
    expect(parseAgyUsage({ command: {} })).toEqual([])
  })
})

describe('fetchAgyUsage', () => {
  it('成功路径：解析 groups 并保持 ok 快照', async () => {
    const { run } = fakeRun({ '-p /usage --output-format json': { stdout: JSON.stringify(USAGE_JSON) } })
    const snapshot = await fetchAgyUsage(run, 'C:\\agy\\bin\\agy.exe')
    expect(snapshot.status).toBe('ok')
    expect(at(at(snapshot.groups, 0).buckets, 0).window).toBe('weekly')
  })

  it('非零退出码折叠为可读错误', async () => {
    const { run } = fakeRun({ '-p /usage --output-format json': { exitCode: 2, stderr: 'boom' } })
    const snapshot = await fetchAgyUsage(run, 'C:\\agy\\bin\\agy.exe')
    expect(snapshot.status).toBe('error')
    expect(snapshot.error?.code).toBe('request-failed')
    expect(snapshot.error?.message).toContain('boom')
  })

  it('输出不是 JSON / 没有额度分组时折叠为错误', async () => {
    const { run } = fakeRun({ '-p /usage --output-format json': { stdout: '<html>oops</html>' } })
    expect((await fetchAgyUsage(run, 'x')).status).toBe('error')
    const { run: empty } = fakeRun({ '-p /usage --output-format json': { stdout: '{"command":{"data":{"groups":[]}}}' } })
    expect((await fetchAgyUsage(empty, 'x')).status).toBe('error')
  })

  it('spawn 异常折叠为错误（含脱敏）', async () => {
    const run: CliRun = async () => {
      throw new Error('spawn Bearer ya29.secret-token-value failed')
    }
    const snapshot = await fetchAgyUsage(run, 'x')
    expect(snapshot.status).toBe('error')
    expect(JSON.stringify(snapshot)).not.toContain('ya29.secret-token-value')
  })
})

describe('fetchAgyModels', () => {
  it('成功解析官方清单', async () => {
    const { run, calls } = fakeRun({ models: { stdout: MODELS_TSV } })
    const models = await fetchAgyModels(run, 'C:\\agy\\bin\\agy.exe')
    expect(models.map((m) => m.id)).toContain('claude-opus-5-5-low')
    expect(at(calls, 0)).toEqual(['C:\\agy\\bin\\agy.exe', 'models'])
  })

  it('失败/空输出抛 AgyCliError', async () => {
    const { run } = fakeRun({ models: { exitCode: 1, stderr: 'nope' } })
    await expect(fetchAgyModels(run, 'x')).rejects.toBeInstanceOf(AgyCliError)
    const { run: empty } = fakeRun({ models: { stdout: '' } })
    await expect(fetchAgyModels(empty, 'x')).rejects.toMatchObject({ code: 'cli-bad-output' })
  })
})

describe('家族折叠与思考强度路由', () => {
  const RAW = parseAgyModels([
    'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
    'gemini-4-argon-high\tGemini 4 Argon (High)',
    'gemini-4-argon-low\tGemini 4 Argon (Low)',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
    'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
    'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
    'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
    'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
    'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
    'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  ].join('\n'))

  it('档位 id 折叠成家族：选择器只出家族，不把思考强度放进模型', () => {
    const { models } = foldAgyModelFamilies(RAW)
    expect(models.map((m) => m.id)).toEqual([
      'gemini-4-argon',
      'gemini-3.8-flash',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ])
    expect(models.map((m) => m.name)).toEqual([
      'Gemini 4 Argon',
      'Gemini 3.8 Flash',
      'Claude Opus 5.5',
      'Claude Sonnet 5.5',
    ])
  })

  it('gpt-oss-120b 整族排除（临近下架，用户指示不进选择器）', () => {
    expect(AGY_MODEL_EXCLUDED_FAMILIES.has('gpt-oss-120b')).toBe(true)
    const { models, tiers } = foldAgyModelFamilies(RAW)
    expect(models.some((m) => m.id.includes('gpt-oss'))).toBe(false)
    expect(tiers.has('gpt-oss-120b')).toBe(false)
  })

  it('记录各家族支持的档位', () => {
    const { tiers } = foldAgyModelFamilies(RAW)
    expect([...(tiers.get('claude-opus-5-5') ?? [])]).toEqual(['low', 'medium', 'high'])
  })

  it('路由：家族 + 思考强度 → 对应档位模型', () => {
    expect(routeTieredModelId('claude-opus-5-5', 'high')).toBe('claude-opus-5-5-high')
    expect(routeTieredModelId('gemini-4-argon', 'low')).toBe('gemini-4-argon-low')
    const onlyMedium = new Set(['medium'] as const)
    expect(routeTieredModelId('x', 'high', onlyMedium)).toBe('x-medium')
  })

  it('家族/档位识别：无后缀的 id 原样作为家族', () => {
    expect(tierForModelId('claude-opus-5-5-high')).toBe('high')
    expect(tierForModelId('claude-opus-5-5')).toBeUndefined()
    expect(modelFamilyId('gemini-3.8-flash-low')).toBe('gemini-3.8-flash')
    expect(modelFamilyId('server-default')).toBe('server-default')
  })
})

describe('CLI 调用面', () => {
  it('argv 是只读命令（额度 slash 命令 + models 列表），默认超时已定义', () => {
    expect(AGY_CLI_TIMEOUT_MS).toBeGreaterThan(10_000)
    const { run, calls } = fakeRun({ '-p /usage --output-format json': { stdout: JSON.stringify(USAGE_JSON) } })
    void fetchAgyUsage(run, 'agy')
    expect(at(calls, 0).slice(1)).toEqual(['-p', '/usage', '--output-format', 'json'])
  })

  it('cliEnv 只透传系统/用户/代理键，不带 DSH_* 内部键', () => {
    const env = cliEnv({
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\bin',
      USERPROFILE: 'C:\\Users\\x',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      DSH_HOME: 'C:\\secret',
      DSH_TOKEN: 'leak',
      RANDOM_KEY: 'nope',
    })
    expect(env).toMatchObject({ SystemRoot: 'C:\\Windows', PATH: 'C:\\bin', HTTPS_PROXY: 'http://127.0.0.1:7890' })
    expect(Object.keys(env)).not.toContain('DSH_HOME')
    expect(Object.keys(env)).not.toContain('DSH_TOKEN')
    expect(Object.keys(env)).not.toContain('RANDOM_KEY')
  })

  it('候选路径：AGY_CLI_BIN 覆盖优先', () => {
    expect(agyCliCandidates({ AGY_CLI_BIN: 'D:\\custom\\agy.exe' })).toEqual(['D:\\custom\\agy.exe'])
    const candidates = agyCliCandidates({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'C:\\Users\\x')
    expect(candidates[0]).toContain('AppData\\Local\\agy\\bin\\agy.exe')
  })
})

/**
 * cliEnv 的代理补齐（2026-10-16 回归）。
 *
 * 实测：`agy -p /usage` 启动时会做登录/配置刷新，**没有代理会一直挂在网络上**
 * （无代理变体 60s 未返回，有代理变体 5–8s 返回额度表）。而 DSH 的 subprocess 会
 * scrub 父环境，宿主进程也未必导出代理变量——插件配置的 proxyUrl 才是权威来源。
 * 规则必须与官方 ACP 进程一致：**配置优先，其次宿主环境**。
 */
describe('cliEnv 代理补齐', () => {
  const parent = {
    SystemRoot: 'C:\Windows',
    PATH: 'C:\Windows\system32',
    USERPROFILE: 'C:\Users\tester',
    LOCALAPPDATA: 'C:\Users\tester\AppData\Local',
    HTTPS_PROXY: 'http://ambient:8080',
    NO_PROXY: 'example.com',
    UNRELATED_SECRET: 'should-not-pass',
  }

  it('配置了 proxyUrl 时注入大小写两套代理，并始终排除 loopback', () => {
    const env = cliEnv(parent, { url: 'http://127.0.0.1:7890' })
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.https_proxy).toBe('http://127.0.0.1:7890')
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    // 配置的代理覆盖宿主环境里的同名值。
    expect(env.HTTPS_PROXY).not.toBe(parent.HTTPS_PROXY)
    // loopback 必须绕过（私有 MCP 桥、OAuth 回调都在本机）。
    expect(env.NO_PROXY).toContain('127.0.0.1')
  })

  it('未配置 proxyUrl 时转发宿主环境自身的代理', () => {
    const env = cliEnv(parent)
    expect(env.HTTPS_PROXY).toBe('http://ambient:8080')
    expect(env.NO_PROXY).toContain('127.0.0.1')
    expect(env.NO_PROXY).toContain('example.com')
  })

  it('两边都没有代理时不注入任何代理键', () => {
    const env = cliEnv({ SystemRoot: 'C:\Windows' })
    expect(Object.keys(env).filter((key) => /proxy/i.test(key))).toEqual([])
  })

  it('白名单之外的环境变量一律不透传', () => {
    expect(cliEnv(parent)).not.toHaveProperty('UNRELATED_SECRET')
    expect(cliEnv(parent).SystemRoot).toBe('C:\Windows')
    expect(cliEnv(parent).USERPROFILE).toBe('C:\Users\tester')
  })
})
