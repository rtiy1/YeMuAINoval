import { contentToText } from './result-text.mjs'

export class ApiError extends Error {
  constructor(message, status, payload = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.payload = payload
  }
}

function normalizeApiBase(value) {
  const base = String(value || 'http://127.0.0.1:8787/api').trim().replace(/\/+$/, '')
  return base.endsWith('/api') ? base : `${base}/api`
}

function responseError(payload, status) {
  const detail = payload?.error ?? payload?.detail ?? payload?.message
  const message = contentToText(detail) || `请求失败（${status}）`
  return new ApiError(message, status, payload)
}

export class NovelApiClient {
  constructor({ baseUrl, accessToken = null } = {}) {
    this.baseUrl = normalizeApiBase(baseUrl)
    this.accessToken = accessToken
    this.refreshCookie = null
  }

  captureCookie(response) {
    const raw = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()[0]
      : response.headers.get('set-cookie')
    if (raw) this.refreshCookie = raw.split(';', 1)[0]
  }

  async rawRequest(path, options = {}) {
    const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`
    if (this.refreshCookie) headers.cookie = this.refreshCookie
    const response = await fetch(`${this.baseUrl}${path}`, { ...options, headers })
    this.captureCookie(response)
    const text = await response.text()
    let payload = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = { message: text }
      }
    }
    return { response, payload }
  }

  async refresh() {
    if (!this.refreshCookie) return false
    const { response, payload } = await this.rawRequest('/auth/refresh', { method: 'POST' })
    if (!response.ok || !payload?.accessToken) return false
    this.accessToken = payload.accessToken
    return true
  }

  async request(path, options = {}, retry = true) {
    const { response, payload } = await this.rawRequest(path, options)
    if (response.status === 401 && retry && !path.startsWith('/auth/') && await this.refresh()) {
      return this.request(path, options, false)
    }
    if (!response.ok) throw responseError(payload, response.status)
    return payload
  }

  async login(email, password) {
    const payload = await this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }, false)
    this.accessToken = payload.accessToken
    return payload
  }

  me() { return this.request('/auth/me') }
  getSettings() { return this.request('/settings') }
  getSkills() { return this.request('/ai/skills') }
  getProjects() { return this.request('/projects') }
  getChapters(projectId) { return this.request(`/projects/${encodeURIComponent(projectId)}/chapters`) }
  getDraft(projectId, chapterId) { return this.request(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/draft`) }
  getContext(projectId, chapterId) { return this.request(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/context`) }
  getHistory(projectId, chapterId) { return this.request(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/history`) }
  saveDraft(projectId, chapterId, content) {
    return this.request(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/draft`, {
      method: 'PUT', body: JSON.stringify({ content }),
    })
  }
  runSkill(message, skill, payload = {}) {
    return this.request('/ai/agent/runs', {
      method: 'POST', body: JSON.stringify({ message, skill, payload }),
    })
  }
  createTask(message, skill, payload = {}, { idempotencyKey = '', signal } = {}) {
    return this.request('/ai/tasks', {
      method: 'POST',
      body: JSON.stringify({ message, skill, payload, ...(idempotencyKey ? { idempotencyKey } : {}) }),
      signal,
    })
  }
  getTask(taskId, { signal } = {}) {
    return this.request(`/ai/tasks/${encodeURIComponent(taskId)}`, { signal })
  }
  getTasks(projectId = '') {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
    return this.request(`/ai/tasks${query}`)
  }
  cancelTask(taskId) {
    return this.request(`/ai/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' })
  }
  retryTask(taskId, { signal } = {}) {
    return this.request(`/ai/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST', signal })
  }
  sendMessage(message, options = {}) {
    return this.request('/writing-assistant/messages', {
      method: 'POST', body: JSON.stringify({ message, ...options }),
    })
  }
  getAssistantSession() { return this.request('/writing-assistant/session') }
  clearAssistantSession() { return this.request('/writing-assistant/session', { method: 'DELETE' }) }
  confirmAssistant(sessionId, proposal) {
    return this.request('/writing-assistant/confirm', {
      method: 'POST', body: JSON.stringify({ sessionId, proposal }),
    })
  }
}

export { normalizeApiBase }
