import { desc } from 'drizzle-orm'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import type { Variables } from './auth'
import { db } from './db/client'
import { apps, builds } from './db/schema'
import type { Env } from './env'
import { localeFrom, t } from './i18n'
import { escapeHtml, page } from './render'
import { api, cleanupExpiredUploads } from './routes/api'
import { downloads } from './routes/download'
import { pages } from './routes/pages'

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      styleSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  }),
)

app.get('/healthz', async (c) => {
  const [database, bucket] = await Promise.all([
    c.env.DB.prepare('SELECT 1').first(),
    c.env.R2.list({ limit: 1 }),
  ])
  return c.json({ ok: Boolean(database && bucket) })
})
app.route('/api', api)
app.route('/', downloads)
app.route('/', pages)

app.get('/upload', (c) =>
  c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upload · SlapDrop</title>
<link rel="stylesheet" href="/app.css">
</head>
<body><main class="wrap"><h1>Upload APK</h1>
<form id="upload-form" class="upload-form">
<label>Upload token<input name="token" type="password" required autocomplete="off"></label>
<label>App slug<input name="app" pattern="[a-z0-9]+(-[a-z0-9]+)*" required placeholder="my-android-app"></label>
<label>App name <small>(first upload only)</small><input name="name" maxlength="120" placeholder="My Android App"></label>
<label>APK file<input name="apk" type="file" accept=".apk,application/vnd.android.package-archive" required></label>
<label>Release notes<textarea name="notes" maxlength="10000"></textarea></label>
<label>Commit SHA<input name="commit" maxlength="100"></label>
<label class="check"><input name="create" type="checkbox" checked> Create app if it does not exist</label>
<button>Upload and publish</button></form>
<p id="status" aria-live="polite"></p><a id="result" hidden></a></main><script src="/app.js"></script></body></html>`),
)

app.get('/', async (c) => {
  const locale = localeFrom(c.req.header('accept-language'), c.req.query('lang'))
  const strings = t(locale)
  const database = db(c.env)
  const allApps = await database.select().from(apps).orderBy(apps.name)
  const allBuilds = await database
    .select()
    .from(builds)
    .orderBy(desc(builds.versionCode), desc(builds.uploadedAt))
  const latestByApp = new Map<string, typeof builds.$inferSelect>()
  for (const build of allBuilds) {
    if (!latestByApp.has(build.appId)) latestByApp.set(build.appId, build)
  }
  const items = allApps
    .map((entry) => {
      const latest = latestByApp.get(entry.id)
      const version = latest ? ` · ${strings.version} ${escapeHtml(latest.versionName)}` : ''
      return `<li><a href="/a/${encodeURIComponent(entry.slug)}">${escapeHtml(entry.name)}</a>${version}</li>`
    })
    .join('')
  return c.html(
    page(
      'SlapDrop',
      locale,
      `<h1>🐝 SlapDrop</h1><p>${strings.appsList}</p><ul class="applist">${items}</ul><p><a class="button" href="/upload">Upload</a></p>`,
    ),
  )
})

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (_controller, env, ctx) => ctx.waitUntil(cleanupExpiredUploads(env)),
} satisfies ExportedHandler<Env>
