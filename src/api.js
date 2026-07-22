const API_BASE = import.meta.env.VITE_API_URL || '/api'
let accessToken = null
let refreshPromise = null

async function rawRequest(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers,
    ...options,
  })

  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  return { response, payload }
}

async function refreshSession(notifyExpiry = true) {
  if (!refreshPromise) {
    refreshPromise = rawRequest('/auth/refresh', { method: 'POST' })
      .then(({ response, payload }) => {
        if (!response.ok) {
          accessToken = null
          if (notifyExpiry && typeof window !== 'undefined') window.dispatchEvent(new Event('story-auth-expired'))
          return null
        }
        accessToken = payload.accessToken
        return payload
      })
      .finally(() => { refreshPromise = null })
  }
  return refreshPromise
}

async function request(path, options = {}, retry = true) {
  const { response, payload } = await rawRequest(path, options)
  if (response.status === 401 && retry && !path.startsWith('/auth/')) {
    const session = await refreshSession()
    if (session) return request(path, options, false)
  }

  if (!response.ok) {
    throw new Error(payload?.error || `请求失败（${response.status}）`)
  }

  return payload
}

export const api = {
  register: async (credentials) => {
    const payload = await request('/auth/register', { method: 'POST', body: JSON.stringify(credentials) }, false)
    accessToken = payload.accessToken
    return payload
  },
  login: async (credentials) => {
    const payload = await request('/auth/login', { method: 'POST', body: JSON.stringify(credentials) }, false)
    accessToken = payload.accessToken
    return payload
  },
  restoreSession: () => refreshSession(false),
  logout: async () => {
    await request('/auth/logout', { method: 'POST' }, false).catch(() => undefined)
    accessToken = null
  },
  getMe: () => request('/auth/me'),
  getSkills: () => request('/ai/skills'),
  runStoryAgent: (input) => request('/ai/agent/runs', { method: 'POST', body: JSON.stringify(input) }),
  reviewChapter: (chapter) => request('/ai/reviews/chapter', { method: 'POST', body: JSON.stringify(chapter) }),
  getProjects: () => request('/projects'),
  getProject: (projectId) => request(`/projects/${encodeURIComponent(projectId)}`),
  createProject: (project) => request('/projects', { method: 'POST', body: JSON.stringify(project) }),
  updateProject: (projectId, updates) => request(`/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify(updates) }),
  deleteProject: (projectId) => request(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
  getChapters: (projectId) => request(`/projects/${encodeURIComponent(projectId)}/chapters`),
  createChapter: (projectId, title) => request(`/projects/${encodeURIComponent(projectId)}/chapters`, { method: 'POST', body: JSON.stringify({ title }) }),
  updateChapter: (projectId, chapterId, updates) => request(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}`, { method: 'PATCH', body: JSON.stringify(updates) }),
  deleteChapter: (projectId, chapterId) => request(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}`, { method: 'DELETE' }),
  getDraft: (projectId) => request(`/projects/${encodeURIComponent(projectId)}/draft`),
  saveDraft: (projectId, content) => request(`/projects/${encodeURIComponent(projectId)}/draft`, { method: 'PUT', body: JSON.stringify({ content }) }),
  getIdeas: () => request('/ideas'),
  createIdea: (idea) => request('/ideas', { method: 'POST', body: JSON.stringify(idea) }),
  updateIdea: (ideaId, updates) => request(`/ideas/${encodeURIComponent(ideaId)}`, { method: 'PATCH', body: JSON.stringify(updates) }),
  deleteIdea: (ideaId) => request(`/ideas/${encodeURIComponent(ideaId)}`, { method: 'DELETE' }),
}
