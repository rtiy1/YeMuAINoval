import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import {
  createAccessToken,
  createRefreshSession,
  decryptSecret,
  encryptSecret,
  hashRefreshToken,
  hashPassword,
  maskKey,
  publicUser,
  refreshCookie,
  usesDefaultSecret,
  verifyAccessToken,
  verifyPassword,
} from './auth.mjs'
import { countWords, findProject, formatWords, loadDb, updateDb } from './store.mjs'

const app = express()
const parsedPort = Number(process.env.PORT)
const port = Number.isFinite(parsedPort) ? parsedPort : 8787
const host = process.env.HOST || '127.0.0.1'
const serverDir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(serverDir, '..', 'dist')
const allowedOrigins = (process.env.WEB_ORIGIN || 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean)
const corsMiddleware = cors({ origin: true, credentials: true })
const aiServiceUrl = (process.env.AI_SERVICE_URL || 'http://127.0.0.1:8890').replace(/\/$/, '')
const aiServiceToken = process.env.AI_SERVICE_TOKEN || 'local-ai-service-token'

app.disable('x-powered-by')
app.use(helmet({ contentSecurityPolicy: false }))
app.use((req, res, next) => {
  const origin = req.get('origin')
  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim()
  const ownOrigin = `${forwardedProto || req.protocol}://${forwardedHost || req.get('host')}`
  if (!origin || origin === ownOrigin || allowedOrigins.includes(origin)) {
    corsMiddleware(req, res, next)
    return
  }
  next(Object.assign(new Error('不允许的请求来源'), { status: 403 }))
})
app.use(cookieParser())
app.use(express.json({ limit: '20mb' }))

app.use(['/api/auth/register', '/api/auth/login'], rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: '登录尝试过于频繁，请稍后再试' },
}))

function cleanText(value, field, maxLength) {
  if (typeof value !== 'string') {
    const error = new Error(`${field} 必须是文本`)
    error.status = 400
    throw error
  }
  const text = value.trim()
  if (!text) {
    const error = new Error(`${field} 不能为空`)
    error.status = 400
    throw error
  }
  if (text.length > maxLength) {
    const error = new Error(`${field} 不能超过 ${maxLength} 个字符`)
    error.status = 400
    throw error
  }
  return text
}

function cleanEmail(value) {
  const email = cleanText(value, '邮箱', 160).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error('邮箱格式不正确')
    error.status = 400
    throw error
  }
  return email
}

function cleanPassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    const error = new Error('密码长度需要在 8 到 128 个字符之间')
    error.status = 400
    throw error
  }
  return value
}

function cleanTags(value) {
  if (value == null || value === '') return []
  const source = Array.isArray(value) ? value : String(value).split(/[,，]/)
  return [...new Set(source.map((item) => String(item).trim()).filter(Boolean).map((item) => item.slice(0, 20)))].slice(0, 8)
}

function unauthorized(message = '请先登录') {
  const error = new Error(message)
  error.status = 401
  return error
}

