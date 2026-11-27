import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { seed } from './seed.mjs'
import { normalizeAgentThreads } from './agent-thread.mjs'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(serverDir, 'data')
// 数据落盘优先级：
//   1. STORY_DATA_FILE（显式指定）
//   2. DESKTOP_DATA_DIR（桌面壳/启动器注入的应用数据目录）
//   3. server/data/db.json（开发默认；打包后该目录只读，因此桌面版必须走 2）
const dataFile = process.env.STORY_DATA_FILE
  ? path.resolve(process.env.STORY_DATA_FILE)
  : process.env.DESKTOP_DATA_DIR
    ? path.join(path.resolve(process.env.DESKTOP_DATA_DIR), 'db.json')
    : path.join(dataDir, 'db.json')
let mutationQueue = Promise.resolve()
let jsonWriteSequence = 0

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeDb(db) {
  db ||= {}
  db.users ||= []
  db.projects ||= []
  db.chapters ||= {}
  db.drafts ||= {}
  db.editHistory ||= {}
  db.writingSessions ||= {}
  db.writingTasks ||= []
  normalizeAgentThreads(db)
  db.aiUsage ||= []
  db.foreshadows ||= []
  db.storyMemories ||= []
  db.ideas ||= []
  db.writingLog ||= []
  for (const project of db.projects) {
    if (!Object.hasOwn(project, 'userId')) project.userId = null
    if (!Object.hasOwn(project, 'style')) project.style = ''
    if (!Object.hasOwn(project, 'createdAt')) project.createdAt = null
    if (!Object.hasOwn(project, 'updatedAt')) project.updatedAt = project.createdAt

    const chapters = Array.isArray(db.chapters[project.id]) ? db.chapters[project.id] : []
    db.chapters[project.id] = chapters

    const legacyDraft = db.drafts[project.id]
    if (typeof legacyDraft === 'string') {
      const firstChapter = chapters[0]
      db.drafts[project.id] = firstChapter
        ? { [String(firstChapter.id)]: legacyDraft }
        : { __legacy: legacyDraft }
    } else if (!legacyDraft || typeof legacyDraft !== 'object' || Array.isArray(legacyDraft)) {
      db.drafts[project.id] = {}
    }

    const draftMap = db.drafts[project.id]
    const projectHistory = db.editHistory[project.id]
    if (!projectHistory || typeof projectHistory !== 'object' || Array.isArray(projectHistory)) {
      db.editHistory[project.id] = {}
    }
    for (const chapter of chapters) {
      const key = String(chapter.id)
      if (!Object.hasOwn(chapter, 'outline')) chapter.outline = ''
      const content = typeof draftMap[key] === 'string' ? draftMap[key] : ''
      if (!Object.hasOwn(chapter, 'createdAt')) chapter.createdAt = project.createdAt
      if (!Object.hasOwn(chapter, 'updatedAt')) chapter.updatedAt = project.updatedAt
      chapter.words = formatWords(countWords(content))
      const snapshots = db.editHistory[project.id][key]
      db.editHistory[project.id][key] = Array.isArray(snapshots)
        ? snapshots.filter((snapshot) => snapshot && typeof snapshot.content === 'string').slice(-80)
        : []
    }

    project.chapters = chapters.length
    project.words = formatWords(chapters.reduce((total, chapter) => {
      const content = draftMap[String(chapter.id)]
      return total + countWords(typeof content === 'string' ? content : '')
    }, 0))
  }
  for (const idea of db.ideas) {
    if (!Object.hasOwn(idea, 'userId')) idea.userId = null
    if (!Object.hasOwn(idea, 'createdAt')) idea.createdAt = null
    if (!Object.hasOwn(idea, 'updatedAt')) idea.updatedAt = idea.createdAt
    if (!Object.hasOwn(idea, 'tags')) idea.tags = []
    if (!Object.hasOwn(idea, 'pinned')) idea.pinned = false
  }
  for (const foreshadow of db.foreshadows) {
    if (!Object.hasOwn(foreshadow, 'userId')) foreshadow.userId = null
    if (!Object.hasOwn(foreshadow, 'status')) foreshadow.status = 'planned'
    if (!Object.hasOwn(foreshadow, 'category')) foreshadow.category = ''
    if (!Object.hasOwn(foreshadow, 'importance')) foreshadow.importance = 3
    if (!Object.hasOwn(foreshadow, 'plantChapterId')) foreshadow.plantChapterId = null
    if (!Object.hasOwn(foreshadow, 'targetChapterId')) foreshadow.targetChapterId = null
    if (!Object.hasOwn(foreshadow, 'resolvedChapterId')) foreshadow.resolvedChapterId = null
    if (!Object.hasOwn(foreshadow, 'createdAt')) foreshadow.createdAt = null
    if (!Object.hasOwn(foreshadow, 'updatedAt')) foreshadow.updatedAt = foreshadow.createdAt
  }
  for (const memory of db.storyMemories) {
    if (!Object.hasOwn(memory, 'userId')) memory.userId = null
    if (!Object.hasOwn(memory, 'type')) memory.type = 'canon_fact'
    if (!Object.hasOwn(memory, 'status')) memory.status = 'active'
    if (!Object.hasOwn(memory, 'importance')) memory.importance = 3
    if (!Object.hasOwn(memory, 'characterName')) memory.characterName = ''
    if (!Object.hasOwn(memory, 'sourceChapterId')) memory.sourceChapterId = null
    if (!Object.hasOwn(memory, 'tags')) memory.tags = []
    if (!Object.hasOwn(memory, 'createdAt')) memory.createdAt = null
    if (!Object.hasOwn(memory, 'updatedAt')) memory.updatedAt = memory.createdAt
  }
  for (const user of db.users) {
    if (!Object.hasOwn(user, 'settings')) user.settings = null
    if (!Object.hasOwn(user, 'authVersion')) user.authVersion = 0
  }
  return db
}

