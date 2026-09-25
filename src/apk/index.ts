import { parseAndroidManifest, type ApkManifest } from './manifest'
import { readZipEntry, listZipEntries, type ByteSource } from './zip'

export type { ApkManifest } from './manifest'
export type { ByteSource } from './zip'

/** Reads only the APK ZIP directory plus AndroidManifest.xml bytes. */
export const readApkManifest = async (source: ByteSource): Promise<ApkManifest> => {
  const manifestEntry = (await listZipEntries(source)).find((entry) => entry.name === 'AndroidManifest.xml')
  if (!manifestEntry) throw new Error('Invalid APK: AndroidManifest.xml not found')
  return parseAndroidManifest(await readZipEntry(source, manifestEntry))
}

/** Adapts a specific R2 object version to the small ranged reads used by readApkManifest(). */
export const r2SourceFromGet = async (bucket: R2Bucket, key: string): Promise<ByteSource | undefined> => {
  const head = await bucket.head(key)
  if (!head) return undefined
  return {
    size: head.size,
    read: async (offset, length) => {
      const object = await bucket.get(key, {
        onlyIf: { etagMatches: head.etag },
        range: { offset, length },
      })
      if (!object || !('body' in object)) throw new Error(`APK object changed while being validated: ${key}`)
      return new Uint8Array(await object.arrayBuffer())
    },
  }
}

/** Gets the same R2 object version after ranged validation, ready for immutable publication. */
export const getValidatedR2Object = (bucket: R2Bucket, key: string, etag: string) =>
  bucket.get(key, { onlyIf: { etagMatches: etag } })
