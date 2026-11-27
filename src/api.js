import { consumeSseStream } from './sse.mjs'
import { appFetch, getApiBase } from './platform.mjs'

let accessToken = null
let refreshPromise = null

function responseErrorMessage(payload, status) {
  const value = payload?.error ?? payload?.detail ?? payload?.message
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    const text = value.map((item) => typeof item === 'string' ? item : item?.msg || item?.message || item?.text).filter(Boolean).join('；')
    if (text) return text
  }
  if (value && typeof value === 'object') {
    for (const key of ['message', 'msg', 'text', 'detail', 'error']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
    }
    try {
      const serialized = JSON.stringify(value)
      if (serialized && serialized !== '{}') return serialized
    } catch {
      // Fall through to the status-based message.
    }
  }
  return `请求失败（${status}）`
}

async function rawRequest(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  const { headers: _optionHeaders, ...requestOptions } = options
  const response = await appFetch(`${getApiBase()}${path}`, {
    credentials: 'include',
    headers,
    ...requestOptions,
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
    refreshPromise = rawRequest('/auth/me')
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
    throw new Error(responseErrorMessage(payload, response.status))
  }

  return payload
}

async function streamRequest(path, { signal, onEvent } = {}, retry = true) {
  const headers = { Accept: 'text/event-stream' }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  const response = await appFetch(`${getApiBase()}${path}`, {
    credentials: 'include',
    headers,
    signal,
  })
  if (response.status === 401 && retry && !path.startsWith('/auth/')) {
    const session = await refreshSession()
    if (session) return streamRequest(path, { signal, onEvent }, false)
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(responseErrorMessage(payload, response.status))
  }
  await consumeSseStream(response.body, async ({ event, data }) => {
    let payload = null
    try {
      payload = data ? JSON.parse(data) : null
    } catch {
      payload = data
    }
    if (event === 'error') throw new Error(payload?.error || '任务流读取失败')
    await onEvent?.(event, payload)
  })
}

async function downloadRequest(path, retry = true) {
  const headers = {}
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  const response = await appFetch(`${getApiBase()}${path}`, { credentials: 'include', headers })
  if (response.status === 401 && retry && !path.startsWith('/auth/')) {
    const session = await refreshSession()
    if (session) return downloadRequest(path, false)
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(responseErrorMessage(payload, response.status))
  }
  const disposition = response.headers.get('content-disposition') || ''
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1]
  let fileName = plainName || 'skill-package'
  if (encodedName) {
    try { fileName = decodeURIComponent(encodedName) } catch { fileName = encodedName }
  }
  return { blob: await response.blob(), fileName }
}

