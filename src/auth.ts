import type { MiddlewareHandler } from 'hono'
import type { Env } from './env'

export type Variables = { uploader: string }

const tokens = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim().split(':', 2))
    .flatMap(([label, token]) => (label && token ? [{ label, token }] : []))

export const uploaderAuth: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  c,
  next,
) => {
  const token = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1]
  const uploader = token && tokens(c.env.UPLOAD_TOKENS).find((candidate) => candidate.token === token)
  if (!uploader) return c.json({ error: 'Unauthorized' }, 401)
  c.set('uploader', uploader.label)
  await next()
}
