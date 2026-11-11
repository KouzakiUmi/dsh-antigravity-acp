/**
 * 代理模式的 replay 元数据：块对齐的 thoughtSignature 保留。
 *
 * 口径与 dsh-tool-antigravity 的 replay.ts 相同（只保留上游签名的有界子集），
 * provider 标识为 `antigravity-proxy`，因此 ACP 模式的 replay 状态不会被
 * 代理模式误用，反之亦然。
 */
import type { Message, ReplayEnvelope, ToolSchema } from '@deepseek-ai/dsh-llm'

export const PROXY_REPLAY_VERSION = 1 as const
export const PROXY_PROVIDER_ID = 'antigravity-proxy' as const
export const PROXY_MAX_SIGNATURE_LENGTH = 16 * 1024
const MAX_BLOCKS = 128

export type ReplayBlockKind = 'text' | 'reasoning' | 'tool-call'
export type ProxyModelFamily = 'gemini' | 'claude' | 'gpt-oss' | 'unknown'

export interface ProxyReplayBlock {
  readonly kind: ReplayBlockKind
  readonly signature?: string
}

export interface ProxyReplayState extends ReplayEnvelope {
  readonly response: {
    readonly version: typeof PROXY_REPLAY_VERSION
    readonly provider: typeof PROXY_PROVIDER_ID
    readonly model: string
    readonly family: ProxyModelFamily
    readonly wireModel?: string
    readonly finish?: string
  }
  readonly blocks: readonly ProxyReplayBlock[]
}

export function proxyModelFamily(model: string): ProxyModelFamily {
  const value = model.toLowerCase()
  if (value.includes('gemini')) return 'gemini'
  if (value.includes('claude')) return 'claude'
  if (value.includes('gpt-oss')) return 'gpt-oss'
  return 'unknown'
}

export function createProxyReplayState(
  model: string,
  family: ProxyModelFamily,
  finish: string | undefined,
  blocks: readonly ProxyReplayBlock[],
  wireModel?: string,
): ProxyReplayState {
  const boundedBlocks = blocks.slice(0, MAX_BLOCKS).map((block) => {
    const signature = safeSignature(block.signature)
    return { kind: block.kind, ...(signature === undefined ? {} : { signature }) }
  })
  const boundedFinish = safeFinish(finish)
  return {
    response: {
      version: PROXY_REPLAY_VERSION,
      provider: PROXY_PROVIDER_ID,
      model: model.slice(0, 256),
      family,
      ...(wireModel === undefined ? {} : { wireModel }),
      ...(boundedFinish === undefined ? {} : { finish: boundedFinish }),
    },
    blocks: boundedBlocks,
  }
}

/** 校验历史消息上的 replay 元数据；不兼容返回 undefined（按无签名重放）。 */
export function compatibleProxyReplayState(
  message: Message,
  model: string,
  blockKinds?: readonly ReplayBlockKind[],
  wireModel?: string,
): ProxyReplayState | undefined {
  if (message.role !== 'assistant') return undefined
  const provenance = isRecord(message.source) ? (message.source as Record<string, unknown>) : undefined
  if (provenance !== undefined && provenance.kind === 'model' && (provenance.provider !== PROXY_PROVIDER_ID || provenance.model !== model)) return undefined
  const value = isRecord(provenance?.replayState)
    ? provenance.replayState
    : isRecord((message as unknown as Record<string, unknown>).replayState)
      ? (message as unknown as Record<string, unknown>).replayState
      : undefined
  if (!isRecord(value) || !isRecord(value.response) || !Array.isArray(value.blocks)) return undefined
  const family = value.response.family
  if (value.response.version !== PROXY_REPLAY_VERSION
    || value.response.provider !== PROXY_PROVIDER_ID
    || value.response.model !== model
    || (wireModel !== undefined && value.response.wireModel !== undefined && value.response.wireModel !== wireModel)
    || !isFamily(family)
    || value.blocks.length > MAX_BLOCKS) return undefined
  const blocks: ProxyReplayBlock[] = []
  for (const item of value.blocks) {
    if (!isRecord(item) || typeof item.kind !== 'string') continue
    const kind = item.kind as ReplayBlockKind
    const signature = typeof item.signature === 'string' && safeSignature(item.signature) !== undefined ? item.signature : undefined
    blocks.push({ kind, ...(signature === undefined ? {} : { signature }) })
  }
  if (blockKinds !== undefined
    && (blocks.length !== blockKinds.length || blocks.some((block, index) => block.kind !== blockKinds[index]))) return undefined
  const finish = value.response.finish === undefined ? undefined : safeFinish(value.response.finish)
  if (value.response.finish !== undefined && finish === undefined) return undefined
  return {
    response: {
      version: PROXY_REPLAY_VERSION,
      provider: PROXY_PROVIDER_ID,
      model,
      family,
      ...(typeof value.response.wireModel === 'string' ? { wireModel: value.response.wireModel } : {}),
      ...(finish === undefined ? {} : { finish }),
    },
    blocks,
  }
}

