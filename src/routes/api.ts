import { and, desc, eq, isNull, lt, ne, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { hashPasscode } from '../access'
import { getValidatedR2Object, r2SourceFromGet, readApkManifest } from '../apk'
import { uploaderAuth, type Variables } from '../auth'
import { db } from '../db/client'
import { apps, builds, uploadIntents } from '../db/schema'
import type { Env } from '../env'
import { presignR2Put } from '../sigv4'

const createId = () => crypto.randomUUID()
const uploadLifetimeMs = 15 * 60 * 1000

const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case')

const createAppSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120),
  passcode: z.string().min(12).max(128).optional(),
})

const MAX_VERSION_CODE = 2_147_483_647

const intentSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(240)
    .transform((value) => value.toLowerCase())
    .refine((value) => value.endsWith('.apk'), 'filename must end in .apk'),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024 * 1024),
  create: z.boolean().optional(),
  name: z.string().min(1).max(120).optional(),
  versionName: z.string().min(1).max(100).optional(),
  versionCode: z.number().int().positive().max(MAX_VERSION_CODE).optional(),
  notes: z.string().max(10_000).optional(),
  commitSha: z.string().max(100).optional(),
})

const completeSchema = z.object({ force: z.boolean().optional() })

const fileNameMetadata = (filename: string) => {
  const match = filename.match(/-(\d+(?:\.\d+)+)-(\d+)\.apk$/i)
  const versionCode = match ? Number(match[2]) : NaN
  if (!match || !Number.isSafeInteger(versionCode) || versionCode > MAX_VERSION_CODE) return {}
  return { versionName: match[1], versionCode }
}

const nextVersionCode = async (env: Env, appId: string) => {
  const result = await env.DB.prepare(
    'SELECT COALESCE(MAX(version_code), 0) + 1 AS next FROM builds WHERE app_id = ?',
  )
    .bind(appId)
    .first<{ next: number }>()
  return result?.next ?? 1
}

const findOrCreateApp = async (
  env: Env,
  input: z.infer<typeof intentSchema>,
  slug: string,
): Promise<{ id: string; slug: string; name: string }> => {
  const database = db(env)
  const found = await database.query.apps.findFirst({ where: eq(apps.slug, slug) })
  if (found) return found
  if (!input.create || !input.name) throw new Error('App not found')
  const app = { id: createId(), slug, name: input.name }
  try {
    await database.insert(apps).values(app)
  } catch (error) {
    if (String(error).includes('UNIQUE')) {
      const raced = await database.query.apps.findFirst({ where: eq(apps.slug, slug) })
      if (raced) return raced
    }
    throw error instanceof Error ? error : new Error('Could not create app')
  }
  return app
}

const parse = async <T>(request: Request, schema: z.ZodType<T>) => {
  let json: unknown
  try {
    json = await request.json()
  } catch {
    return { error: { error: 'Request body must be JSON' } } as const
  }
  const result = schema.safeParse(json)
  return result.success
    ? ({ data: result.data } as const)
    : ({ error: result.error.flatten() } as const)
}

const cleanupExpiredUploads = async (env: Env) => {
  const database = db(env)
  const nowIso = new Date().toISOString()
  const staleCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  // Batched: a >1000-row backlog must drain over several hourly runs instead of
  // blowing the ~1000-subrequest cap and wedging cleanup forever.
  const expired = await database
    .select()
    .from(uploadIntents)
    .where(and(lt(uploadIntents.expiresAt, nowIso), ne(uploadIntents.state, 'validating')))
    .limit(100)
  const staleClaims = await database
    .select()
    .from(uploadIntents)
    .where(
      and(
        eq(uploadIntents.state, 'validating'),
        or(isNull(uploadIntents.claimedAt), lt(uploadIntents.claimedAt, staleCutoff)),
      ),
    )
    .limit(100)
  const doomed = [...expired, ...staleClaims]
  await Promise.all(doomed.map((intent) => env.R2.delete(intent.r2Key)))
  if (doomed.length) {
    await database
      .delete(uploadIntents)
      .where(and(lt(uploadIntents.expiresAt, nowIso), ne(uploadIntents.state, 'validating')))
    await database
      .delete(uploadIntents)
      .where(
        and(
          eq(uploadIntents.state, 'validating'),
          or(isNull(uploadIntents.claimedAt), lt(uploadIntents.claimedAt, staleCutoff)),
        ),
      )
  }
}

export { cleanupExpiredUploads }

