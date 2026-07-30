const DESKTOP_API_STORAGE_KEY = 'yemu:desktop-api-base'
const LOCAL_DESKTOP_API = 'http://127.0.0.1:8787/api'

export function isDesktopApp() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)
}

export function normalizeApiBase(value, { desktop = isDesktopApp() } = {}) {
  const input = String(value || '').trim()
  if (!input) return desktop ? LOCAL_DESKTOP_API : '/api'
  if (input.startsWith('/')) return input.replace(/\/+$/, '') || '/api'

  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`
  let url
  try {
    url = new URL(withProtocol)
  } catch {
    throw new Error('服务器地址格式不正确')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('服务器地址仅支持 HTTP 或 HTTPS')
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = /\/api$/i.test(path) ? path : `${path}/api`
  return url.toString().replace(/\/$/, '')
}

export function getApiBase() {
  const configured = import.meta.env.VITE_API_URL
  if (configured) return normalizeApiBase(configured)
  if (!isDesktopApp()) return '/api'
  try {
    return normalizeApiBase(window.localStorage.getItem(DESKTOP_API_STORAGE_KEY), { desktop: true })
  } catch {
    return LOCAL_DESKTOP_API
  }
}

export function setDesktopApiBase(value) {
  const normalized = normalizeApiBase(value, { desktop: true })
  if (typeof window !== 'undefined') window.localStorage.setItem(DESKTOP_API_STORAGE_KEY, normalized)
  return normalized
}

export async function appFetch(input, init) {
  if (!isDesktopApp()) return globalThis.fetch(input, init)
  const { fetch } = await import('@tauri-apps/plugin-http')
  return fetch(input, { connectTimeout: 10_000, ...init })
}

export async function openExternalUrl(value) {
  const url = new URL(String(value))
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) throw new Error('不支持打开这个链接')
  if (!isDesktopApp()) {
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
    return
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url.toString())
}

export async function sendAgentNotification({ title, body }) {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) return false
  if (!isDesktopApp()) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false
    new Notification(String(title || '夜幕 AI 小说'), { body: String(body || '') })
    return true
  }

  const {
    isPermissionGranted,
    requestPermission,
    sendNotification,
  } = await import('@tauri-apps/plugin-notification')
  let permissionGranted = await isPermissionGranted()
  if (!permissionGranted) permissionGranted = (await requestPermission()) === 'granted'
  if (!permissionGranted) return false
  sendNotification({
    title: String(title || '夜幕 AI 小说'),
    body: String(body || ''),
  })
  return true
}

function safeFileName(value, fallback = '文稿.txt') {
  const normalized = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  return normalized || fallback
}

function browserDownload({ fileName, content, mimeType }) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function saveTextDocument({ fileName, content }) {
  const normalizedName = safeFileName(fileName)
  if (!isDesktopApp()) {
    browserDownload({ fileName: normalizedName, content, mimeType: 'text/plain;charset=utf-8' })
    return { saved: true, path: null }
  }

  const [{ save }, { writeTextFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ])
  const path = await save({
    defaultPath: normalizedName,
    filters: [{ name: '纯文本', extensions: ['txt'] }],
  })
  if (!path) return { saved: false, path: null }
  await writeTextFile(path, String(content ?? ''))
  return { saved: true, path }
}

export async function openTextDocument({ maxBytes = 20 * 1024 * 1024 } = {}) {
  if (!isDesktopApp()) throw new Error('系统文件选择器仅在桌面客户端中可用')
  const [{ open }, { readTextFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ])
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: '纯文本', extensions: ['txt'] }],
  })
  if (!path || Array.isArray(path)) return null
  const content = await readTextFile(path)
  if (new TextEncoder().encode(content).byteLength > maxBytes) throw new Error('文件不能超过 20 MB')
  return {
    content,
    name: String(path).split(/[\\/]/).pop() || '未命名.txt',
    path,
  }
}

export async function testApiBase(value) {
  const base = normalizeApiBase(value, { desktop: true })
  const response = await appFetch(`${base}/health`, {
    headers: { Accept: 'application/json' },
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error || `连接失败（${response.status}）`)
  return { base, payload }
}
