# SlapDrop — feature scope

Self-hosted TestFlight-like distribution for Android APKs, running on a single
Cloudflare Worker (Hono + R2 + D1). Audience: testers without Play Store access
(e.g. mainland China), with CI-driven uploads.

## Distribution (tester-facing, trilingual EN / 繁體中文 / 简体中文)

- **F1** Install page per app `GET /a/:slug` — latest build card: version,
  size, upload date, download count, release notes (package name / min Android
  available via API only — rendering them needs persisted columns)
- **F2** Install button → direct APK download `GET /d/:buildId.apk` (correct
  MIME type, `Content-Disposition` attachment, friendly filename)
- **F3** QR code on the install page, generated client-side (no external APIs —
  must work behind the GFW)
- **F4** Shareable per-app link; per-build link `GET /a/:slug/v/:versionCode`;
  QR is scannable straight from the phone
- **F5** Version history with per-version download links
- **F6** Sideload guide accordion (enable "install unknown apps", per-OEM hints)
- **F7** Optional per-app passcode gate (SHA-256 + pepper, HMAC-signed cookie, 24h)
- **F8** Locale auto-detected via `Accept-Language`, manual toggle via `?lang=`
  links (per-request, not persisted)

## Upload & management (Bearer token auth)

- **F9** Two-phase large-file upload: `POST /api/apps/:slug/builds/intent` →
  presigned R2 PUT URL → client PUTs bytes directly to R2 (no Worker
  body-size limit) → `POST /api/builds/:id/complete`
- **F10** Server-side APK metadata via R2 ranged reads: package, versionName,
  versionCode, minSdkVersion, app label — never downloads the whole APK
- **F11** Metadata fallback chain: explicit params → filename pattern
  (`app-1.2.3-45.apk`) → per-app monotonic versionCode
- **F12** Upload validation: zip magic bytes + `AndroidManifest.xml` entry
  present (rejects non-APK); duplicate `versionCode` → 409 unless `force`
- **F13** Build metadata: notes, commit SHA, uploader label, timestamps
- **F14** App management API: create / list / delete apps, list / delete builds
  (delete cascades R2 objects)
- **F15** Auto-create app on first upload (`create` flag) — CI convenience
- **F16** Download counters per build + totals per app

## Upload UI

- **F17** `/upload` single page: token stored in localStorage, create/pick app,
  file-picker APK upload (intent → PUT → complete) with status line and
  share-URL result (drag-drop, progress bar, and result QR not built yet)

## CI integrations

- **F18** Reusable composite action `ci/upload/action.yml` —
  `uses: <this-repo>/ci/upload@main` with inputs (api URL, token, app slug,
  APK path, notes, commit SHA, create/force flags); prints the install URL
- **F19** Example recipes in `examples/`: GitHub Actions release upload,
  EAS post-build hook, plain `curl` shell script
- **F20** `GET /api/apps/:slug/builds/latest` — CI dedupe check (skip upload
  when the version is already distributed)
- **F21** `/healthz` — DB + R2 ping

## Ops

- **F22** README runbook: create D1/R2, secrets, R2 bucket CORS, custom domain
  (`*.workers.dev` is blocked in mainland China — a custom domain is required),
  deploy, migrate
- **F23** Fully self-contained pages (no external fonts/scripts) for GFW
  reliability

## v1.1 backlog (explicitly not in v1)

- Release channels (alpha / beta / stable) per app
- Changelog rendering (markdown notes), per-build diff links
- Upload notifications (webhooks, Telegram/Bark)
- Per-app scoped API tokens
- S3-compatible upload endpoint for existing tooling
- Rate limiting on download / passcode routes
- Mainland mirror or China-edge delivery option
- Per-app branding on install pages
