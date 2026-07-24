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
  createAiTask: (input) => request('/ai/tasks', { method: 'POST', body: JSON.stringify(input) }),
  getAiTasks: (projectId = '') => request(`/ai/tasks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  getAiTask: (taskId) => request(`/ai/tasks/${encodeURIComponent(taskId)}`),
  retryAiTask: (taskId) => request(`/ai/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST' }),
  cancelAiTask: (taskId) => request(`/ai/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' }),
  getWritingContext: (projectId, chapterId) => request(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/context`),
  reviewChapter: (chapter) => request('/ai/reviews/chapter', { method: 'POST', body: JSON.stringify(chapter) }),
  getSettings: () => request('/settings'),
  updateSettings: (config) => request('/settings', { method: 'PUT', body: JSON.stringify(config) }),
  getModels: () => request('/ai/models', { method: 'POST' }),
  getWritingAssistantSession: () => request('/writing-assistant/session'),
  sendWritingAssistantMessage: (message, options = {}) => request('/writing-assistant/messages', { method: 'POST', body: JSON.stringify({ message, ...options }) }),
  confirmWritingAssistant: (sessionId, proposal) => request('/writing-assistant/confirm', { method: 'POST', body: JSON.stringify({ sessionId, proposal }) }),
  clearWritingAssistantSession: () => request('/writing-assistant/session', { method: 'DELETE' }),
  getProjects: () => request('/projects'),
  getDashboard: () => request('/dashboard'),
  getProject: (projectId) => request(`/projects/${encodeURIComponent(projectId)}`),
  createProject: (project) => request('/projects', { method: 'POST', body: JSON.stringify(project) }),
  createSmartProject: (project) => request('/projects/smart', { method: 'POST', body: JSON.stringify(project) }),
  importProject: (project) => request('/projects/import', { method: 'POST', body: JSON.stringify(project) }),
  updateProject: (projectId, updates) => request(`/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify(updates) }),
  deleteProject: (projectId) => request(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
  getChapters: (projectId) => request(`/projects/${encodeURIComponent(projectId)}/chapters`),
  createChapter: (projectId, title) => request(`/projects/${encodeURIComponent(projectId)}/chapters`, { method: 'POST', body: JSON.stringify({ title }) }),
  updateChapter: (projectId, chapterId, updates) => request(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}`, { method: 'PATCH', body: JSON.stringify(updates) }),
  deleteChapter: (projectId, chapterId) => request(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}`, { method: 'DELETE' }),
  getDraft: (projectId) => request(`/projects/${encodeURIComponent(projectId)}/draft`),
  saveDraft: (projectId, content) => request(`/projects/${encodeURIComponent(projectId)}/draft`, { method: 'PUT', body: JSON.stringify({ content }) }),
  getChapterDraft: (projectId, chapterId) => request(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/draft`),
  saveChapterDraft: (projectId, chapterId, content) => request(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/draft`, { method: 'PUT', body: JSON.stringify({ content }) }),
  getChapterHistory: (projectId, chapterId) => request(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/history`),
  createChapterHistory: (projectId, chapterId, content) => request(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/history`, { method: 'POST', body: JSON.stringify({ content }) }),
  getIdeas: () => request('/ideas'),
  createIdea: (idea) => request('/ideas', { method: 'POST', body: JSON.stringify(idea) }),
  updateIdea: (ideaId, updates) => request(`/ideas/${encodeURIComponent(ideaId)}`, { method: 'PATCH', body: JSON.stringify(updates) }),
  deleteIdea: (ideaId) => request(`/ideas/${encodeURIComponent(ideaId)}`, { method: 'DELETE' }),
  getStoryMemories: (projectId = '') => request(`/story-memories${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  createStoryMemory: (memory) => request('/story-memories', { method: 'POST', body: JSON.stringify(memory) }),
  confirmStoryMemories: (projectId, memories) => request('/story-memories/batch', { method: 'POST', body: JSON.stringify({ projectId, memories }) }),
  updateStoryMemory: (memoryId, updates) => request(`/story-memories/${encodeURIComponent(memoryId)}`, { method: 'PATCH', body: JSON.stringify(updates) }),
  deleteStoryMemory: (memoryId) => request(`/story-memories/${encodeURIComponent(memoryId)}`, { method: 'DELETE' }),
  extractChapterMemories: (projectId, chapterId) => request(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/memory-candidates`, { method: 'POST' }),
  getForeshadows: (projectId = '', status = '') => request(`/foreshadows?projectId=${encodeURIComponent(projectId)}${status ? `&status=${encodeURIComponent(status)}` : ''}`),
  createForeshadow: (foreshadow) => request('/foreshadows', { method: 'POST', body: JSON.stringify(foreshadow) }),
  updateForeshadow: (foreshadowId, updates) => request(`/foreshadows/${encodeURIComponent(foreshadowId)}`, { method: 'PATCH', body: JSON.stringify(updates) }),
  deleteForeshadow: (foreshadowId) => request(`/foreshadows/${encodeURIComponent(foreshadowId)}`, { method: 'DELETE' }),
}
