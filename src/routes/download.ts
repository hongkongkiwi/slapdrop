import { Hono } from 'hono'
import type { Env } from '../env'
import { canDownload, publicBuildFor } from './pages'

interface ByteRange {
  offset: number
  length: number
}

/** Parses a single `bytes=` range. Multi-range and non-byte units fall back to a full download. */
const parseRange = (
  header: string | undefined,
  size: number,
): ByteRange | 'invalid' | undefined => {
  if (!header) return undefined
  const match = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return undefined
  const [, startRaw, endRaw] = match
  if (!startRaw && !endRaw) return undefined
  if (!startRaw) {
    const suffix = Number(endRaw)
    if (!suffix) return 'invalid'
    const length = Math.min(suffix, size)
    return { offset: size - length, length }
  }
  const start = Number(startRaw)
  const end = endRaw ? Math.min(Number(endRaw), size - 1) : size - 1
  if (start >= size || end < start) return 'invalid'
  return { offset: start, length: end - start + 1 }
}

export const downloads = new Hono<{ Bindings: Env }>()

downloads.get('/d/:id', async (c) => {
  const id = c.req.param('id')?.replace(/\.apk$/, '')
  if (!id) return c.text('Release not found', 404)
  const release = await publicBuildFor(c.env, id)
  if (!release) return c.text('Release not found', 404)
  if (release.app.passcodeHash && !(await canDownload(c.req.raw, release.app.id, c.env))) {
    return c.redirect(`/a/${encodeURIComponent(release.app.slug)}`)
  }

  const head = await c.env.R2.head(release.build.r2Key)
  if (!head) return c.text('Release file not found', 404)
  const range = parseRange(c.req.header('range'), head.size)
  if (range === 'invalid') {
    c.header('Accept-Ranges', 'bytes')
    c.header('Content-Range', `bytes */${head.size}`)
    return c.text('Requested range not satisfiable', 416)
  }

  const object = range
    ? await c.env.R2.get(release.build.r2Key, {
        range: { offset: range.offset, length: range.length },
      })
    : await c.env.R2.get(release.build.r2Key)
  if (!object) return c.text('Release file not found', 404)

  const safeVersion = release.build.versionName.replace(/[^\w.-]/g, '_')
  c.header('Accept-Ranges', 'bytes')
  c.header('Content-Type', 'application/vnd.android.package-archive')
  c.header('Content-Disposition', `attachment; filename="${release.app.slug}-${safeVersion}.apk"`)

  if (range) {
    c.header(
      'Content-Range',
      `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
    )
    c.header('Content-Length', String(range.length))
    return c.body(object.body, 206)
  }

  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE builds SET downloads = downloads + 1 WHERE id = ?')
      .bind(release.build.id)
      .run(),
  )
  c.header('Content-Length', String(head.size))
  return c.body(object.body)
})
