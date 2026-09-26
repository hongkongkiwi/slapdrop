import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { hashPasscode } from '../src/access'

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

    for (let attempt = 0; attempt < 20; attempt++) {
      const row = await env.DB.prepare('SELECT downloads FROM builds WHERE id = ?')
        .bind(buildId)
        .first<{ downloads: number }>()
      if (row?.downloads === 1) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('download counter never reached 1')
  })

  it('gates downloads behind the passcode cookie flow', async () => {
    const hash = await hashPasscode('correct-long-passcode', 'test-app-secret')
    const { slug, buildId } = await seedRelease(hash)
    const base = `https://example.com/a/${slug}`
    const form = { 'content-type': 'application/x-www-form-urlencoded' }

    const lockedPage = await SELF.fetch(base)
    expect(lockedPage.status).toBe(200)
    expect(lockedPage.headers.get('cache-control')).toBe('private, no-store')
    expect(await lockedPage.text()).not.toContain(`/d/${buildId}.apk`)

    const wrong = await SELF.fetch(`${base}/access`, {
      method: 'POST',
      redirect: 'manual',
      headers: form,
      body: new URLSearchParams({ passcode: 'wrong-long-passcode' }),
    })
    expect(wrong.status).toBe(303)
    expect(wrong.headers.get('location')).toContain('error=invalid')

    const good = await SELF.fetch(`${base}/access`, {
      method: 'POST',
      redirect: 'manual',
      headers: form,
      body: new URLSearchParams({ passcode: 'correct-long-passcode' }),
    })
    expect(good.status).toBe(303)
    const setCookie = good.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('HttpOnly')
    const cookie = setCookie.split(';')[0] ?? ''
    expect(cookie).toContain('=')

    const denied = await SELF.fetch(`https://example.com/d/${buildId}.apk`, {
      redirect: 'manual',
    })
    expect(denied.status).toBe(302)
    const allowed = await SELF.fetch(`https://example.com/d/${buildId}.apk`, {
      headers: { cookie },
    })
    expect(allowed.status).toBe(200)
  })

  it('blocks open-redirect next values on passcode success', async () => {
    const hash = await hashPasscode('correct-long-passcode', 'test-app-secret')
    const { slug } = await seedRelease(hash)
    const response = await SELF.fetch(
      `https://example.com/a/${slug}/access?next=${encodeURIComponent('//evil.com/x')}`,
      {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ passcode: 'correct-long-passcode' }),
      },
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`/a/${slug}`)
  })

  it('sends 405 with Allow for wrong methods and 404 for unknown paths', async () => {
    const slug = `m-${crypto.randomUUID().slice(0, 8)}`
    const seeded = await seedRelease()
    const pagePost = await SELF.fetch(`https://example.com/a/${seeded.slug}`, { method: 'POST' })
    expect(pagePost.status).toBe(405)
    expect(pagePost.headers.get('allow')).toContain('GET')

    const apiUnknown = await SELF.fetch('https://example.com/api/nope/nope', {
      headers: { authorization: 'Bearer ci-test-token-1' },
    })
    expect(apiUnknown.status).toBe(404)
    expect(apiUnknown.headers.get('content-type')).toContain('application/json')

    const pageUnknown = await SELF.fetch(`https://example.com/a/${slug}/deep`)
    expect(pageUnknown.status).toBe(404)
  })

  it('supports conditional downloads and skips HEAD from counters', async () => {
    const { buildId } = await seedRelease()
    const base = `https://example.com/d/${buildId}.apk`

    const first = await SELF.fetch(base)
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag') ?? ''
    expect(etag).toMatch(/^"/)
    expect(first.headers.get('cache-control')).toContain('max-age=300')

    const revalidate = await SELF.fetch(base, {
      headers: { 'if-none-match': etag },
    })
    expect(revalidate.status).toBe(304)

    const head = await SELF.fetch(base, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(Number(head.headers.get('content-length'))).toBe(4)

    for (let attempt = 0; attempt < 20; attempt++) {
      const row = await env.DB.prepare('SELECT downloads FROM builds WHERE id = ?')
        .bind(buildId)
        .first<{ downloads: number }>()
      if (row?.downloads === 1) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('download counter never reached 1')
  })

  it('escapes app names on the landing page', async () => {
    await env.DB.prepare('INSERT INTO apps (id, slug, name) VALUES (?, ?, ?)')
      .bind(
        crypto.randomUUID(),
        `evil-${crypto.randomUUID().slice(0, 8)}`,
        '<script>alert(1)</script>',
      )
      .run()
    const landing = await SELF.fetch('https://example.com/')
    const html = await landing.text()
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert')
  })

  it('lists version history and serves older versions', async () => {
    const slug = `hist-${crypto.randomUUID().slice(0, 8)}`
    const appId = crypto.randomUUID()
    const oldId = crypto.randomUUID()
    const newId = crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare('INSERT INTO apps (id, slug, name) VALUES (?, ?, ?)').bind(
        appId,
        slug,
        'History',
      ),
      env.DB.prepare(
        'INSERT INTO builds (id, app_id, version_name, version_code, r2_key, size_bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(newId, appId, '2.0.0', 2, `builds/${newId}.apk`, 4, 'ci'),
      env.DB.prepare(
        'INSERT INTO builds (id, app_id, version_name, version_code, r2_key, size_bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(oldId, appId, '1.0.0', 1, `builds/${oldId}.apk`, 4, 'ci'),
    ])
    await env.R2.put(`builds/${oldId}.apk`, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
    await env.R2.put(`builds/${newId}.apk`, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))

    const latest = await SELF.fetch(`https://example.com/a/${slug}`)
    const html = await latest.text()
    expect(html).toContain('2.0.0')
    expect(html).toContain(`/a/${slug}/v/1`)

    const older = await SELF.fetch(`https://example.com/a/${slug}/v/1`)
    expect(older.status).toBe(200)
    expect(await older.text()).toContain('1.0.0')
  })
})
