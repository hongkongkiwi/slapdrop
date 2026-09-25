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

/** Adapts an R2 binding to the small ranged reads used by readApkManifest(). */
export const r2SourceFromGet = async (bucket: R2Bucket, key: string): Promise<ByteSource | undefined> => {
  const head = await bucket.head(key)
  if (!head) return undefined
  return {
    size: head.size,
    read: async (offset, length) => {
      const object = await bucket.get(key, { range: { offset, length } })
      if (!object) throw new Error(`APK object disappeared: ${key}`)
      return new Uint8Array(await object.arrayBuffer())
    },
  }
}
