import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { seed } from './seed.mjs'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(serverDir, 'data')
const dataFile = process.env.STORY_DATA_FILE ? path.resolve(process.env.STORY_DATA_FILE) : path.join(dataDir, 'db.json')
let mutationQueue = Promise.resolve()
let postgresPoolPromise = null
let postgresSchemaPromise = null

const postgresEnabled = Boolean(String(process.env.DATABASE_URL || '').trim())

async function getPostgresPool() {
  if (!postgresPoolPromise) {
    postgresPoolPromise = import('pg').then(({ Pool }) => new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DATABASE_POOL_MAX) > 0 ? Number(process.env.DATABASE_POOL_MAX) : 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    }))
  }
  return postgresPoolPromise
}

async function ensurePostgresSchema(pool) {
  if (!postgresSchemaPromise) {
    postgresSchemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS story_state (
        state_key TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch((error) => {
      postgresSchemaPromise = null
      throw error
    })
  }
  await postgresSchemaPromise
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeDb(db) {
  db ||= {}
  db.users ||= []
  db.sessions ||= []
  db.projects ||= []
  db.chapters ||= {}
  db.drafts ||= {}
  db.editHistory ||= {}
  db.writingSessions ||= {}
  db.writingTasks ||= []
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
  if (postgresEnabled) {
    const pool = await getPostgresPool()
    await ensurePostgresSchema(pool)
    const result = await pool.query('SELECT data FROM story_state WHERE state_key = $1', ['default'])
    if (result.rowCount === 0) {
      const fresh = normalizeDb(clone(seed))
      await pool.query(
        'INSERT INTO story_state (state_key, data, schema_version) VALUES ($1, $2::jsonb, $3) ON CONFLICT (state_key) DO NOTHING',
        ['default', JSON.stringify(fresh), 1],
      )
      return fresh
    }
    return normalizeDb(clone(result.rows[0].data))
  }
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
    if (postgresEnabled) {
      const pool = await getPostgresPool()
      await ensurePostgresSchema(pool)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        let result = await client.query('SELECT data FROM story_state WHERE state_key = $1 FOR UPDATE', ['default'])
        if (result.rowCount === 0) {
          const fresh = normalizeDb(clone(seed))
          await client.query(
            'INSERT INTO story_state (state_key, data, schema_version) VALUES ($1, $2::jsonb, $3)',
            ['default', JSON.stringify(fresh), 1],
          )
          result = { rows: [{ data: fresh }] }
        }
        const db = normalizeDb(clone(result.rows[0].data))
        const value = await mutator(db)
        await client.query(
          'UPDATE story_state SET data = $1::jsonb, updated_at = NOW() WHERE state_key = $2',
          [JSON.stringify(db), 'default'],
        )
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }
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
  return {
    backend: postgresEnabled ? 'postgres' : 'json',
    dataFile: postgresEnabled ? null : dataFile,
    postgres: postgresEnabled,
  }
}

export async function closeStore() {
  if (!postgresPoolPromise) return
  const pool = await postgresPoolPromise
  await pool.end()
  postgresPoolPromise = null
  postgresSchemaPromise = null
}
