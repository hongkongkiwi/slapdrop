import { describe, expect, it } from 'vitest'
import { type ByteSource, listZipEntries, readZipEntry } from '../src/apk/zip'

const encoder = new TextEncoder()

const concat = (...parts: Uint8Array[]) => {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

const u16 = (value: number) => {
  const bytes = new Uint8Array(2)
  new DataView(bytes.buffer).setUint16(0, value, true)
  return bytes
}

const u32 = (value: number) => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

const deflate = async (bytes: Uint8Array) => {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

interface TestEntry {
  name: string
  content: string
  compressed?: boolean
}

const testZip = async (entries: TestEntry[]) => {
  const locals: Uint8Array[] = []
  const central: Uint8Array[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const content = encoder.encode(entry.content)
    const data = entry.compressed ? await deflate(content) : content
    const method = entry.compressed ? 8 : 0
    const local = concat(
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(data.byteLength),
      u32(content.byteLength),
      u16(name.byteLength),
      u16(0),
      name,
      data,
    )
    locals.push(local)
    central.push(
      concat(
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(method),
        u16(0),
        u16(0),
        u32(0),
        u32(data.byteLength),
        u32(content.byteLength),
        u16(name.byteLength),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(localOffset),
        name,
      ),
    )
    localOffset += local.byteLength
  }

  const localBytes = concat(...locals)
  const centralBytes = concat(...central)
  return concat(
    localBytes,
    centralBytes,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBytes.byteLength),
    u32(localBytes.byteLength),
    u16(0),
  )
}

const source = (bytes: Uint8Array): ByteSource => ({
  size: bytes.byteLength,
  read: async (offset, length) => bytes.slice(offset, offset + length),
})

describe('APK ZIP reader', () => {
  it('reads AndroidManifest.xml through central-directory range lookup', async () => {
    const zip = await testZip([
      { name: 'classes.dex', content: 'dex' },
      { name: 'AndroidManifest.xml', content: 'binary-manifest' },
    ])

    const entries = await listZipEntries(source(zip))
    expect(entries.map((entry) => entry.name)).toEqual(['classes.dex', 'AndroidManifest.xml'])

    const manifest = entries.find((entry) => entry.name === 'AndroidManifest.xml')
    if (!manifest) throw new Error('AndroidManifest.xml entry missing from test zip')
    expect(new TextDecoder().decode(await readZipEntry(source(zip), manifest))).toBe(
      'binary-manifest',
    )
  })

  it('inflates a DEFLATE-compressed manifest entry', async () => {
    const zip = await testZip([
      { name: 'AndroidManifest.xml', content: 'compressed manifest', compressed: true },
    ])
    const [manifest] = await listZipEntries(source(zip))
    if (!manifest) throw new Error('test zip has no entries')

    expect(new TextDecoder().decode(await readZipEntry(source(zip), manifest))).toBe(
      'compressed manifest',
    )
  })

  it('rejects archives without an EOCD record', async () => {
    await expect(listZipEntries(source(encoder.encode('not a zip')))).rejects.toThrow('EOCD record')
  })
})