export const api = {
  requestRegistrationCode: (email) => request('/auth/register/code', { method: 'POST', body: JSON.stringify({ email }) }, false),
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
  requestPasswordReset: (email) => request('/auth/password/forgot', { method: 'POST', body: JSON.stringify({ email }) }, false),
  resetPassword: (token, password) => request('/auth/password/reset', { method: 'POST', body: JSON.stringify({ token, password }) }, false),
  restoreSession: () => refreshSession(false),
  logout: async () => {
    await request('/auth/logout', { method: 'POST' }, false).catch(() => undefined)
    accessToken = null
  },
  getMe: () => request('/auth/me'),
  getSkills: () => request('/ai/skills'),
  getAiUsage: () => request('/ai/usage'),
  runStoryAgent: (input, options = {}) => request('/ai/agent/runs', { method: 'POST', body: JSON.stringify(input), signal: options.signal }),
  getAgentThread: (projectId, chapterId) => request(`/ai/threads?projectId=${encodeURIComponent(projectId)}&chapterId=${encodeURIComponent(chapterId)}`),
  getAgentThreads: ({ projectId = '', includeArchived = true, q = '' } = {}) => {
    const query = new URLSearchParams()
    if (projectId) query.set('projectId', projectId)
    if (includeArchived) query.set('includeArchived', 'true')
    if (q) query.set('q', q)
    return request(`/ai/threads${query.size ? `?${query}` : ''}`)
  },
  getAgentThreadById: (threadId) => request(`/ai/threads/${encodeURIComponent(threadId)}`),
  createAgentThread: (projectId, chapterId) => request('/ai/threads', { method: 'POST', body: JSON.stringify({ projectId, chapterId }) }),
  updateAgentThread: (threadId, updates) => request(`/ai/threads/${encodeURIComponent(threadId)}`, { method: 'PATCH', body: JSON.stringify(updates) }),
  archiveAgentThread: (threadId) => request(`/ai/threads/${encodeURIComponent(threadId)}`, { method: 'DELETE' }),
  resumeAgentThread: (threadId) => request(`/ai/threads/${encodeURIComponent(threadId)}/resume`, { method: 'POST' }),
  compactAgentThread: (threadId, input = {}) => request(`/ai/threads/${encodeURIComponent(threadId)}/compact`, { method: 'POST', body: JSON.stringify(input) }),
  createAgentTurn: (threadId, input, options = {}) => request(`/ai/threads/${encodeURIComponent(threadId)}/turns`, { method: 'POST', body: JSON.stringify(input), signal: options.signal }),
  answerAgentTurn: (threadId, turnId, answers, options = {}) => request(`/ai/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/input`, { method: 'POST', body: JSON.stringify({ answers }), signal: options.signal }),
  regenerateAgentTurn: (threadId, turnId, options = {}) => request(`/ai/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/regenerate`, { method: 'POST', signal: options.signal }),
  steerAgentTurn: (threadId, turnId, input, options = {}) => request(`/ai/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/steer`, { method: 'POST', body: JSON.stringify(input), signal: options.signal }),
  getAgentTurn: (threadId, turnId, options = {}) => request(`/ai/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}`, { signal: options.signal }),
  streamAgentTurn: (threadId, turnId, options = {}) => streamRequest(`/ai/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/stream`, options),
  interruptAgentTurn: (threadId, turnId) => request(`/ai/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`, { method: 'POST' }),
  createAiTask: (input, options = {}) => request('/ai/tasks', { method: 'POST', body: JSON.stringify(input), signal: options.signal }),
  getAiTasks: (projectId = '') => request(`/ai/tasks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  getAiTask: (taskId, options = {}) => request(`/ai/tasks/${encodeURIComponent(taskId)}`, { signal: options.signal }),
  applyAiTaskArtifacts: (taskId) => request(`/ai/tasks/${encodeURIComponent(taskId)}/artifacts/apply`, { method: 'POST' }),
  retryAiTask: (taskId) => request(`/ai/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST' }),
  cancelAiTask: (taskId) => request(`/ai/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' }),
  getWritingContext: (projectId, chapterId) => request(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/context`),
  reviewChapter: (chapter) => request('/ai/reviews/chapter', { method: 'POST', body: JSON.stringify(chapter) }),
  getSettings: () => request('/settings'),
  updateSettings: (config) => request('/settings', { method: 'PUT', body: JSON.stringify(config) }),
  getModels: (config = {}) => request('/ai/models', { method: 'POST', body: JSON.stringify(config) }),
  getWritingAssistantSession: () => request('/writing-assistant/session'),
  sendWritingAssistantMessage: (message, options = {}) => request('/writing-assistant/messages', { method: 'POST', body: JSON.stringify({ message, ...options }) }),
  confirmWritingAssistant: (sessionId, proposal) => request('/writing-assistant/confirm', { method: 'POST', body: JSON.stringify({ sessionId, proposal }) }),
  clearWritingAssistantSession: () => request('/writing-assistant/session', { method: 'DELETE' }),
  getProjects: () => request('/projects'),
  getDashboard: () => request('/dashboard'),
  getProject: (projectId) => request(`/projects/${encodeURIComponent(projectId)}`),
  getProjectRelationships: (projectId) => request(`/projects/${encodeURIComponent(projectId)}/relationships`),
  saveProjectRelationships: (projectId, relationships) => request(`/projects/${encodeURIComponent(projectId)}/relationships`, { method: 'PUT', body: JSON.stringify(relationships) }),
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

  // ---- 本地工作区 ----
  getWorkspace: () => request('/workspace'),
  openWorkspace: (input) => request('/workspace/open', { method: 'POST', body: JSON.stringify(input) }),
  closeWorkspace: () => request('/workspace/close', { method: 'POST' }),
  getWorkspaceTree: () => request('/workspace/tree'),
  reconcileWorkspace: (knownChapters = []) => request('/workspace/reconcile', { method: 'POST', body: JSON.stringify({ knownChapters }) }),
  getWorkspaceMeta: () => request('/workspace/meta'),
  updateWorkspaceMeta: (patch) => request('/workspace/meta', { method: 'PUT', body: JSON.stringify(patch) }),
  readWorkspaceFile: (path) => request(`/workspace/file?path=${encodeURIComponent(path)}`),
  writeWorkspaceFile: (path, content, options = {}) => request('/workspace/file', {
    method: 'PUT',
    body: JSON.stringify({ path, content, snapshot: options.snapshot !== false }),
  }),
  deleteWorkspaceFile: (path) => request(`/workspace/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  getWorkspaceChapters: () => request('/workspace/chapters'),
  createWorkspaceChapter: (title, content = '') => request('/workspace/chapters', { method: 'POST', body: JSON.stringify({ title, content }) }),
  renameWorkspaceChapter: (path, title) => request('/workspace/chapters', { method: 'PATCH', body: JSON.stringify({ path, title }) }),
  deleteWorkspaceChapter: (path) => request(`/workspace/chapters?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  getWorkspaceHistory: (path) => request(`/workspace/history?path=${encodeURIComponent(path)}`),
  getWorkspaceSnapshot: (path, snapshotId) => request(`/workspace/history/${encodeURIComponent(snapshotId)}?path=${encodeURIComponent(path)}`),
  getWorkspaceState: (name) => request(`/workspace/state/${encodeURIComponent(name)}`),
  updateWorkspaceState: (name, value) => request(`/workspace/state/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  getWorkspaceThreads: () => request('/workspace/threads'),
  getWorkspaceThread: (threadId) => request(`/workspace/threads/${encodeURIComponent(threadId)}`),
  saveWorkspaceThread: (threadId, thread) => request(`/workspace/threads/${encodeURIComponent(threadId)}`, { method: 'PUT', body: JSON.stringify({ thread }) }),
  deleteWorkspaceThread: (threadId) => request(`/workspace/threads/${encodeURIComponent(threadId)}`, { method: 'DELETE' }),
}
