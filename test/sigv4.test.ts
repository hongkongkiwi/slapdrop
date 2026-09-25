import { describe, expect, it } from 'vitest'
import { presignR2Put } from '../src/sigv4'

describe('R2 SigV4 presigner', () => {
  it('creates a deterministic virtual-hosted PUT URL', async () => {
    const url = await presignR2Put({
      accountId: 'abc123',
      accessKeyId: 'ACCESSKEY',
      secretAccessKey: 'secret',
      bucket: 'slapdrop-apks',
      key: 'builds/build id.apk',
      ifNoneMatch: '*',
      now: new Date('2026-09-28T12:34:56Z'),
    })

    expect(url.origin).toBe('https://slapdrop-apks.abc123.r2.cloudflarestorage.com')
    expect(url.pathname).toBe('/builds/build%20id.apk')
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Credential')).toBe('ACCESSKEY/20260928/auto/s3/aws4_request')
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260928T123456Z')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host;if-none-match')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/)
  })
})
