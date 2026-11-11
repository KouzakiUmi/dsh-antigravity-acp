/**
 * 代理模式工具 schema 的本地 `$ref` 展开。
 *
 * DSH 的工具参数会带同一个 schema 内部的本地引用（JSON Pointer 或
 * `$defs` 名字）。上游（Antigravity / Code Assist）不接受引用，而把节点
 * 原样丢过去会让参数结构整个消失；magpie 的直连实现为同一问题写了展开
 * （其 issue #4561）。这里锁住展开、回退与循环引用的边界。
 */
import { describe, expect, it } from 'vitest'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { buildProxyFunctionDeclarations } from '../src/proxy/replay.js'

function declarations(parameters: unknown): Record<string, unknown> {
  const tools = [{ name: 'demo', description: 'demo', parameters }] as unknown as ToolSchema[]
  const [declaration] = buildProxyFunctionDeclarations(tools)
  return declaration!.parameters as Record<string, unknown>
}

function propertiesOf(parameters: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return parameters.properties as Record<string, Record<string, unknown>>
}

describe('代理模式工具 schema 的本地 $ref', () => {
  it('JSON Pointer 引用展开成真实结构，而不是空对象', () => {
    const parameters = declarations({
      type: 'object',
      properties: {
        target: { $ref: '#/properties/targetShape' },
        targetShape: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    })
    const target = propertiesOf(parameters).target!
    expect(target.type).toBe('object')
    expect(Object.keys(propertiesOf(target))).toEqual(['path'])
    expect(target.required).toEqual(['path'])
  })

  it('$defs 名字引用同样展开', () => {
    const parameters = declarations({
      type: 'object',
      $defs: { Point: { type: 'object', properties: { x: { type: 'number' } } } },
      properties: { origin: { $ref: '#/$defs/Point' } },
    })
    expect(Object.keys(propertiesOf(propertiesOf(parameters).origin!))).toEqual(['x'])
  })

  it('引用节点的 description 覆盖被引用节点', () => {
    const parameters = declarations({
      type: 'object',
      properties: {
        a: { $ref: '#/properties/b', description: '调用方说明' },
        b: { type: 'string', description: '定义处说明' },
      },
    })
    expect(propertiesOf(parameters).a!.description).toBe('调用方说明')
  })

  it('循环引用不会无限展开（形状说不清时按 string）', () => {
    const parameters = declarations({
      type: 'object',
      properties: { node: { $ref: '#/properties/node' } },
    })
    expect(propertiesOf(parameters).node!.type).toBe('string')
  })

  it('解析不到的引用不抛错，退化成 string', () => {
    const parameters = declarations({
      type: 'object',
      properties: { missing: { $ref: '#/properties/nope' } },
    })
    expect(propertiesOf(parameters).missing).toMatchObject({ type: 'string' })
  })

  it('$ref 别名链一路解到真实结构', () => {
    const parameters = declarations({
      type: 'object',
      $defs: { A: { $ref: '#/$defs/B' }, B: { type: 'object', properties: { path: { type: 'string' } } } },
      properties: { target: { $ref: '#/$defs/A' } },
    })
    expect(Object.keys(propertiesOf(propertiesOf(parameters).target!))).toEqual(['path'])
  })

  it('$ref 的兄弟键（nullable）不丢', () => {
    const parameters = declarations({
      type: 'object',
      $defs: { P: { type: 'object', properties: { x: { type: 'number' } } } },
      properties: { point: { $ref: '#/$defs/P', nullable: true } },
    })
    expect(propertiesOf(parameters).point).toMatchObject({ type: 'object', nullable: true })
  })

  it('空 enum 不会出现在发出的 schema 里', () => {
    const parameters = declarations({ type: 'string', enum: [] })
    expect(parameters.enum).toBeUndefined()
    expect(parameters.type).toBe('string')
  })
})

describe('对象节点带兄弟 union', () => {
  it('保留 object 与 properties，丢弃只表达字段互斥的 oneOf', () => {
    // magpie issue #4046 的复现形态：oneOf 的两个分支都只有 required/not。
    const parameters = declarations({
      type: 'object',
      properties: { pattern: { type: 'string' }, cursor: { type: 'string' } },
      oneOf: [
        { required: ['pattern'], not: { required: ['cursor'] } },
        { required: ['cursor'], not: { required: ['pattern'] } },
      ],
    })
    expect(parameters.type).toBe('object')
    expect(Object.keys(propertiesOf(parameters))).toEqual(['pattern', 'cursor'])
    expect(parameters.anyOf).toBeUndefined()
  })

  it('纯类型联合会按形状回退到 string（不向上游发 anyOf）', () => {
    const parameters = declarations({ anyOf: [{ type: 'string' }, { type: 'number' }] })
    expect(parameters.anyOf).toBeUndefined()
    // 工具参数的根按参考实现一定是 object（isRoot → object）。
    expect(parameters.type).toBe('object')
  })
})

describe('节点类型推断（items / properties 优先）', () => {
  it('未类型化但带 items 的数组是 array，不是从 enum 推出的 string', () => {
    const parameters = declarations({
      type: 'object',
      properties: {
        display: { description: 'columns', items: { type: 'string' }, enum: ['name', 'size', 'date'] },
        filter: { description: 'a filter', properties: { q: { type: 'string' } }, const: 'x' },
        plain: { enum: ['a', 'b'] },
      },
    })
    const props = propertiesOf(parameters)
    expect(props.display!.type).toBe('array')
    expect(props.display!.items).toMatchObject({ type: 'string' })
    expect(props.filter!.type).toBe('object')
    expect(props.plain!.type).toBe('string')
  })

  it('显式 type 也向 items / properties 让位', () => {
    const parameters = declarations({
      type: 'object',
      properties: {
        listed: { type: ['string', 'array', 'null'], items: { type: 'string' } },
        word: { type: 'string', minItems: 1, properties: { q: { type: 'string' } }, required: ['q'] },
      },
    })
    const props = propertiesOf(parameters)
    expect(props.listed!.type).toBe('array')
    expect(props.word!.type).toBe('object')
    expect(props.word!.properties).toMatchObject({ q: { type: 'string' } })
  })

  it('空数组元素类型被补成 string，且 description 不丢', () => {
    const parameters = declarations({
      type: 'object',
      properties: { batch: { type: 'array' }, items: { type: 'array', description: 'topics' } },
    })
    const props = propertiesOf(parameters)
    expect(props.batch!.items).toMatchObject({ type: 'string' })
    expect(props.items!.items).toMatchObject({ type: 'string' })
    expect(props.items!.description).toBe('topics')
  })

  it('空串与纯空白不算有效枚举值，数字 0 仍保留', () => {
    const blank = declarations({ type: 'string', enum: ['', ' '] })
    expect(blank.enum).toBeUndefined()
    const mixed = declarations({ type: 'string', enum: ['ok', '', ' '] })
    expect(mixed.enum).toEqual(['ok'])
    const numeric = declarations({ enum: ['a', 0, 1] })
    expect(numeric.enum).toBeUndefined()
    expect(numeric.description).toContain('Allowed values')
  })
})

describe('union 折叠（foldUnion 语义）', () => {
  it('null 分支给 nullable，所有分支共同要求的字段才 required，分支字段并入对象', () => {
    const parameters = declarations({
      type: 'object',
      properties: { a: { type: 'integer' } },
      anyOf: [{ required: ['a'] }, { type: 'null' }],
    })
    expect(parameters.type).toBe('object')
    expect(parameters.nullable).toBe(true)
    expect(parameters.required).toEqual(['a'])
  })

  it('分支声明的字段并进对象（第一个声明它的分支决定形状）', () => {
    const parameters = declarations({
      type: 'object',
      properties: { keep: { type: 'string' } },
      oneOf: [{ properties: { x: { type: 'string' } } }, { properties: { y: { type: 'number' } } }],
    })
    const props = propertiesOf(parameters)
    expect(Object.keys(props).sort()).toEqual(['keep', 'x', 'y'])
    expect(parameters.anyOf).toBeUndefined()
    expect(parameters.oneOf).toBeUndefined()
  })

  it('显式标量 type 遇注解 union 时保留 type，不产生空 object 分支', () => {
    const parameters = declarations({ type: 'string', description: 'd', anyOf: [{ format: 'date' }, { format: 'uuid' }] })
    expect(parameters.type).toBe('string')
    expect(parameters.anyOf).toBeUndefined()
  })
})

describe('布尔 schema', () => {
  it('false 属性被删除，true items 按形状推断', () => {
    const parameters = declarations({
      type: 'object',
      properties: { gone: false, kept: { type: 'string' } },
      required: ['gone', 'kept'],
    })
    const props = propertiesOf(parameters)
    expect(Object.keys(props)).toEqual(['kept'])
    expect(parameters.required).toEqual(['kept'])
  })

  it('items: false 仍补回一个合法 items', () => {
    const parameters = declarations({ type: 'array', items: false })
    expect(parameters.type).toBe('array')
    expect(parameters.items).toMatchObject({ type: 'string' })
  })
})
