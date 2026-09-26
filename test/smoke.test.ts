import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import worker from '../src/index'

describe('smoke', () => {
  it('exports fetch and scheduled handlers', () => {
    expect(typeof worker.fetch).toBe('function')
    expect(typeof worker.scheduled).toBe('function')
  })

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
