import type { Context } from 'hono'
import type { Env } from './env'

const encoder = new TextEncoder()
const maxFailures = 5
const windowMs = 15 * 60 * 1000
const lockMs = 60 * 60 * 1000

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

const hash = async (value: string) => {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return base64url(new Uint8Array(bytes))
}

const sign = async (value: string, secret: string) => {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))))
}

export const timingSafeEqualString = (left: string, right: string) => {
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  if (leftBytes.byteLength !== rightBytes.byteLength) return false
  let difference = 0
  for (let index = 0; index < leftBytes.byteLength; index++) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  }
  return difference === 0
}

const equal = timingSafeEqualString

export const hashPasscode = (passcode: string, secret: string) => hash(`${secret}:${passcode}`)

const cookieName = (appId: string) => `slapdrop_${appId}`

const parseCookies = (header: string | null | undefined) =>
  new Map(
    (header ?? '')
      .split(';')
      .map((part) => part.trim().split('=', 2))
      .flatMap(([name, value]) => (name && value ? [[name, value] as const] : [])),
  )

export const hasAppAccess = async (request: Request, appId: string, env: Env) => {
  const cookie = parseCookies(request.headers.get('cookie')).get(cookieName(appId))
  if (!cookie) return false
  const [expiresAt, signature] = cookie.split('.', 2)
  if (!expiresAt || !signature || Number(expiresAt) < Date.now()) return false
  return equal(signature, await sign(`${appId}.${expiresAt}`, env.APP_SECRET))
}

export const grantAppAccess = async (c: Context<{ Bindings: Env }>, appId: string) => {
  const expiresAt = String(Date.now() + 24 * 60 * 60 * 1000)
  const signature = await sign(`${appId}.${expiresAt}`, c.env.APP_SECRET)
  c.header(
    'Set-Cookie',
    `${cookieName(appId)}=${expiresAt}.${signature}; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax; Secure`,
  )
}

export const passcodeMatches = async (passcode: string, expectedHash: string, secret: string) =>
  equal(await hashPasscode(passcode, secret), expectedHash)

export const passcodeClientKey = (request: Request) =>
  request.headers.get('cf-connecting-ip') ?? 'unknown'

/** Permits five failed guesses per IP/app per 15 minutes, then locks that pair for one hour. */
export const verifyPasscodeAttempt = async (
  env: Env,
  appId: string,
  expectedHash: string,
  passcode: string,
  clientKey: string,
): Promise<'ok' | 'invalid' | 'locked'> => {
  const now = Date.now()
  const attempt = await env.DB.prepare(
    'SELECT id, failures, window_started_at, locked_until FROM passcode_attempts WHERE app_id = ? AND client_key = ?',
  )
    .bind(appId, clientKey)
    .first<{
      id: string
      failures: number
      window_started_at: string
      locked_until: string | null
    }>()
  if (attempt?.locked_until && Date.parse(attempt.locked_until) > now) return 'locked'

  if (await passcodeMatches(passcode, expectedHash, env.APP_SECRET)) {
    if (attempt)
      await env.DB.prepare('DELETE FROM passcode_attempts WHERE id = ?').bind(attempt.id).run()
    return 'ok'
  }

  const resetWindow = !attempt || now - Date.parse(attempt.window_started_at) >= windowMs
  const failures = (resetWindow ? 0 : attempt.failures) + 1
  const windowStartedAt = new Date(
    resetWindow ? now : Date.parse(attempt.window_started_at),
  ).toISOString()
  const lockedUntil = failures >= maxFailures ? new Date(now + lockMs).toISOString() : null
  if (attempt) {
    await env.DB.prepare(
      'UPDATE passcode_attempts SET failures = ?, window_started_at = ?, locked_until = ? WHERE id = ?',
    )
      .bind(failures, windowStartedAt, lockedUntil, attempt.id)
      .run()
  } else {
    await env.DB.prepare(
      'INSERT INTO passcode_attempts (id, app_id, client_key, failures, window_started_at, locked_until) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(crypto.randomUUID(), appId, clientKey, failures, windowStartedAt, lockedUntil)
      .run()
  }
  return lockedUntil ? 'locked' : 'invalid'
}
