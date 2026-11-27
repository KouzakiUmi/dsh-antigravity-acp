import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { collectArtifacts, parseExecution, prepareExecution, pythonOutcome } from './execute.js'
import { IMAGE_OUTPUT, NOTEBOOK_INPUT } from './notebook.js'
import { ColabRunError, createCliRunner, type CliRunner } from './runner.js'
import { parseUsage } from './usage.js'

export const name = 'antigravity-colab'
export const inject = ['tools', 'subprocess']
const EXECUTE = 'colab_execute'
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export const Config = Schema.object({
  executable: Schema.string().default('').description('Absolute path to the installed Google Colab CLI 0.8.0.'),
  session: Schema.string().default('').description('A single existing Colab CLI session name. Leave empty to disable execution.'),
})
export type Config = ReturnType<typeof Config>

export interface ToolServices {
  runner: CliRunner
  approval: () => Pick<ApprovalService, 'request'> | undefined
  attachments: () => Pick<AttachmentStore, 'saveFile'> | undefined
  onCleanupFailure?: () => void
}

type JsonSchemaNode = ToolDefinition['output']['schema']
const NUMBER_OR_UNKNOWN: JsonSchemaNode = { oneOf: [{ type: 'number' }, { type: 'null' }] }
const USAGE_PARAMETERS = { type: 'object', properties: {}, additionalProperties: false } as const
const EXECUTE_PARAMETERS = {
  type: 'object', additionalProperties: false,
  properties: {
    code: { type: 'string', description: 'Python source sent over stdin, not a local file path (up to 32 KiB). Supply only one of code or notebook.' },
    notebook: { type: 'string', description: 'Workspace-relative path to a v4 .ipynb (up to 2 MiB). Supply only one of notebook or code.' },
  },
} as const

const ARTIFACT_SCHEMA: JsonSchemaNode = {
  type: 'object', properties: { attachmentId: { type: 'string' }, name: { type: 'string' }, bytes: { type: 'integer' } },
  required: ['attachmentId', 'name', 'bytes'], additionalProperties: false,
}