function findOr404(db, projectId, userId) {
  const project = findProject(db, projectId)
  if (!project || (userId && project.userId !== userId)) {
    const error = new Error('作品不存在')
    error.status = 404
    throw error
  }
  return project
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function draftMapFor(db, projectId) {
  const current = db.drafts[projectId]
  if (current && typeof current === 'object' && !Array.isArray(current)) return current
  const next = {}
  if (typeof current === 'string' && current) next.__legacy = current
  db.drafts[projectId] = next
  return next
}

function chapterOr404(db, project, chapterId) {
  const chapter = (db.chapters[project.id] || []).find((item) => String(item.id) === String(chapterId))
  if (!chapter) throw Object.assign(new Error('章节不存在'), { status: 404 })
  return chapter
}

function touchProject(project, timestamp = new Date().toISOString()) {
  project.updated = '刚刚'
  project.updatedAt = timestamp
}

function recalculateProject(db, project) {
  const chapters = db.chapters[project.id] || []
  const drafts = draftMapFor(db, project.id)
  const totalWords = chapters.reduce((total, chapter) => total + countWords(drafts[String(chapter.id)] || ''), 0)
  project.chapters = chapters.length
  project.words = formatWords(totalWords)
  if (project.status === '已完结') project.progress = 100
  else if (totalWords > 0 && Number(project.progress) === 0) project.progress = 1
  else if (totalWords === 0 && Number(project.progress) === 1) project.progress = 0
  return totalWords
}

function recordWriting(db, { userId, projectId, chapterId, delta, timestamp }) {
  if (delta <= 0) return
  const date = localDateKey(new Date(timestamp))
  const existing = db.writingLog.find((entry) => entry.userId === userId && entry.projectId === projectId && String(entry.chapterId) === String(chapterId) && entry.date === date)
  if (existing) {
    existing.words += delta
    existing.updatedAt = timestamp
    return
  }
  db.writingLog.push({
    id: crypto.randomUUID(),
    userId,
    projectId,
    chapterId,
    date,
    words: delta,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
}

function saveChapterContent(db, project, chapter, content, userId) {
  const drafts = draftMapFor(db, project.id)
  const key = String(chapter.id)
  const previous = typeof drafts[key] === 'string' ? drafts[key] : ''
  const previousWords = countWords(previous)
  const nextWords = countWords(content)
  const timestamp = new Date().toISOString()
  drafts[key] = content
  delete drafts.__legacy
  chapter.words = formatWords(nextWords)
  chapter.updatedAt = timestamp
  touchProject(project, timestamp)
  recalculateProject(db, project)
  recordWriting(db, { userId, projectId: project.id, chapterId: chapter.id, delta: Math.max(0, nextWords - previousWords), timestamp })
  return { content, chapter, project }
}

function createChapterRecord(db, project, title) {
  const chapters = db.chapters[project.id] || []
  const timestamp = new Date().toISOString()
  const chapter = {
    id: chapters.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1,
    title,
    words: '0',
    state: 'draft',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  db.chapters[project.id] = [...chapters, chapter]
  const drafts = draftMapFor(db, project.id)
  drafts[String(chapter.id)] = chapters.length === 0 && typeof drafts.__legacy === 'string' ? drafts.__legacy : ''
  delete drafts.__legacy
  recalculateProject(db, project)
  touchProject(project, timestamp)
  return chapter
}

function dashboardStats(db, userId) {
  const projects = db.projects.filter((project) => project.userId === userId)
  const totalWords = projects.reduce((total, project) => total + Number(String(project.words || '0').replaceAll(',', '')), 0)
  const chapterCount = projects.reduce((total, project) => total + (db.chapters[project.id] || []).length, 0)
  const log = db.writingLog.filter((entry) => entry.userId === userId)
  const now = new Date()
  const daily = []
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(now)
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - offset)
    const key = localDateKey(date)
    daily.push({ date: key, words: log.filter((entry) => entry.date === key).reduce((total, entry) => total + Number(entry.words || 0), 0) })
  }
  let previousWeekWords = 0
  for (let offset = 13; offset >= 7; offset -= 1) {
    const date = new Date(now)
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - offset)
    const key = localDateKey(date)
    previousWeekWords += log.filter((entry) => entry.date === key).reduce((total, entry) => total + Number(entry.words || 0), 0)
  }
  const weekWords = daily.reduce((total, item) => total + item.words, 0)
  return {
    projectCount: projects.length,
    completedProjects: projects.filter((project) => project.status === '已完结').length,
    chapterCount,
    totalWords,
    todayWords: daily.at(-1)?.words || 0,
    weekWords,
    previousWeekWords,
    growthPercent: previousWeekWords > 0 ? Math.round(((weekWords - previousWeekWords) / previousWeekWords) * 100) : null,
    activeDays: daily.filter((item) => item.words > 0).length,
    daily,
  }
}

function setRefreshCookie(res, token) {
  res.cookie(refreshCookie.name, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/auth',
    maxAge: refreshCookie.maxAge,
  })
}

