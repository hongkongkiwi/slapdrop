export interface ByteSource {
  size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export interface ZipEntry {
  name: string
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const MAX_EOCD_WINDOW = 65_557
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024
const MAX_ZIP_ENTRIES = 100_000

const textDecoder = new TextDecoder()

const fail = (message: string): never => {
  throw new Error(`Invalid ZIP: ${message}`)
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

const u64 = (bytes: Uint8Array, offset: number) => {
  if (offset + 8 > bytes.byteLength) fail('unexpected end of data')
  const value = view(bytes).getBigUint64(offset, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('offset or size exceeds JavaScript safe range')
  return Number(value)
}

const findSignatureBackwards = (
  bytes: Uint8Array,
  signature: number,
  start = bytes.byteLength - 4,
) => {
  for (let offset = start; offset >= 0; offset--) {
    if (u32(bytes, offset) === signature) return offset
  }
  return -1
}

interface CentralDirectoryLocation {
  offset: number
  size: number
  entries: number
}

const parseZip64Extra = (
  bytes: Uint8Array,
  needs: { size: boolean; compressed: boolean; offset: boolean },
) => {
  let cursor = 0
  while (cursor + 4 <= bytes.byteLength) {
    const id = u16(bytes, cursor)
    const length = u16(bytes, cursor + 2)
    const dataStart = cursor + 4
    const dataEnd = dataStart + length
    if (dataEnd > bytes.byteLength) fail('truncated ZIP extra field')
    if (id === 0x0001) {
      let extraCursor = dataStart
      const value = (required: boolean) => {
        if (!required) return undefined
        if (extraCursor + 8 > dataEnd) fail('ZIP64 extra field truncated')
        const result = u64(bytes, extraCursor)
        extraCursor += 8
        return result
      }
      return {
        uncompressedSize: value(needs.size),
        compressedSize: value(needs.compressed),
        localHeaderOffset: value(needs.offset),
      }
    }
    cursor = dataEnd
  }
  return {}
}

const centralDirectoryFromTail = async (source: ByteSource): Promise<CentralDirectoryLocation> => {
  // 20 extra bytes keep the ZIP64 locator (which sits immediately before the
  // EOCD) inside the window even when a max-length comment precedes the EOCD.
  const tailOffset = Math.max(0, source.size - MAX_EOCD_WINDOW - 20)
  const tail = await source.read(tailOffset, source.size - tailOffset)
  // Walk candidates downward: the first 0x06054b50 found from the end may sit
  // inside a comment whose own length then fails to reach EOF (PK APPNOTE rule).
  let eocdOffset = findSignatureBackwards(tail, EOCD_SIGNATURE)
  while (eocdOffset >= 0) {
    if (
      eocdOffset + 22 <= tail.byteLength &&
      eocdOffset + 22 + u16(tail, eocdOffset + 20) === tail.byteLength
    ) {
      break
    }
    eocdOffset = findSignatureBackwards(tail, EOCD_SIGNATURE, eocdOffset - 1)
  }
  if (eocdOffset < 0) fail('EOCD record not found')

  const entries = u16(tail, eocdOffset + 10)
  const size = u32(tail, eocdOffset + 12)
  const offset = u32(tail, eocdOffset + 16)
  if (entries !== 0xffff && size !== 0xffffffff && offset !== 0xffffffff) {
    return { entries, size, offset }
  }

  const locatorOffset = eocdOffset - 20
  if (locatorOffset < 0 || u32(tail, locatorOffset) !== ZIP64_LOCATOR_SIGNATURE) {
    fail('ZIP64 locator missing')
  }
  const zip64Offset = u64(tail, locatorOffset + 8)
  const zip64Head = await source.read(zip64Offset, 56)
  if (u32(zip64Head, 0) !== ZIP64_EOCD_SIGNATURE || u64(zip64Head, 4) < 44)
    fail('invalid ZIP64 EOCD')
  return {
    entries: u64(zip64Head, 32),
    size: u64(zip64Head, 40),
    offset: u64(zip64Head, 48),
  }
}

export const listZipEntries = async (source: ByteSource): Promise<ZipEntry[]> => {
  const directory = await centralDirectoryFromTail(source)
  if (directory.size > MAX_CENTRAL_DIRECTORY_BYTES) fail('central directory too large')
  if (directory.entries > MAX_ZIP_ENTRIES) fail('too many entries')
  if (directory.offset + directory.size > source.size)
    fail('central directory lies outside archive')
  const bytes = await source.read(directory.offset, directory.size)
  const entries: ZipEntry[] = []
  let cursor = 0

  while (cursor < bytes.byteLength && entries.length < directory.entries) {
    if (cursor + 46 > bytes.byteLength || u32(bytes, cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      fail('invalid central directory entry')
    }
    const compressedRaw = u32(bytes, cursor + 20)
    const uncompressedRaw = u32(bytes, cursor + 24)
    const filenameLength = u16(bytes, cursor + 28)
    const extraLength = u16(bytes, cursor + 30)
    const commentLength = u16(bytes, cursor + 32)
    const localOffsetRaw = u32(bytes, cursor + 42)
    const nameStart = cursor + 46
    const extraStart = nameStart + filenameLength
    const end = extraStart + extraLength + commentLength
    if (end > bytes.byteLength) fail('truncated central directory entry')

    const zip64 = parseZip64Extra(bytes.slice(extraStart, extraStart + extraLength), {
      size: uncompressedRaw === 0xffffffff,
      compressed: compressedRaw === 0xffffffff,
      offset: localOffsetRaw === 0xffffffff,
    })
    const uncompressedSize = zip64.uncompressedSize ?? uncompressedRaw
    const compressedSize = zip64.compressedSize ?? compressedRaw
    const localHeaderOffset = zip64.localHeaderOffset ?? localOffsetRaw
    if (localHeaderOffset < 0 || localHeaderOffset + 30 > source.size) {
      fail(`entry ${textDecoder.decode(bytes.slice(nameStart, extraStart))} outside archive`)
    }
    entries.push({
      name: textDecoder.decode(bytes.slice(nameStart, extraStart)),
      compressionMethod: u16(bytes, cursor + 10),
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    })
    cursor = end
  }

  if (entries.length !== directory.entries) fail('central directory entry count mismatch')
  return entries
}

export const readZipEntry = async (source: ByteSource, entry: ZipEntry): Promise<Uint8Array> => {
  const header = await source.read(entry.localHeaderOffset, 30)
  if (u32(header, 0) !== LOCAL_FILE_HEADER_SIGNATURE) fail(`invalid local header for ${entry.name}`)
  const dataOffset = entry.localHeaderOffset + 30 + u16(header, 26) + u16(header, 28)
  if (dataOffset + entry.compressedSize > source.size)
    fail(`entry ${entry.name} lies outside archive`)
  const bytes = await source.read(dataOffset, entry.compressedSize)
  if (entry.compressionMethod === 0) return bytes
  if (entry.compressionMethod !== 8)
    fail(`unsupported compression method ${entry.compressionMethod}`)

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const decompressed = new Uint8Array(await new Response(stream).arrayBuffer())
  if (decompressed.byteLength !== entry.uncompressedSize)
    fail(`invalid uncompressed size for ${entry.name}`)
  return decompressed
}

export const zipEntry = async (source: ByteSource, name: string) => {
  const entry = (await listZipEntries(source)).find((candidate) => candidate.name === name)
  if (!entry) return undefined
  return readZipEntry(source, entry)
}
