import { createRequire } from 'node:module'
import crypto from 'node:crypto'

const require = createRequire(import.meta.url)

export function isRedisEnabled() {
  return Boolean(String(process.env.REDIS_URL || '').trim())
}

const KEY_PREFIX = 'writing-assistant:v2:'
const SESSION_VERSION = 2

let clientPromise = null

function getClient() {
  if (!isRedisEnabled()) return null
  if (!clientPromise) {
    const redisUrl = String(process.env.REDIS_URL).trim()
    const Redis = require('ioredis')
    clientPromise = new Redis(redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      reconnectOnError(err) {
        return err?.message?.includes('READONLY') || false
      },
    })
    clientPromise.on('error', (error) => {
      // ioredis 默认会在后台重连；这里只记日志，避免未捕获事件杀进程。
      if (process.env.NODE_ENV !== 'test') console.error('[chat-memory] redis error:', error.message)
    })
  }
  return clientPromise
}

function emptyRequirements() {
  return { type: '', genre: '', style: '', premise: '', platform: '', title: '' }
}

/**
 * 把任意来源的会话对象归一化为内部会话形状，保证字段与默认值齐全。
 * 镜像 server/index.mjs 的 createWritingSession / appendWritingMessage 不变量。
 */
export function normalizeWritingSession(raw, userId) {
  if (!raw || typeof raw !== 'object') return null
  const session = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    userId: userId || raw.userId || null,
    phase: ['collecting_requirements', 'awaiting_confirmation', 'writing'].includes(raw.phase) ? raw.phase : 'collecting_requirements',
    messages: Array.isArray(raw.messages)
      ? raw.messages
          .filter((item) => item && typeof item === 'object' && typeof item.text === 'string')
          .map((item) => ({
            id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
            role: item.role === 'assistant' ? 'assistant' : 'user',
            text: String(item.text).slice(0, 4000),
            createdAt: typeof item.createdAt === 'string' ? item.createdAt : null,
          }))
          .slice(-20)
      : [],
    requirements: { ...emptyRequirements(), ...(raw.requirements && typeof raw.requirements === 'object' ? raw.requirements : {}) },
    proposal: raw.proposal && typeof raw.proposal === 'object' ? raw.proposal : null,
    selectedSkill: typeof raw.selectedSkill === 'string' ? raw.selectedSkill : null,
    questions: Array.isArray(raw.questions) ? raw.questions.filter(Boolean) : [],
    lastResult: raw.lastResult ?? null,
    projectId: typeof raw.projectId === 'string' ? raw.projectId : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : raw.createdAt || null,
  }
  return session
}

export function serializeSession(session) {
  return JSON.stringify({ v: SESSION_VERSION, session })
}

export async function getSession(userId) {
  if (!isRedisEnabled()) return null
  const client = getClient()
  if (!client) return null
  try {
    const raw = await client.get(`${KEY_PREFIX}${userId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return normalizeWritingSession(parsed?.session ?? parsed, userId)
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') console.error('[chat-memory] getSession failed:', error.message)
    return null
  }
}

export async function setSession(userId, session) {
  if (!isRedisEnabled()) return false
  const client = getClient()
  if (!client) return false
  try {
    const normalized = normalizeWritingSession(session, userId)
    await client.set(`${KEY_PREFIX}${userId}`, serializeSession(normalized))
    return true
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') console.error('[chat-memory] setSession failed:', error.message)
    return false
  }
}

export async function deleteSession(userId) {
  if (!isRedisEnabled()) return false
  const client = getClient()
  if (!client) return false
  try {
    await client.del(`${KEY_PREFIX}${userId}`)
    return true
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') console.error('[chat-memory] deleteSession failed:', error.message)
    return false
  }
}

export async function closeClient() {
  if (!clientPromise) return
  try {
    await clientPromise.quit()
  } catch {
    // 忽略关闭错误
  }
  clientPromise = null
}
