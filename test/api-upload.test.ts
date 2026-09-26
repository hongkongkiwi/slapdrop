import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { hashPasscode } from '../src/access'
import { cleanupExpiredUploads } from '../src/routes/api'
import { buildTestApk } from './fixtures'

const auth = { authorization: 'Bearer ci-test-token-1' }
const otherAuth = { authorization: 'Bearer ci-test-token-2' }

const jsonHeaders = { ...auth, 'content-type': 'application/json' }

const postJson = (path: string, body: unknown, extra: Record<string, string> = {}) =>
  SELF.fetch(`https://example.com${path}`, {
    method: 'POST',
    headers: { ...jsonHeaders, ...extra },
    body: JSON.stringify(body),
  })

const stageUpload = async (slug: string, apk: Uint8Array, versionCode: number) => {
  const intentResponse = await postJson(`/api/apps/${slug}/builds/intent`, {
    filename: `${slug}-${versionCode}.apk`,
    sizeBytes: apk.byteLength,
    create: true,
    name: `App ${slug}`,
  })
  expect(intentResponse.status).toBe(201)
  const intent = (await intentResponse.json()) as { id: string }
  await env.R2.put(`uploads/${intent.id}.apk`, apk)
  return intent.id
}

const headEventually = async (key: string, expected: boolean) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (Boolean(await env.R2.head(key)) === expected) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`R2 head ${key} never became ${expected ? 'present' : 'absent'}`)
}

