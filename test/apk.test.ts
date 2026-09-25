import { describe, expect, it } from 'vitest'
import { readApkManifest } from '../src/apk'

const source = (bytes: Uint8Array) => ({
  size: bytes.byteLength,
  read: async (offset: number, length: number) => bytes.slice(offset, offset + length),
})

describe('APK metadata', () => {
  it('requires AndroidManifest.xml', async () => {
    await expect(readApkManifest(source(new Uint8Array()))).rejects.toThrow('EOCD')
  })
})