export const api = new Hono<{ Bindings: Env; Variables: Variables }>()
api.use('*', uploaderAuth)
api.use('*', async (c, next) => {
  await next()
  if (c.req.method === 'GET') c.header('Cache-Control', 'private, no-store')
})

api.get('/apps', async (c) =>
  c.json(
    await db(c.env)
      .select({
        id: apps.id,
        slug: apps.slug,
        name: apps.name,
        packageName: apps.packageName,
        createdAt: apps.createdAt,
      })
      .from(apps)
      .orderBy(apps.name),
  ),
)

api.post('/apps', async (c) => {
  const body = await parse(c.req.raw, createAppSchema)
  if ('error' in body) return c.json(body.error, 400)
  const existing = await db(c.env).query.apps.findFirst({ where: eq(apps.slug, body.data.slug) })
  if (existing) return c.json({ error: 'App slug already exists' }, 409)
  const app = {
    id: createId(),
    slug: body.data.slug,
    name: body.data.name,
    passcodeHash: body.data.passcode
      ? await hashPasscode(body.data.passcode, c.env.APP_SECRET)
      : null,
  }
  try {
    await db(c.env).insert(apps).values(app)
  } catch (error) {
    if (String(error).includes('UNIQUE')) return c.json({ error: 'App slug already exists' }, 409)
    throw error
  }
  return c.json({ id: app.id, slug: app.slug, name: app.name }, 201)
})

api.get('/apps/:slug/builds/latest', async (c) => {
  const app = await db(c.env).query.apps.findFirst({ where: eq(apps.slug, c.req.param('slug')) })
  if (!app) return c.json({ error: 'App not found' }, 404)
  const build = await db(c.env).query.builds.findFirst({
    where: eq(builds.appId, app.id),
    orderBy: [desc(builds.versionCode), desc(builds.uploadedAt)],
  })
  return c.json(build ?? null)
})

api.get('/apps/:slug/builds', async (c) => {
  const app = await db(c.env).query.apps.findFirst({ where: eq(apps.slug, c.req.param('slug')) })
  if (!app) return c.json({ error: 'App not found' }, 404)
  return c.json(
    await db(c.env)
      .select()
      .from(builds)
      .where(eq(builds.appId, app.id))
      .orderBy(desc(builds.versionCode)),
  )
})

api.post('/apps/:slug/builds/intent', async (c) => {
  const body = await parse(c.req.raw, intentSchema)
  if ('error' in body) return c.json(body.error, 400)
  const slug = slugSchema.safeParse(c.req.param('slug'))
  if (!slug.success) return c.json({ error: slug.error.flatten() }, 400)
  c.executionCtx.waitUntil(
    cleanupExpiredUploads(c.env).catch((error) => {
      console.error('expired-upload cleanup failed', error)
    }),
  )

  let app: { id: string; slug: string; name: string }
  try {
    app = await findOrCreateApp(c.env, body.data, slug.data)
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'App not found' || error.message === 'Could not create app')
    ) {
      return c.json({ error: 'App not found; use create and name to create it' }, 404)
    }
    throw error
  }

  const id = createId()
  const key = `uploads/${id}.apk`
  const expiresAt = new Date(Date.now() + uploadLifetimeMs).toISOString()
  await db(c.env)
    .insert(uploadIntents)
    .values({
      id,
      appId: app.id,
      r2Key: key,
      filename: body.data.filename,
      expectedSizeBytes: body.data.sizeBytes,
      versionName: body.data.versionName,
      versionCode: body.data.versionCode,
      notes: body.data.notes,
      commitSha: body.data.commitSha,
      uploader: c.get('uploader'),
      expiresAt,
    })
  const uploadUrl = await presignR2Put({
    accountId: c.env.R2_ACCOUNT_ID,
    accessKeyId: c.env.R2_S3_ACCESS_KEY_ID,
    secretAccessKey: c.env.R2_S3_SECRET_ACCESS_KEY,
    bucket: c.env.R2_BUCKET_NAME,
    key,
    ifNoneMatch: '*',
  })
  return c.json(
    { id, uploadUrl: uploadUrl.toString(), expiresAt, requiredHeaders: { 'If-None-Match': '*' } },
    201,
  )
})

