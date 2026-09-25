import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('D1 migrations', () => {
  it('creates apps and builds tables', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('apps', 'builds') ORDER BY name",
    ).all<{ name: string }>()

    expect(results.map((row) => row.name)).toEqual(['apps', 'builds'])
  })
})