function clearRefreshCookie(res) {
  res.clearCookie(refreshCookie.name, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/api/auth' })
}

async function issueSession(user, req, res) {
  const accessToken = await createAccessToken(user)
  const refresh = createRefreshSession(user.id, { userAgent: req.get('user-agent') })
  await updateDb((db) => {
    db.sessions = db.sessions.filter((session) => new Date(session.expiresAt) > new Date())
    db.sessions.push(refresh.session)
  })
  setRefreshCookie(res, refresh.token)
  return { accessToken, user: publicUser(user) }
}

async function authenticate(req, _res, next) {
  try {
    const authorization = req.get('authorization') || ''
    if (!authorization.startsWith('Bearer ')) throw unauthorized()
    const payload = await verifyAccessToken(authorization.slice(7))
    const db = await loadDb()
    const user = db.users.find((item) => item.id === payload.sub)
    if (!user) throw unauthorized('账号不存在')
    req.user = user
    next()
  } catch (error) {
    next(error.status ? error : unauthorized())
  }
}

app.get('/api/health', async (_req, res, next) => {
  try {
    const db = await loadDb()
    res.json({ ok: true, users: db.users.length, projects: db.projects.length })
  } catch (error) {
    next(error)
  }
})

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const name = cleanText(req.body?.name, '昵称', 40)
    const email = cleanEmail(req.body?.email)
    const password = cleanPassword(req.body?.password)
    const passwordHash = await hashPassword(password)
    const user = {
      id: crypto.randomUUID(),
      name,
      email,
      passwordHash,
      createdAt: new Date().toISOString(),
    }
    const created = await updateDb((db) => {
      if (db.users.some((item) => item.email === email)) {
        throw Object.assign(new Error('该邮箱已经注册'), { status: 409 })
      }
      db.users.push(user)
      if (!db.projects.some((project) => project.userId === user.id)) {
        const timestamp = new Date().toISOString()
        const project = {
          id: crypto.randomUUID(), userId: user.id, title: '我的第一本书', type: '长篇', genre: '现代言情', status: '构思中', progress: 0,
          words: '0', updated: '刚刚', chapters: 0, tone: '等待你的第一笔设定', cover: 'cover-new', isActive: true, createdAt: timestamp, updatedAt: timestamp,
        }
        db.projects.push(project)
        db.chapters[project.id] = []
        db.drafts[project.id] = {}
        createChapterRecord(db, project, '第一章')
      }
      return user
    })
    res.status(201).json(await issueSession(created, req, res))
  } catch (error) {
    next(error)
  }
})

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = cleanEmail(req.body?.email)
    const password = cleanPassword(req.body?.password)
    const db = await loadDb()
    const user = db.users.find((item) => item.email === email)
    if (!user || !(await verifyPassword(password, user.passwordHash))) throw unauthorized('邮箱或密码不正确')
    res.json(await issueSession(user, req, res))
  } catch (error) {
    next(error)
  }
})

app.post('/api/auth/refresh', async (req, res, next) => {
  try {
    const rawToken = req.cookies[refreshCookie.name]
    if (!rawToken) throw unauthorized()
    const tokenHash = hashRefreshToken(rawToken)
    const result = await updateDb((db) => {
      const index = db.sessions.findIndex((session) => session.tokenHash === tokenHash && new Date(session.expiresAt) > new Date())
      if (index === -1) throw unauthorized('登录已过期，请重新登录')
      const session = db.sessions[index]
      const user = db.users.find((item) => item.id === session.userId)
      if (!user) throw unauthorized('账号不存在')
      db.sessions.splice(index, 1)
      const nextSession = createRefreshSession(user.id, { userAgent: req.get('user-agent') })
      db.sessions.push(nextSession.session)
      return { user, token: nextSession.token }
    })
    setRefreshCookie(res, result.token)
    res.json({ accessToken: await createAccessToken(result.user), user: publicUser(result.user) })
  } catch (error) {
    clearRefreshCookie(res)
    next(error)
  }
})

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    const rawToken = req.cookies[refreshCookie.name]
    if (rawToken) {
      const tokenHash = hashRefreshToken(rawToken)
      await updateDb((db) => { db.sessions = db.sessions.filter((session) => session.tokenHash !== tokenHash) })
    }
    clearRefreshCookie(res)
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ user: publicUser(req.user) })
})

app.use('/api', authenticate)

