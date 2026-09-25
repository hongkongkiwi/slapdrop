import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('smoke', () => {
  it('serves /healthz', async () => {
    const res = await SELF.fetch('https://example.com/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('serves the landing page', async () => {
    const res = await SELF.fetch('https://example.com/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })
})
