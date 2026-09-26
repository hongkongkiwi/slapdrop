import qrcode from 'qrcode-generator'
import type { Locale } from './i18n'

const localeTags: Record<Locale, string> = {
  en: 'en-GB',
  'zh-Hant': 'zh-HK',
  'zh-Hans': 'zh-CN',
}

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

export const formatDate = (iso: string, locale: Locale) => {
  try {
    return new Intl.DateTimeFormat(localeTags[locale], { dateStyle: 'medium' }).format(
      new Date(iso),
    )
  } catch {
    return iso.slice(0, 10)
  }
}

export const qrSvg = (url: string) => {
  const qr = qrcode(0, 'M')
  qr.addData(url)
  qr.make()
  // 4-module quiet zone so phone cameras resolve the code reliably.
  return qr.createSvgTag(4, 4)
}

/** Locale toggle links that preserve the current path and params (minus error state). */
const localeNav = (currentUrl?: URL) => {
  const href = (target: Locale) => {
    if (!currentUrl) return `?lang=${target}`
    const link = new URL(currentUrl)
    link.searchParams.delete('error')
    link.searchParams.set('lang', target)
    return `${link.pathname}${link.search}${link.hash}`
  }
  return `<nav class="locales"><a href="${href('en')}">EN</a><a href="${href('zh-Hant')}">繁</a><a href="${href('zh-Hans')}">简</a></nav>`
}

export const page = (title: string, locale: Locale, content: string, currentUrl?: URL) =>
  `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}${title ? ' · ' : ''}SlapDrop</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main class="wrap">
${localeNav(currentUrl)}
${content}
</main>
</body>
</html>`
