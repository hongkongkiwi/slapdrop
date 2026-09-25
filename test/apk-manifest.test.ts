import { describe, expect, it } from 'vitest'
import { parseAndroidManifest } from '../src/apk/manifest'

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

const utf8Length = (length: number) => (length < 0x80 ? new Uint8Array([length]) : new Uint8Array([0x80 | (length >> 8), length & 0xff]))

const stringPool = (strings: string[]) => {
  const offsets: Uint8Array[] = []
  const values: Uint8Array[] = []
  let offset = 0
  for (const string of strings) {
    const value = encoder.encode(string)
    offsets.push(u32(offset))
    const encoded = concat(utf8Length([...string].length), utf8Length(value.byteLength), value, new Uint8Array([0]))
    values.push(encoded)
    offset += encoded.byteLength
  }
  const headerSize = 28
  const stringsStart = headerSize + strings.length * 4
  const body = concat(u32(strings.length), u32(0), u32(0x100), u32(stringsStart), u32(0), ...offsets, ...values)
  return concat(u16(1), u16(headerSize), u32(headerSize + body.byteLength), body)
}

const startElement = (
  element: number,
  attributes: Array<{ name: number; value: number | string }>,
  strings: string[],
) => {
  const headerSize = 36
  const attributeSize = 20
  const attributeBytes = attributes.map(({ name, value }) => {
    const isString = typeof value === 'string'
    const data = isString ? strings.indexOf(value) : value
    return concat(
      u32(0xffffffff),
      u32(name),
      u32(isString ? data : 0xffffffff),
      u16(8),
      new Uint8Array([0, isString ? 3 : 0x10]),
      u32(data),
    )
  })
  const extension = concat(
    u32(0),
    u32(0xffffffff),
    u32(element),
    u16(20),
    u16(attributeSize),
    u16(attributes.length),
    u16(0),
    u16(0),
    u16(0),
  )
  const body = concat(extension, ...attributeBytes)
  return concat(u16(0x0102), u16(headerSize), u32(headerSize + body.byteLength), body)
}

const binaryManifest = () => {
  const strings = [
    'manifest',
    'uses-sdk',
    'application',
    'package',
    'versionName',
    'versionCode',
    'minSdkVersion',
    'label',
    'dev.slapdrop.fixture',
    '1.2.3',
    'Fixture App',
  ]
  const index = (value: string) => strings.indexOf(value)
  const content = concat(
    stringPool(strings),
    startElement(
      index('manifest'),
      [
        { name: index('package'), value: 'dev.slapdrop.fixture' },
        { name: index('versionName'), value: '1.2.3' },
        { name: index('versionCode'), value: 123 },
      ],
      strings,
    ),
    startElement(index('uses-sdk'), [{ name: index('minSdkVersion'), value: 23 }], strings),
    startElement(index('application'), [{ name: index('label'), value: 'Fixture App' }], strings),
  )
  return concat(u16(3), u16(8), u32(8 + content.byteLength), content)
}

describe('Android binary XML manifest parser', () => {
  it('extracts literal Android manifest metadata', () => {
    expect(parseAndroidManifest(binaryManifest())).toEqual({
      packageName: 'dev.slapdrop.fixture',
      versionName: '1.2.3',
      versionCode: 123,
      minSdkVersion: '23',
      appLabel: 'Fixture App',
    })
  })

  it('rejects plaintext XML', () => {
    expect(() => parseAndroidManifest(encoder.encode('<manifest />'))).toThrow('not binary Android XML')
  })
})
