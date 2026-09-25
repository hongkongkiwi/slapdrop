import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { buildTestApk } from './fixtures'

const auth = { authorization: 'Bearer ci-test-token-1' }

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
    const response = await SELF.fetch('https://example.com/api/apps', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'protected-app',
        name: 'Protected App',
        passcode: 'a-long-test-passcode',
      }),
    })

    expect(response.status).toBe(201)
    const app = await env.DB.prepare('SELECT passcode_hash FROM apps WHERE slug = ?')
      .bind('protected-app')
      .first<{ passcode_hash: string }>()
    expect(app?.passcode_hash).not.toBe('a-long-test-passcode')
    expect(app?.passcode_hash).toBeTruthy()

    const list = await SELF.fetch('https://example.com/api/apps', { headers: auth })
    expect(list.status).toBe(200)
    expect(await list.text()).not.toContain('passcode')
  })

  it('creates an app and a direct R2 upload intent', async () => {
    const response = await SELF.fetch('https://example.com/api/apps/fixture/builds/intent', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'fixture-1.2.3-123.apk',
        sizeBytes: 123,
        create: true,
        name: 'Fixture',
      }),
    })

    expect(response.status).toBe(201)
    const intent = (await response.json()) as { id: string; uploadUrl: string; expiresAt: string }
    expect(intent.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(intent.uploadUrl).toContain('slapdrop-apks.')
    expect(intent.expiresAt).toMatch(/Z$/)
  })

  it('rejects complete when uploaded file is not an APK', async () => {
    const intentResponse = await SELF.fetch(
      'https://example.com/api/apps/not-an-apk/builds/intent',
      {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: 'nope.apk',
          sizeBytes: 4,
          create: true,
          name: 'Not an APK',
        }),
      },
    )
    const intent = (await intentResponse.json()) as { id: string }
    await env.R2.put(`uploads/${intent.id}.apk`, new Uint8Array([0, 1, 2, 3]))

    const response = await SELF.fetch(`https://example.com/api/builds/${intent.id}/complete`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'File is not a ZIP/APK' })
  })

  it('rejects requests without an upload token', async () => {
    const response = await SELF.fetch('https://example.com/api/apps')
    expect(response.status).toBe(401)
  })

  it('publishes a valid APK end to end', async () => {
    const apk = buildTestApk({
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

  it('rejects duplicate versionCode and replaces it under force', async () => {
    const slug = `dupe-${crypto.randomUUID().slice(0, 8)}`
    const first = buildTestApk({
      packageName: 'dev.slapdrop.dupe',
      versionName: '9.0.0',
      versionCode: 9,
    })
    const firstId = await stageUpload(slug, first, 9)
    const firstComplete = await postJson(`/api/builds/${firstId}/complete`, {})
    expect(firstComplete.status).toBe(201)
    const build = (await firstComplete.json()) as { id: string; r2Key: string }

    const second = buildTestApk({
      packageName: 'dev.slapdrop.dupe',
      versionName: '9.0.0',
      versionCode: 9,
    })
    const secondId = await stageUpload(slug, second, 9)
    const rejected = await postJson(`/api/builds/${secondId}/complete`, {})
    expect(rejected.status).toBe(409)

    const third = buildTestApk({
      packageName: 'dev.slapdrop.dupe',
      versionName: '9.1.0',
      versionCode: 9,
    })
    const thirdId = await stageUpload(slug, third, 9)
    const forced = await postJson(`/api/builds/${thirdId}/complete`, { force: true })
    expect(forced.status).toBe(201)
    const replaced = (await forced.json()) as { id: string; r2Key: string }
    expect(replaced.id).toBe(build.id)
    expect(replaced.r2Key).not.toBe(build.r2Key)

    await headEventually(build.r2Key, false)
    const download = await SELF.fetch(`https://example.com/d/${replaced.id}.apk`)
    expect(download.status).toBe(200)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(third)
  })
})
