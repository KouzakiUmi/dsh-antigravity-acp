/**
 * 官方 Antigravity ACP server 二进制的解析与获取。
 *
 * 解析顺序：config.binaryPath → 环境变量 AGY_ACP_BIN → 缓存目录中已下载
 * 版本 → 自动下载到缓存。所有副作用集中在文件底部的过程函数；纯函数
 * （URL 拼接、URL 校验、zip 条目校验、可执行文件挑选、缓存路径）单独导出，
 * 便于单元测试。
 */
import { createWriteStream } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { homedir as osHomedir, tmpdir } from 'node:os'
import { join, normalize, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

/** 默认下载的官方 server 版本（可经 config.acpVersion 配置）。 */
export const DEFAULT_ACP_SERVER_VERSION = '1.4.0'
/** 唯一允许的下载域名。 */
export const DOWNLOAD_HOST_WHITELIST = 'dl.google.com'
/** 缓存目录在 DSH home 下的相对位置。 */
export const CACHE_SUBPATH = ['cache', 'antigravity-acp'] as const

/**
 * 本包原创错误码体系（AGY_*）。与协议层的 AGY_LAUNCH_FAILED 等共用前缀，
 * 便于在日志中区分归属。
 */
export const AGY_BINARY_ERROR = {
  /** URL 不满足 https + dl.google.com 白名单。 */
  BLOCKED_URL: 'AGY_DOWNLOAD_BLOCKED',
  /** 服务器返回 3xx 重定向；安全策略要求拒绝且不跟随。 */
  REDIRECT_REFUSED: 'AGY_DOWNLOAD_REDIRECT_REFUSED',
  /** 下载返回非 2xx（非 3xx）状态。 */
  BAD_STATUS: 'AGY_DOWNLOAD_BAD_STATUS',
  /** zip 条目路径不安全（绝对路径、穿越、盘符等）。 */
  UNSAFE_ENTRY: 'AGY_UNSAFE_ZIP_ENTRY',
  /** zip 内找不到可执行文件等结构异常。 */
  ARCHIVE_LAYOUT: 'AGY_ARCHIVE_LAYOUT',
  /** zip 打开或读取失败。 */
  ARCHIVE_READ: 'AGY_ARCHIVE_READ',
  /** 所有解析顺序都未找到二进制且未启用自动下载。 */
  BINARY_MISSING: 'AGY_BINARY_MISSING',
  /** 当前平台/架构无法映射出已知的下载坐标。 */
  PLATFORM_UNSUPPORTED: 'AGY_PLATFORM_UNSUPPORTED',
} as const

export class AgyBinaryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AgyBinaryError'
  }
}

export type AcpPlatform = 'windows' | 'darwin' | 'linux'
export type AcpArch = 'x86_64' | 'aarch64'
/** posix = darwin / linux（可执行文件挑选规则一致）。 */
export type ExecutableFlavor = 'windows' | 'posix'

/**
 * 拼接官方下载 URL。
 *
 * 平台与架构都用 hyphen 分隔。已实测验证的组合仅有一组：
 * windows / x86_64 / 1.4.0 → HTTP 200（`agy-acp-server-1.4.0-windows-x86_64.zip`）。
 * 曾经实测 underscore 变体（`windows_x86_64`）为 404，禁止使用。
 * darwin / linux 目录按同一 hyphen 模式拼接，但属于【未验证】组合——
 * 实际可用性未经确认，不能当作事实引用；此类平台应优先用 binaryPath /
 * AGY_ACP_BIN / AGY_ACP_URL 覆盖。
 */
export function resolveDownloadUrl(
  platform: AcpPlatform,
  arch: AcpArch,
  version: string = DEFAULT_ACP_SERVER_VERSION,
): string {
  return `https://${DOWNLOAD_HOST_WHITELIST}/agy-extensions/releases/${platform}/agy-acp-server-${version}-${platform}-${arch}.zip`
}