function sanitizeSettings(input, existing) {
  const settings = { ...(existing || {}) }
  if (input.apiBaseUrl !== undefined) {
    settings.apiBaseUrl = typeof input.apiBaseUrl === 'string' ? input.apiBaseUrl.trim().replace(/\/$/, '') : ''
  }
  if (input.model !== undefined) {
    settings.model = typeof input.model === 'string' ? input.model.trim().slice(0, 80) : ''
  }
  if (input.temperature !== undefined) {
    const temp = Number(input.temperature)
    if (Number.isFinite(temp)) settings.temperature = Math.min(2, Math.max(0, temp))
  }
  if (input.maxTokens !== undefined) {
    const mt = Number(input.maxTokens)
    if (Number.isFinite(mt) && mt > 0) settings.maxTokens = Math.min(128000, Math.round(mt))
  }
  if (input.contextWindow !== undefined) {
    const cw = Number(input.contextWindow)
    if (Number.isFinite(cw) && cw > 0) settings.contextWindow = Math.min(1000000, Math.round(cw))
  }
  if (input.apiKey !== undefined && input.apiKey !== null && String(input.apiKey).trim()) {
    settings.apiKeyEnc = encryptSecret(String(input.apiKey).trim())
  }
  return settings
}

function publicSettings(settings) {
  if (!settings) return { apiBaseUrl: '', apiKeyMask: null, model: '', temperature: null, maxTokens: null, contextWindow: null }
  return {
    apiBaseUrl: settings.apiBaseUrl || '',
    apiKeyMask: maskKey(decryptSecret(settings.apiKeyEnc)),
    model: settings.model || '',
    temperature: settings.temperature ?? null,
    maxTokens: settings.maxTokens ?? null,
    contextWindow: settings.contextWindow ?? null,
  }
}

async function getUserModelConfig(user) {
  if (!user?.settings) return null
  const s = user.settings
  const apiKey = decryptSecret(s.apiKeyEnc)
  if (!apiKey && !process.env.OPENAI_API_KEY) return null
  return {
    apiBaseUrl: s.apiBaseUrl || undefined,
    apiKey,
    model: s.model || undefined,
    temperature: s.temperature ?? undefined,
    maxTokens: s.maxTokens ?? undefined,
    contextWindow: s.contextWindow ?? undefined,
  }
}

app.get('/api/settings', async (req, res, next) => {
  try {
    res.json({ settings: publicSettings(req.user.settings) })
  } catch (error) {
    next(error)
  }
})

