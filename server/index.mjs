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
import { countWords, findProject, formatWords, loadDb, storeInfo, updateDb } from './store.mjs'
import * as chatMemory from './chat-memory.mjs'

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
const PROJECT_TYPES = new Set(['长篇', '短篇', '参考书'])
const PROJECT_STATUSES = new Set(['构思中', '连载中', '已完结', '已拆文'])
const CHAPTER_STATES = new Set(['draft', 'current', 'done'])
const FORESHADOW_STATUSES = new Set(['planned', 'planted', 'resolved', 'abandoned'])
const STORY_MEMORY_TYPES = new Set(['character_state', 'event', 'world_rule', 'chapter_summary', 'canon_fact', 'voice_habit'])
const STORY_MEMORY_STATUSES = new Set(['active', 'archived'])
const STORY_MEMORY_ORDER = new Map(['canon_fact', 'world_rule', 'character_state', 'voice_habit', 'event', 'chapter_summary'].map((type, index) => [type, index]))
const WRITING_REQUIREMENTS = ['type', 'genre', 'style', 'premise']
const GENRE_SUGGESTIONS = ['现代言情', '古代言情', '东方玄幻', '悬疑推理', '都市现实', '科幻末世', '历史架空']
const STYLE_SUGGESTIONS = ['逆袭打脸', '重生复仇', '甜宠拉扯', '克苏鲁悬疑', '群像成长', '职场现实', '无限流']
const writingTaskControllers = new Map()

function isCodespacesOrigin(origin) {
  if (process.env.CODESPACES !== 'true' || !process.env.CODESPACE_NAME) return false
  try {
    const url = new URL(origin)
    const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'
    return url.protocol === 'https:'
      && url.hostname.startsWith(`${process.env.CODESPACE_NAME}-`)
      && url.hostname.endsWith(`.${domain}`)
  } catch {
    return false
  }
}

app.disable('x-powered-by')
app.use(helmet({ contentSecurityPolicy: false }))
app.use((req, res, next) => {
  const origin = req.get('origin')
  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim()
  const ownOrigin = `${forwardedProto || req.protocol}://${forwardedHost || req.get('host')}`
  if (!origin || origin === ownOrigin || allowedOrigins.includes(origin) || isCodespacesOrigin(origin)) {
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

function cleanEnum(value, field, allowedValues) {
  const text = cleanText(value, field, 20)
  if (!allowedValues.has(text)) {
    throw Object.assign(new Error(`${field}无效，可选值：${[...allowedValues].join('、')}`), { status: 400 })
  }
  return text
}

function cleanOptionalText(value, field, maxLength) {
  if (value == null || value === '') return ''
  if (typeof value !== 'string') throw Object.assign(new Error(`${field} 必须是文本`), { status: 400 })
  const text = value.trim()
  if (text.length > maxLength) throw Object.assign(new Error(`${field} 不能超过 ${maxLength} 个字符`), { status: 400 })
  return text
}

function cleanIntegerRange(value, field, min, max, fallback = null) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw Object.assign(new Error(`${field}必须是 ${min} 到 ${max} 之间的整数`), { status: 400 })
  }
  return number
}

function cleanModelBaseUrl(value) {
  if (value == null || value === '') return ''
  if (typeof value !== 'string') throw Object.assign(new Error('API Base URL 必须是文本'), { status: 400 })
  const text = value.trim().replace(/\/$/, '')
  if (!text) return ''
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw Object.assign(new Error('API Base URL 格式不正确'), { status: 400 })
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw Object.assign(new Error('API Base URL 仅支持不带认证信息的 HTTP/HTTPS 地址'), { status: 400 })
  }
  return text
}

