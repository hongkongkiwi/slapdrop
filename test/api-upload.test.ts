import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const auth = { authorization: 'Bearer ci-test-token-1' }

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
})
