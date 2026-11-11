/**
 * 上游指纹诊断（**只读**，不改写任何请求内容）。
 *
 * magpie 生态里两个独立实现的实测结论：
 * - `hexiaolv/magpie-antigravity-cloak`：Antigravity 上游按请求文本里的指纹串
 *   拦截，并统一伪装成 `429 Resource has been exhausted`——不是额度问题，
 *   换账号、等额度恢复都无效；关键触发词是 Claude Code 塞进 system 的
 *   `x-anthropic-billing-header` 计费标记行（该公司用零宽空格打散这些词）。
 * - `DylanLIiii/opencode-antigravity-bridge`：把「独立计费伪 header」整行删掉、
 *   把已知 Agent SDK 身份句换成中性句，并明确「通用 429 不再被当作确定配额
 *   耗尽」。
 * - `yetone/magpie` 本体（`internal/gateway/billing_line.go`）的口径不同：它只在
 *   「Anthropic Messages API 上的 Claude 模型」保留计费行，对 **Code Assist /
 *   Antigravity 照旧发送**，去掉该行是为了别的厂家的前缀缓存命中率。
 *
 * 两派做法互斥，本包不选边：**默认只诊断**，把命中的规则 id 与次数交给宿主日志，
 * 让「恒定 429」有据可查；只有显式打开 `cloakSensitiveWords` 时才改写 system
 * （见 {@link cloakUpstreamFingerprints}，属绕过上游识别，默认关闭，风险自负）。
 * DSH 自身的 system 不含这些词（已在本机宿主包里核对），命中通常意味着用户自定义
 * 指令里出现了它们。边界说明见 `docs/configuration.md` 的代理模式一节。
 */

/** 已知会被上游识别为「非官方客户端」的指纹词表（口径取自上面两份实现）。 */
export const UPSTREAM_FINGERPRINTS: readonly { ruleId: string; phrase: string }[] = [
  { ruleId: 'anthropic-billing-header', phrase: 'x-anthropic-billing-header' },
  { ruleId: 'claude-agent-sdk-identity', phrase: "built on Anthropic's Claude Agent SDK" },
  { ruleId: 'claude-code-identity', phrase: "Anthropic's official CLI for Claude" },
  { ruleId: 'claude-agent-sdk', phrase: 'Claude Agent SDK' },
  { ruleId: 'claude-code', phrase: 'Claude Code' },
  { ruleId: 'system-conventions', phrase: 'system-conventions' },
  { ruleId: 'system-conventions-underscore', phrase: 'system_conventions' },
  { ruleId: 'system-directive', phrase: 'system-directive' },
  { ruleId: 'system-directive-underscore', phrase: 'system_directive' },
  { ruleId: 'rfc-2119', phrase: 'RFC 2119' },
]

export interface FingerprintHit {
  /** 命中的规则 id；不含命中的原文，日志里也不回显正文。 */
  readonly ruleId: string
  readonly count: number
}

/**
 * 大小写不敏感地统计文本里出现的已知指纹。
 *
 * @param text 待扫描文本（通常是本轮 system）；undefined / 空串返回空数组。
 * @returns 命中的规则与次数；顺序与 {@link UPSTREAM_FINGERPRINTS} 一致。
 */
export function scanUpstreamFingerprints(text: string | undefined): FingerprintHit[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const haystack = text.toLowerCase()
  const hits: FingerprintHit[] = []
  for (const rule of UPSTREAM_FINGERPRINTS) {
    const needle = rule.phrase.toLowerCase()
    let count = 0
    let from = 0
    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at < 0) break
      count += 1
      from = at + needle.length
    }
    if (count > 0) hits.push({ ruleId: rule.ruleId, count })
  }
  return hits
}

/** 把命中结果压成一行日志片段（只有规则 id 与次数）。 */
export function describeFingerprintHits(hits: readonly FingerprintHit[]): string {
  return hits.map((hit) => `${hit.ruleId}×${String(hit.count)}`).join('、')
}

/**
 * magpie 实测会被 Antigravity 拒绝的整段文本（其 `googleTurnsAway` 词表：
 * 一条条真实账号上试过——原样写、任意大小写都被拒，**首字符后插入零宽空格
 * 后通过**）。与上面的诊断词表分开：诊断表更宽（含社区中间件的词），
 * 这张表只放有实测依据的。
 */
export const CLOAK_PHRASES: readonly { ruleId: string; phrase: string }[] = [
  { ruleId: 'anthropic-billing-header', phrase: 'x-anthropic-billing-header:' },
  { ruleId: 'claude-agent-sdk-identity', phrase: "built on anthropic's claude agent sdk" },
  { ruleId: 'codex-identity', phrase: 'you are codex, an agent based on gpt-5' },
  { ruleId: 'codex-identity-coding', phrase: 'you are codex, a coding agent based on gpt-5' },
  { ruleId: 'hermes-identity', phrase: 'hermes agent, an intelligent ai assistant created by nous research' },
]

/**
 * 只把 A-Z 降成小写：长度与每个字符的位置都不变。
 *
 * 不能用 `String.prototype.toLowerCase`：它是全量大小写映射，`'İ'` 这类字符
 * 会变成两个 code unit，降级串的下标就与原串错位（magpie 的 Go 实现用
 * `len(low) != len(system)` 检查绕开同一问题，并有用例锁定）。
 */
function asciiLower(text: string): string {
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[index]!
  }
  return out
}

/** 零宽空格：人眼不可见、去零宽即还原原文（magpie 与社区中间件同一手法）。 */
export const ZERO_WIDTH_SPACE = '\u200b'

function isAsciiAlnum(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

/** 在长度 ≥3 的 ASCII 字母/数字连续段的第 1、2 个字符后各插一个零宽空格。 */
function breakAsciiRuns(segment: string): string {
  let out = ''
  for (let index = 0; index < segment.length;) {
    let end = index
    while (end < segment.length && isAsciiAlnum(segment.charCodeAt(end))) end += 1
    if (end === index) {
      out += segment[index]
      index += 1
      continue
    }
    const run = segment.slice(index, end)
    out += run.length >= 3
      ? `${run[0]!}${ZERO_WIDTH_SPACE}${run[1]!}${ZERO_WIDTH_SPACE}${run.slice(2)}`
      : run
    index = end
  }
  return out
}

/**
 * 把已知会被上游拒绝的身份文本打散（大小写不敏感，命中区间内逐段插入零宽空格）。
 *
 * 只作用于 system 指令，不动用户消息；返回命中规则用于日志。是否启用由配置决定
 * （默认关闭）：这属于绕过上游识别，写进 `docs/reference.md` 的代理模式边界里。
 */
export function cloakUpstreamFingerprints(text: string | undefined): { text: string; hits: FingerprintHit[] } {
  if (typeof text !== 'string' || text.length === 0) return { text: text ?? '', hits: [] }
  let result = text
  const hits: FingerprintHit[] = []
  for (const rule of CLOAK_PHRASES) {
    let cursor = 0
    let count = 0
    let output = ''
    const lowered = asciiLower(result)
    for (;;) {
      const at = lowered.indexOf(rule.phrase, cursor)
      if (at < 0) {
        output += result.slice(cursor)
        break
      }
      output += result.slice(cursor, at) + breakAsciiRuns(result.slice(at, at + rule.phrase.length))
      cursor = at + rule.phrase.length
      count += 1
    }
    if (count > 0) {
      result = output
      hits.push({ ruleId: rule.ruleId, count })
    }
  }
  return { text: result, hits }
}