export function createTools(config: Config, services: ToolServices) {
  // Snapshot trusted Host settings. Neither native nor nested calls have a runtime setting.
  const { executable, session } = config
  const lifecycle = new AbortController()
  let active: Promise<unknown> | undefined
  let blocked = false

  function runExclusive<T>(exec: ToolRunContext, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!isAbsolute(executable) || /[\x00-\x1f]|\.(?:cmd|bat|ps1)$/i.test(executable)) {
      return Promise.reject(new Error('Configure the absolute path to the installed Colab CLI executable, not a shell wrapper.'))
    }
    if (blocked) return Promise.reject(new Error('Colab local process exit was not confirmed. Check it before reloading the bundle.'))
    if (active) return Promise.reject(new Error('Another Colab tool call is in progress.'))
    const signal = AbortSignal.any([exec.signal, lifecycle.signal])
    const operation = Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal) })
    active = operation
    return operation.finally(() => { active = undefined })
  }

  async function inPrivateDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-colab-'))
    let retain = false
    try { return await work(dir) }
    catch (error) {
      retain = error instanceof ColabRunError && error.retainTemp
      if (retain) blocked = true
      throw error
    } finally {
      if (!retain) {
        try { await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }) }
        catch { services.onCleanupFailure?.() }
      }
    }
  }

  async function withCli<T>(signal: AbortSignal, work: (dir: string) => Promise<T>): Promise<T> {
    return inPrivateDir(async (dir) => {
      const version = await services.runner({ executable, cwd: dir, args: ['--auth=adc', 'version'], budgetMs: 8_000, signal })
      if (version.truncated || version.stdout.trim() !== 'Version: 0.8.0') throw new Error('This bundle requires Google Colab CLI 0.8.0.')
      signal.throwIfAborted()
      return work(dir)
    })
  }

  const usage: ToolDefinition = {
    name: 'colab_usage', description: 'Read Google Colab compute-unit balance, hourly usage rate and active assignment count for the configured CLI environment.',
    parameters: USAGE_PARAMETERS,
    output: {
      schema: { type: 'object', properties: { balanceCu: NUMBER_OR_UNKNOWN, rateCuPerHour: NUMBER_OR_UNKNOWN, activeAssignments: NUMBER_OR_UNKNOWN },
        required: ['balanceCu', 'rateCuPerHour', 'activeAssignments'], additionalProperties: false },
      render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Reflect.ownKeys(args).length) throw new Error('colab_usage takes no arguments.')
      return runExclusive(exec, (signal) => withCli(signal, async (dir) => {
        const result = await services.runner({ executable, cwd: dir, args: ['--auth=adc', 'usage'], budgetMs: 15_000, signal })
        // A retained tail can start partway into a truncated line.
        return parseUsage(result.truncated ? result.stdout.slice(result.stdout.indexOf('\n') + 1) : result.stdout)
      }))
    },
  }

  const execute: ToolDefinition = {
    name: EXECUTE,
    description: 'Run Python or a workspace Notebook on the user-configured existing Colab runtime after DSH approval. Colab CLI records executed code and outputs in local session history.',
    parameters: EXECUTE_PARAMETERS,
    output: {
      schema: { type: 'object', properties: {
        status: { type: 'string', enum: ['completed', 'python-error', 'unverified'] }, stdout: { type: 'string' },
        truncated: { type: 'boolean' }, artifactIssue: { type: 'boolean' }, artifacts: { type: 'array', items: ARTIFACT_SCHEMA },
      }, required: ['status', 'stdout', 'truncated', 'artifactIssue', 'artifacts'], additionalProperties: false },
      render: (_, value) => {
        const { artifacts, ...summary } = value as unknown as { artifacts: FileAttachmentRef[]; status: string; stdout: string; truncated: boolean; artifactIssue: boolean }
        return [{ type: 'text', text: JSON.stringify(summary) }, ...artifacts.map((attachment) => ({ type: 'file' as const, attachment }))]
      },
    },
    async execute(args, exec) {
      if (session !== session.trim() || !SESSION_NAME.test(session)) throw new Error('Configure one existing named Colab session before using colab_execute.')
      const input = parseExecution(args)
      return runExclusive(exec, async (signal) => {
        await approve(services, exec, session, 'notebook' in input ? 'workspace Notebook' : 'Python source', signal)
        const attachments = services.attachments()
        if ('notebook' in input && !attachments) throw new Error('The DSH attachment service is required for Notebook execution.')
        return withCli(signal, async (dir) => {
          const prepared = await prepareExecution(input, dir, exec.agent?.session.header.cwd, signal)
          const result = await services.runner({ executable, cwd: dir, stdin: prepared.stdin, budgetMs: 120_000,
            signal, remoteExecution: true, args: ['--auth=adc', 'exec', `--session=${session}`, '--timeout=90',
              `--output-image=${IMAGE_OUTPUT}`, ...('notebook' in input ? [`--file=${NOTEBOOK_INPUT}`] : [])] })
          const files = await collectArtifacts(dir, 'notebook' in input, attachments, signal)
          const outcome = prepared.marker ? pythonOutcome(result, prepared.marker) : { status: files.status, stdout: '' }
          return { ...outcome, stdout: safeStdout(outcome.stdout), artifacts: files.artifacts, truncated: result.truncated,
            artifactIssue: files.artifactIssue }
        })
      })
    },
  }

  return { usage, execute, async dispose() {
    lifecycle.abort(new Error('Colab component unloaded.'))
    await active?.catch(() => { /* The invoking tool reports the failure. */ })
  } }
}

function safeStdout(value: string): string {
  // CLI diagnostics can contain runtime URLs, tokens and local file paths. The
  // Notebook attachment owns Notebook output; Python exposes only a bounded stdout tail.
  return value.split(/\r?\n/).filter((line) => !/^\s*\[(?:colab|Image saved to)/i.test(line))
    .join('\n').replace(/https?:\/\/\S+|\b(?:Bearer|Basic)\s+\S+|\b[\w-]*(?:token|secret|password|api[_-]?key|cookie|authorization)[\w-]*\s*[:=]\s*[^\n]+/gi, '[redacted]')
}

async function approve(services: ToolServices, exec: ToolRunContext, session: string, source: string, signal: AbortSignal) {
  const approval = services.approval()
  if (!exec.agent || !approval) throw new Error('Colab execution needs DSH user approval; no approval channel is available.')
  const reason = `Run ${source} on existing Google Colab session "${session}". This can consume compute units. The official CLI stores code and outputs in local history.`
  const approvalSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)])
  const result = await approval.request({ agent: exec.agent, toolName: EXECUTE, callId: exec.callId, reason, signal: approvalSignal })
  if (approvalSignal.aborted || result !== 'allowed-once' || !services.approval()) {
    throw new Error('Colab execution did not receive one-time DSH user approval.')
  }
}

export function apply(ctx: Context, config: Config) {
  const tools = createTools(config, {
    runner: createCliRunner(ctx.subprocess), approval: () => ctx.get('approval'), attachments: () => ctx.get('attachments'),
    onCleanupFailure: () => ctx.logger('colab').warn('Could not remove a private Colab working directory.'),
  })
  ctx.effect(function* () {
    yield ctx.tools.register(tools.usage)
    yield ctx.tools.register(tools.execute)
    yield () => tools.dispose()
  }, 'Colab tool lifecycle')
}
