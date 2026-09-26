import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('D1 migrations', () => {
  it('creates apps, builds, upload_intents, and passcode_attempts tables', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('apps', 'builds', 'upload_intents', 'passcode_attempts') ORDER BY name",
    ).all<{ name: string }>()

    expect(results.map((row) => row.name)).toEqual([
      'apps',
      'builds',
      'passcode_attempts',
      'upload_intents',
    ])
  })

  it('has the upload intent state columns and the passcode unique index', async () => {
    const { results } = await env.DB.prepare(
      'SELECT claimed_at, build_id, state, expires_at FROM upload_intents LIMIT 1',
    ).all()
    expect(Array.isArray(results)).toBe(true)
    const { results: indexes } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'passcode_attempts_app_client_unique'",
    ).all<{ name: string }>()
    expect(indexes.map((row) => row.name)).toEqual(['passcode_attempts_app_client_unique'])
  })
})