api.post('/builds/:id/complete', async (c) => {
  const body = await parse(c.req.raw, completeSchema)
  if ('error' in body) return c.json(body.error, 400)
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'Build intent is invalid or expired' }, 400)
  const database = db(c.env)
  const intent = await database.query.uploadIntents.findFirst({ where: eq(uploadIntents.id, id) })
  if (!intent || intent.expiresAt <= new Date().toISOString())
    return c.json({ error: 'Build intent is invalid or expired' }, 400)
  if (intent.uploader !== c.get('uploader'))
    return c.json({ error: 'Build intent belongs to another token' }, 403)
  if (intent.state === 'published' && intent.buildId) {
    const build = await database.query.builds.findFirst({ where: eq(builds.id, intent.buildId) })
    return build ? c.json(build, 200) : c.json({ error: 'Published build disappeared' }, 409)
  }

  const claim = await c.env.DB.prepare(
    "UPDATE upload_intents SET state = 'validating', claimed_at = ? WHERE id = ? AND state = 'pending'",
  )
    .bind(new Date().toISOString(), intent.id)
    .run()
  if (claim.meta.changes !== 1)
    return c.json({ error: 'Build completion is already in progress' }, 409)

  try {
    const object = await c.env.R2.head(intent.r2Key)
    if (!object) return c.json({ error: 'Upload missing from R2' }, 400)
    if (object.size !== intent.expectedSizeBytes)
      return c.json({ error: 'Uploaded file size does not match intent' }, 400)

    const source = await r2SourceFromGet(c.env.R2, intent.r2Key)
    if (!source) return c.json({ error: 'Upload disappeared from R2' }, 400)
    const magic = await source.read(0, 4)
    if (magic[0] !== 0x50 || magic[1] !== 0x4b || magic[2] !== 0x03 || magic[3] !== 0x04) {
      return c.json({ error: 'File is not a ZIP/APK' }, 400)
    }
    const metadata = await readApkManifest(source)
    const app = await database.query.apps.findFirst({ where: eq(apps.id, intent.appId) })
    if (!app) return c.json({ error: 'App was deleted while uploading' }, 409)

    const fallback = fileNameMetadata(intent.filename)
    const bounded = (value: number | null | undefined) =>
      value != null && Number.isSafeInteger(value) && value <= MAX_VERSION_CODE ? value : undefined
    const versionName = metadata.versionName ?? intent.versionName ?? fallback.versionName
    if (!versionName)
      return c.json({ error: 'APK has no versionName; include versionName in the intent' }, 400)
    const publishedKey = `builds/${intent.id}.apk`
    // A prior attempt of this same intent may have committed its row before a
    // transient failure; adopt it so retries reuse its versionCode instead of
    // skipping past it (MAX+1) and colliding on the build id.
    let duplicate = await database.query.builds.findFirst({
      where: eq(builds.r2Key, publishedKey),
    })
    let versionCode =
      bounded(metadata.versionCode) ?? bounded(intent.versionCode) ?? bounded(fallback.versionCode)
    if (versionCode === undefined) {
      const computed = bounded(await nextVersionCode(c.env, app.id))
      versionCode = duplicate?.versionCode ?? computed ?? MAX_VERSION_CODE
    }
    if (!duplicate) {
      duplicate = await database.query.builds.findFirst({
        where: and(eq(builds.appId, app.id), eq(builds.versionCode, versionCode)),
      })
    }
    if (duplicate && duplicate.versionCode !== versionCode) versionCode = duplicate.versionCode
    if (duplicate && !body.data.force && duplicate.r2Key !== publishedKey)
      return c.json({ error: 'versionCode already exists', buildId: duplicate.id }, 409)
    const validated = await getValidatedR2Object(c.env.R2, intent.r2Key, object.etag)
    if (!validated || !('body' in validated))
      return c.json({ error: 'Upload changed while being validated' }, 409)
    await c.env.R2.put(publishedKey, validated.body)

    const build = {
      appId: app.id,
      versionName,
      versionCode,
      r2Key: publishedKey,
      sizeBytes: object.size,
      commitSha: intent.commitSha ?? null,
      notes: intent.notes ?? null,
      uploadedBy: intent.uploader,
    }
    const shareUrlFor = (slug: string, code: number) =>
      new URL(`/a/${encodeURIComponent(slug)}/v/${code}`, c.env.BASE_URL).toString()
    let buildId: string
    if (duplicate) {
      // CAS on the key this request read: two concurrent force-replaces of the
      // same version must not clobber each other's row (last write silently wins).
      const replace = await database
        .update(builds)
        .set(build)
        .where(and(eq(builds.id, duplicate.id), eq(builds.r2Key, duplicate.r2Key)))
        .run()
      if (replace.meta.changes === 1) {
        buildId = duplicate.id
      } else {
        const current = await database.query.builds.findFirst({
          where: and(eq(builds.appId, app.id), eq(builds.versionCode, versionCode)),
        })
        if (current) {
          c.executionCtx.waitUntil(c.env.R2.delete(publishedKey))
          await database
            .update(uploadIntents)
            .set({ state: 'published', buildId: current.id })
            .where(eq(uploadIntents.id, intent.id))
          return c.json({ ...current, shareUrl: shareUrlFor(app.slug, current.versionCode) }, 200)
        }
        // The row was deleted concurrently; publish as a fresh build.
        try {
          await database.insert(builds).values({ id: intent.id, ...build })
        } catch (error) {
          if (String(error).includes('UNIQUE'))
            return c.json({ error: 'versionCode already exists' }, 409)
          throw error
        }
        buildId = intent.id
      }
    } else {
      try {
        await database.insert(builds).values({ id: intent.id, ...build })
      } catch (error) {
        if (String(error).includes('UNIQUE'))
          return c.json({ error: 'versionCode already exists' }, 409)
        throw error
      }
      buildId = intent.id
    }
    await database
      .update(apps)
      .set({ packageName: metadata.packageName ?? app.packageName })
      .where(eq(apps.id, app.id))
    await database
      .update(uploadIntents)
      .set({ state: 'published', buildId })
      .where(eq(uploadIntents.id, intent.id))
    c.executionCtx.waitUntil(c.env.R2.delete(intent.r2Key))
    if (duplicate && duplicate.r2Key !== publishedKey)
      c.executionCtx.waitUntil(c.env.R2.delete(duplicate.r2Key))
    return c.json(
      {
        id: buildId,
        ...build,
        packageName: metadata.packageName,
        minSdkVersion: metadata.minSdkVersion,
        shareUrl: shareUrlFor(app.slug, versionCode),
      },
      // An in-place force-replace updated an existing resource, not a new one.
      duplicate ? 200 : 201,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid APK'
    // Parse failures are client errors; everything else is transient infra and
    // must not leak internals or masquerade as a bad request.
    const parseFailure = /^(Invalid APK|Invalid ZIP|Invalid AndroidManifest\.xml)/.test(message)
    const replaced = message.includes('APK object changed while being validated')
    const appDeleted = message.includes('FOREIGN KEY')
    if (!parseFailure && !replaced && !appDeleted) {
      console.error('complete failed for intent', intent.id, error)
      return c.json({ error: 'Internal error; retry the publish' }, 500)
    }
    if (replaced) return c.json({ error: 'Upload changed while being validated' }, 409)
    if (appDeleted) return c.json({ error: 'App was deleted while uploading' }, 409)
    return c.json({ error: message }, 400)
  } finally {
    try {
      await c.env.DB.prepare(
        "UPDATE upload_intents SET state = 'pending' WHERE id = ? AND state = 'validating'",
      )
        .bind(intent.id)
        .run()
    } catch (error) {
      console.error('claim reset failed for intent', intent.id, error)
    }
  }
})

