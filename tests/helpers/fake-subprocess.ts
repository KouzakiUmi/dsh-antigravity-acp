/**
 * 测试专用假 ctx.subprocess（原创，非产品代码）。
 *
 * 不启动任何真实进程、不触碰 child_process：每次 `spawn` 产出一条进程内双向
 * **字节**通道，并按 dsh-subprocess 的 `SubprocessHandle` 形状暴露
 * stdin/stdout，使生产代码里的 `ndJsonStream`（NDJSON over stdio）照常工作。
 * agent 侧拿到的是同一条通道的消息级 `Stream`，可直接交给 FakeAcpAgent。
 */
import { PassThrough, Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import type { Stream } from '@agentclientprotocol/sdk'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

export interface FakeAgentProcess {
  /** 交给被测代码（launchAcpAgent 的返回值）的句柄。 */
  readonly handle: SubprocessHandle
  /** agent 侧消息级双向流；喂给 FakeAcpAgent 即可扮演官方 ACP server。 */
  readonly stream: Stream
  /** 该进程是否已被 terminate()。 */
  terminated(): boolean
}

export interface FakeSubprocessHarness {
  /** 注入 ctx.subprocess 的运行时。 */
  readonly runtime: SubprocessRuntime
  /** 按 spawn 顺序记录的假进程。 */
  readonly spawns: FakeAgentProcess[]
}

/**
 * 建一个假 subprocess 运行时。
 * @param onSpawn 每次 spawn 后同步回调，用于挂上该进程对应的假 agent。
 */
export function createFakeSubprocessRuntime(onSpawn?: (process: FakeAgentProcess) => void): FakeSubprocessHarness {
  const spawns: FakeAgentProcess[] = []
  const runtime = {
    spawn: () => {
      const process = createFakeAgentProcess()
      spawns.push(process)
      onSpawn?.(process)
      return process.handle
    },
  } as unknown as SubprocessRuntime
  return { runtime, spawns }
}

function createFakeAgentProcess(): FakeAgentProcess {
  // 两个方向相反的字节通道：client 写入的字节经 toAgent 流向 agent，
  // agent 写入的字节经 fromAgent 流向 client。
  const toAgent = new PassThrough()
  const fromAgent = new PassThrough()
  let terminated = false
  let resolveExit: ((outcome: SubprocessOutcome) => void) | undefined
  const done = new Promise<SubprocessOutcome>((resolve) => {
    resolveExit = resolve
  })
  const handle = {
    stdin: toAgent,
    stdout: fromAgent,
    stderr: undefined,
    control: undefined,
    collected: {},
    done,
    terminate: () => {
      if (terminated) return
      terminated = true
      // 以 EOF（end 而非 destroy）收束通道：等价于子进程退出后 stdio 关闭，
      // 又不会让 web stream 适配器抛出未处理的 premature-close。
      if (!toAgent.writableEnded && !toAgent.destroyed) toAgent.end()
      if (!fromAgent.writableEnded && !fromAgent.destroyed) fromAgent.end()
      resolveExit?.({ exitCode: 0, signal: null })
    },
    waitForExit: async () => true,
  } as unknown as SubprocessHandle
  // agent 侧：写回 client 的字节走 fromAgent，从 client 读到的字节来自 toAgent。
  const stream = ndJsonStream(
    Writable.toWeb(fromAgent) as WritableStream<Uint8Array>,
    Readable.toWeb(toAgent) as ReadableStream<Uint8Array>,
  )
  return { handle, stream, terminated: () => terminated }
}