function isNetworkError(error) {
  return error?.name === 'TimeoutError'
    || error?.name === 'TypeError'
    || ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(error?.cause?.code)
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

function recordEditSnapshot(db, projectId, chapterId, content, timestamp = new Date().toISOString()) {
  db.editHistory[projectId] ||= {}
  const key = String(chapterId)
  const snapshots = db.editHistory[projectId][key] ||= []
  const latest = snapshots.at(-1)
  if (latest?.content === content) return { snapshot: latest, duplicate: true }
  const snapshot = { id: crypto.randomUUID(), content, words: countWords(content), createdAt: timestamp }
  snapshots.push(snapshot)
  db.editHistory[projectId][key] = snapshots.slice(-80)
  return { snapshot, duplicate: false }
}

function saveChapterContent(db, project, chapter, content, userId) {
  const drafts = draftMapFor(db, project.id)
  const key = String(chapter.id)
  const previous = typeof drafts[key] === 'string' ? drafts[key] : ''
  const previousWords = countWords(previous)
  const nextWords = countWords(content)
  const timestamp = new Date().toISOString()
  if (previous && previous !== content) recordEditSnapshot(db, project.id, chapter.id, previous, timestamp)
  drafts[key] = content
  delete drafts.__legacy
  chapter.words = formatWords(nextWords)
  chapter.updatedAt = timestamp
  touchProject(project, timestamp)
  recalculateProject(db, project)
  recordWriting(db, { userId, projectId: project.id, chapterId: chapter.id, delta: Math.max(0, nextWords - previousWords), timestamp })
  return { content, chapter, project }
}

function cleanStoryMemoryInput(input, { partial = false } = {}) {
  const memory = {}
  if (!partial || input?.type !== undefined) memory.type = cleanEnum(input?.type, '记忆类型', STORY_MEMORY_TYPES)
  if (!partial || input?.title !== undefined) memory.title = cleanText(input?.title, '记忆标题', 160)
  if (!partial || input?.content !== undefined) memory.content = cleanText(input?.content, '记忆内容', 4000)
  if (!partial || input?.status !== undefined) memory.status = cleanEnum(input?.status || 'active', '记忆状态', STORY_MEMORY_STATUSES)
  if (!partial || input?.importance !== undefined) memory.importance = cleanIntegerRange(input?.importance, '记忆重要性', 1, 5, 3)
  if (!partial || input?.characterName !== undefined) memory.characterName = cleanOptionalText(input?.characterName, '角色名', 80)
  if (!partial || input?.tags !== undefined) memory.tags = cleanTags(input?.tags)
  return memory
}

function createStoryMemoryRecord(db, userId, project, input, timestamp = new Date().toISOString()) {
  const values = cleanStoryMemoryInput(input)
  const sourceChapterId = input?.sourceChapterId == null || input?.sourceChapterId === ''
    ? null
    : String(chapterOr404(db, project, input.sourceChapterId).id)
  return {
    id: crypto.randomUUID(), userId, projectId: project.id, ...values, sourceChapterId,
    createdAt: timestamp, updatedAt: timestamp,
  }
}

function contextExcerpt(value, maxLength = 1600) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.floor(maxLength * 0.35))}\n…\n${text.slice(-Math.floor(maxLength * 0.65))}`
}

function buildWritingContext(db, project, chapter) {
  const chapters = db.chapters[project.id] || []
  const chapterIndex = chapters.findIndex((item) => String(item.id) === String(chapter.id))
  const drafts = draftMapFor(db, project.id)
  const previousChapters = chapters
    .slice(Math.max(0, chapterIndex - 6), chapterIndex)
    .map((item) => ({
      id: item.id,
      title: item.title,
      outline: contextExcerpt(item.outline, 900),
      ending: contextExcerpt(drafts[String(item.id)], 1200).slice(-1200),
    }))
  const materials = db.ideas
    .filter((idea) => idea.userId === project.userId && (!idea.projectId || idea.projectId === project.id))
    .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, 20)
    .map((idea) => ({ label: idea.label, title: idea.title, body: contextExcerpt(idea.body, 500), tags: idea.tags || [] }))
  const unresolvedForeshadows = db.foreshadows
    .filter((item) => item.userId === project.userId && item.projectId === project.id && !['resolved', 'abandoned'].includes(item.status))
    .sort((left, right) => Number(right.importance || 0) - Number(left.importance || 0))
    .slice(0, 20)
    .map((item) => ({ title: item.title, content: contextExcerpt(item.content, 700), status: item.status, targetChapterId: item.targetChapterId || null }))
  const storyMemory = db.storyMemories
    .filter((item) => item.userId === project.userId && item.projectId === project.id && item.status !== 'archived')
    .sort((left, right) => (STORY_MEMORY_ORDER.get(left.type) ?? 99) - (STORY_MEMORY_ORDER.get(right.type) ?? 99)
      || Number(right.importance || 0) - Number(left.importance || 0)
      || String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, 60)
    .map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      content: contextExcerpt(item.content, 900),
      importance: item.importance || 3,
      characterName: item.characterName || '',
      sourceChapterId: item.sourceChapterId || null,
      tags: item.tags || [],
    }))
  return {
    version: 2,
    project: { id: project.id, title: project.title, type: project.type, genre: project.genre, style: project.style || '', premise: project.tone || '' },
    chapter: { id: chapter.id, title: chapter.title, outline: contextExcerpt(chapter.outline, 2400), state: chapter.state },
    previousChapters,
    storyMemory,
    materials,
    unresolvedForeshadows,
  }
}

function createChapterRecord(db, project, title) {
  const chapters = db.chapters[project.id] || []
  const timestamp = new Date().toISOString()
  const chapter = {
    id: chapters.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1,
    title,
    outline: '',
    words: '0',
    state: 'draft',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  db.chapters[project.id] = [...chapters, chapter]
  const drafts = draftMapFor(db, project.id)
  drafts[String(chapter.id)] = chapters.length === 0 && typeof drafts.__legacy === 'string' ? drafts.__legacy : ''
  db.editHistory[project.id] ||= {}
  db.editHistory[project.id][String(chapter.id)] ||= []
  delete drafts.__legacy
  recalculateProject(db, project)
  touchProject(project, timestamp)
  return chapter
}

function createProjectBase({ userId, title, type, genre, style = '', tone, timestamp }) {
  return {
    id: crypto.randomUUID(), userId, title, type, genre, status: '构思中', progress: 0, words: '0', updated: '刚刚', chapters: 0,
    style, tone, cover: 'cover-new', isActive: true, createdAt: timestamp, updatedAt: timestamp,
  }
}

function emptyWritingRequirements() {
  return { type: '', genre: '', style: '', premise: '', platform: '', title: '' }
}

function createWritingSession(userId) {
  const timestamp = new Date().toISOString()
  return {
    id: crypto.randomUUID(), userId, phase: 'collecting_requirements', messages: [],
    requirements: emptyWritingRequirements(), proposal: null, selectedSkill: null, questions: [], lastResult: null, projectId: null,
    createdAt: timestamp, updatedAt: timestamp,
  }
}

function writingSessionPublic(session) {
  if (!session) return null
  return {
    id: session.id, phase: session.phase, messages: session.messages || [],
    requirements: { ...emptyWritingRequirements(), ...(session.requirements || {}) },
    proposal: session.proposal || null, selectedSkill: session.selectedSkill || null,
    questions: Array.isArray(session.questions) ? session.questions : [], lastResult: session.lastResult || null,
    projectId: session.projectId || null, createdAt: session.createdAt, updatedAt: session.updatedAt,
  }
}

function appendWritingMessage(session, role, text) {
  const message = { id: crypto.randomUUID(), role, text, createdAt: new Date().toISOString() }
  session.messages = [...(session.messages || []), message].slice(-20)
  session.updatedAt = message.createdAt
  return message
}

async function loadWritingSession(userId) {
  const fromRedis = await chatMemory.getSession(userId)
  if (fromRedis) return fromRedis
  const db = await loadDb()
  const dbSession = db.writingSessions[userId]
  if (!dbSession) return null
  const normalized = chatMemory.normalizeWritingSession(dbSession, userId) || dbSession
  if (chatMemory.isRedisEnabled()) void chatMemory.setSession(userId, normalized)
  return normalized
}

async function saveWritingSession(userId, session) {
  if (chatMemory.isRedisEnabled()) await chatMemory.setSession(userId, session)
  await updateDb((db) => {
    db.writingSessions[userId] = session
  })
}

async function deleteWritingSession(userId) {
  await chatMemory.deleteSession(userId)
  await updateDb((db) => { delete db.writingSessions[userId] })
}

function mergeWritingRequirements(current, message) {
  const requirements = { ...emptyWritingRequirements(), ...(current || {}) }
  const text = message.trim()
  const expected = missingWritingRequirements(requirements)[0]
  if (!requirements.type) {
    if (/短篇/.test(text)) requirements.type = '短篇'
    else if (/长篇/.test(text)) requirements.type = '长篇'
  }
  if (!requirements.genre) {
    const suggestion = GENRE_SUGGESTIONS.find((item) => text.includes(item))
    if (suggestion) requirements.genre = suggestion
  }
  if (!requirements.style) {
    const suggestion = STYLE_SUGGESTIONS.find((item) => text.includes(item))
    if (suggestion) requirements.style = suggestion
  }
  if (expected === 'genre' && !requirements.genre) requirements.genre = text.slice(0, 30)
  if (expected === 'style' && !requirements.style) requirements.style = text.slice(0, 80)
  if (!requirements.platform) {
    const platform = text.match(/(?:平台|发布|发在)\s*[:：]?\s*(番茄|起点|知乎盐言|晋江|通用网文)/)?.[1]
    if (platform) requirements.platform = platform
  }
  if (expected === 'premise' && !requirements.premise) {
    requirements.premise = text.slice(0, 2000)
  }
  return requirements
}

function missingWritingRequirements(requirements) {
  return WRITING_REQUIREMENTS.filter((field) => !String(requirements?.[field] || '').trim())
}

function writingQuestion(missing) {
  const questions = {
    type: '你想写短篇还是长篇？也可以直接说预计篇幅。',
    genre: `想写什么题材？例如：${GENRE_SUGGESTIONS.slice(0, 5).join('、')}。`,
    style: `想采用什么流派或核心爽点？例如：${STYLE_SUGGESTIONS.slice(0, 5).join('、')}，也可以自由描述。`,
    premise: '故事的核心设定是什么？用一两句话告诉我主角、目标和主要冲突即可。',
  }
  return questions[missing[0]] || '再告诉我一点你想写的故事。'
}

function validateSmartProposal(input, defaultType = '长篇') {
  const title = cleanText(input?.title, '作品名', 80)
  const type = cleanEnum(input?.type || defaultType, '篇幅', PROJECT_TYPES)
  const genre = cleanText(input?.genre, '题材', 30)
  const style = cleanOptionalText(input?.style, '流派', 80)
  const tone = cleanText(input?.tone || input?.premise, '故事主线', 2000)
  if (!Array.isArray(input?.chapters) || !input.chapters.length) throw Object.assign(new Error('智能创建结果至少需要一个章节大纲'), { status: 400 })
  if (input.chapters.length > 100) throw Object.assign(new Error('智能创建结果最多包含 100 个章节'), { status: 400 })
  const chapters = input.chapters.map((chapter, index) => ({
    title: cleanText(chapter?.title || `第 ${index + 1} 章`, '章节标题', 100),
    content: cleanText(chapter?.content, '章节大纲', 5000),
  }))
  return { title, type, genre, style, tone, chapters }
}

function createProjectWithOutline(db, { userId, proposal, timestamp = new Date().toISOString() }) {
  const project = createProjectBase({ userId, title: proposal.title, type: proposal.type, genre: proposal.genre, style: proposal.style, tone: proposal.tone, timestamp })
  db.projects = [project, ...db.projects.map((item) => item.userId === userId ? { ...item, isActive: false } : item)]
  db.chapters[project.id] = []
  db.drafts[project.id] = {}
  db.editHistory[project.id] = {}
  for (const item of proposal.chapters) {
    const chapter = createChapterRecord(db, project, item.title)
    chapter.outline = item.content
    chapter.updatedAt = timestamp
  }
  recalculateProject(db, project)
  touchProject(project, timestamp)
  return { project, chapters: db.chapters[project.id] }
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
    res.json({ ok: true, users: db.users.length, projects: db.projects.length, storage: storeInfo() })
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
          words: '0', updated: '刚刚', chapters: 0, style: '', tone: '等待你的第一笔设定', cover: 'cover-new', isActive: true, createdAt: timestamp, updatedAt: timestamp,
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
    settings.apiBaseUrl = cleanModelBaseUrl(input.apiBaseUrl)
  }
  if (input.provider !== undefined) {
    settings.provider = input.provider === 'anthropic' ? 'anthropic' : 'openai'
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
  if (!settings) return { provider: 'openai', apiBaseUrl: '', apiKeyMask: null, model: '', temperature: null, maxTokens: null, contextWindow: null }
  return {
    provider: settings.provider === 'anthropic' ? 'anthropic' : 'openai',
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
  return {
    provider: s.provider === 'anthropic' ? 'anthropic' : 'openai',
    api_base_url: s.apiBaseUrl || undefined,
    api_key: apiKey || undefined,
    model: s.model || undefined,
    temperature: s.temperature ?? undefined,
    max_tokens: s.maxTokens ?? undefined,
    context_window: s.contextWindow ?? undefined,
  }
}

function validateStoryAgentInput(input) {
  const message = cleanText(input?.message, '智能体指令', 4000)
  const skill = input?.skill === undefined || input?.skill === null ? null : cleanText(input.skill, 'Skill 名称', 80)
  if (skill && !/^[a-z0-9-]+$/.test(skill)) throw Object.assign(new Error('Skill 名称格式无效'), { status: 400 })
  const payload = input?.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {}
  if (JSON.stringify(payload).length > 1_000_000) throw Object.assign(new Error('智能体上下文不能超过 1,000,000 个字符'), { status: 400 })
  return { message, skill, payload }
}

async function enrichStoryAgentPayload(userId, payload) {
  const projectId = payload.project_id || payload.projectId
  const chapterId = payload.chapter_id || payload.chapterId
  if (!projectId) return payload
  const db = await loadDb()
  const project = findOr404(db, projectId, userId)
  const chapter = chapterId ? chapterOr404(db, project, chapterId) : null
  const writingContext = chapter
    ? buildWritingContext(db, project, chapter)
    : { version: 1, project: { id: project.id, title: project.title, type: project.type, genre: project.genre, style: project.style || '', premise: project.tone || '' } }
  return { ...payload, writing_context: writingContext }
}

async function invokeStoryAgent(user, input, signal = AbortSignal.timeout(120_000)) {
  const validated = validateStoryAgentInput(input)
  const payload = await enrichStoryAgentPayload(user.id, validated.payload)
  const modelConfig = await getUserModelConfig(user)
  const body = { message: validated.message, skill: validated.skill, payload }
  if (modelConfig) body.model_config = modelConfig
  const response = await fetch(`${aiServiceUrl}/v1/agents/story`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-token': aiServiceToken },
    body: JSON.stringify(body),
    signal,
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) throw Object.assign(new Error(result?.detail || 'Story Agent 处理失败'), { status: response.status >= 500 ? 502 : response.status })
  return result
}

function taskRequestKey(userId, input, idempotencyKey = '') {
  const stable = JSON.stringify({ userId, skill: input.skill || null, message: input.message, payload: input.payload })
  return crypto.createHash('sha256').update(idempotencyKey ? `${userId}:${idempotencyKey}` : stable).digest('hex')
}

function classifyTaskError(error, cancelled = false) {
  if (cancelled) return { errorCode: 'cancelled', retryable: true, message: '任务已取消，可重新提交' }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { errorCode: 'timeout', retryable: true, message: '模型响应超时，可重试此任务' }
  if (isNetworkError(error) || error?.status === 502 || error?.status === 503) return { errorCode: 'service_unavailable', retryable: true, message: 'AI 服务暂不可用，可稍后重试' }
  if (error?.status === 400 && /模型|API Key|密钥|model/i.test(error?.message || '')) return { errorCode: 'model_config', retryable: false, message: '模型配置无效，请在设置中检查地址、密钥和模型名' }
  if (/上下文|字符|token|length/i.test(error?.message || '')) return { errorCode: 'context_too_large', retryable: false, message: '输入上下文过长，请缩短正文或素材后重试' }
  return { errorCode: 'unknown', retryable: true, message: error?.message || 'AI Skill 执行失败' }
}

function createWritingTask({ userId, input, requestKey, parentTaskId = null, attempt = 1 }) {
  const projectId = input.payload.project_id || input.payload.projectId || null
  const chapterId = input.payload.chapter_id || input.payload.chapterId || null
  const timestamp = new Date().toISOString()
  return {
    id: crypto.randomUUID(), userId, projectId, chapterId: chapterId == null ? null : String(chapterId),
    skill: input.skill, message: input.message, input, requestKey, parentTaskId, attempt,
    status: 'queued', progress: 0, statusMessage: attempt > 1 ? `重试任务已排队（第 ${attempt} 次）` : '任务已排队',
    result: null, error: null, errorCode: null, retryable: false, cancelRequested: false,
    createdAt: timestamp, updatedAt: timestamp,
  }
}

function writingTaskPublic(task) {
  return {
    id: task.id, userId: task.userId, projectId: task.projectId || null, chapterId: task.chapterId || null,
    skill: task.skill || null, message: task.message, status: task.status, progress: task.progress || 0,
    statusMessage: task.statusMessage || '', result: task.result || null, error: task.error || null,
    errorCode: task.errorCode || null, retryable: task.retryable === true, attempt: task.attempt || 1,
    parentTaskId: task.parentTaskId || null, reused: task.reused === true,
    cancelRequested: task.cancelRequested === true, createdAt: task.createdAt, updatedAt: task.updatedAt,
  }
}

async function executeWritingTask(taskId, userId) {
  const controller = new AbortController()
  writingTaskControllers.set(taskId, controller)
  try {
    const prepared = await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId && item.userId === userId)
      const user = db.users.find((item) => item.id === userId)
      if (!task || !user || task.status === 'cancelled' || task.cancelRequested) return null
      task.status = 'running'
      task.progress = 15
      task.statusMessage = '正在构建写作上下文'
      task.updatedAt = new Date().toISOString()
      return { input: task.input, user }
    })
    if (!prepared) return
    await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId)
      if (task && task.status === 'running') {
        task.progress = 35
        task.statusMessage = '正在执行 AI Skill'
        task.updatedAt = new Date().toISOString()
      }
    })
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    const result = await invokeStoryAgent(prepared.user, prepared.input, signal)
    await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId)
      if (!task || task.status === 'cancelled' || task.cancelRequested) return
      task.status = 'completed'
      task.progress = 100
      task.statusMessage = 'AI Skill 执行完成'
      task.result = result
      task.updatedAt = new Date().toISOString()
    })
  } catch (error) {
    await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId)
      if (!task) return
      const classified = classifyTaskError(error, controller.signal.aborted || task.cancelRequested)
      if (classified.errorCode === 'cancelled') {
        task.status = 'cancelled'
        task.statusMessage = classified.message
      } else {
        task.status = 'failed'
        task.statusMessage = classified.message
        task.error = classified.message
      }
      task.errorCode = classified.errorCode
      task.retryable = classified.retryable
      task.updatedAt = new Date().toISOString()
    }).catch(() => undefined)
  } finally {
    writingTaskControllers.delete(taskId)
  }
}

async function requestWritingAssistantTurn(user, session, message, skill = null, payload = {}) {
  const modelConfig = await getUserModelConfig(user)
  const body = {
    message,
    messages: (session.messages || []).map(({ role, text }) => ({ role, text })),
    requirements: session.requirements || emptyWritingRequirements(),
    skill: skill || undefined,
    payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {},
  }
  if (modelConfig) body.model_config = modelConfig
  const response = await fetch(`${aiServiceUrl}/v1/assistants/writing/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-token': aiServiceToken },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) throw Object.assign(new Error(result?.detail || '写作助手处理失败'), { status: response.status >= 500 ? 502 : response.status })
  return result
}

