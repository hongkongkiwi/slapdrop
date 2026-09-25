import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { hasAppAccess, grantAppAccess, passcodeMatches } from '../access'
import { db } from '../db/client'
import { apps, builds } from '../db/schema'
import type { Env } from '../env'
import { localeFrom, t } from '../i18n'
import { escapeHtml, formatBytes, page, qrSvg } from '../render'

const appBySlug = (env: Env, slug: string) => db(env).query.apps.findFirst({ where: eq(apps.slug, slug) })

const buildUrl = (baseUrl: string, slug: string, versionCode: number) =>
  new URL(`/a/${encodeURIComponent(slug)}/v/${versionCode}`, baseUrl).toString()

const renderBuild = (
  app: { id: string; name: string; slug: string; passcodeHash: string | null },
  build: typeof builds.$inferSelect,
  baseUrl: string,
  locale: ReturnType<typeof localeFrom>,
  hasAccess: boolean,
  error?: string,
) => {
  const strings = t(locale)
  const shareUrl = buildUrl(baseUrl, app.slug, build.versionCode)
  const action = `/a/${encodeURIComponent(app.slug)}/access?next=${encodeURIComponent(`/d/${build.id}.apk`)}`
  const install = app.passcodeHash && !hasAccess
    ? `<form class="passcode" action="${action}" method="post"><label>${strings.passcode}<input name="passcode" type="password" required autocomplete="one-time-code"></label><button>${strings.unlock}</button>${error ? `<p class="error">${strings.invalidPasscode}</p>` : ''}</form>`
    : `<a class="button" href="/d/${build.id}.apk">${strings.install}</a>`
  return page(
    app.name,
    locale,
    `<header><p class="eyebrow">${strings.latest}</p><h1>${escapeHtml(app.name)}</h1><p>${strings.version} ${escapeHtml(build.versionName)} (${build.versionCode})</p></header>
<section class="release"><div class="qr">${qrSvg(shareUrl)}</div><div><p>${strings.size}: ${formatBytes(build.sizeBytes)}</p><p>${strings.uploaded}: ${escapeHtml(build.uploadedAt)}</p><p>${strings.downloads}: ${build.downloads}</p>${install}</div></section>
<details><summary>${strings.guide}</summary><p>${strings.guideText}</p></details>`,
  )
}

export const pages = new Hono<{ Bindings: Env }>()

pages.get('/a/:slug', async (c) => {
  const app = await appBySlug(c.env, c.req.param('slug'))
  const locale = localeFrom(c.req.header('accept-language'), c.req.query('lang'))
  if (!app) return c.html(page('SlapDrop', locale, `<h1>${t(locale).unavailable}</h1>`), 404)
  const build = await db(c.env).query.builds.findFirst({
    where: eq(builds.appId, app.id),
    orderBy: [desc(builds.versionCode), desc(builds.uploadedAt)],
  })
  if (!build) return c.html(page(app.name, locale, `<h1>${t(locale).unavailable}</h1>`), 404)
  return c.html(
    renderBuild(app, build, c.env.BASE_URL, locale, await hasAppAccess(c.req.raw, app.id, c.env), c.req.query('error')),
  )
})

pages.get('/a/:slug/v/:versionCode', async (c) => {
  const app = await appBySlug(c.env, c.req.param('slug'))
  const locale = localeFrom(c.req.header('accept-language'), c.req.query('lang'))
  const versionCode = Number(c.req.param('versionCode'))
  if (!app || !Number.isSafeInteger(versionCode)) return c.html(page('SlapDrop', locale, `<h1>${t(locale).unavailable}</h1>`), 404)
  const build = await db(c.env).query.builds.findFirst({
    where: (candidate, { and }) => and(eq(candidate.appId, app.id), eq(candidate.versionCode, versionCode)),
  })
  if (!build) return c.html(page(app.name, locale, `<h1>${t(locale).unavailable}</h1>`), 404)
  return c.html(
    renderBuild(app, build, c.env.BASE_URL, locale, await hasAppAccess(c.req.raw, app.id, c.env), c.req.query('error')),
  )
})

pages.post('/a/:slug/access', async (c) => {
  const app = await appBySlug(c.env, c.req.param('slug'))
  if (!app?.passcodeHash) return c.redirect(`/a/${encodeURIComponent(c.req.param('slug'))}`)
  const form = await c.req.formData()
  const passcode = form.get('passcode')
  if (typeof passcode !== 'string' || !(await passcodeMatches(passcode, app.passcodeHash, c.env.APP_SECRET))) {
    return c.redirect(`/a/${encodeURIComponent(app.slug)}?error=1`)
  }
  await grantAppAccess(c, app.id)
  const next = c.req.query('next')
  return c.redirect(next?.startsWith('/') ? next : `/a/${encodeURIComponent(app.slug)}`)
})

export const publicBuildFor = async (env: Env, id: string) => {
  const build = await db(env).query.builds.findFirst({ where: eq(builds.id, id) })
  if (!build) return undefined
  const app = await db(env).query.apps.findFirst({ where: eq(apps.id, build.appId) })
  return app ? { app, build } : undefined
}

export const canDownload = (request: Request, appId: string, env: Env) => hasAppAccess(request, appId, env)