app.put('/api/settings', async (req, res, next) => {
  try {
    const result = await updateDb((db) => {
      const user = db.users.find((item) => item.id === req.user.id)
      if (!user) throw Object.assign(new Error('账号不存在'), { status: 404 })
      user.settings = sanitizeSettings(req.body || {}, user.settings)
      return user.settings
    })
    res.json({ settings: publicSettings(result) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/ai/models', async (req, res, next) => {
  try {
    const s = req.user.settings || {}
    const apiKey = decryptSecret(s.apiKeyEnc)
    if (!apiKey) throw Object.assign(new Error('请先在设置中配置 API Key'), { status: 400 })
    const baseUrl = (s.apiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw Object.assign(new Error(`拉取模型列表失败（${response.status}）`), { status: 502 })
    }
    const data = await response.json().catch(() => null)
    const models = Array.isArray(data?.data) ? data.data.map((item) => item.id).filter(Boolean).sort() : []
    res.json({ models })
  } catch (error) {
    if (error.name === 'TimeoutError' || error.cause?.code === 'ECONNREFUSED') {
      next(Object.assign(new Error('模型服务暂不可用'), { status: 503 }))
      return
    }
    next(error)
  }
})

app.get('/api/ai/skills', async (req, res, next) => {
  try {
    const response = await fetch(`${aiServiceUrl}/v1/skills`, {
      headers: { 'x-service-token': aiServiceToken },
      signal: AbortSignal.timeout(15_000),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw Object.assign(new Error(payload?.detail || 'Skill 目录读取失败'), { status: response.status >= 500 ? 502 : response.status })
    res.json(payload)
  } catch (error) {
    if (error.name === 'TimeoutError' || error.cause?.code === 'ECONNREFUSED') {
      next(Object.assign(new Error('AI 服务暂不可用'), { status: 503 }))
      return
    }
    next(error)
  }
})

app.post('/api/ai/agent/runs', async (req, res, next) => {
  try {
    const message = cleanText(req.body?.message, '智能体指令', 4000)
    const skill = req.body?.skill === undefined || req.body?.skill === null ? null : cleanText(req.body.skill, 'Skill 名称', 80)
    if (skill && !/^[a-z0-9-]+$/.test(skill)) throw Object.assign(new Error('Skill 名称格式无效'), { status: 400 })
    const payload = req.body?.payload && typeof req.body.payload === 'object' && !Array.isArray(req.body.payload) ? req.body.payload : {}
    const modelConfig = await getUserModelConfig(req.user)
    const body = { message, skill, payload }
    if (modelConfig) body.model_config = modelConfig
    const response = await fetch(`${aiServiceUrl}/v1/agents/story`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': aiServiceToken },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    const result = await response.json().catch(() => null)
    if (!response.ok) throw Object.assign(new Error(result?.detail || 'Story Agent 处理失败'), { status: response.status >= 500 ? 502 : response.status })
    res.json(result)
  } catch (error) {
    if (error.name === 'TimeoutError' || error.cause?.code === 'ECONNREFUSED') {
      next(Object.assign(new Error('AI 服务暂不可用'), { status: 503 }))
      return
    }
    next(error)
  }
})

app.post('/api/ai/reviews/chapter', async (req, res, next) => {
  try {
    const title = cleanText(req.body?.title || '未命名章节', '章节标题', 120)
    const genre = cleanText(req.body?.genre || '网络小说', '题材', 40)
    const platform = cleanText(req.body?.platform || '通用网文', '目标平台', 40)
    const mode = req.body?.mode || 'full'
    if (!['full', 'lean', 'solo'].includes(mode)) throw Object.assign(new Error('审查模式无效'), { status: 400 })
    if (typeof req.body?.content !== 'string' || !req.body.content.trim()) {
      throw Object.assign(new Error('正文不能为空'), { status: 400 })
    }
    if (req.body.content.length > 500000) {
      throw Object.assign(new Error('单章正文不能超过 500,000 个字符'), { status: 400 })
    }
    const modelConfig = await getUserModelConfig(req.user)
    const reviewBody = { title, genre, platform, mode, content: req.body.content }
    if (modelConfig) reviewBody.model_config = modelConfig
    const response = await fetch(`${aiServiceUrl}/v1/reviews/chapter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': aiServiceToken },
      body: JSON.stringify(reviewBody),
      signal: AbortSignal.timeout(60_000),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const error = new Error(payload?.detail || 'AI 服务处理失败')
      error.status = response.status >= 500 ? 502 : response.status
      throw error
    }
    res.json(payload)
  } catch (error) {
    if (error.name === 'TimeoutError' || error.cause?.code === 'ECONNREFUSED') {
      next(Object.assign(new Error('AI 服务暂不可用'), { status: 503 }))
      return
    }
    next(error)
  }
})

app.get('/api/projects', async (req, res, next) => {
  try {
    const db = await loadDb()
    res.json({ projects: db.projects.filter((project) => project.userId === req.user.id) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/dashboard', async (req, res, next) => {
  try {
    const db = await loadDb()
    res.json({ stats: dashboardStats(db, req.user.id) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/projects/:projectId', async (req, res, next) => {
  try {
    const db = await loadDb()
    res.json({ project: findOr404(db, req.params.projectId, req.user.id) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/projects', async (req, res, next) => {
  try {
    const title = cleanText(req.body?.title, '作品名', 80)
    const type = cleanText(req.body?.type || '长篇', '篇幅', 20)
    const genre = cleanText(req.body?.genre || '现代言情', '题材', 30)
    const timestamp = new Date().toISOString()
    const project = {
      id: crypto.randomUUID(), userId: req.user.id, title, type, genre, status: '构思中', progress: 0, words: '0', updated: '刚刚', chapters: 0,
      tone: '等待你的第一笔设定', cover: 'cover-new', isActive: true, createdAt: timestamp, updatedAt: timestamp,
    }
    const result = await updateDb((db) => {
      db.projects = [project, ...db.projects.map((item) => item.userId === req.user.id ? { ...item, isActive: false } : item)]
      db.chapters[project.id] = []
      db.drafts[project.id] = {}
      createChapterRecord(db, project, '第一章')
      return project
    })
    res.status(201).json({ project: result })
  } catch (error) {
    next(error)
  }
})

app.post('/api/projects/import', async (req, res, next) => {
  try {
    const title = cleanText(req.body?.title, '作品名', 80)
    const type = cleanText(req.body?.type || '长篇', '篇幅', 20)
    const genre = cleanText(req.body?.genre || '未分类', '题材', 30)
    if (!Array.isArray(req.body?.chapters) || !req.body.chapters.length) {
      throw Object.assign(new Error('至少需要一个章节'), { status: 400 })
    }
    if (req.body.chapters.length > 500) {
      throw Object.assign(new Error('单次最多导入 500 个章节'), { status: 400 })
    }
    let totalCharacters = 0
    const importedChapters = req.body.chapters.map((chapter, index) => {
      const chapterTitle = cleanText(chapter?.title || `第 ${index + 1} 章`, '章节标题', 100)
      if (typeof chapter?.content !== 'string') throw Object.assign(new Error(`第 ${index + 1} 个章节正文必须是文本`), { status: 400 })
      if (chapter.content.length > 500_000) throw Object.assign(new Error(`《${chapterTitle}》正文不能超过 500,000 个字符`), { status: 400 })
      totalCharacters += chapter.content.length
      return { title: chapterTitle, content: chapter.content }
    })
    if (totalCharacters > 10_000_000) throw Object.assign(new Error('单次导入正文不能超过 10,000,000 个字符'), { status: 400 })

    const timestamp = new Date().toISOString()
    const project = {
      id: crypto.randomUUID(), userId: req.user.id, title, type, genre, status: '构思中', progress: 0, words: '0', updated: '刚刚', chapters: 0,
      tone: '由本地文稿导入，可继续补充设定与创作基调', cover: 'cover-new', isActive: true, createdAt: timestamp, updatedAt: timestamp,
    }
    const result = await updateDb((db) => {
      db.projects = [project, ...db.projects.map((item) => item.userId === req.user.id ? { ...item, isActive: false } : item)]
      db.chapters[project.id] = []
      db.drafts[project.id] = {}
      for (const imported of importedChapters) {
        const chapter = createChapterRecord(db, project, imported.title)
        db.drafts[project.id][String(chapter.id)] = imported.content
        chapter.words = formatWords(countWords(imported.content))
        chapter.updatedAt = timestamp
      }
      recalculateProject(db, project)
      touchProject(project, timestamp)
      return { project, chapters: db.chapters[project.id] }
    })
    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
})

app.patch('/api/projects/:projectId', async (req, res, next) => {
  try {
    const result = await updateDb((db) => {
      const project = findOr404(db, req.params.projectId, req.user.id)
      if (req.body.title !== undefined) project.title = cleanText(req.body.title, '作品名', 80)
      if (req.body.type !== undefined) project.type = cleanText(req.body.type, '篇幅', 20)
      if (req.body.genre !== undefined) project.genre = cleanText(req.body.genre, '题材', 30)
      if (req.body.status !== undefined) project.status = cleanText(req.body.status, '状态', 20)
      if (req.body.tone !== undefined) project.tone = cleanText(req.body.tone, '创作基调', 160)
      if (req.body.progress !== undefined) {
        const progress = Number(req.body.progress)
        if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw Object.assign(new Error('完成度必须在 0 到 100 之间'), { status: 400 })
        project.progress = Math.round(progress)
      }
      if (req.body.isActive === true) db.projects.forEach((item) => { if (item.userId === req.user.id) item.isActive = item.id === project.id })
      touchProject(project)
      return project
    })
    res.json({ project: result })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/projects/:projectId', async (req, res, next) => {
  try {
    await updateDb((db) => {
      findOr404(db, req.params.projectId, req.user.id)
      db.projects = db.projects.filter((project) => project.id !== req.params.projectId)
      delete db.chapters[req.params.projectId]
      delete db.drafts[req.params.projectId]
      db.ideas = db.ideas.filter((idea) => idea.projectId !== req.params.projectId)
      db.writingLog = db.writingLog.filter((entry) => entry.projectId !== req.params.projectId)
    })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.get('/api/projects/:projectId/chapters', async (req, res, next) => {
  try {
    const db = await loadDb()
    findOr404(db, req.params.projectId, req.user.id)
    res.json({ chapters: db.chapters[req.params.projectId] || [] })
  } catch (error) {
    next(error)
  }
})

app.post('/api/projects/:projectId/chapters', async (req, res, next) => {
  try {
    const title = cleanText(req.body?.title, '章节标题', 100)
    const result = await updateDb((db) => {
      const project = findOr404(db, req.params.projectId, req.user.id)
      return createChapterRecord(db, project, title)
    })
    res.status(201).json({ chapter: result })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/projects/:projectId/chapters/:chapterId', async (req, res, next) => {
  try {
    const result = await updateDb((db) => {
      const project = findOr404(db, req.params.projectId, req.user.id)
      const chapter = (db.chapters[project.id] || []).find((item) => String(item.id) === req.params.chapterId)
      if (!chapter) throw Object.assign(new Error('章节不存在'), { status: 404 })
      if (req.body.title !== undefined) chapter.title = cleanText(req.body.title, '章节标题', 100)
      if (req.body.state !== undefined) chapter.state = cleanText(req.body.state, '章节状态', 20)
      chapter.updatedAt = new Date().toISOString()
      touchProject(project, chapter.updatedAt)
      return chapter
    })
    res.json({ chapter: result })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/projects/:projectId/chapters/:chapterId', async (req, res, next) => {
  try {
    await updateDb((db) => {
      const project = findOr404(db, req.params.projectId, req.user.id)
      const chapters = db.chapters[project.id] || []
      if (chapters.length <= 1) throw Object.assign(new Error('每个作品至少保留一个章节'), { status: 400 })
      const chapterIndex = chapters.findIndex((item) => String(item.id) === req.params.chapterId)
      if (chapterIndex === -1) throw Object.assign(new Error('章节不存在'), { status: 404 })
      const [deleted] = chapters.splice(chapterIndex, 1)
      const drafts = draftMapFor(db, project.id)
      delete drafts[String(deleted.id)]
      db.writingLog = db.writingLog.filter((entry) => !(entry.projectId === project.id && String(entry.chapterId) === String(deleted.id)))
      recalculateProject(db, project)
      touchProject(project)
    })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.get('/api/projects/:projectId/draft', async (req, res, next) => {
  try {
    const db = await loadDb()
    const project = findOr404(db, req.params.projectId, req.user.id)
    const chapters = db.chapters[project.id] || []
    const chapter = chapters.find((item) => item.state === 'current') || chapters.at(-1) || chapters[0]
    const drafts = draftMapFor(db, project.id)
    res.json({ content: chapter ? drafts[String(chapter.id)] || '' : drafts.__legacy || '', chapter: chapter || null })
  } catch (error) {
    next(error)
  }
})

app.put('/api/projects/:projectId/draft', async (req, res, next) => {
  try {
    if (typeof req.body?.content !== 'string') throw Object.assign(new Error('正文必须是文本'), { status: 400 })
    if (req.body.content.length > 500000) throw Object.assign(new Error('单章正文不能超过 500,000 个字符'), { status: 400 })
    const result = await updateDb((db) => {
      const project = findOr404(db, req.params.projectId, req.user.id)
      const chapters = db.chapters[project.id] || []
      const chapter = chapters.find((item) => item.state === 'current') || chapters.at(-1) || createChapterRecord(db, project, '第一章')
      return { ...saveChapterContent(db, project, chapter, req.body.content, req.user.id), stats: dashboardStats(db, req.user.id) }
    })
    res.json(result)
  } catch (error) {
    next(error)
  }
})

app.get('/api/projects/:projectId/chapters/:chapterId/draft', async (req, res, next) => {
  try {
    const db = await loadDb()
    const project = findOr404(db, req.params.projectId, req.user.id)
    const chapter = chapterOr404(db, project, req.params.chapterId)
    const drafts = draftMapFor(db, project.id)
    res.json({ content: drafts[String(chapter.id)] || '', chapter })
  } catch (error) {
    next(error)
  }
})

app.put('/api/projects/:projectId/chapters/:chapterId/draft', async (req, res, next) => {
  try {
    if (typeof req.body?.content !== 'string') throw Object.assign(new Error('正文必须是文本'), { status: 400 })
    if (req.body.content.length > 500000) throw Object.assign(new Error('单章正文不能超过 500,000 个字符'), { status: 400 })
    const result = await updateDb((db) => {
      const project = findOr404(db, req.params.projectId, req.user.id)
      const chapter = chapterOr404(db, project, req.params.chapterId)
      return { ...saveChapterContent(db, project, chapter, req.body.content, req.user.id), stats: dashboardStats(db, req.user.id) }
    })
    res.json(result)
  } catch (error) {
    next(error)
  }
})

app.get('/api/ideas', async (req, res, next) => {
  try {
    const db = await loadDb()
    const ideas = db.ideas
      .filter((idea) => idea.userId === req.user.id)
      .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))
    res.json({ ideas })
  } catch (error) {
    next(error)
  }
})

app.post('/api/ideas', async (req, res, next) => {
  try {
    const title = cleanText(req.body?.title, '灵感标题', 160)
    const body = cleanText(req.body?.body || '记录下此刻的想法。', '灵感内容', 10000)
    const projectId = req.body?.projectId || null
    const timestamp = new Date().toISOString()
    const idea = {
      id: crypto.randomUUID(), userId: req.user.id, label: cleanText(req.body?.label || '灵感', '灵感类型', 20), title, body,
      color: ['coral', 'teal', 'yellow', 'purple'][Math.floor(Math.random() * 4)], projectId,
      folder: req.body?.folder ? cleanText(req.body.folder, '素材目录', 40) : '未分类', tags: cleanTags(req.body?.tags), pinned: req.body?.pinned === true,
      createdAt: timestamp, updatedAt: timestamp,
    }
    const result = await updateDb((db) => {
      if (projectId) findOr404(db, projectId, req.user.id)
      db.ideas = [idea, ...db.ideas]
      return idea
    })
    res.status(201).json({ idea: result })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/ideas/:ideaId', async (req, res, next) => {
  try {
    const result = await updateDb((db) => {
      const idea = db.ideas.find((item) => item.id === req.params.ideaId && item.userId === req.user.id)
      if (!idea) throw Object.assign(new Error('灵感不存在'), { status: 404 })
      if (req.body.title !== undefined) idea.title = cleanText(req.body.title, '灵感标题', 160)
      if (req.body.body !== undefined) idea.body = cleanText(req.body.body, '灵感内容', 10000)
      if (req.body.label !== undefined) idea.label = cleanText(req.body.label, '灵感类型', 20)
      if (req.body.folder !== undefined) idea.folder = req.body.folder ? cleanText(req.body.folder, '素材目录', 40) : '未分类'
      if (req.body.tags !== undefined) idea.tags = cleanTags(req.body.tags)
      if (req.body.pinned !== undefined) idea.pinned = req.body.pinned === true
      if (req.body.projectId !== undefined) {
        const projectId = req.body.projectId || null
        if (projectId) findOr404(db, projectId, req.user.id)
        idea.projectId = projectId
      }
      idea.updatedAt = new Date().toISOString()
      return idea
    })
    res.json({ idea: result })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/ideas/:ideaId', async (req, res, next) => {
  try {
    await updateDb((db) => {
      const exists = db.ideas.some((item) => item.id === req.params.ideaId && item.userId === req.user.id)
      if (!exists) throw Object.assign(new Error('灵感不存在'), { status: 404 })
      db.ideas = db.ideas.filter((idea) => idea.id !== req.params.ideaId)
    })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.use('/api', (_req, res) => {
  res.status(404).json({ error: '接口不存在' })
})

app.use(express.static(distDir))
app.use((req, res, next) => {
  if (req.method === 'GET' && req.accepts('html')) {
    res.sendFile(path.join(distDir, 'index.html'))
    return
  }
  next()
})

app.use((error, _req, res, _next) => {
  const status = Number.isInteger(error.status) ? error.status : 500
  if (status >= 500) console.error(error)
  res.status(status).json({ error: status >= 500 ? '服务器内部错误' : error.message })
})

const server = app.listen(port, host, () => {
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  console.log(`Story API listening on http://${host}:${actualPort}`)
  console.log(`Data file: ${path.join(serverDir, 'data', 'db.json')}`)
  if (usesDefaultSecret) console.warn('AUTH_SECRET is not set; use a strong secret in production.')
})