async function writeDb(db) {
  await mkdir(path.dirname(dataFile), { recursive: true })
  const tempFile = `${dataFile}.${process.pid}.${++jsonWriteSequence}.tmp`
  await writeFile(tempFile, JSON.stringify(db, null, 2), 'utf8')
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tempFile, dataFile)
        return
      } catch (error) {
        const retryableWindowsLock = ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)
        if (!retryableWindowsLock || attempt >= 7) throw error
        await new Promise((resolve) => setTimeout(resolve, 12 * (attempt + 1)))
      }
    }
  } catch (error) {
    await unlink(tempFile).catch(() => undefined)
    throw error
  }
}

export async function loadDb() {
  try {
    const raw = await readFile(dataFile, 'utf8')
    return normalizeDb(JSON.parse(raw))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const fresh = normalizeDb(clone(seed))
    await writeDb(fresh)
    return fresh
  }
}

export function updateDb(mutator) {
  const operation = mutationQueue.then(async () => {
    const db = await loadDb()
    const result = await mutator(db)
    await writeDb(db)
    return result
  })
  mutationQueue = operation.catch(() => undefined)
  return operation
}

export function countWords(text = '') {
  return String(text).replace(/\s/g, '').length
}

export function formatWords(count) {
  return count.toLocaleString('en-US')
}

export function findProject(db, projectId) {
  return db.projects.find((project) => project.id === projectId)
}

export function replaceDb(nextDb) {
  return updateDb((db) => {
    const replacement = normalizeDb(clone(nextDb))
    for (const key of Object.keys(db)) delete db[key]
    Object.assign(db, replacement)
  })
}

export function storeInfo() {
  return { backend: 'json', dataFile }
}

export async function closeStore() {
  // JSON 存储无需释放连接；保留导出以便统一关闭流程。
}