describe('upload API', () => {
  it('stores an app passcode as a hash, never the original value', async () => {
    const response = await postJson('/api/apps', {
      slug: 'protected-app',
      name: 'Protected App',
      passcode: 'a-long-test-passcode',
    })

    expect(response.status).toBe(201)
    const app = await env.DB.prepare('SELECT passcode_hash FROM apps WHERE slug = ?')
      .bind('protected-app')
      .first<{ passcode_hash: string }>()
    expect(app?.passcode_hash).toBe(await hashPasscode('a-long-test-passcode', 'test-app-secret'))

    const list = await SELF.fetch('https://example.com/api/apps', { headers: jsonHeaders })
    expect(list.status).toBe(200)
    const listed = (await list.json()) as Array<Record<string, unknown>>
    expect(Array.isArray(listed)).toBe(true)
    expect(listed.length).toBeGreaterThan(0)
    for (const entry of listed) {
      expect(Object.keys(entry).sort()).toEqual(['createdAt', 'id', 'name', 'packageName', 'slug'])
    }
  })

  it('creates an app and a direct R2 upload intent', async () => {
    const response = await postJson('/api/apps/fixture/builds/intent', {
      filename: 'fixture-1.2.3-123.apk',
      sizeBytes: 123,
      create: true,
      name: 'Fixture',
    })

    expect(response.status).toBe(201)
    const intent = (await response.json()) as {
      id: string
      uploadUrl: string
      expiresAt: string
      requiredHeaders: Record<string, string>
    }
    expect(intent.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(intent.uploadUrl).toContain('slapdrop-apks.')
    expect(intent.expiresAt).toMatch(/Z$/)
    expect(intent.requiredHeaders).toEqual({ 'If-None-Match': '*' })
  })

  it('rejects complete when uploaded file is not an APK', async () => {
    const intentResponse = await postJson('/api/apps/not-an-apk/builds/intent', {
      filename: 'nope.apk',
      sizeBytes: 4,
      create: true,
      name: 'Not an APK',
    })
    const intent = (await intentResponse.json()) as { id: string }
    await env.R2.put(`uploads/${intent.id}.apk`, new Uint8Array([0, 1, 2, 3]))

    const response = await postJson(`/api/builds/${intent.id}/complete`, {})

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'File is not a ZIP/APK' })
  })

  it('rejects requests without an upload token', async () => {
    const response = await SELF.fetch('https://example.com/api/apps')
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('Bearer')
  })

  it("rejects completion of another token's intent", async () => {
    const apk = await buildTestApk({
      packageName: 'dev.slapdrop.tokens',
      versionName: '1.0.0',
      versionCode: 3,
    })
    const intentId = await stageUpload('token-split', apk, 3)
    const response = await SELF.fetch(`https://example.com/api/builds/${intentId}/complete`, {
      method: 'POST',
      headers: { ...otherAuth, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(403)
  })

  it('cleans expired intents and reclaims stale claims', async () => {
    const appId = crypto.randomUUID()
    await env.DB.prepare('INSERT INTO apps (id, slug, name) VALUES (?, ?, ?)')
      .bind(appId, `cleanup-${appId.slice(0, 8)}`, 'Cleanup')
      .run()
    const now = Date.now()
    const seed = async (state: string, claimedAt: string | null, expiresAt: string) => {
      const id = crypto.randomUUID()
      const key = `uploads/${id}.apk`
      await env.DB.prepare(
        'INSERT INTO upload_intents (id, app_id, r2_key, filename, expected_size_bytes, uploader, state, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(id, appId, key, 'x.apk', 4, 'ci', state, claimedAt, expiresAt)
        .run()
      await env.R2.put(key, new Uint8Array([1, 2, 3, 4]))
      return key
    }
    const expiredPending = await seed('pending', null, new Date(now - 60_000).toISOString())
    const freshValidating = await seed(
      'validating',
      new Date(now).toISOString(),
      new Date(now + 600_000).toISOString(),
    )
    const staleValidating = await seed(
      'validating',
      new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      new Date(now + 600_000).toISOString(),
    )

    await cleanupExpiredUploads(env)

    expect(await env.R2.head(expiredPending)).toBeNull()
    expect(await env.R2.head(staleValidating)).toBeNull()
    expect(await env.R2.head(freshValidating)).not.toBeNull()
    const remaining = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM upload_intents WHERE app_id = ?',
    )
      .bind(appId)
      .first<{ n: number }>()
    expect(remaining?.n).toBe(1)
  })

  it('deletes builds and apps along with their objects', async () => {
    const slug = `del-${crypto.randomUUID().slice(0, 8)}`
    const apk = await buildTestApk({
      packageName: 'dev.slapdrop.del',
      versionName: '3.0.0',
      versionCode: 30,
    })
    const intentId = await stageUpload(slug, apk, 30)
    const complete = await postJson(`/api/builds/${intentId}/complete`, {})
    expect(complete.status).toBe(201)
    const build = (await complete.json()) as { id: string; r2Key: string }

    const unauthenticated = await SELF.fetch(`https://example.com/api/builds/${build.id}`, {
      method: 'DELETE',
    })
    expect(unauthenticated.status).toBe(401)
    const missing = await SELF.fetch('https://example.com/api/builds/does-not-exist', {
      method: 'DELETE',
      headers: jsonHeaders,
    })
    expect(missing.status).toBe(404)

    const delBuild = await SELF.fetch(`https://example.com/api/builds/${build.id}`, {
      method: 'DELETE',
      headers: jsonHeaders,
    })
    expect(delBuild.status).toBe(204)
    await headEventually(build.r2Key, false)

    const stagingKey = `uploads/${intentId}.apk`
    const delApp = await SELF.fetch(`https://example.com/api/apps/${slug}`, {
      method: 'DELETE',
      headers: jsonHeaders,
    })
    expect(delApp.status).toBe(204)
    await headEventually(stagingKey, false)
    const gone = await SELF.fetch(`https://example.com/a/${slug}`)
    expect(gone.status).toBe(404)
  })

  it('lists latest and all builds newest first', async () => {
    const slug = `list-${crypto.randomUUID().slice(0, 8)}`
    const appId = crypto.randomUUID()
    await env.DB.prepare('INSERT INTO apps (id, slug, name) VALUES (?, ?, ?)')
      .bind(appId, slug, 'List App')
      .run()
    for (const [id, code] of [
      [crypto.randomUUID(), 1],
      [crypto.randomUUID(), 2],
    ] as const) {
      await env.DB.prepare(
        'INSERT INTO builds (id, app_id, version_name, version_code, r2_key, size_bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(id, appId, `${code}.0.0`, code, `builds/${id}.apk`, 4, 'ci')
        .run()
    }

    const latest = await SELF.fetch(`https://example.com/api/apps/${slug}/builds/latest`, {
      headers: jsonHeaders,
    })
    expect(await latest.json()).toMatchObject({ versionCode: 2, versionName: '2.0.0' })
    const list = await SELF.fetch(`https://example.com/api/apps/${slug}/builds`, {
      headers: jsonHeaders,
    })
    const builds = (await list.json()) as Array<{ versionCode: number }>
    expect(builds.map((build) => build.versionCode)).toEqual([2, 1])
    const unknown = await SELF.fetch('https://example.com/api/apps/nope/builds/latest', {
      headers: jsonHeaders,
    })
    expect(unknown.status).toBe(404)
  })

  it('publishes a valid APK end to end', async () => {
    const apk = await buildTestApk({
      packageName: 'dev.slapdrop.e2e',
      versionName: '1.2.3',
      versionCode: 7,
      minSdk: 24,
      label: 'E2E',
    })
    const intentId = await stageUpload('e2e-app', apk, 7)
    const complete = await postJson(`/api/builds/${intentId}/complete`, {})
    expect(complete.status).toBe(201)
    const build = (await complete.json()) as {
      id: string
      versionName: string
      versionCode: number
      packageName?: string
      r2Key: string
    }
    expect(build).toMatchObject({
      versionName: '1.2.3',
      versionCode: 7,
      packageName: 'dev.slapdrop.e2e',
    })

    await headEventually(`uploads/${intentId}.apk`, false)
    expect(await env.R2.head(build.r2Key)).not.toBeNull()
    const intent = await env.DB.prepare('SELECT state, build_id FROM upload_intents WHERE id = ?')
      .bind(intentId)
      .first<{ state: string; build_id: string }>()
    expect(intent).toMatchObject({ state: 'published', build_id: build.id })

    const again = await postJson(`/api/builds/${intentId}/complete`, {})
    expect(again.status).toBe(200)

    const download = await SELF.fetch(`https://example.com/d/${build.id}.apk`)
    expect(download.status).toBe(200)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(apk)
  })

  it('publishes a DEFLATE-manifest APK end to end', async () => {
    const apk = await buildTestApk(
      { packageName: 'dev.slapdrop.deflate', versionName: '4.5.6', versionCode: 456 },
      { compressManifest: true },
    )
    const intentId = await stageUpload('deflate-app', apk, 456)
    const complete = await postJson(`/api/builds/${intentId}/complete`, {})
    expect(complete.status).toBe(201)
    expect(await complete.json()).toMatchObject({ versionName: '4.5.6', versionCode: 456 })
  })

  it('rejects duplicate versionCode and replaces it under force', async () => {
    const slug = `dupe-${crypto.randomUUID().slice(0, 8)}`
    const first = await buildTestApk({
      packageName: 'dev.slapdrop.dupe',
      versionName: '9.0.0',
      versionCode: 9,
    })
    const firstId = await stageUpload(slug, first, 9)
    const firstComplete = await postJson(`/api/builds/${firstId}/complete`, {})
    expect(firstComplete.status).toBe(201)
    const build = (await firstComplete.json()) as { id: string; r2Key: string }

    const second = await buildTestApk({
      packageName: 'dev.slapdrop.dupe',
      versionName: '9.0.0',
      versionCode: 9,
    })
    const secondId = await stageUpload(slug, second, 9)
    const rejected = await postJson(`/api/builds/${secondId}/complete`, {})
    expect(rejected.status).toBe(409)

    const third = await buildTestApk({
      packageName: 'dev.slapdrop.dupe',
      versionName: '9.1.0',
      versionCode: 9,
    })
    const thirdId = await stageUpload(slug, third, 9)
    const forced = await postJson(`/api/builds/${thirdId}/complete`, { force: true })
    expect(forced.status).toBe(200)
    const replaced = (await forced.json()) as { id: string; r2Key: string }
    expect(replaced.id).toBe(build.id)
    expect(replaced.r2Key).not.toBe(build.r2Key)

    await headEventually(build.r2Key, false)
    const download = await SELF.fetch(`https://example.com/d/${replaced.id}.apk`)
    expect(download.status).toBe(200)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(third)
  })

  it('accepts uppercase .APK filenames and rejects missing apps without create', async () => {
    const upper = await postJson('/api/apps/upper-case/builds/intent', {
      filename: 'APP-1.0.0-1.APK',
      sizeBytes: 4,
      create: true,
      name: 'Upper',
    })
    expect(upper.status).toBe(201)

    const missing = await postJson('/api/apps/never-created/builds/intent', {
      filename: 'app.apk',
      sizeBytes: 4,
    })
    expect(missing.status).toBe(404)
  })

  it('rejects complete for an unknown intent', async () => {
    const response = await postJson('/api/builds/00000000-0000-0000-0000-000000000000/complete', {})
    expect(response.status).toBe(400)
  })
})
