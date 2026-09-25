import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from './env'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

const fromBase64url = (value: string) => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

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

const equal = (left: string, right: string) => {
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  if (leftBytes.byteLength !== rightBytes.byteLength) return false
  let difference = 0
  for (let index = 0; index < leftBytes.byteLength; index++) difference |= leftBytes[index]! ^ rightBytes[index]!
  return difference === 0
}

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

export const requireAppAccess = (appId: string): MiddlewareHandler<{ Bindings: Env }> => async (c, next) => {
  if (await hasAppAccess(c.req.raw, appId, c.env)) await next()
  else return c.text('Passcode required', 401)
}

export const passcodeMatches = async (passcode: string, expectedHash: string, secret: string) =>
  equal(await hashPasscode(passcode, secret), expectedHash)

export const decodePasscode = (value: string) => decoder.decode(fromBase64url(value))
