# SlapDrop

Standalone Android APK distribution service on Cloudflare Workers.

## Project map

| Area | Purpose |
| --- | --- |
| `src/index.ts` | Hono Worker composition and health endpoint |
| `src/routes/api.ts` | Token-protected app/build management and upload lifecycle |
| `src/routes/pages.ts` | Trilingual public install pages and passcode access |
| `src/routes/download.ts` | APK streaming and download counting |
| `src/apk/` | R2 ranged ZIP reads and Android binary-manifest parsing |
| `src/sigv4.ts` | R2 S3 presigned direct-upload URLs |
| `src/db/schema.ts` | Drizzle D1 schema |
| `migrations/` | Ordered hand-written D1 migrations |
| `test/` | Vitest tests running in the Workers runtime |
| `ci/upload/` | Reusable GitHub Action for publishing APKs |

## Commands

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm check
```

Run verification in this order after every code change:

```sh
pnpm typecheck
pnpm lint
pnpm test
```

Do not run the gates in parallel.

## Change rules

- Reproduce a bug with a failing test before fixing it.
- Add a hand-written migration for every D1 schema change; never edit a migration that may have reached a deployed database.
- Keep upload staging keys separate from published build keys. The presigned direct R2 PUT contract requires `If-None-Match: *`; changing it needs focused security tests.
- Passcode changes require tests for access grants and attempt limits. Do not log passcodes, API tokens, R2 credentials, or secret values.
- Keep public install pages self-contained: no third-party browser scripts or external fonts, to preserve mainland-China reachability.

## Deploying

1. Apply D1 migrations before deploying Worker code.
2. Set `BASE_URL` to the custom domain; do not distribute `workers.dev` links to mainland-China testers.
3. Configure R2 CORS before using `/upload`; it must allow `PUT`, `If-None-Match`, and `Content-Type` from the custom domain.
4. Keep `UPLOAD_TOKENS`, `APP_SECRET`, `R2_S3_ACCESS_KEY_ID`, and `R2_S3_SECRET_ACCESS_KEY` in Wrangler secrets only.

See `README.md` for the complete deployment runbook and `SECURITY.md` for vulnerability reporting.
