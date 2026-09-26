import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { hashPasscode, verifyPasscodeAttempt } from '../src/access'

describe('passcode attempt limit', () => {
  it('locks an app/IP pair after five failed attempts', async () => {
    const appId = crypto.randomUUID()
    await env.DB.prepare('INSERT INTO apps (id, slug, name) VALUES (?, ?, ?)')
      .bind(appId, `app-${appId.slice(0, 8)}`, 'Protected App')
      .run()
    const expected = await hashPasscode('correct-long-passcode', 'test-app-secret')

    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(
        verifyPasscodeAttempt(env, appId, expected, 'wrong-long-passcode', '198.51.100.4'),
      ).resolves.toBe('invalid')
    }
    await expect(
      verifyPasscodeAttempt(env, appId, expected, 'wrong-long-passcode', '198.51.100.4'),
    ).resolves.toBe('locked')
    await expect(
      verifyPasscodeAttempt(env, appId, expected, 'correct-long-passcode', '198.51.100.4'),
    ).resolves.toBe('locked')
  })
})
