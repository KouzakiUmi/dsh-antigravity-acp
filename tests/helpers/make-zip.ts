/**
 * 测试专用最小 zip 写入器（store 方法、原创实现）。
 * 仅用于在测试中构造真实 zip 容器（正常布局与恶意布局各取所需），
 * 不进入 src/ 运行时代码。
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface ZipInput {
  name: string
  data: Buffer
}

/** 构造一个 store 方法的 zip 容器 Buffer。 */
export function zip(inputs: readonly ZipInput[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const input of inputs) {
    const nameBytes = Buffer.from(input.name, 'utf8')
    const crc = crc32(input.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // flags: UTF-8 names
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(0, 10) // mtime
    local.writeUInt16LE(0x2100, 12) // mdate (arbitrary valid)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(input.data.length, 18) // compressed size
    local.writeUInt32LE(input.data.length, 22) // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    localParts.push(local, nameBytes, input.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // central directory signature
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8) // flags
    central.writeUInt16LE(0, 10) // method: store
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x2100, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(input.data.length, 20)
    central.writeUInt32LE(input.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42) // local header offset
    centralParts.push(central, nameBytes)

    offset += 30 + nameBytes.length + input.data.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4) // disk
  eocd.writeUInt16LE(0, 6) // cd disk
  eocd.writeUInt16LE(inputs.length, 8) // entries on this disk
  eocd.writeUInt16LE(inputs.length, 10) // total entries
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16) // cd offset
  eocd.writeUInt16LE(0, 20) // comment length

  const buffer = Buffer.concat([...localParts, ...centralParts, eocd])
  return buffer
}

/** 构造 zip 并写入磁盘文件，返回文件路径。 */
export async function zipToFile(inputs: readonly ZipInput[], path: string): Promise<string> {
  const buffer = zip(inputs)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, buffer)
  return path
}