/** 校验下载 URL：仅 https + 白名单域名，其余一律拒绝。 */
export function assertDownloadUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (cause) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.BLOCKED_URL, `下载 URL 无法解析: ${url}`, { cause })
  }
  if (parsed.protocol !== 'https:') {
    throw new AgyBinaryError(AGY_BINARY_ERROR.BLOCKED_URL, `仅允许 https 下载，拒绝: ${parsed.protocol}`)
  }
  if (parsed.hostname !== DOWNLOAD_HOST_WHITELIST) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.BLOCKED_URL, `仅允许 ${DOWNLOAD_HOST_WHITELIST} 域，拒绝: ${parsed.hostname}`)
  }
  return parsed
}

/** downloadBinary 可注入的最小 HTTP 响应形状（结构化，便于测试伪造）。 */
export interface HttpResponseLike {
  ok: boolean
  status: number
  arrayBuffer(): Promise<ArrayBuffer>
}

export type FetchLike = (
  url: string,
  init: { redirect: 'manual'; signal?: AbortSignal },
) => Promise<HttpResponseLike>

/**
 * 下载二进制。redirect 显式设为 'manual'，任何 3xx 都视为错误——
 * 官方分发应直链；重定向意味着 URL 失效或被劫持，不跟随。
 */
export async function downloadBinary(
  url: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  assertDownloadUrl(url)
  const doFetch: FetchLike = options.fetchImpl ?? ((url2, init) => fetch(url2, init))
  const response = await doFetch(url, { redirect: 'manual', signal: options.signal })
  if (response.status >= 300 && response.status < 400) {
    throw new AgyBinaryError(
      AGY_BINARY_ERROR.REDIRECT_REFUSED,
      `下载返回重定向 ${response.status}，安全策略拒绝跟随: ${url}`,
    )
  }
  if (!response.ok) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.BAD_STATUS, `下载失败，HTTP ${response.status}: ${url}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * 校验单个 zip 条目路径，返回规范化的 POSIX 相对路径（目录条目保留尾随 `/`）。
 *
 * 拒绝：空路径、反斜杠分隔、绝对路径、Windows 盘符、`.`/`..` 段、中间空段。
 * 放行：以 `/` 结尾的**目录条目**（`dir/`、`dir/sub/`）——它们是合法的 zip
 * 布局（yauzl 的 validateFileName 同样接受），其尾随斜杠只是「这是目录」的
 * 标记，不构成路径穿越或绝对路径；解压时按目录创建。
 */
export function validateZipEntryPath(entryName: string): string {
  if (entryName.length === 0) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.UNSAFE_ENTRY, 'zip 条目路径为空')
  }
  if (entryName.includes('\\')) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.UNSAFE_ENTRY, `zip 条目含反斜杠分隔符（Windows 路径注入嫌疑）: ${entryName}`)
  }
  if (entryName.startsWith('/')) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.UNSAFE_ENTRY, `zip 条目为绝对路径: ${entryName}`)
  }
  if (/^[A-Za-z]:/.test(entryName)) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.UNSAFE_ENTRY, `zip 条目含 Windows 盘符: ${entryName}`)
  }
  const isDirectory = entryName.endsWith('/')
  // 目录条目：只在末尾允许一个空段（`dir//` 这类畸形写法仍会在下面的循环里被拒）。
  const segments = isDirectory ? entryName.split('/').slice(0, -1) : entryName.split('/')
  if (segments.length === 0) {
    throw new AgyBinaryError(AGY_BINARY_ERROR.UNSAFE_ENTRY, `zip 条目含非法段（空/./..）: ${entryName}`)
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new AgyBinaryError(AGY_BINARY_ERROR.UNSAFE_ENTRY, `zip 条目含非法段（空/./..）: ${entryName}`)
    }
  }
  return isDirectory ? `${segments.join('/')}/` : segments.join('/')
}