/** DSH 工具 schema → 上游 functionDeclarations 子集（有界、可序列化）。 */
export function buildProxyFunctionDeclarations(tools: readonly ToolSchema[] | undefined): readonly Record<string, unknown>[] {
  if (tools === undefined) return []
  return [...tools].slice(0, 384).map((tool) => {
    // 本地 $ref 指向同一个工具 schema 的内部：DSH 的工具参数就带这种引用
    // （magpie 的直连实现专门为它写了展开，issue #4561）。不展开会把整个
    // 节点退化成空对象，模型与上游都看不到真实参数结构。
    const scope: SchemaScope = { root: tool.parameters, defs: collectLocalDefs(tool.parameters) }
    return {
      name: boundedName(tool.name),
      description: boundedText(tool.description, 4096),
      parameters: sanitizeSchema(tool.parameters, 0, scope, true),
    }
  })
}

interface SchemaScope {
  /** 该工具 parameters 的根，供 `#` 与 `#/…` 指针解析。 */
  readonly root: unknown
  /** 根上的 `$defs` / `definitions`，供名字或指针末段回退。 */
  readonly defs: ReadonlyMap<string, unknown>
}

/** 收集根上的 `$defs` / `definitions`；两个键都存在时后者不覆盖前者。 */
function collectLocalDefs(root: unknown): ReadonlyMap<string, unknown> {
  const defs = new Map<string, unknown>()
  if (!isRecord(root)) return defs
  for (const key of ['$defs', 'definitions']) {
    const bucket = root[key]
    if (!isRecord(bucket)) continue
    for (const [name, value] of Object.entries(bucket)) if (!defs.has(name)) defs.set(name, value)
  }
  return defs
}

/** 解析本地 `$ref`：`#`、JSON Pointer（`#/properties/x/items`）或末段名字。 */
function resolveLocalRef(ref: string, scope: SchemaScope): unknown {
  if (ref === '#') return scope.root
  const name = ref.slice(ref.lastIndexOf('/') + 1)
  if (!ref.startsWith('#/')) return scope.defs.get(name)
  let current: unknown = scope.root
  for (const rawToken of ref.slice(2).split('/')) {
    const token = rawToken.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (Array.isArray(current)) {
      const index = Number(token)
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) { current = undefined; break }
      current = current[index]
    } else if (isRecord(current)) current = current[token]
    else { current = undefined; break }
    if (current === undefined) break
  }
  // 指针没走通时退回「最后一段作为 $defs / definitions 名字」。
  return current === undefined ? scope.defs.get(name) : current
}

// ---------------------------------------------------------------- internals

const ALLOWED_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function isNullBranch(branch: unknown): boolean {
  if (!isRecord(branch)) return false
  const type = typeof branch.type === 'string' ? branch.type.toLowerCase() : undefined
  return type === 'null' || (type === undefined && branch.const === null)
}

