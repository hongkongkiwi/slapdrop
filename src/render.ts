import qrcode from 'qrcode-generator'
import type { Locale } from './i18n'

export const escapeHtml = (value: string | number | null | undefined) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const qrSvg = (url: string) => {
  const qr = qrcode(0, 'M')
  qr.addData(url)
  qr.make()
  return qr.createSvgTag(4, 0)
}

export const page = (title: string, locale: Locale, content: string) => `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · SlapDrop</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main class="wrap">
<nav class="locales"><a href="?lang=en">EN</a><a href="?lang=zh-Hant">繁</a><a href="?lang=zh-Hans">简</a></nav>
${content}
</main>
</body>
</html>`
