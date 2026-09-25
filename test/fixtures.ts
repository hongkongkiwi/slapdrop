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

const utf8Length = (length: number) =>
  length < 0x80 ? new Uint8Array([length]) : new Uint8Array([0x80 | (length >> 8), length & 0xff])

const stringPool = (strings: string[]) => {
  const offsets: Uint8Array[] = []
  const values: Uint8Array[] = []
  let offset = 0
  for (const string of strings) {
    const value = encoder.encode(string)
    offsets.push(u32(offset))
    const encoded = concat(
      utf8Length([...string].length),
      utf8Length(value.byteLength),
      value,
      new Uint8Array([0]),
    )
    values.push(encoded)
    offset += encoded.byteLength
  }
  const headerSize = 28
  const stringsStart = headerSize + strings.length * 4
  const valuesBytes = concat(...values)
  return concat(
    u16(1),
    u16(headerSize),
    u32(stringsStart + valuesBytes.byteLength),
    u32(strings.length),
    u32(0),
    u32(0x100),
    u32(stringsStart),
    u32(0),
    concat(...offsets),
    valuesBytes,
  )
}

const startElement = (
  element: number,
  attributes: Array<{ name: number; value: number | string }>,
  strings: string[],
) => {
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
  return concat(u16(0x0102), u16(16), u32(16 + body.byteLength), u32(1), u32(0xffffffff), body)
}

export interface TestApkManifest {
  packageName: string
  versionName: string
  versionCode: number
  minSdk?: number
  label?: string
}

const binaryManifest = (manifest: TestApkManifest) => {
  const strings = [
    'manifest',
    'uses-sdk',
    'application',
    'package',
    'versionName',
    'versionCode',
    'minSdkVersion',
    'label',
    manifest.packageName,
    manifest.versionName,
    manifest.label ?? '',
  ]
  const index = (value: string) => strings.indexOf(value)
  const content = concat(
    stringPool(strings),
    startElement(
      index('manifest'),
      [
        { name: index('package'), value: manifest.packageName },
        { name: index('versionName'), value: manifest.versionName },
        { name: index('versionCode'), value: manifest.versionCode },
      ],
      strings,
    ),
    startElement(
      index('uses-sdk'),
      [{ name: index('minSdkVersion'), value: manifest.minSdk ?? 23 }],
      strings,
    ),
    startElement(
      index('application'),
      [{ name: index('label'), value: manifest.label ?? '' }],
      strings,
    ),
  )
  return concat(u16(3), u16(8), u32(8 + content.byteLength), content)
}

/** Builds a minimal valid APK: STORED AndroidManifest.xml plus a classes.dex filler. */
export const buildTestApk = (manifest: TestApkManifest): Uint8Array => {
  const manifestBytes = binaryManifest(manifest)
  const dex = encoder.encode('dex\n')
  const locals: Uint8Array[] = []
  const central: Uint8Array[] = []
  let localOffset = 0
  for (const [name, data] of [
    ['AndroidManifest.xml', manifestBytes],
    ['classes.dex', dex],
  ] as const) {
    const nameBytes = encoder.encode(name)
    const local = concat(
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(data.byteLength),
      u32(data.byteLength),
      u16(nameBytes.byteLength),
      u16(0),
      nameBytes,
      data,
    )
    locals.push(local)
    central.push(
      concat(
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(data.byteLength),
        u32(data.byteLength),
        u16(nameBytes.byteLength),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(localOffset),
        nameBytes,
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
    u16(locals.length),
    u16(locals.length),
    u32(centralBytes.byteLength),
    u32(localBytes.byteLength),
    u16(0),
  )
}