async function requestWritingProposal(user, session) {
  const modelConfig = await getUserModelConfig(user)
  const body = {
    requirements: session.requirements,
    messages: (session.messages || []).map(({ role, text }) => ({ role, text })),
  }
  if (modelConfig) body.model_config = modelConfig
  const response = await fetch(`${aiServiceUrl}/v1/assistants/writing/proposal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-token': aiServiceToken },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw Object.assign(new Error(payload?.detail || '写作助手生成方案失败'), { status: response.status >= 500 ? 502 : response.status })
  return payload
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
    const provider = s.provider === 'anthropic' ? 'anthropic' : 'openai'
    let models = []
    if (provider === 'anthropic') {
      const baseUrl = (s.apiBaseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '')
      const response = await fetch(`${baseUrl}/models`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw Object.assign(new Error(`拉取模型列表失败（${response.status}）`), { status: 502 })
      const data = await response.json().catch(() => null)
      models = Array.isArray(data?.data) ? data.data.map((item) => item.id).filter(Boolean).sort() : []
    } else {
      const baseUrl = (s.apiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
      const response = await fetch(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw Object.assign(new Error(`拉取模型列表失败（${response.status}）`), { status: 502 })
      const data = await response.json().catch(() => null)
      models = Array.isArray(data?.data) ? data.data.map((item) => item.id).filter(Boolean).sort() : []
    }
    res.json({ models })
  } catch (error) {
    if (isNetworkError(error)) {
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
    if (isNetworkError(error)) {
      next(Object.assign(new Error('AI 服务暂不可用'), { status: 503 }))
      return
    }
    next(error)
  }
})

app.post('/api/ai/agent/runs', async (req, res, next) => {
  try {
    res.json(await invokeStoryAgent(req.user, req.body || {}))
  } catch (error) {
    if (isNetworkError(error)) {
      next(Object.assign(new Error('AI 服务暂不可用'), { status: 503 }))
      return
    }
    next(error)
  }
})

app.get('/api/ai/tasks', async (req, res, next) => {
  try {
    const db = await loadDb()
    const projectId = req.query.projectId ? String(req.query.projectId) : ''
    if (projectId) findOr404(db, projectId, req.user.id)
    const tasks = db.writingTasks
      .filter((task) => task.userId === req.user.id && (!projectId || task.projectId === projectId))
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
      .slice(0, 50)
      .map(writingTaskPublic)
    res.json({ tasks })
  } catch (error) {
    next(error)
  }
})

app.get('/api/ai/tasks/:taskId', async (req, res, next) => {
  try {
    const db = await loadDb()
    const task = db.writingTasks.find((item) => item.id === req.params.taskId && item.userId === req.user.id)
    if (!task) throw Object.assign(new Error('AI 任务不存在'), { status: 404 })
    res.json({ task: writingTaskPublic(task) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/ai/tasks', async (req, res, next) => {
  try {
    const input = validateStoryAgentInput(req.body || {})
    const projectId = input.payload.project_id || input.payload.projectId || null
    const chapterId = input.payload.chapter_id || input.payload.chapterId || null
    if (projectId) {
      const db = await loadDb()
      const project = findOr404(db, projectId, req.user.id)
      if (chapterId) chapterOr404(db, project, chapterId)
    }
    const idempotencyKey = cleanOptionalText(req.body?.idempotencyKey, '幂等键', 160)
    const requestKey = taskRequestKey(req.user.id, input, idempotencyKey)
    let reused = null
    const task = await updateDb((db) => {
      const existing = db.writingTasks.find((item) => item.userId === req.user.id && item.requestKey === requestKey && ['queued', 'running'].includes(item.status))
      if (existing) {
        reused = existing
        return existing
      }
      const created = createWritingTask({ userId: req.user.id, input, requestKey })
      db.writingTasks = [created, ...db.writingTasks].slice(0, 500)
      return created
    })
    if (!reused) queueMicrotask(() => { void executeWritingTask(task.id, req.user.id) })
    res.status(reused ? 200 : 202).json({ task: { ...writingTaskPublic(task), reused: Boolean(reused) } })
  } catch (error) {
    next(error)
  }
})

app.post('/api/ai/tasks/:taskId/retry', async (req, res, next) => {
  try {
    const task = await updateDb((db) => {
      const original = db.writingTasks.find((item) => item.id === req.params.taskId && item.userId === req.user.id)
      if (!original) throw Object.assign(new Error('AI 任务不存在'), { status: 404 })
      if (!['failed', 'cancelled'].includes(original.status)) throw Object.assign(new Error('只有失败或已取消任务可以重试'), { status: 409 })
      const existing = db.writingTasks.find((item) => item.parentTaskId === original.id && ['queued', 'running'].includes(item.status))
      if (existing) return existing
      const created = createWritingTask({
        userId: req.user.id,
        input: original.input,
        requestKey: `${original.requestKey || taskRequestKey(req.user.id, original.input)}:retry:${(original.attempt || 1) + 1}`,
        parentTaskId: original.id,
        attempt: (original.attempt || 1) + 1,
      })
      db.writingTasks = [created, ...db.writingTasks].slice(0, 500)
      return created
    })
    if (task.status === 'queued') queueMicrotask(() => { void executeWritingTask(task.id, req.user.id) })
    res.status(202).json({ task: writingTaskPublic(task) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/ai/tasks/:taskId/cancel', async (req, res, next) => {
  try {
    const task = await updateDb((db) => {
      const current = db.writingTasks.find((item) => item.id === req.params.taskId && item.userId === req.user.id)
      if (!current) throw Object.assign(new Error('AI 任务不存在'), { status: 404 })
      if (['completed', 'failed', 'cancelled'].includes(current.status)) return current
      current.cancelRequested = true
      current.status = 'cancelled'
      current.statusMessage = '任务已取消，可重新提交'
      current.errorCode = 'cancelled'
      current.retryable = true
      current.updatedAt = new Date().toISOString()
      return current
    })
    writingTaskControllers.get(task.id)?.abort()
    res.json({ task: writingTaskPublic(task) })
  } catch (error) {
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
    if (isNetworkError(error)) {
      next(Object.assign(new Error('AI 服务暂不可用'), { status: 503 }))
      return
    }
    next(error)
  }
})

app.get('/api/writing-assistant/session', async (req, res, next) => {
  try {
    const session = await loadWritingSession(req.user.id)
    res.json({ session: writingSessionPublic(session) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/writing-assistant/messages', async (req, res, next) => {
  let prepared = null
  try {
    const message = cleanText(req.body?.message, '助手消息', 4000)
    const skill = req.body?.skill === undefined || req.body?.skill === null || req.body?.skill === ''
      ? null
      : cleanText(req.body.skill, 'Skill 名称', 80)
    if (skill && !/^[a-z0-9-]+$/.test(skill)) throw Object.assign(new Error('Skill 名称格式无效'), { status: 400 })
    const payload = req.body?.payload && typeof req.body.payload === 'object' && !Array.isArray(req.body.payload) ? req.body.payload : {}
    if (JSON.stringify(payload).length > 1_000_000) throw Object.assign(new Error('智能体上下文不能超过 1,000,000 个字符'), { status: 400 })

    let session = await loadWritingSession(req.user.id)
    if (!session || session.userId !== req.user.id || req.body?.restart === true || session.phase === 'writing') {
      session = createWritingSession(req.user.id)
    }
    appendWritingMessage(session, 'user', message)
    if (session.phase === 'awaiting_confirmation') {
      const reply = '建书方案已经准备好，请先确认创建，或开始新对话。'
      appendWritingMessage(session, 'assistant', reply)
      await saveWritingSession(req.user.id, session)
      const publicSession = writingSessionPublic(session)
      res.json({ status: 'completed', phase: publicSession.phase, reply, missing: [], questions: [], selectedSkill: publicSession.selectedSkill, requirements: publicSession.requirements, proposal: publicSession.proposal, session: publicSession })
      return
    }
    session.questions = []
    await saveWritingSession(req.user.id, session)
    prepared = { session }

    const generated = await requestWritingAssistantTurn(req.user, writingSessionPublic(session), message, skill, payload)
    const reloaded = await loadWritingSession(req.user.id)
    if (!reloaded || reloaded.id !== session.id) throw Object.assign(new Error('创作会话已变化，请重新发送'), { status: 409 })
    session = reloaded
    session.requirements = { ...emptyWritingRequirements(), ...(generated.requirements || session.requirements || {}) }
    session.selectedSkill = generated.selected_skill || skill || session.selectedSkill || null
    session.questions = Array.isArray(generated.questions) ? generated.questions.slice(0, 2) : []
    session.lastResult = generated.result || null
    const reply = cleanOptionalText(generated.reply, '助手回复', 4000)
      || (generated.status === 'needs_model' ? '请先在设置中配置模型，当前创作需求已经保存。' : generated.status === 'failed' ? '处理失败，请检查模型配置后重试。' : '我已经处理好这个请求。')
    if (generated.proposal) {
      session.proposal = validateSmartProposal(generated.proposal, session.requirements.type || '长篇')
      session.phase = 'awaiting_confirmation'
    } else if (generated.phase === 'completed') {
      session.phase = 'collecting_requirements'
    } else {
      session.phase = generated.phase || 'collecting_requirements'
    }
    appendWritingMessage(session, 'assistant', reply)
    await saveWritingSession(req.user.id, session)
    const publicSession = writingSessionPublic(session)

    res.json({
      status: generated.status,
      phase: publicSession.phase,
      reply,
      missing: generated.missing || [],
      questions: publicSession.questions,
      selectedSkill: publicSession.selectedSkill,
      route: generated.route || '',
      requirements: publicSession.requirements,
      result: publicSession.lastResult,
      proposal: publicSession.proposal,
      session: publicSession,
    })
  } catch (error) {
    if (isNetworkError(error)) {
      next(Object.assign(new Error(prepared ? 'AI 服务暂不可用，本轮消息已保存' : 'AI 服务暂不可用'), { status: 503 }))
      return
    }
    next(error)
  }
})

app.post('/api/writing-assistant/confirm', async (req, res, next) => {
  try {
    const sessionId = cleanText(req.body?.sessionId, '创作会话 ID', 80)
    const session = await loadWritingSession(req.user.id)
    if (!session || session.id !== sessionId) throw Object.assign(new Error('创作会话不存在或已过期'), { status: 404 })
    if (session.projectId) {
      const db = await loadDb()
      const project = findOr404(db, session.projectId, req.user.id)
      res.status(200).json({ project, chapters: db.chapters[project.id] || [], duplicate: true })
      return
    }
    if (session.phase !== 'awaiting_confirmation' || !session.proposal) throw Object.assign(new Error('建书方案尚未生成，不能确认创建'), { status: 409 })
    const proposal = validateSmartProposal(req.body?.proposal || session.proposal, session.requirements?.type || '长篇')
    const created = await updateDb((db) => createProjectWithOutline(db, { userId: req.user.id, proposal }))
    session.phase = 'writing'
    session.proposal = proposal
    session.projectId = created.project.id
    session.selectedSkill = proposal.type === '短篇' ? 'story-short-write' : 'story-long-write'
    appendWritingMessage(session, 'assistant', `《${created.project.title}》已经创建，可以进入编辑器继续写作。`)
    await saveWritingSession(req.user.id, session)
    res.status(201).json({ ...created, duplicate: false })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/writing-assistant/session', async (req, res, next) => {
  try {
    await deleteWritingSession(req.user.id)
    res.status(204).end()
  } catch (error) {
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
    const type = cleanEnum(req.body?.type || '长篇', '篇幅', PROJECT_TYPES)
    const genre = cleanText(req.body?.genre || '现代言情', '题材', 30)
    const style = cleanOptionalText(req.body?.style, '流派', 80)
    const timestamp = new Date().toISOString()
    const project = createProjectBase({ userId: req.user.id, title, type, genre, style, tone: '等待你的第一笔设定', timestamp })
    const result = await updateDb((db) => {
      db.projects = [project, ...db.projects.map((item) => item.userId === req.user.id ? { ...item, isActive: false } : item)]
      db.chapters[project.id] = []
      db.drafts[project.id] = {}
      db.editHistory[project.id] = {}
      createChapterRecord(db, project, '第一章')
      return project
    })
    res.status(201).json({ project: result })
  } catch (error) {
    next(error)
  }
})

app.post('/api/projects/smart', async (req, res, next) => {
  try {
    const proposal = validateSmartProposal(req.body, req.body?.type || '长篇')
    const result = await updateDb((db) => createProjectWithOutline(db, { userId: req.user.id, proposal }))
    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
})

app.post('/api/projects/import', async (req, res, next) => {
  try {
    const title = cleanText(req.body?.title, '作品名', 80)
    const type = cleanEnum(req.body?.type || '长篇', '篇幅', PROJECT_TYPES)
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
    const project = createProjectBase({ userId: req.user.id, title, type, genre, tone: '由本地文稿导入，可继续补充设定与创作基调', timestamp })
    const result = await updateDb((db) => {
      db.projects = [project, ...db.projects.map((item) => item.userId === req.user.id ? { ...item, isActive: false } : item)]
      db.chapters[project.id] = []
      db.drafts[project.id] = {}
      db.editHistory[project.id] = {}
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
      if (req.body.type !== undefined) project.type = cleanEnum(req.body.type, '篇幅', PROJECT_TYPES)
      if (req.body.genre !== undefined) project.genre = cleanText(req.body.genre, '题材', 30)
      if (req.body.style !== undefined) project.style = cleanOptionalText(req.body.style, '流派', 80)
      if (req.body.status !== undefined) project.status = cleanEnum(req.body.status, '状态', PROJECT_STATUSES)
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
      delete db.editHistory[req.params.projectId]
      db.ideas = db.ideas.filter((idea) => idea.projectId !== req.params.projectId)
      db.foreshadows = db.foreshadows.filter((item) => item.projectId !== req.params.projectId)
      db.storyMemories = db.storyMemories.filter((item) => item.projectId !== req.params.projectId)
      db.writingTasks = db.writingTasks.filter((item) => item.projectId !== req.params.projectId)
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
      if (req.body.state !== undefined) chapter.state = cleanEnum(req.body.state, '章节状态', CHAPTER_STATES)
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
      if (db.editHistory[project.id]) delete db.editHistory[project.id][String(deleted.id)]
      const deletedChapterId = String(deleted.id)
      for (const foreshadow of db.foreshadows.filter((item) => item.projectId === project.id)) {
        let changed = false
        if (String(foreshadow.plantChapterId || '') === deletedChapterId) {
          foreshadow.plantChapterId = null
          if (foreshadow.status === 'planted') foreshadow.status = 'planned'
          changed = true
        }
        if (String(foreshadow.targetChapterId || '') === deletedChapterId) {
          foreshadow.targetChapterId = null
          changed = true
        }
        if (String(foreshadow.resolvedChapterId || '') === deletedChapterId) {
          foreshadow.resolvedChapterId = null
          if (foreshadow.status === 'resolved') foreshadow.status = foreshadow.plantChapterId ? 'planted' : 'planned'
          changed = true
        }
        if (changed) foreshadow.updatedAt = new Date().toISOString()
      }
      for (const memory of db.storyMemories.filter((item) => item.projectId === project.id && String(item.sourceChapterId || '') === deletedChapterId)) {
        memory.sourceChapterId = null
        memory.updatedAt = new Date().toISOString()
      }
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

app.get('/api/projects/:projectId/chapters/:chapterId/history', async (req, res, next) => {
  try {
    const db = await loadDb()
    const project = findOr404(db, req.params.projectId, req.user.id)
    const chapter = chapterOr404(db, project, req.params.chapterId)
    const snapshots = db.editHistory[project.id]?.[String(chapter.id)] || []
    res.json({ snapshots })
  } catch (error) {
    next(error)
  }
})

app.get('/api/projects/:projectId/chapters/:chapterId/context', async (req, res, next) => {
  try {
    const db = await loadDb()
    const project = findOr404(db, req.params.projectId, req.user.id)
    const chapter = chapterOr404(db, project, req.params.chapterId)
    res.json({ context: buildWritingContext(db, project, chapter) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/projects/:projectId/chapters/:chapterId/history', async (req, res, next) => {
  try {
    if (typeof req.body?.content !== 'string') throw Object.assign(new Error('历史正文必须是文本'), { status: 400 })
    if (req.body.content.length > 500000) throw Object.assign(new Error('历史正文不能超过 500,000 个字符'), { status: 400 })
    const result = await updateDb((db) => {
      const project = findOr404(db, req.params.projectId, req.user.id)
      const chapter = chapterOr404(db, project, req.params.chapterId)
      return recordEditSnapshot(db, project.id, chapter.id, req.body.content)
    })
    res.status(result.duplicate ? 200 : 201).json(result)
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

app.get('/api/story-memories', async (req, res, next) => {
  try {
    const db = await loadDb()
    const projectId = req.query.projectId ? String(req.query.projectId) : ''
    if (projectId) findOr404(db, projectId, req.user.id)
    const memories = db.storyMemories
      .filter((item) => item.userId === req.user.id && (!projectId || item.projectId === projectId))
      .sort((left, right) => (STORY_MEMORY_ORDER.get(left.type) ?? 99) - (STORY_MEMORY_ORDER.get(right.type) ?? 99)
        || Number(right.importance || 0) - Number(left.importance || 0)
        || String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    res.json({ memories })
  } catch (error) {
    next(error)
  }
})

app.post('/api/story-memories', async (req, res, next) => {
  try {
    const memory = await updateDb((db) => {
      const project = findOr404(db, req.body?.projectId, req.user.id)
      const created = createStoryMemoryRecord(db, req.user.id, project, req.body)
      db.storyMemories = [created, ...db.storyMemories]
      return created
    })
    res.status(201).json({ memory })
  } catch (error) {
    next(error)
  }
})

app.post('/api/story-memories/batch', async (req, res, next) => {
  try {
    if (!Array.isArray(req.body?.memories) || !req.body.memories.length) throw Object.assign(new Error('至少需要一条候选记忆'), { status: 400 })
    if (req.body.memories.length > 40) throw Object.assign(new Error('单次最多确认 40 条记忆'), { status: 400 })
    const result = await updateDb((db) => {
      const project = findOr404(db, req.body?.projectId, req.user.id)
      const created = []
      const updated = []
      const timestamp = new Date().toISOString()
      for (const input of req.body.memories) {
        const replacingId = input?.replacesMemoryId || input?.replaces_memory_id
        const existing = replacingId ? db.storyMemories.find((item) => item.id === replacingId && item.userId === req.user.id && item.projectId === project.id) : null
        if (existing) {
          Object.assign(existing, cleanStoryMemoryInput(input), {
            sourceChapterId: input?.sourceChapterId == null || input?.sourceChapterId === '' ? existing.sourceChapterId : String(chapterOr404(db, project, input.sourceChapterId).id),
            updatedAt: timestamp,
          })
          updated.push(existing)
        } else {
          const memory = createStoryMemoryRecord(db, req.user.id, project, input, timestamp)
          db.storyMemories.unshift(memory)
          created.push(memory)
        }
      }
      return { created, updated }
    })
    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
})

app.patch('/api/story-memories/:memoryId', async (req, res, next) => {
  try {
    const memory = await updateDb((db) => {
      const current = db.storyMemories.find((item) => item.id === req.params.memoryId && item.userId === req.user.id)
      if (!current) throw Object.assign(new Error('作品记忆不存在'), { status: 404 })
      const project = findOr404(db, current.projectId, req.user.id)
      Object.assign(current, cleanStoryMemoryInput(req.body, { partial: true }))
      if (req.body.sourceChapterId !== undefined) current.sourceChapterId = req.body.sourceChapterId == null || req.body.sourceChapterId === '' ? null : String(chapterOr404(db, project, req.body.sourceChapterId).id)
      current.updatedAt = new Date().toISOString()
      return current
    })
    res.json({ memory })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/story-memories/:memoryId', async (req, res, next) => {
  try {
    await updateDb((db) => {
      const exists = db.storyMemories.some((item) => item.id === req.params.memoryId && item.userId === req.user.id)
      if (!exists) throw Object.assign(new Error('作品记忆不存在'), { status: 404 })
      db.storyMemories = db.storyMemories.filter((item) => item.id !== req.params.memoryId)
    })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.post('/api/projects/:projectId/chapters/:chapterId/memory-candidates', async (req, res, next) => {
  try {
    const db = await loadDb()
    const project = findOr404(db, req.params.projectId, req.user.id)
    const chapter = chapterOr404(db, project, req.params.chapterId)
    const content = draftMapFor(db, project.id)[String(chapter.id)] || ''
    if (!content.trim()) throw Object.assign(new Error('当前章节还没有正文'), { status: 400 })
    const modelConfig = await getUserModelConfig(req.user)
    const body = { chapter_title: chapter.title, content, writing_context: buildWritingContext(db, project, chapter) }
    if (modelConfig) body.model_config = modelConfig
    const response = await fetch(`${aiServiceUrl}/v1/memories/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': aiServiceToken },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw Object.assign(new Error(payload?.detail || '作品记忆整理失败'), { status: response.status >= 500 ? 502 : response.status })
    res.json(payload)
  } catch (error) {
    next(error)
  }
})

