const encoder = new TextEncoder()

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const sha256 = async (value: string) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))

const hmac = async (key: ArrayBuffer | Uint8Array, value: string) =>
  crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    encoder.encode(value),
  )

const signingKey = async (secret: string, date: string) => {
  const dateKey = await hmac(encoder.encode(`AWS4${secret}`), date)
  const regionKey = await hmac(dateKey, 'auto')
  const serviceKey = await hmac(regionKey, 's3')
  return hmac(serviceKey, 'aws4_request')
}

const amzDate = (date: Date) => date.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/')

const canonicalQuery = (query: URLSearchParams) =>
  [...query.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyOrder = leftKey.localeCompare(rightKey)
      return keyOrder === 0 ? leftValue.localeCompare(rightValue) : keyOrder
    })
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')

export interface PresignR2PutOptions {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  key: string
  expiresInSeconds?: number
  now?: Date
}

/** Creates a direct browser/CI PUT URL for R2. Credentials never leave the Worker. */
export const presignR2Put = async ({
  accountId,
  accessKeyId,
  secretAccessKey,
  bucket,
  key,
  expiresInSeconds = 900,
  now = new Date(),
}: PresignR2PutOptions) => {
  if (expiresInSeconds < 1 || expiresInSeconds > 604_800) throw new Error('expiresInSeconds must be 1–604800')

  const host = `${bucket}.${accountId}.r2.cloudflarestorage.com`
  const date = amzDate(now)
  const shortDate = date.slice(0, 8)
  const credentialScope = `${shortDate}/auto/s3/aws4_request`
  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': date,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  })
  const path = `/${encodeKey(key)}`
  const canonicalRequest = ['PUT', path, canonicalQuery(query), `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    date,
    credentialScope,
    await sha256(canonicalRequest),
  ].join('\n')
  query.set('X-Amz-Signature', hex(await hmac(await signingKey(secretAccessKey, shortDate), stringToSign)))
  return new URL(`https://${host}${path}?${canonicalQuery(query)}`)
}
