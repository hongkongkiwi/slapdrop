export interface ApkManifest {
  packageName?: string
  versionName?: string
  versionCode?: number
  minSdkVersion?: string
  appLabel?: string
}

const RES_XML_TYPE = 0x0003
const RES_STRING_POOL_TYPE = 0x0001
const RES_XML_START_ELEMENT_TYPE = 0x0102
const UTF8_FLAG = 0x00000100
const NO_VALUE = 0xffffffff
const TYPE_STRING = 0x03
const TYPE_INT_DEC = 0x10
const TYPE_INT_HEX = 0x11

const decoder = new TextDecoder()

const fail = (message: string): never => {
  throw new Error(`Invalid AndroidManifest.xml: ${message}`)
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const u16 = (bytes: Uint8Array, offset: number) => {
  if (offset + 2 > bytes.byteLength) fail('unexpected end of data')
  return view(bytes).getUint16(offset, true)
}

const u32 = (bytes: Uint8Array, offset: number) => {
  if (offset + 4 > bytes.byteLength) fail('unexpected end of data')
  return view(bytes).getUint32(offset, true)
}

const utf8Length = (bytes: Uint8Array, offset: number) => {
  const first = bytes[offset] ?? fail('truncated UTF-8 string length')
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 }
  const second = bytes[offset + 1] ?? fail('truncated UTF-8 string length')
  return { length: ((first & 0x7f) << 8) | second, next: offset + 2 }
}

const utf16Length = (bytes: Uint8Array, offset: number) => {
  const first = u16(bytes, offset)
  if ((first & 0x8000) === 0) return { length: first, next: offset + 2 }
  return { length: ((first & 0x7fff) << 16) | u16(bytes, offset + 2), next: offset + 4 }
}

const stringPool = (
  bytes: Uint8Array,
  offset: number,
  headerSize: number,
  size: number,
): ((index: number) => string) => {
  if (headerSize < 28 || offset + size > bytes.byteLength) fail('invalid string pool')
  const count = u32(bytes, offset + 8)
  const flags = u32(bytes, offset + 16)
  const stringsStart = u32(bytes, offset + 20)
  const offsetsStart = offset + headerSize
  const dataStart = offset + stringsStart
  if (offsetsStart + count * 4 > offset + size || dataStart > offset + size) fail('truncated string pool')

  return (index: number) => {
    if (index < 0 || index >= count) fail('string index out of range')
    let cursor = dataStart + u32(bytes, offsetsStart + index * 4)
    if (cursor >= offset + size) fail('string offset out of range')

    if ((flags & UTF8_FLAG) !== 0) {
      const utf16 = utf8Length(bytes, cursor)
      const utf8 = utf8Length(bytes, utf16.next)
      cursor = utf8.next
      if (cursor + utf8.length > offset + size) fail('truncated UTF-8 string')
      return decoder.decode(bytes.slice(cursor, cursor + utf8.length))
    }

    const utf16 = utf16Length(bytes, cursor)
    cursor = utf16.next
    const length = utf16.length * 2
    if (cursor + length > offset + size) fail('truncated UTF-16 string')
    return new TextDecoder('utf-16le').decode(bytes.slice(cursor, cursor + length))
  }
}

interface Attribute {
  name: string
  value?: string | number
}

const attributes = (bytes: Uint8Array, offset: number, chunkSize: number, getString: (index: number) => string) => {
  const headerSize = u16(bytes, offset + 2)
  if (headerSize < 36 || offset + headerSize > offset + chunkSize) fail('invalid start element')
  const attributeStart = u16(bytes, offset + 24)
  const attributeSize = u16(bytes, offset + 26)
  const attributeCount = u16(bytes, offset + 28)
  if (attributeSize < 20) fail('invalid attribute size')

  const result: Attribute[] = []
  const start = offset + 16 + attributeStart
  for (let index = 0; index < attributeCount; index++) {
    const attributeOffset = start + index * attributeSize
    if (attributeOffset + 20 > offset + chunkSize) fail('truncated attribute')
    const name = getString(u32(bytes, attributeOffset + 4))
    const rawValue = u32(bytes, attributeOffset + 8)
    const type = bytes[attributeOffset + 15]
    const data = u32(bytes, attributeOffset + 16)
    let value: string | number | undefined
    if (rawValue !== NO_VALUE) value = getString(rawValue)
    else if (type === TYPE_STRING) value = getString(data)
    else if (type === TYPE_INT_DEC || type === TYPE_INT_HEX) value = data
    result.push({ name, value })
  }
  return result
}

const findAttribute = (attributes: Attribute[], name: string) =>
  attributes.find((attribute) => attribute.name === name)?.value

/** Extracts literal manifest values. Resource references (such as @string/app_name) stay undefined. */
export const parseAndroidManifest = (bytes: Uint8Array): ApkManifest => {
  if (bytes.byteLength < 8 || u16(bytes, 0) !== RES_XML_TYPE || u16(bytes, 2) !== 8) {
    fail('not binary Android XML')
  }
  if (u32(bytes, 4) !== bytes.byteLength) fail('invalid XML document size')

  const manifest: ApkManifest = {}
  let getString: ((index: number) => string) | undefined
  let cursor = 8
  while (cursor < bytes.byteLength) {
    if (cursor + 8 > bytes.byteLength) fail('truncated XML chunk')
    const type = u16(bytes, cursor)
    const headerSize = u16(bytes, cursor + 2)
    const size = u32(bytes, cursor + 4)
    if (headerSize < 8 || size < headerSize || cursor + size > bytes.byteLength) fail('invalid XML chunk')

    if (type === RES_STRING_POOL_TYPE) getString = stringPool(bytes, cursor, headerSize, size)
    if (type === RES_XML_START_ELEMENT_TYPE) {
      const strings = getString ?? fail('start element precedes string pool')
      const name = strings(u32(bytes, cursor + 20))
      const nodeAttributes = attributes(bytes, cursor, size, strings)
      if (name === 'manifest') {
        const packageName = findAttribute(nodeAttributes, 'package')
        const versionName = findAttribute(nodeAttributes, 'versionName')
        const versionCode = findAttribute(nodeAttributes, 'versionCode')
        if (typeof packageName === 'string') manifest.packageName = packageName
        if (typeof versionName === 'string') manifest.versionName = versionName
        if (typeof versionCode === 'number') manifest.versionCode = versionCode
      }
      if (name === 'uses-sdk') {
        const minSdkVersion = findAttribute(nodeAttributes, 'minSdkVersion')
        if (minSdkVersion !== undefined) manifest.minSdkVersion = String(minSdkVersion)
      }
      if (name === 'application') {
        const appLabel = findAttribute(nodeAttributes, 'label')
        if (typeof appLabel === 'string') manifest.appLabel = appLabel
      }
    }
    cursor += size
  }
  return manifest
}
