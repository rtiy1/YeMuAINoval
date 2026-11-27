export function normalizeApiBase(value) {
  const input = String(value || '').trim()
  if (!input) return '/api'
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
  return '/api'
}

export async function appFetch(input, init) {
  return globalThis.fetch(input, init)
}

export async function sendAgentNotification({ title, body }) {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) return false
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false
  new Notification(String(title || '夜幕 AI 小说'), { body: String(body || '') })
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
  browserDownload({ fileName: normalizedName, content, mimeType: 'text/plain;charset=utf-8' })
  return { saved: true, path: null }
}

export const EDITOR_PREFERENCES_KEY = 'yemu:editor-preferences'
export const EDITOR_FONT_SIZES = Object.freeze([
  { value: 15, label: '小' },
  { value: 16, label: '标准' },
  { value: 18, label: '大' },
])
export const EDITOR_LINE_HEIGHTS = Object.freeze([
  { value: 1.8, label: '紧凑' },
  { value: 2.05, label: '舒适' },
  { value: 2.35, label: '宽松' },
])
export const DEFAULT_EDITOR_PREFERENCES = Object.freeze({
  theme: 'system',
  fontSize: 16,
  lineHeight: 2.05,
  panelWidths: Object.freeze({ chapter: 300, assistant: 420 }),
})

function preferenceObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function preferenceWidth(value, minimum, maximum, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.min(maximum, Math.max(minimum, Math.round(value))) : fallback
}

export function normalizeEditorPreferences(value = {}) {
  const source = preferenceObject(value)
  const widths = preferenceObject(source.panelWidths)
  return {
    theme: ['system', 'light', 'dark'].includes(source.theme) ? source.theme : 'system',
    fontSize: EDITOR_FONT_SIZES.some((option) => option.value === source.fontSize) ? source.fontSize : 16,
    lineHeight: EDITOR_LINE_HEIGHTS.some((option) => option.value === source.lineHeight) ? source.lineHeight : 2.05,
    panelWidths: {
      chapter: preferenceWidth(widths.chapter, 220, 420, 300),
      assistant: preferenceWidth(widths.assistant, 320, 520, 420),
    },
  }
}

export function mergeEditorPreferences(current, patch) {
  const base = normalizeEditorPreferences(current)
  const update = preferenceObject(patch)
  return normalizeEditorPreferences({
    ...base,
    ...update,
    panelWidths: { ...base.panelWidths, ...preferenceObject(update.panelWidths) },
  })
}

function parsePreferenceObject(value) {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function readEditorPreferences(storage) {
  try {
    const target = storage ?? globalThis.localStorage
    const saved = parsePreferenceObject(target?.getItem(EDITOR_PREFERENCES_KEY))
    if (saved) return normalizeEditorPreferences(saved)
    return normalizeEditorPreferences({
      theme: target?.getItem('story-studio-theme'),
      panelWidths: parsePreferenceObject(target?.getItem('yemu:editor-panel-widths')),
    })
  } catch {
    return normalizeEditorPreferences()
  }
}

export function writeEditorPreferences(preferences, storage) {
  try {
    const target = storage ?? globalThis.localStorage
    if (!target) return false
    target.setItem(EDITOR_PREFERENCES_KEY, JSON.stringify(normalizeEditorPreferences(preferences)))
    return true
  } catch {
    return false
  }
}

export function resolveEditorTheme(mode, systemDark = false) {
  return mode === 'light' || mode === 'dark' ? mode : systemDark ? 'dark' : 'light'
}

// 是否运行在 Tauri 桌面壳里。壳会注入 __TAURI_INTERNALS__。
export function isDesktopShell() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)
}

// 原生文件夹选择器。浏览器里返回 null，调用方应回退到手输路径。
// 动态 import 是为了让浏览器构建不把 Tauri 包打进主 bundle。
export async function pickWorkspaceFolder() {
  if (!isDesktopShell()) return null
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择作品工作区',
      buttonLabel: '打开',
    })
    if (!selected) return null
    return Array.isArray(selected) ? selected[0] : String(selected)
  } catch {
    return null
  }
}