app.get('/api/foreshadows', async (req, res, next) => {
  try {
    const db = await loadDb()
    const projectId = req.query.projectId ? String(req.query.projectId) : ''
    if (projectId) findOr404(db, projectId, req.user.id)
    const status = req.query.status ? String(req.query.status) : ''
    if (status && !FORESHADOW_STATUSES.has(status)) throw Object.assign(new Error('伏笔状态无效'), { status: 400 })
    const foreshadows = db.foreshadows
      .filter((item) => item.userId === req.user.id && (!projectId || item.projectId === projectId) && (!status || item.status === status))
      .sort((left, right) => Number(right.importance || 0) - Number(left.importance || 0) || String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    res.json({ foreshadows })
  } catch (error) {
    next(error)
  }
})

app.post('/api/foreshadows', async (req, res, next) => {
  try {
    const title = cleanText(req.body?.title, '伏笔标题', 120)
    const content = cleanText(req.body?.content, '伏笔内容', 2000)
    const result = await updateDb((db) => {
      const project = findOr404(db, req.body?.projectId, req.user.id)
      const plantChapterId = req.body?.plantChapterId == null || req.body?.plantChapterId === '' ? null : String(chapterOr404(db, project, req.body.plantChapterId).id)
      const targetChapterId = req.body?.targetChapterId == null || req.body?.targetChapterId === '' ? null : String(chapterOr404(db, project, req.body.targetChapterId).id)
      const resolvedChapterId = req.body?.resolvedChapterId == null || req.body?.resolvedChapterId === '' ? null : String(chapterOr404(db, project, req.body.resolvedChapterId).id)
      const status = req.body?.status || 'planned'
      if (!FORESHADOW_STATUSES.has(status)) throw Object.assign(new Error('伏笔状态无效'), { status: 400 })
      const timestamp = new Date().toISOString()
      const foreshadow = {
        id: crypto.randomUUID(), userId: req.user.id, projectId: project.id, title, content,
        status, category: cleanOptionalText(req.body?.category, '伏笔分类', 40),
        importance: cleanIntegerRange(req.body?.importance, '重要性', 1, 5, 3),
        plantChapterId, targetChapterId, resolvedChapterId: status === 'resolved' ? resolvedChapterId : null,
        createdAt: timestamp, updatedAt: timestamp,
      }
      db.foreshadows = [foreshadow, ...db.foreshadows]
      return foreshadow
    })
    res.status(201).json({ foreshadow: result })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/foreshadows/:foreshadowId', async (req, res, next) => {
  try {
    const result = await updateDb((db) => {
      const foreshadow = db.foreshadows.find((item) => item.id === req.params.foreshadowId && item.userId === req.user.id)
      if (!foreshadow) throw Object.assign(new Error('伏笔不存在'), { status: 404 })
      const project = findOr404(db, foreshadow.projectId, req.user.id)
      if (req.body.title !== undefined) foreshadow.title = cleanText(req.body.title, '伏笔标题', 120)
      if (req.body.content !== undefined) foreshadow.content = cleanText(req.body.content, '伏笔内容', 2000)
      if (req.body.category !== undefined) foreshadow.category = cleanOptionalText(req.body.category, '伏笔分类', 40)
      if (req.body.importance !== undefined) foreshadow.importance = cleanIntegerRange(req.body.importance, '重要性', 1, 5, 3)
      if (req.body.status !== undefined) {
        if (!FORESHADOW_STATUSES.has(req.body.status)) throw Object.assign(new Error('伏笔状态无效'), { status: 400 })
        foreshadow.status = req.body.status
      }
      if (req.body.plantChapterId !== undefined) foreshadow.plantChapterId = req.body.plantChapterId == null || req.body.plantChapterId === '' ? null : String(chapterOr404(db, project, req.body.plantChapterId).id)
      if (req.body.targetChapterId !== undefined) foreshadow.targetChapterId = req.body.targetChapterId == null || req.body.targetChapterId === '' ? null : String(chapterOr404(db, project, req.body.targetChapterId).id)
      if (req.body.resolvedChapterId !== undefined) foreshadow.resolvedChapterId = req.body.resolvedChapterId == null || req.body.resolvedChapterId === '' ? null : String(chapterOr404(db, project, req.body.resolvedChapterId).id)
      if (foreshadow.status === 'resolved' && !foreshadow.resolvedChapterId && req.body.chapterId !== undefined) foreshadow.resolvedChapterId = String(chapterOr404(db, project, req.body.chapterId).id)
      if (foreshadow.status !== 'resolved') foreshadow.resolvedChapterId = null
      foreshadow.updatedAt = new Date().toISOString()
      return foreshadow
    })
    res.json({ foreshadow: result })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/foreshadows/:foreshadowId', async (req, res, next) => {
  try {
    await updateDb((db) => {
      const exists = db.foreshadows.some((item) => item.id === req.params.foreshadowId && item.userId === req.user.id)
      if (!exists) throw Object.assign(new Error('伏笔不存在'), { status: 404 })
      db.foreshadows = db.foreshadows.filter((item) => item.id !== req.params.foreshadowId)
    })
    res.status(204).end()
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

await updateDb((db) => {
  const timestamp = new Date().toISOString()
  for (const task of db.writingTasks) {
    if (!['queued', 'running'].includes(task.status)) continue
    task.status = 'failed'
    task.error = '服务曾在任务执行期间重启，请重新提交任务'
    task.statusMessage = '任务因服务重启中断'
    task.updatedAt = timestamp
  }
})

const server = app.listen(port, host, (error) => {
  if (error) {
    console.error(`Story API failed to listen on ${host}:${port}: ${error.message}`)
    process.exitCode = 1
    return
  }
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  console.log(`Story API listening on http://${host}:${actualPort}`)
  console.log(`Data file: ${path.join(serverDir, 'data', 'db.json')}`)
  if (usesDefaultSecret) console.warn('AUTH_SECRET is not set; use a strong secret in production.')
})
