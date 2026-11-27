import crypto from 'node:crypto'

// 单用户本地应用：写作助手会话只存在 db.writingSessions 里。
// 这里保留归一化工具与同名接口，方便调用方无需改动。
const SESSION_VERSION = 2

export function isRedisEnabled() {
  return false
}

export async function getSession() {
  return null
}

export async function setSession() {
  return false
}

export async function deleteSession() {
  return false
}

export async function closeClient() {
  // 无外部连接需要释放。
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

