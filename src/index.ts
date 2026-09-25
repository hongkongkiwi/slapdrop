import { Hono } from 'hono'
import type { Variables } from './auth'
import type { Env } from './env'
import { api } from './routes/api'

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

app.get('/healthz', async (c) => {
  const [database, bucket] = await Promise.all([
    c.env.DB.prepare('SELECT 1').first(),
    c.env.R2.list({ limit: 1 }),
  ])
  return c.json({ ok: Boolean(database && bucket) })
})
app.route('/api', api)

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