api.delete('/builds/:id', async (c) => {
  const id = c.req.param('id')
  const build = id && (await db(c.env).query.builds.findFirst({ where: eq(builds.id, id) }))
  if (!build) return c.json({ error: 'Build not found' }, 404)
  // Row first, object after: a failed R2 delete leaves an invisible orphan blob,
  // while the reverse order leaves a user-visible row pointing at nothing.
  await db(c.env).delete(builds).where(eq(builds.id, build.id))
  await c.env.R2.delete(build.r2Key)
  return c.body(null, 204)
})

api.delete('/apps/:slug', async (c) => {
  const app = await db(c.env).query.apps.findFirst({ where: eq(apps.slug, c.req.param('slug')) })
  if (!app) return c.json({ error: 'App not found' }, 404)
  const appBuilds = await db(c.env).select().from(builds).where(eq(builds.appId, app.id))
  const appIntents = await db(c.env)
    .select()
    .from(uploadIntents)
    .where(eq(uploadIntents.appId, app.id))
  // App row first: an in-flight complete() then fails on the FK instead of
  // publishing into an app whose R2 sweep already ran.
  await db(c.env).delete(apps).where(eq(apps.id, app.id))
  await Promise.all([...appBuilds, ...appIntents].map((row) => c.env.R2.delete(row.r2Key)))
  return c.body(null, 204)
})
