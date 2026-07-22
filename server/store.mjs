import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { seed } from './seed.mjs'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(serverDir, 'data')
const dataFile = process.env.STORY_DATA_FILE ? path.resolve(process.env.STORY_DATA_FILE) : path.join(dataDir, 'db.json')
let mutationQueue = Promise.resolve()

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeDb(db) {
  db.users ||= []
  db.sessions ||= []
  db.projects ||= []
  db.chapters ||= {}
  db.drafts ||= {}
  db.ideas ||= []
  db.writingLog ||= []
  for (const project of db.projects) {
    if (!Object.hasOwn(project, 'userId')) project.userId = null
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
    for (const chapter of chapters) {
      const key = String(chapter.id)
      const content = typeof draftMap[key] === 'string' ? draftMap[key] : ''
      if (!Object.hasOwn(chapter, 'createdAt')) chapter.createdAt = project.createdAt
      if (!Object.hasOwn(chapter, 'updatedAt')) chapter.updatedAt = project.updatedAt
      chapter.words = formatWords(countWords(content))
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
  for (const user of db.users) {
    if (!Object.hasOwn(user, 'settings')) user.settings = null
  }
  return db
}

async function writeDb(db) {
  await mkdir(path.dirname(dataFile), { recursive: true })
  const tempFile = `${dataFile}.tmp`
  await writeFile(tempFile, JSON.stringify(db, null, 2), 'utf8')
  await rename(tempFile, dataFile)
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
