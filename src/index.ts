import { Hono } from 'hono'
import type { Variables } from './auth'
import type { Env } from './env'
import { api } from './routes/api'
import { downloads } from './routes/download'
import { pages } from './routes/pages'

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

app.get('/healthz', async (c) => {
  const [database, bucket] = await Promise.all([
    c.env.DB.prepare('SELECT 1').first(),
    c.env.R2.list({ limit: 1 }),
  ])
  return c.json({ ok: Boolean(database && bucket) })
})
app.route('/api', api)
app.route('/', downloads)
app.route('/', pages)

app.get('/upload', (c) =>
  c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upload · SlapDrop</title>
<link rel="stylesheet" href="/app.css">
</head>
<body><main class="wrap"><h1>Upload APK</h1>
<form id="upload-form" class="upload-form">
<label>Upload token<input name="token" type="password" required autocomplete="off"></label>
<label>App slug<input name="app" pattern="[a-z0-9]+(-[a-z0-9]+)*" required placeholder="my-android-app"></label>
<label>App name <small>(first upload only)</small><input name="name" maxlength="120" placeholder="My Android App"></label>
<label>APK file<input name="apk" type="file" accept=".apk,application/vnd.android.package-archive" required></label>
<label>Release notes<textarea name="notes" maxlength="10000"></textarea></label>
<label>Commit SHA<input name="commit" maxlength="100"></label>
<label class="check"><input name="create" type="checkbox" checked> Create app if it does not exist</label>
<button>Upload and publish</button></form>
<p id="status" aria-live="polite"></p><a id="result" hidden></a></main><script src="/app.js"></script></body></html>`),
)

app.get('/', (c) =>
  c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SlapDrop</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main class="wrap">
  <h1>🐝 SlapDrop</h1>
  <p>Self-hosted Android app distribution.</p>
</main>
</body>
</html>`),
)

export default app