/**
 * 从已校验的相对条目列表里挑出 ACP server 可执行文件。
 * windows：找 `.exe`（官方 zip 通常恰好一个）；posix：找无扩展名且名为
 * agy-acp-server（或以其为前缀）的文件。挑选必须确定性：取路径深度最小、
 * 同深度取字典序最小。找不到抛 AGY_ARCHIVE_LAYOUT。
 */
export function pickExecutablePath(entries: readonly string[], flavor: ExecutableFlavor): string {
  const candidates = entries.filter((entry) => {
    if (entry.endsWith('/')) return false
    const base = entry.split('/').at(-1) ?? ''
    if (flavor === 'windows') return base.toLowerCase().endsWith('.exe')
    return base === 'agy-acp-server' || (base.startsWith('agy-acp-server') && !base.includes('.'))
  })
  if (candidates.length === 0) {
    throw new AgyBinaryError(
      AGY_BINARY_ERROR.ARCHIVE_LAYOUT,
      `zip 内未找到 ACP server 可执行文件（flavor=${flavor}，条目数=${entries.length}）`,
    )
  }
  const depth = (entry: string): number => entry.split('/').length
  return candidates
    .slice()
    .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
    .at(0)!
}

/** 解压目标子目录名（限定在版本缓存目录内）。 */
export function extractDirName(version: string): string {
  return `extract-${version}`
}

/**
 * 解析缓存根目录。优先 $DSH_HOME（宿主注入的环境变量）；缺失时回退到
 * 用户 home 下的 `.dsh`（与 DSH 默认 home 布局一致，注释性回退而非承诺）；
 * 两者都不可用则退到系统临时目录，保证本插件在无 DSH_HOME 的开发环境也能运行。
 */
export function resolveCacheDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homedir: () => string = osHomedir,
): string {
  const dshHome = env.DSH_HOME
  if (dshHome && dshHome.trim().length > 0) {
    return join(dshHome, ...CACHE_SUBPATH)
  }
  try {
    return join(homedir(), '.dsh', ...CACHE_SUBPATH)
  } catch {
    return join(tmpdir(), 'dsh-antigravity-cache')
  }
}

/** 版本缓存目录与其解压子目录。 */
export function versionCachePaths(cacheDir: string, version: string): { versionDir: string; extractDir: string } {
  const versionDir = join(cacheDir, version)
  return { versionDir, extractDir: join(versionDir, extractDirName(version)) }
}

/**
 * Node 的 process.platform / process.arch → 下载坐标映射。
 * 未映射组合抛 AGY_PLATFORM_UNSUPPORTED（用户可用 binaryPath/AGY_ACP_BIN
 * 或 AGY_ACP_URL 覆盖，而不是让我们猜测 URL）。
 */
export function mapNodePlatform(platform: NodeJS.Platform, arch: string): { platform: AcpPlatform; arch: AcpArch } {
  const mappedPlatform: AcpPlatform | undefined =
    platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined
  const mappedArch: AcpArch | undefined = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined
  if (!mappedPlatform || !mappedArch) {
    throw new AgyBinaryError(
      AGY_BINARY_ERROR.PLATFORM_UNSUPPORTED,
      `未知平台组合 ${platform}/${arch}；请用 binaryPath 或 AGY_ACP_BIN 手动指定二进制`,
    )
  }
  return { platform: mappedPlatform, arch: mappedArch }
}

/** posix 解压产物补执行位。 */
export async function ensureExecutable(file: string, flavor: ExecutableFlavor): Promise<void> {
  if (flavor === 'posix') {
    await chmod(file, 0o755)
  } else {
    // windows 无需额外操作；存在性检查交给调用方。
    await access(file)
  }
}

