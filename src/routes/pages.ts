import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { grantAppAccess, hasAppAccess, passcodeClientKey, verifyPasscodeAttempt } from '../access'
import { db } from '../db/client'
import { apps, builds } from '../db/schema'
import type { Env } from '../env'
import { localeFrom, t } from '../i18n'
import { escapeHtml, formatBytes, formatDate, page, qrSvg } from '../render'

const appBySlug = (env: Env, slug: string) =>
  db(env).query.apps.findFirst({ where: eq(apps.slug, slug) })

const buildUrl = (baseUrl: string, slug: string, versionCode: number) =>
  new URL(`/a/${encodeURIComponent(slug)}/v/${versionCode}`, baseUrl).toString()

const historyFor = (env: Env, appId: string) =>
  db(env)
    .select()
    .from(builds)
    .where(eq(builds.appId, appId))
    .orderBy(desc(builds.versionCode), desc(builds.uploadedAt))
    .limit(25)

// Pages render per-cookie (locked vs unlocked) and per-locale, and change on
// publish: never cacheable, and variants must not cross pools.
const noCacheHeaders = (c: { header: (name: string, value: string) => void }) => {
  c.header('Cache-Control', 'private, no-store')
  c.header('Vary', 'Accept-Language, Cookie')
}

const renderBuild = (
  app: { id: string; name: string; slug: string; passcodeHash: string | null },
  build: typeof builds.$inferSelect,
  history: (typeof builds.$inferSelect)[],
  baseUrl: string,
  locale: ReturnType<typeof localeFrom>,
  currentUrl: URL,
  hasAccess: boolean,
  error?: string,
) => {
  const strings = t(locale)
  const shareUrl = buildUrl(baseUrl, app.slug, build.versionCode)
  const action = `/a/${encodeURIComponent(app.slug)}/access?next=${encodeURIComponent(`/d/${build.id}.apk`)}`
  const errorMessage =
    error === 'locked' ? strings.lockedPasscode : error ? strings.invalidPasscode : ''
  const locked = Boolean(app.passcodeHash) && !hasAccess
  const install = locked
    ? `<form class="passcode" action="${action}" method="post"><label>${strings.passcode}<input name="passcode" type="password" required autocomplete="current-password"${errorMessage ? ' aria-invalid="true"' : ''}></label><button>${strings.unlock}</button>${errorMessage ? `<p class="error" role="alert">${errorMessage}</p>` : ''}</form>`
    : `<a class="button" href="/d/${build.id}.apk">${strings.install}</a>`
  const historyRows = history
    .filter((release) => release.id !== build.id)
    .map(
      (release) =>
        `<li><a href="/a/${encodeURIComponent(app.slug)}/v/${release.versionCode}">${strings.version} ${escapeHtml(release.versionName)} (${strings.build} ${release.versionCode})</a> · ${formatBytes(release.sizeBytes)}</li>`,
    )
    .join('')

  return page(
    app.name,
    locale,
    `<header><p class="eyebrow">${strings.latest}</p><h1>${escapeHtml(app.name)}</h1><p>${strings.version} ${escapeHtml(build.versionName)} <span class="muted">(${strings.build} ${build.versionCode})</span></p></header>
<section class="release"><div class="qr" aria-hidden="true">${qrSvg(shareUrl)}</div><div><p>${strings.size}: ${formatBytes(build.sizeBytes)}</p><p>${strings.uploaded}: ${formatDate(build.uploadedAt, locale)}</p><p>${strings.downloads}: ${build.downloads}</p>${install}</div></section>
<details><summary>${strings.guide}</summary><p>${strings.guideText}</p></details>${!locked && build.notes ? `<section><h2>${strings.notes}</h2><p class="notes">${escapeHtml(build.notes)}</p></section>` : ''}${!locked && historyRows ? `<section><h2>${strings.history}</h2><ul>${historyRows}</ul></section>` : ''}`,
    currentUrl,
  )
}

const unavailable = (locale: ReturnType<typeof localeFrom>, currentUrl: URL, title = '') =>
  page(title, locale, `<h1>${t(locale).unavailable}</h1>`, currentUrl)

export const pages = new Hono<{ Bindings: Env }>()

pages.get('/a/:slug', async (c) => {
  noCacheHeaders(c)
  const app = await appBySlug(c.env, c.req.param('slug'))
  const locale = localeFrom(c.req.header('accept-language'), c.req.query('lang'))
  const currentUrl = new URL(c.req.url)
  if (!app) return c.html(unavailable(locale, currentUrl), 404)
  const history = await historyFor(c.env, app.id)
  const build = history[0]
  if (!build) return c.html(unavailable(locale, currentUrl, app.name), 404)
  return c.html(
    renderBuild(
      app,
      build,
      history,
      c.env.BASE_URL,
      locale,
      currentUrl,
      await hasAppAccess(c.req.raw, app.id, c.env),
      c.req.query('error'),
    ),
  )
})

pages.get('/a/:slug/v/:versionCode', async (c) => {
  noCacheHeaders(c)
  const app = await appBySlug(c.env, c.req.param('slug'))
  const locale = localeFrom(c.req.header('accept-language'), c.req.query('lang'))
  const currentUrl = new URL(c.req.url)
  const versionCode = Number(c.req.param('versionCode'))
  if (!app || !Number.isSafeInteger(versionCode))
    return c.html(unavailable(locale, currentUrl), 404)
  const build = await db(c.env).query.builds.findFirst({
    where: and(eq(builds.appId, app.id), eq(builds.versionCode, versionCode)),
  })
  if (!build) return c.html(unavailable(locale, currentUrl, app.name), 404)
  const history = await historyFor(c.env, app.id)
  return c.html(
    renderBuild(
      app,
      build,
      history,
      c.env.BASE_URL,
      locale,
      currentUrl,
      await hasAppAccess(c.req.raw, app.id, c.env),
      c.req.query('error'),
    ),
  )
})

pages.post('/a/:slug/access', async (c) => {
  const app = await appBySlug(c.env, c.req.param('slug'))
  if (!app?.passcodeHash) return c.redirect(`/a/${encodeURIComponent(c.req.param('slug'))}`, 303)
  const locale = localeFrom(c.req.header('accept-language'), c.req.query('lang'))
  const back = (error?: string) => {
    const target = new URL(`/a/${encodeURIComponent(app.slug)}`, c.req.url)
    if (locale !== 'en' || c.req.query('lang')) target.searchParams.set('lang', locale)
    if (error) target.searchParams.set('error', error)
    return c.redirect(`${target.pathname}${target.search}`, 303)
  }
  let passcode: unknown = null
  try {
    passcode = (await c.req.formData()).get('passcode')
  } catch {
    return back('invalid')
  }
  const outcome =
    typeof passcode === 'string'
      ? await verifyPasscodeAttempt(
          c.env,
          app.id,
          app.passcodeHash,
          passcode,
          passcodeClientKey(c.req.raw),
        )
      : 'invalid'
  if (outcome !== 'ok') return back(outcome)
  await grantAppAccess(c, app.id)
  const next = c.req.query('next')
  const safeNext =
    next?.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
      ? next
      : `/a/${encodeURIComponent(app.slug)}`
  return c.redirect(safeNext, 303)
})

export const publicBuildFor = async (env: Env, id: string) => {
  const build = await db(env).query.builds.findFirst({ where: eq(builds.id, id) })
  if (!build) return undefined
  const app = await db(env).query.apps.findFirst({ where: eq(apps.id, build.appId) })
  return app ? { app, build } : undefined
}

export const canDownload = (request: Request, appId: string, env: Env) =>
  hasAppAccess(request, appId, env)