function sanitizeSchema(value: unknown, depth = 0, scope?: SchemaScope, isRoot = false): Record<string, unknown> | undefined {
  // 布尔 schema：true 是「任意值」（按 {} 处理，随后按形状推断），false 是
  // 「没有值」，整个节点/属性/分支被删掉。Google 会因为 `items: true` 这类节点
  // 拒绝整个请求（"Invalid value at '…items.items' …, true"）。
  if (value === false) return undefined
  if (value === true) value = {}
  if (depth > 8 || !isRecord(value)) return { type: isRoot ? 'object' : 'string' }
  let source = value
  // 本地 $ref：循环解链（zod/生成器会产生别名链），并保留本节点的兄弟键
  // （description / nullable / enum …）——只挑 description 会让兄弟约束消失。
  if (typeof source.$ref === 'string' && source.$ref.length > 0 && scope !== undefined) {
    const seen = new Set<string>()
    let ref: string | undefined = source.$ref
    let target: unknown
    while (typeof ref === 'string' && ref.length > 0 && !seen.has(ref)) {
      seen.add(ref)
      const resolved = resolveLocalRef(ref, scope)
      if (!isRecord(resolved)) break
      target = resolved
      ref = typeof resolved.$ref === 'string' ? resolved.$ref : undefined
    }
    if (isRecord(target)) {
      const siblings: Record<string, unknown> = { ...source }
      delete siblings.$ref
      source = { ...target, ...siblings }
    }
  }
  if (Array.isArray(source.allOf) && source.allOf.length > 0) {
    const mergedProps: Record<string, unknown> = isRecord(source.properties) ? { ...source.properties } : {}
    const mergedReq = new Set(Array.isArray(source.required) ? source.required.filter((item): item is string => typeof item === 'string') : [])
    for (const branch of source.allOf.slice(0, 8)) {
      if (!isRecord(branch)) continue
      if (isRecord(branch.properties)) Object.assign(mergedProps, branch.properties)
      if (Array.isArray(branch.required)) for (const req of branch.required) if (typeof req === 'string') mergedReq.add(req)
    }
    source = { ...source, type: 'object', properties: mergedProps, ...(mergedReq.size > 0 ? { required: [...mergedReq] } : {}) }
  }
  const rawUnion = Array.isArray(source.anyOf) && source.anyOf.length > 0 ? source.anyOf
    : Array.isArray(source.oneOf) && source.oneOf.length > 0 ? source.oneOf : undefined
  let unionNullable = false
  let unionRequired: string[] | undefined
  let unionProperties: Record<string, unknown> | undefined
  if (rawUnion !== undefined) {
    // foldUnion（照 magpie 的直连实现）：**本节点自己说的算**，union 只贡献能合并
    // 的部分——null 分支给 nullable；对象形态下分支声明的字段并进 properties
    // （第一个声明它的分支决定形状）；只有所有非 null 分支都要求的字段才算
    // required；「哪些字段能一起给」和 not 这类规则在上游的 schema 子集里表达
    // 不了，丢弃。照 union 折叠整个节点会丢掉对象结构与显式 type，上游随即 400
    // （"input_schema.type: Input should be 'object'"）。
    const objectLike = source.type === 'object' || isRecord(source.properties)
      || (Array.isArray(source.type) && source.type.some((item) => typeof item === 'string' && item.toLowerCase() === 'object'))
    const props: Record<string, unknown> = {}
    const requiredSets: Set<string>[] = []
    for (const branch of rawUnion.slice(0, 8)) {
      if (!isRecord(branch)) continue
      if (isNullBranch(branch)) { unionNullable = true; continue }
      const resolved = typeof branch.$ref === 'string' && scope !== undefined ? resolveLocalRef(branch.$ref, scope) : branch
      const node = isRecord(resolved) ? resolved : branch
      if (!objectLike) continue
      if (isRecord(node.properties)) for (const [key, item] of Object.entries(node.properties)) if (!(key in props)) props[key] = item
      requiredSets.push(new Set(Array.isArray(node.required) ? node.required.filter((item): item is string => typeof item === 'string') : []))
    }
    if (objectLike) {
      if (Object.keys(props).length > 0) unionProperties = props
      if (requiredSets.length > 0) {
        const common = [...requiredSets[0]!].filter((key) => requiredSets.every((set) => set.has(key)))
        if (common.length > 0) unionRequired = common
      }
    }
    const rest: Record<string, unknown> = { ...source }
    delete rest.anyOf
    delete rest.oneOf
    source = rest
  }
  let explicitType: string | undefined
  let nullable = source.nullable === true || unionNullable
  if (typeof source.type === 'string' && ALLOWED_SCHEMA_TYPES.has(source.type.toLowerCase())) explicitType = source.type.toLowerCase()
  else if (Array.isArray(source.type)) {
    const valid = [...new Set(source.type.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase()).filter((item) => ALLOWED_SCHEMA_TYPES.has(item)))]
    const nonNull = valid.filter((item) => item !== 'null')
    if (valid.includes('null') && nonNull.length > 0) nullable = true
    explicitType = nonNull[0] ?? valid[0]
  }
  let enumValues: string[] | undefined
  const hints: string[] = []
  if (typeof source.const === 'string' && source.const.trim().length > 0 && !hasControl(source.const)) {
    enumValues = [source.const.slice(0, 256)]
    explicitType ??= 'string'
  } else if (typeof source.const === 'number' || typeof source.const === 'boolean') {
    hints.push(`Must be ${String(source.const)}`)
    explicitType ??= typeof source.const
  } else if (Array.isArray(source.enum)) {
    // 空串与纯空白都是上游眼里的空枚举值（"enum[3]: cannot be empty"）；
    // 数字 / 布尔 0 与 false 不是空值，不能一起过滤掉。
    const rawEnum = source.enum.slice(0, 128).filter((item) => ['string', 'number', 'boolean'].includes(typeof item)
      && !(typeof item === 'string' && item.trim() === ''))
    if (rawEnum.length > 0) {
      if (rawEnum.every((item): item is string => typeof item === 'string' && !hasControl(item))) {
        enumValues = rawEnum.map((item) => item.slice(0, 256))
        explicitType ??= 'string'
      } else {
        hints.push(`Allowed values: ${rawEnum.map((item) => JSON.stringify(item)).join(', ')}`)
      }
    }
  }
  // items 只出现在 array 上、properties 只出现在 object 上：节点有 items 就是
  // array、有 properties 就是 object，**优先于**显式 type 与从 enum/const 推断的
  // 类型（未类型化的数组 `{items:{type:'string'}, enum:[…]}` 被推成 string 后，
  // items 挂在 string 上会让上游整轮 400）。形状说不清的节点回退 string，只有
  // 工具参数的根一定是 object。
  const hasProperties = isRecord(source.properties)
  const type = source.items !== undefined ? 'array' : hasProperties ? 'object' : explicitType ?? (isRoot ? 'object' : 'string')
  const output: Record<string, unknown> = { type }
  const baseDesc = typeof source.description === 'string' ? boundedText(source.description, 1024) : ''
  const fullDesc = hints.length > 0 ? (baseDesc ? `${baseDesc} (${hints.join('; ')})` : hints.join('; ')) : baseDesc
  if (fullDesc.length > 0) output.description = fullDesc
  if (nullable && type !== 'null') output.nullable = true
  if (enumValues !== undefined && enumValues.length > 0) output.enum = enumValues
  if (type === 'object') {
    const properties: Record<string, unknown> = {}
    const declared: Record<string, unknown> = { ...(isRecord(source.properties) ? source.properties : {}), ...(unionProperties ?? {}) }
    for (const [key, item] of Object.entries(declared).slice(0, 128)) {
      if (hasControl(key) || key.length === 0) continue
      const cleaned = sanitizeSchema(item, depth + 1, scope)
      // false schema 的属性整体删掉：模型看不到一个「不存在的参数」。
      if (cleaned !== undefined) properties[key.slice(0, 128)] = cleaned
    }
    output.properties = properties
    const required = new Set<string>()
    if (Array.isArray(source.required)) for (const item of source.required) if (typeof item === 'string') required.add(item)
    for (const item of unionRequired ?? []) required.add(item)
    const validRequired = [...required].filter((item) => Object.prototype.hasOwnProperty.call(properties, item)).slice(0, 128)
    if (validRequired.length > 0) output.required = validRequired
  } else if (type === 'array') {
    const items = source.items === undefined ? undefined : sanitizeSchema(source.items, depth + 1, scope)
    output.items = items ?? { type: 'string' }
  }
  return output
}


function safeFinish(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return undefined
  const normalized = value.toUpperCase()
  return ['STOP', 'MAX_TOKENS', 'LENGTH', 'TOOL_CALLS', 'FUNCTION_CALL', 'SAFETY', 'BLOCKLIST', 'ERROR'].includes(normalized) ? normalized : undefined
}

function safeSignature(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > PROXY_MAX_SIGNATURE_LENGTH) return undefined
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return undefined
  }
  return value
}

function boundedName(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && !hasControl(value) ? value.slice(0, 128) : 'unnamed_tool'
}

function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' && !hasControl(value) ? value.slice(0, limit) : ''
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return true
  }
  return false
}

function isFamily(value: unknown): value is ProxyModelFamily {
  return value === 'gemini' || value === 'claude' || value === 'gpt-oss' || value === 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