/** 用 yauzl 把 zip 安全解到 destDir；返回全部已校验的相对条目路径。 */
export async function extractZipSafely(zipPath: string, destDir: string): Promise<readonly string[]> {
  const zip = await new Promise<yauzl.ZipFile>((resolveOpen, rejectOpen) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (error, file) => {
      if (error) rejectOpen(new AgyBinaryError(AGY_BINARY_ERROR.ARCHIVE_READ, `无法打开 zip: ${zipPath}`, { cause: error }))
      else resolveOpen(file!)
    })
  })
  const extracted: string[] = []
  try {
    for (;;) {
      const entry = await new Promise<yauzl.Entry | null>((resolveNext, rejectNext) => {
        zip.readEntry()
        zip.once('entry', (e) => resolveNext(e))
        // yauzl 自身也会对恶意 fileName 报 error（absolute path / invalid
        // relative path / invalid characters in fileName）；统一映射为
        // UNSAFE_ENTRY，与我们的条目校验共用一个错误码。
        zip.once('error', (error) => {
          const unsafe = error instanceof Error && /fileName|relative path|absolute path/.test(error.message)
          rejectNext(
            new AgyBinaryError(
              unsafe ? AGY_BINARY_ERROR.UNSAFE_ENTRY : AGY_BINARY_ERROR.ARCHIVE_READ,
              `读取 zip 条目失败: ${zipPath}`,
              { cause: error },
            ),
          )
        })
        zip.once('end', () => resolveNext(null))
      })
      if (!entry) break
      const safeRelative = validateZipEntryPath(entry.fileName)
      // 双保险：join 后的绝对路径必须仍限定在 destDir 内。
      const target = resolve(destDir, safeRelative)
      if (target !== normalize(destDir) && !target.startsWith(normalize(destDir) + sep)) {
        throw new AgyBinaryError(AGY_BINARY_ERROR.UNSAFE_ENTRY, `zip 条目逃出解压目录: ${entry.fileName}`)
      }
      if (entry.fileName.endsWith('/')) {
        await mkdir(target, { recursive: true })
        continue
      }
      await mkdir(dirname(target), { recursive: true })
      await new Promise<void>((resolveWrite, rejectWrite) => {
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            rejectWrite(new AgyBinaryError(AGY_BINARY_ERROR.ARCHIVE_READ, `读取条目内容失败: ${entry.fileName}`, { cause: error }))
            return
          }
          // yauzl 的 openReadStream 产出 node Readable，直接 pipe。
          pipeline(stream, createWriteStream(target))
            .then(() => resolveWrite())
            .catch((cause) => rejectWrite(new AgyBinaryError(AGY_BINARY_ERROR.ARCHIVE_READ, `写出条目失败: ${entry.fileName}`, { cause })))
        })
      })
      extracted.push(safeRelative)
    }
  } finally {
    zip.close()
  }
  return extracted
}

export interface AgentBinaryResolution {
  /** 可直接交给 ctx.subprocess 的可执行文件路径。 */
  executablePath: string
  /** 命中来源：手动配置 / 环境变量 / 缓存 / 自动下载。 */
  source: 'config' | 'env' | 'cache' | 'download'
  /** 下载缓存中的版本号（手动路径时为 undefined）。 */
  version?: string
  /** 官方未提供校验和，这里永远如实为 false，不得伪造为 true。 */
  checksumVerified: false
}

export interface AgentBinaryOptions {
  /** 用户显式配置的二进制路径，最高优先级。 */
  binaryPath?: string
  /** 是否允许自动下载（默认 true）。 */
  autoDownload?: boolean
  /** 目标版本（默认 1.4.0）。 */
  version?: string
  /** 下载 URL 覆盖（未验证平台组合的逃生门；仍受域名白名单约束）。 */
  downloadUrl?: string
  fetchImpl?: FetchLike
  signal?: AbortSignal
  env?: Readonly<Record<string, string | undefined>>
  cacheDir?: string
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findExtractedExecutable(extractDir: string, flavor: ExecutableFlavor): Promise<string | undefined> {
  if (!(await fileExists(extractDir))) return undefined
  // 扫描解压目录（浅层递归足够：官方 zip 最多一层目录）。
  const walk = async (dir: string, prefix: string): Promise<string[]> => {
    const items = await readdir(dir, { withFileTypes: true })
    const files: string[] = []
    for (const item of items) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isDirectory()) files.push(...(await walk(join(dir, item.name), rel)))
      else files.push(rel)
    }
    return files
  }
  const entries = await walk(extractDir, '')
  try {
    const relative = pickExecutablePath(entries, flavor)
    return join(extractDir, relative)
  } catch {
    return undefined
  }
}

