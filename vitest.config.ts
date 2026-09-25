import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

const migrations = await readD1Migrations('./migrations')

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          UPLOAD_TOKENS: 'ci:ci-test-token-1,web:ci-test-token-2',
          APP_SECRET: 'test-app-secret',
          R2_S3_ACCESS_KEY_ID: 'test-access-key-id',
          R2_S3_SECRET_ACCESS_KEY: 'test-secret-access-key',
          R2_BUCKET_NAME: 'slapdrop-apks',
        },
      },
    }),
  ],
})
