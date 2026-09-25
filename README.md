# SlapDrop

Self-hosted Android APK distribution on Cloudflare Workers, R2, and D1.

Upload an APK once. Send testers an install link or QR code. No Google Play account,
external fonts, or third-party runtime scripts.

## What works

- Large APK uploads go browser/CI → R2 directly; Worker never receives APK body.
- APK ZIP + binary `AndroidManifest.xml` validation happens with R2 range reads.
- Public EN / 繁體中文 / 简体中文 install pages with share links and QR codes.
- Optional app passcodes, version history, direct downloads, counters.
- CI action and plain `curl` upload recipes.

## Deploy — 15 minutes

```sh
cd ~/Development/hongkongkiwi/slapdrop
pnpm install
npx wrangler login
npx wrangler d1 create slapdrop-db
npx wrangler r2 bucket create slapdrop-apks
```

1. Put D1 `database_id` returned by Wrangler into [`wrangler.jsonc`](./wrangler.jsonc).
2. Set `R2_ACCOUNT_ID` to your Cloudflare account ID. Keep `R2_BUCKET_NAME=slapdrop-apks`.
3. Create R2 S3 credentials: Cloudflare dashboard → **R2** → **Manage R2 API Tokens** →
   create token restricted to `slapdrop-apks`, Object Read & Write. Copy access-key ID and secret.
4. Set secrets. `UPLOAD_TOKENS` format is `label:secret,label:secret`.

```sh
npx wrangler secret put UPLOAD_TOKENS
npx wrangler secret put APP_SECRET
npx wrangler secret put R2_S3_ACCESS_KEY_ID
npx wrangler secret put R2_S3_SECRET_ACCESS_KEY
npx wrangler d1 migrations apply slapdrop-db --remote
npx wrangler deploy
```

5. Add custom domain in Cloudflare Workers dashboard. Set `BASE_URL` in `wrangler.jsonc` to it,
   then deploy again. Do **not** send `workers.dev` links to mainland-China testers: it is blocked
   by GFW. Custom-domain reachability still depends on tester network and your domain.
6. Set R2 CORS to allow browser uploads from your custom domain. Replace origin first, then run:

```sh
npx wrangler r2 bucket cors set slapdrop-apks --file docs/r2-cors.json
```

The policy must permit `PUT`, `If-None-Match`, and `Content-Type`; browser uploads preflight those.

## Local development

```sh
cp .dev.vars.example .dev.vars
pnpm db:migrate:local
pnpm dev
```

`R2_S3_*` values must be real only when testing direct upload. Worker/D1/R2 bindings run locally
through Wrangler. HTTPS is needed for production passcode cookies.

## Development workflow

`pnpm install` installs the Lefthook Git hooks. Run checks serially before every commit:

```sh
pnpm typecheck
pnpm lint
pnpm test
```

Use `pnpm test:watch` while changing tests. Contributor rules live in
[`AGENTS.md`](./AGENTS.md); report vulnerabilities privately per
[`SECURITY.md`](./SECURITY.md). Pull requests use the repository checklist.

## Upload

Browser UI: open `/upload`. It stores uploader token in browser `localStorage` on that device.

CLI:

```sh
SLAPDROP_URL=https://drop.example.com \
SLAPDROP_TOKEN='your-token' \
./examples/upload.sh my-android-app ./app-release.apk
```

First upload must either create app through `/upload` or call `POST /api/apps` first. For CI, use
[`ci/upload/action.yml`](./ci/upload/action.yml); example workflow:
[`examples/github-actions.yml`](./examples/github-actions.yml).

**Important:** direct R2 PUT must include `If-None-Match: *`. SlapDrop returns and signs this
required header in the upload intent. It prevents an expired/compromised presigned URL from
overwriting an already-validated APK.

## API

All `/api/*` routes require `Authorization: Bearer <upload-token>`.

- `POST /api/apps` — create app (`slug`, `name`, optional `passcode`)
- `GET /api/apps` — list apps
- `POST /api/apps/:slug/builds/intent` — receive presigned direct R2 upload URL
- `POST /api/builds/:id/complete` — validate/publish staged APK
- `GET /api/apps/:slug/builds/latest` — CI dedupe lookup
- `GET /api/apps/:slug/builds` — release list
- `DELETE /api/builds/:id`, `DELETE /api/apps/:slug`

Public:

- `GET /a/:slug` — latest release, QR, install guide
- `GET /a/:slug/v/:versionCode` — fixed release page
- `GET /d/:buildId.apk` — APK download (passcode-gated if configured)

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test
```

## Limits / out of scope

Android APK only. No iOS, user accounts, rate limits, mainland mirror, release channels, or analytics
beyond download counters. D1/Workers/R2 platform limits still apply.

## License

[MIT](./LICENSE)