/**
 * 完整解析顺序。下载阶段：先落 `<versionDir>/agy-acp-server.zip.tmp`，
 * 成功后原子重命名，失败清理临时残留；解压先在临时目录进行，全部成功
 * 后重命名进 extract 目录，保证缓存状态始终自洽。
 */
export async function ensureAgentBinary(options: AgentBinaryOptions = {}): Promise<AgentBinaryResolution> {
  const env = options.env ?? process.env
  const version = options.version ?? DEFAULT_ACP_SERVER_VERSION
  const cacheDir = options.cacheDir ?? resolveCacheDir(env)
  const { platform, arch } = mapNodePlatform(process.platform, process.arch)
  const flavor: ExecutableFlavor = platform === 'windows' ? 'windows' : 'posix'

  if (options.binaryPath && options.binaryPath.trim().length > 0) {
    if (!(await fileExists(options.binaryPath))) {
      throw new AgyBinaryError(AGY_BINARY_ERROR.BINARY_MISSING, `config.binaryPath 不存在: ${options.binaryPath}`)
    }
    return { executablePath: resolve(options.binaryPath), source: 'config', checksumVerified: false }
  }

  const envPath = env.AGY_ACP_BIN
  if (envPath && envPath.trim().length > 0) {
    if (!(await fileExists(envPath))) {
      throw new AgyBinaryError(AGY_BINARY_ERROR.BINARY_MISSING, `环境变量 AGY_ACP_BIN 指向的文件不存在: ${envPath}`)
    }
    return { executablePath: resolve(envPath), source: 'env', checksumVerified: false }
  }

  const { versionDir, extractDir } = versionCachePaths(cacheDir, version)
  const cached = await findExtractedExecutable(extractDir, flavor)
  if (cached) {
    await ensureExecutable(cached, flavor)
    return { executablePath: cached, source: 'cache', version, checksumVerified: false }
  }

  const autoDownload = options.autoDownload ?? true
  if (!autoDownload) {
    throw new AgyBinaryError(
      AGY_BINARY_ERROR.BINARY_MISSING,
      `未找到 ACP server 二进制（binaryPath 未配置、AGY_ACP_BIN 未设置、缓存无 ${version} 版本）且 autoDownload=false`,
    )
  }

  // URL 覆盖仅供未验证平台组合使用；无论来源都过域名白名单。
  const url = options.downloadUrl ?? env.AGY_ACP_URL ?? resolveDownloadUrl(platform, arch, version)
  await mkdir(versionDir, { recursive: true })
  const staging = await mkdtemp(join(versionDir, '.staging-'))
  const zipTmp = join(staging, 'agy-acp-server.zip.tmp')
  try {
    const bytes = await downloadBinary(url, { fetchImpl: options.fetchImpl, signal: options.signal })
    await writeFile(zipTmp, bytes)
    const stagingExtract = join(staging, 'extract')
    await mkdir(stagingExtract, { recursive: true })
    const entries = await extractZipSafely(zipTmp, stagingExtract)
    const relative = pickExecutablePath(entries, flavor)
    const finalExtract = extractDir
    await rm(finalExtract, { recursive: true, force: true })
    await rename(stagingExtract, finalExtract)
    const executablePath = join(finalExtract, relative)
    await ensureExecutable(executablePath, flavor)
    return { executablePath, source: 'download', version, checksumVerified: false }
  } finally {
    // 失败/成功都要清掉暂存残渣（zip 临时文件与可能的半成品）。
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}
