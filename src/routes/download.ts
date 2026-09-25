import { Hono } from 'hono'
import type { Env } from '../env'
import { canDownload, publicBuildFor } from './pages'

export const downloads = new Hono<{ Bindings: Env }>()

downloads.get('/d/:id', async (c) => {
  const id = c.req.param('id')?.replace(/\.apk$/, '')
  if (!id) return c.text('Release not found', 404)
  const release = await publicBuildFor(c.env, id)
  if (!release) return c.text('Release not found', 404)
  if (release.app.passcodeHash && !(await canDownload(c.req.raw, release.app.id, c.env))) {
    return c.redirect(`/a/${encodeURIComponent(release.app.slug)}`)
  }

  const object = await c.env.R2.get(release.build.r2Key)
  if (!object) return c.text('Release file not found', 404)
  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE builds SET downloads = downloads + 1 WHERE id = ?')
      .bind(release.build.id)
      .run(),
  )
  c.header('Content-Type', 'application/vnd.android.package-archive')
  c.header(
    'Content-Disposition',
    `attachment; filename="${release.app.slug}-${release.build.versionName}.apk"`,
  )
  c.header('Content-Length', String(object.size))
  return c.body(object.body)
})
