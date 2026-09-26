export type Locale = 'en' | 'zh-Hant' | 'zh-Hans'

const copy = {
  en: {
    appsList: 'App releases',
    noApps: 'No apps published yet.',
    upload: 'Upload',
    notes: 'Release notes',
    install: 'Install APK',
    download: 'Download APK',
    latest: 'Latest release',
    history: 'Version history',
    version: 'Version',
    uploaded: 'Uploaded',
    size: 'Size',
    downloads: 'Downloads',
    passcode: 'Passcode',
    unlock: 'Unlock download',
    invalidPasscode: 'Incorrect passcode.',
    lockedPasscode: 'Too many attempts. Try again in one hour.',
    guide: 'How to install',
    guideText:
      'Open the downloaded APK, then allow this browser to install unknown apps when Android asks.',
    unavailable: 'This release is unavailable.',
  },
  'zh-Hant': {
    appsList: '應用發布',
    noApps: '尚未發布任何應用程式。',
    upload: '上傳',
    notes: '版本說明',
    install: '安裝 APK',
    download: '下載 APK',
    latest: '最新版本',
    history: '版本記錄',
    version: '版本',
    uploaded: '上傳時間',
    size: '檔案大小',
    downloads: '下載次數',
    passcode: '密碼',
    unlock: '解鎖下載',
    invalidPasscode: '密碼不正確。',
    lockedPasscode: '嘗試次數過多，請一小時後再試。',
    guide: '安裝方法',
    guideText: '開啟已下載的 APK。Android 提示時，允許此瀏覽器安裝未知應用程式。',
    unavailable: '此版本無法使用。',
  },
  'zh-Hans': {
    appsList: '应用发布',
    noApps: '还没有已发布的应用。',
    upload: '上传',
    notes: '版本说明',
    install: '安装 APK',
    download: '下载 APK',
    latest: '最新版本',
    history: '版本记录',
    version: '版本',
    uploaded: '上传时间',
    size: '文件大小',
    downloads: '下载次数',
    passcode: '密码',
    unlock: '解锁下载',
    invalidPasscode: '密码不正确。',
    lockedPasscode: '尝试次数过多，请一小时后再试。',
    guide: '安装方法',
    guideText: '打开已下载的 APK。Android 提示时，允许此浏览器安装未知应用。',
    unavailable: '此版本不可用。',
  },
} as const

const quality = (part: string) => {
  const match = part.match(/;q=([\d.]+)$/)
  return match ? Number(match[1]) : 1
}

/** Ranked Accept-Language parsing: first matching family by declared preference wins. */
export const localeFrom = (acceptLanguage: string | undefined, selected?: string): Locale => {
  if (selected === 'zh-Hant' || selected === 'zh-Hans' || selected === 'en') return selected
  const ranked = (acceptLanguage ?? '')
    .split(',')
    .map((part) => ({ tag: (part.split(';')[0] ?? '').trim().toLowerCase(), q: quality(part) }))
    .filter((entry) => entry.tag)
    .sort((left, right) => right.q - left.q)
  for (const { tag } of ranked) {
    if (tag.startsWith('zh')) {
      if (/(hant|tw|hk|mo)/.test(tag)) return 'zh-Hant'
      if (/(hans|cn|sg)/.test(tag)) return 'zh-Hans'
      return 'zh-Hant'
    }
    if (tag.startsWith('en')) return 'en'
  }
  return 'en'
}

export const t = (locale: Locale) => copy[locale]
