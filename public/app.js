const api = async (path, token, options = {}) => {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof body.error === 'string' ? body.error : JSON.stringify(body.error ?? body)
    throw new Error(message || `Request failed (${response.status})`)
  }
  return body
}

const form = document.querySelector('#upload-form')
if (form) {
  const tokenInput = form.querySelector('[name=token]')
  const appInput = form.querySelector('[name=app]')
  const fileInput = form.querySelector('[name=apk]')
  const status = document.querySelector('#status')
  const result = document.querySelector('#result')
  tokenInput.value = localStorage.getItem('slapdrop-token') ?? ''

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const token = tokenInput.value.trim()
    const slug = appInput.value.trim()
    const file = fileInput.files?.[0]
    if (!token || !slug || !file) return
    localStorage.setItem('slapdrop-token', token)
    status.textContent = 'Creating upload…'
    result.hidden = true
    try {
      const intent = await api(`/apps/${encodeURIComponent(slug)}/builds/intent`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          sizeBytes: file.size,
          create: form.querySelector('[name=create]').checked,
          name: form.querySelector('[name=name]').value.trim() || undefined,
          notes: form.querySelector('[name=notes]').value.trim() || undefined,
          commitSha: form.querySelector('[name=commit]').value.trim() || undefined,
        }),
      })
      status.textContent = `Uploading ${file.name}…`
      const upload = await fetch(intent.uploadUrl, {
        method: 'PUT',
        headers: intent.requiredHeaders,
        body: file,
      })
      if (!upload.ok) throw new Error(`R2 upload failed (${upload.status})`)
      status.textContent = 'Validating APK…'
      const build = await api(`/builds/${intent.id}/complete`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      status.textContent = 'Published.'
      result.href = build.shareUrl
      result.textContent = `Open share link: ${build.shareUrl}`
      result.hidden = false
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Upload failed'
    }
  })
}
