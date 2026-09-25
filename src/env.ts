export interface Env {
  DB: D1Database
  R2: R2Bucket
  /** Public base URL used for share links and QR targets, e.g. https://drop.example.com */
  BASE_URL: string
  /** Cloudflare account ID — host component of R2 S3 presigned URLs */
  R2_ACCOUNT_ID: string
  /** R2 bucket name — used for the R2 S3 virtual-hosted presigned URL */
  R2_BUCKET_NAME: string
  /** Secret: "label:token,label:token" — bearer tokens accepted on /api/* */
  UPLOAD_TOKENS: string
  /** Secret: HMAC pepper for passcode hashing + gate cookies */
  APP_SECRET: string
  /** Secret: R2 S3 API token, used to presign direct-to-R2 uploads */
  R2_S3_ACCESS_KEY_ID: string
  R2_S3_SECRET_ACCESS_KEY: string
}
