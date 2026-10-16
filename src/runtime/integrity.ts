/**
 * Windows 强制完整性级别（MIC）只读诊断。
 *
 * ## 为什么需要它
 *
 * DSH 把 `$DSH_HOME`（默认 `~/.dsh`）整棵树显式标成 **Low 强制完整性**
 * （`icacls` 可见 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`）。Windows 在
 * 创建进程时**会采用映像文件的强制完整性标签**，所以任何从该树下启动的可执行文件
 * 都以 LOW 运行。
 *
 * LOW 进程受 MIC「禁止向上写」约束，无法在中等完整性的目录里创建文件。官方
 * server 在 `session/new` 期间要把刷新后的凭据写回 `~/.gemini/antigravity-acp/
 * acp_token.json`，实现是 `tempfile.NamedTemporaryFile(dir=<凭据目录>)`：
 * `CreateFile(CREATE_NEW)` 返回 `ERROR_ACCESS_DENIED` → CPython 3.10 的
 * `_mkstemp_inner` 只在 `isdir(dir) and access(dir, W_OK)` 为真时重试，而
 * `os.access(..., W_OK)` 在 Windows 上只看只读属性（不看 ACL/MIC），于是**无限重试**，
 * `session/new` 永不返回——表现为「Gemini 无响应地卡死」。
 *
 * 2026-10-16 实测对照（同一份二进制，仅位置不同）：
 *
 * | 位置 | 文件标签 | 进程 IL |
 * |---|---|---|
 * | `~/.dsh/cache/antigravity-acp/1.4.0/extract-1.4.0/` | Low | LOW → 挂死 |
 * | `%LOCALAPPDATA%/dsh-antigravity-host/1.4.0/` | 无（Medium） | MEDIUM → 正常 |
 *
 * 因此二进制安装根目录必须落在 Low 标签树之外（见 `binary.ts` 的
 * `resolveInstallRoot`），本模块负责在启动前把「仍然落在 Low 树里」这种情况**显式
 * 报出来**，而不是让用户面对一个无解释的挂起。
 *
 * ## 边界
 *
 * 纯只读：只跑一次 `icacls <目标>` 读标签，不修改任何 ACL/标签。探测失败（平台
 * 不是 Windows、icacls 不可用、输出无法解析）一律 **fail-open**：当作正常，绝不
 * 因为探测本身失败而阻断启动。
 */

/** icacls 输出里低完整性标签的英文标记（该字段不随系统语言本地化，实测有效）。 */
export const LOW_INTEGRITY_MARKER = 'Mandatory Label\\Low Mandatory Level'

/**
 * 解析 `icacls <file>` 输出，判断目标文件是否带 Low 强制完整性标签。
 *
 * 只认英文 `Mandatory Label\Low Mandatory Level`：icacls 的其余文案会本地化
 * （中文系统上会打印「已成功处理 1 个文件」），但这个标签名不会。宁可漏报也不
 * 误报——误报会把本来可用的配置判成不可用。
 */
export function parseLowIntegrityLabel(icaclsOutput: string): boolean {
  return icaclsOutput.toLowerCase().includes(LOW_INTEGRITY_MARKER.toLowerCase())
}

/** 面向用户的诊断文案；不含任何凭据。 */
export function describeLowIntegrity(executablePath: string): string {
  return [
    `可执行文件位于低完整性（Low integrity）目录：${executablePath}`,
    'Windows 会按映像文件的强制完整性标签创建进程，因此官方 ACP server 将以 LOW 运行，',
    '无法写入中等完整性的用户目录（~/.gemini/antigravity-acp），表现为 session/new 永久挂起。',
    '请把它安装到 Low 标签树之外：默认安装根为 %LOCALAPPDATA%\\dsh-antigravity-host；',
    '可用环境变量 AGY_ACP_HOME 或配置项 binaryPath 覆盖。',
  ].join('')
}

export type IntegrityRunner = (target: string) => Promise<string | undefined>

/**
 * 只读探测目标文件是否带 Low 标签。非 Windows 直接返回 false（不探测）。
 * `run` 返回 undefined 表示探测本身不可用 → fail-open。
 */
export async function isLowIntegrityTarget(
  target: string,
  run: IntegrityRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== 'win32') return false
  let output: string | undefined
  try {
    output = await run(target)
  } catch {
    return false
  }
  if (output === undefined) return false
  return parseLowIntegrityLabel(output)
}
