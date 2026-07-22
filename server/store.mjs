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
  for (const project of db.projects) {
    if (!Object.hasOwn(project, 'userId')) project.userId = null
  }
  for (const idea of db.ideas) {
    if (!Object.hasOwn(idea, 'userId')) idea.userId = null
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
