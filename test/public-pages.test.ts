import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const seedRelease = async (passcodeHash: string | null = null, versionName = '1.0.0') => {
  const appId = crypto.randomUUID()
  const buildId = crypto.randomUUID()
  const slug = `demo-${crypto.randomUUID().slice(0, 8)}`
  await env.DB.batch([
    env.DB.prepare('INSERT INTO apps (id, slug, name, passcode_hash) VALUES (?, ?, ?, ?)').bind(
      appId,
      slug,
      'Demo App',
      passcodeHash,
    ),
    env.DB.prepare(
      'INSERT INTO builds (id, app_id, version_name, version_code, r2_key, size_bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(buildId, appId, versionName, 1, `builds/${buildId}.apk`, 4, 'ci'),
  ])
  await env.R2.put(`builds/${buildId}.apk`, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
  return { slug, buildId }
}

describe('public installation pages', () => {
  it('serves a localized build page with QR and download link', async () => {
    const { slug, buildId } = await seedRelease()
    const response = await SELF.fetch(`https://example.com/a/${slug}`, {
      headers: { 'accept-language': 'zh-HK,zh;q=0.9' },
    })

    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('最新版本')
    expect(html).toContain('安裝 APK')
    expect(html).toContain('<svg')
    expect(html).toContain(`/d/${buildId}.apk`)
  })

  it('streams the APK with Android install headers', async () => {
    const { slug, buildId } = await seedRelease()
    const page = await SELF.fetch(`https://example.com/a/${slug}`)
    expect(page.status).toBe(200)

    const response = await SELF.fetch(`https://example.com/d/${buildId}.apk`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain(
      'application/vnd.android.package-archive',
    )
    expect(response.headers.get('content-disposition')).toContain('.apk')
    expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(4)
  })

  it('sanitizes version names in the download filename', async () => {
    const { buildId } = await seedRelease(null, '1.0"evil')
    const response = await SELF.fetch(`https://example.com/d/${buildId}.apk`)

    expect(response.status).toBe(200)
    const disposition = response.headers.get('content-disposition') ?? ''
    expect(disposition).toContain('1.0_evil')
    expect(disposition).not.toContain('evil"')
  })

  it('supports range requests and counts only full downloads', async () => {
    const { buildId } = await seedRelease()
    const base = `https://example.com/d/${buildId}.apk`

    const partial = await SELF.fetch(base, { headers: { range: 'bytes=1-2' } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 1-2/4')
    expect(new Uint8Array(await partial.arrayBuffer())).toHaveLength(2)

    const suffix = await SELF.fetch(base, { headers: { range: 'bytes=-1' } })
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe('bytes 3-3/4')

    const unsatisfiable = await SELF.fetch(base, { headers: { range: 'bytes=10-20' } })
    expect(unsatisfiable.status).toBe(416)
    expect(unsatisfiable.headers.get('content-range')).toBe('bytes */4')

    const full = await SELF.fetch(base)
    expect(full.status).toBe(200)
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await full.arrayBuffer())).toHaveLength(4)

    const count = await env.DB.prepare('SELECT downloads FROM builds WHERE id = ?')
      .bind(buildId)
      .first<{ downloads: number }>()
    expect(count?.downloads).toBe(1)
  })
})
