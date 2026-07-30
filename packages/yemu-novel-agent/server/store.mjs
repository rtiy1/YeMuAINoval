import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { seed } from './seed.mjs'
import { normalizeAgentThreads } from './agent-thread.mjs'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(serverDir, 'data')
const dataFile = process.env.STORY_DATA_FILE ? path.resolve(process.env.STORY_DATA_FILE) : path.join(dataDir, 'db.json')
let mutationQueue = Promise.resolve()
let jsonWriteSequence = 0
let postgresPoolPromise = null
let postgresSchemaPromise = null

const RELATIONAL_SCHEMA_VERSION = 2
const relationalKeys = new Set(['users', 'sessions', 'projects', 'chapters', 'drafts', 'ideas'])

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
    postgresSchemaPromise = (async () => {
      await pool.query(`
      CREATE TABLE IF NOT EXISTS story_state (
        state_key TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      `)
      const migration = await readFile(path.join(serverDir, 'migrations', '002-relational-core.sql'), 'utf8')
      await pool.query(migration)
    })().catch((error) => {
      postgresSchemaPromise = null
      throw error
    })
  }
  await postgresSchemaPromise
}

function timestamp(value) {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function numericChapterId(value) {
  const text = String(value)
  return /^\d+$/.test(text) ? Number(text) : text
}

function integerValue(value) {
  const parsed = Number(String(value ?? 0).replaceAll(',', ''))
  return Number.isFinite(parsed) ? Math.round(parsed) : 0
}

function auxiliaryState(db) {
  return Object.fromEntries(Object.entries(db).filter(([key]) => !relationalKeys.has(key)))
}

async function readRelationalState(client, auxiliary) {
  const users = await client.query('SELECT * FROM users ORDER BY created_at NULLS LAST, id')
  const sessions = await client.query('SELECT * FROM sessions ORDER BY created_at NULLS LAST, id')
  const projects = await client.query('SELECT * FROM projects ORDER BY created_at NULLS LAST, id')
  const chapters = await client.query('SELECT * FROM chapters ORDER BY project_id, position, chapter_id')
  const drafts = await client.query('SELECT * FROM drafts ORDER BY project_id, chapter_id')
  const ideas = await client.query('SELECT * FROM ideas ORDER BY created_at NULLS LAST, id')
  const db = {
    ...clone(auxiliary || {}),
    users: users.rows.map((row) => ({
      id: row.id, name: row.name, email: row.email, passwordHash: row.password_hash,
      settings: row.settings, authVersion: Number(row.auth_version) || 0, createdAt: timestamp(row.created_at),
    })),
    sessions: sessions.rows.map((row) => ({
      id: row.id, userId: row.user_id, tokenHash: row.token_hash, userAgent: row.user_agent,
      createdAt: timestamp(row.created_at), expiresAt: timestamp(row.expires_at),
    })),
    projects: projects.rows.map((row) => ({
      id: row.id, userId: row.user_id, title: row.title, type: row.type, genre: row.genre,
      status: row.status, progress: row.progress, words: formatWords(Number(row.word_count || 0)),
      updated: row.updated_label, chapters: row.chapter_count, style: row.style, tone: row.tone,
      cover: row.cover, isActive: row.is_active, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
    })),
    chapters: {},
    drafts: {},
    ideas: ideas.rows.map((row) => ({
      id: row.id, userId: row.user_id, projectId: row.project_id, label: row.label, title: row.title,
      body: row.body, color: row.color, folder: row.folder, tags: row.tags || [], pinned: row.pinned,
      createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
    })),
  }
  for (const project of db.projects) {
    db.chapters[project.id] = []
    db.drafts[project.id] = {}
  }
  for (const row of chapters.rows) {
    db.chapters[row.project_id] ||= []
    db.chapters[row.project_id].push({
      id: numericChapterId(row.chapter_id), title: row.title, outline: row.outline, state: row.state,
      words: formatWords(Number(row.word_count || 0)), createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
    })
  }
  for (const row of drafts.rows) {
    db.drafts[row.project_id] ||= {}
    db.drafts[row.project_id][String(row.chapter_id)] = row.content
  }
  return normalizeDb(db)
}

async function replaceRelationalState(client, db) {
  await client.query('DELETE FROM drafts')
  await client.query('DELETE FROM chapters')
  await client.query('DELETE FROM ideas')
  await client.query('DELETE FROM projects')
  await client.query('DELETE FROM sessions')
  await client.query('DELETE FROM users')

  for (const user of db.users) {
    await client.query(
      'INSERT INTO users (id, name, email, password_hash, settings, auth_version, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)',
      [user.id, user.name, user.email, user.passwordHash, user.settings ? JSON.stringify(user.settings) : null, Number(user.authVersion) || 0, user.createdAt],
    )
  }
  for (const session of db.sessions) {
    await client.query(
      'INSERT INTO sessions (id, user_id, token_hash, user_agent, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [session.id, session.userId, session.tokenHash, session.userAgent || '', session.createdAt, session.expiresAt],
    )
  }
  for (const project of db.projects) {
    await client.query(
      `INSERT INTO projects (
        id, user_id, title, type, genre, status, progress, word_count, updated_label, chapter_count,
        style, tone, cover, is_active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        project.id, project.userId, project.title, project.type, project.genre, project.status,
        integerValue(project.progress), integerValue(project.words), project.updated || '', integerValue(project.chapters),
        project.style || '', project.tone || '', project.cover || 'cover-new', project.isActive === true,
        project.createdAt, project.updatedAt,
      ],
    )
  }
  for (const project of db.projects) {
    const projectChapters = db.chapters[project.id] || []
    for (const [position, chapter] of projectChapters.entries()) {
      await client.query(
        `INSERT INTO chapters (
          project_id, chapter_id, position, title, outline, word_count, state, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [project.id, String(chapter.id), position, chapter.title, chapter.outline || '', integerValue(chapter.words), chapter.state || 'draft', chapter.createdAt, chapter.updatedAt],
      )
      await client.query(
        'INSERT INTO drafts (project_id, chapter_id, content, updated_at) VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()))',
        [project.id, String(chapter.id), db.drafts[project.id]?.[String(chapter.id)] || '', chapter.updatedAt],
      )
    }
  }
  for (const idea of db.ideas) {
    await client.query(
      `INSERT INTO ideas (
        id, user_id, project_id, label, title, body, color, folder, tags, pinned, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12)`,
      [
        idea.id, idea.userId, idea.projectId || null, idea.label, idea.title, idea.body, idea.color || 'coral',
        idea.folder || '未分类', idea.tags || [], idea.pinned === true, idea.createdAt, idea.updatedAt,
      ],
    )
  }
}

function recordsBy(items, keyOf = (item) => item.id) {
  return new Map(items.map((item) => [keyOf(item), item]))
}

function chapterRecords(db) {
  return db.projects.flatMap((project) => (db.chapters[project.id] || []).map((chapter, position) => ({
    ...chapter,
    projectId: project.id,
    chapterId: String(chapter.id),
    position,
  })))
}

function draftRecords(db) {
  return chapterRecords(db).map((chapter) => ({
    projectId: chapter.projectId,
    chapterId: chapter.chapterId,
    content: db.drafts[chapter.projectId]?.[chapter.chapterId] || '',
    updatedAt: chapter.updatedAt,
  }))
}

function relationKey(record) {
  return `${record.projectId}\u0000${record.chapterId}`
}

function changed(previous, current) {
  return !previous || JSON.stringify(previous) !== JSON.stringify(current)
}

async function syncRelationalState(client, previousDb, db) {
  const previous = {
    users: recordsBy(previousDb.users),
    sessions: recordsBy(previousDb.sessions),
    projects: recordsBy(previousDb.projects),
    chapters: recordsBy(chapterRecords(previousDb), relationKey),
    drafts: recordsBy(draftRecords(previousDb), relationKey),
    ideas: recordsBy(previousDb.ideas),
  }
  const current = {
    users: recordsBy(db.users),
    sessions: recordsBy(db.sessions),
    projects: recordsBy(db.projects),
    chapters: recordsBy(chapterRecords(db), relationKey),
    drafts: recordsBy(draftRecords(db), relationKey),
    ideas: recordsBy(db.ideas),
  }

  for (const [id] of previous.ideas) {
    if (!current.ideas.has(id)) await client.query('DELETE FROM ideas WHERE id = $1', [id])
  }
  for (const [key, record] of previous.drafts) {
    if (!current.drafts.has(key)) await client.query('DELETE FROM drafts WHERE project_id = $1 AND chapter_id = $2', [record.projectId, record.chapterId])
  }
  for (const [key, record] of previous.chapters) {
    if (!current.chapters.has(key)) await client.query('DELETE FROM chapters WHERE project_id = $1 AND chapter_id = $2', [record.projectId, record.chapterId])
  }
  for (const [id] of previous.sessions) {
    if (!current.sessions.has(id)) await client.query('DELETE FROM sessions WHERE id = $1', [id])
  }
  for (const [id] of previous.projects) {
    if (!current.projects.has(id)) await client.query('DELETE FROM projects WHERE id = $1', [id])
  }
  for (const [id] of previous.users) {
    if (!current.users.has(id)) await client.query('DELETE FROM users WHERE id = $1', [id])
  }

  for (const [id, user] of current.users) {
    if (!changed(previous.users.get(id), user)) continue
    await client.query(
      `INSERT INTO users (id, name, email, password_hash, settings, auth_version, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash, settings = EXCLUDED.settings,
         auth_version = EXCLUDED.auth_version, created_at = EXCLUDED.created_at`,
      [user.id, user.name, user.email, user.passwordHash, user.settings ? JSON.stringify(user.settings) : null, Number(user.authVersion) || 0, user.createdAt],
    )
  }
  for (const [id, session] of current.sessions) {
    if (!changed(previous.sessions.get(id), session)) continue
    await client.query(
      `INSERT INTO sessions (id, user_id, token_hash, user_agent, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, token_hash = EXCLUDED.token_hash,
         user_agent = EXCLUDED.user_agent, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`,
      [session.id, session.userId, session.tokenHash, session.userAgent || '', session.createdAt, session.expiresAt],
    )
  }
  for (const [id, project] of current.projects) {
    if (!changed(previous.projects.get(id), project)) continue
    await client.query(
      `INSERT INTO projects (
        id, user_id, title, type, genre, status, progress, word_count, updated_label, chapter_count,
        style, tone, cover, is_active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, title = EXCLUDED.title,
        type = EXCLUDED.type, genre = EXCLUDED.genre, status = EXCLUDED.status, progress = EXCLUDED.progress,
        word_count = EXCLUDED.word_count, updated_label = EXCLUDED.updated_label, chapter_count = EXCLUDED.chapter_count,
        style = EXCLUDED.style, tone = EXCLUDED.tone, cover = EXCLUDED.cover, is_active = EXCLUDED.is_active,
        created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
      [
        project.id, project.userId, project.title, project.type, project.genre, project.status,
        integerValue(project.progress), integerValue(project.words), project.updated || '', integerValue(project.chapters),
        project.style || '', project.tone || '', project.cover || 'cover-new', project.isActive === true,
        project.createdAt, project.updatedAt,
      ],
    )
  }
  for (const [key, chapter] of current.chapters) {
    if (!changed(previous.chapters.get(key), chapter)) continue
    await client.query(
      `INSERT INTO chapters (project_id, chapter_id, position, title, outline, word_count, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (project_id, chapter_id) DO UPDATE SET position = EXCLUDED.position, title = EXCLUDED.title,
         outline = EXCLUDED.outline, word_count = EXCLUDED.word_count, state = EXCLUDED.state,
         created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
      [
        chapter.projectId, chapter.chapterId, chapter.position, chapter.title, chapter.outline || '',
        integerValue(chapter.words), chapter.state || 'draft', chapter.createdAt, chapter.updatedAt,
      ],
    )
  }
  for (const [key, draft] of current.drafts) {
    if (!changed(previous.drafts.get(key), draft)) continue
    await client.query(
      `INSERT INTO drafts (project_id, chapter_id, content, updated_at)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()))
       ON CONFLICT (project_id, chapter_id) DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at`,
      [draft.projectId, draft.chapterId, draft.content, draft.updatedAt],
    )
  }
  for (const [id, idea] of current.ideas) {
    if (!changed(previous.ideas.get(id), idea)) continue
    await client.query(
      `INSERT INTO ideas (id, user_id, project_id, label, title, body, color, folder, tags, pinned, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, project_id = EXCLUDED.project_id,
         label = EXCLUDED.label, title = EXCLUDED.title, body = EXCLUDED.body, color = EXCLUDED.color,
         folder = EXCLUDED.folder, tags = EXCLUDED.tags, pinned = EXCLUDED.pinned,
         created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
      [
        idea.id, idea.userId, idea.projectId || null, idea.label, idea.title, idea.body, idea.color || 'coral',
        idea.folder || '未分类', idea.tags || [], idea.pinned === true, idea.createdAt, idea.updatedAt,
      ],
    )
  }
}

async function readPostgresState(client, stateResult) {
  let stateRow = stateResult.rows[0]
  if (!stateRow) {
    const fresh = normalizeDb(clone(seed))
    const inserted = await client.query(
      `INSERT INTO story_state (state_key, data, schema_version) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (state_key) DO NOTHING RETURNING state_key`,
      ['default', JSON.stringify(auxiliaryState(fresh)), RELATIONAL_SCHEMA_VERSION],
    )
    if (inserted.rowCount > 0) {
      await replaceRelationalState(client, fresh)
      return fresh
    }
    const existing = await client.query('SELECT data, schema_version FROM story_state WHERE state_key = $1 FOR UPDATE', ['default'])
    stateRow = existing.rows[0]
  }
  if (Number(stateRow.schema_version || 1) < RELATIONAL_SCHEMA_VERSION) {
    const legacy = normalizeDb(clone(stateRow.data))
    await client.query("SELECT pg_advisory_xact_lock(hashtext('story-state-relational-migration'))")
    const latest = await client.query('SELECT data, schema_version FROM story_state WHERE state_key = $1 FOR UPDATE', ['default'])
    if (Number(latest.rows[0]?.schema_version || 1) >= RELATIONAL_SCHEMA_VERSION) {
      return readRelationalState(client, latest.rows[0].data)
    }
    const lockedLegacy = normalizeDb(clone(latest.rows[0]?.data || legacy))
    await replaceRelationalState(client, lockedLegacy)
    const auxiliary = auxiliaryState(lockedLegacy)
    await client.query(
      'UPDATE story_state SET data = $1::jsonb, schema_version = $2, updated_at = NOW() WHERE state_key = $3',
      [JSON.stringify(auxiliary), RELATIONAL_SCHEMA_VERSION, 'default'],
    )
    stateRow = { data: auxiliary, schema_version: RELATIONAL_SCHEMA_VERSION }
  }
  return readRelationalState(client, stateRow.data)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeDb(db) {
  db ||= {}
  db.users ||= []
  db.sessions ||= []
  db.passwordResetTokens ||= []
  db.emailVerificationCodes ||= []
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
  db.skillMarketItems ||= []
  db.skillMarketInstalls ||= []
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
  for (const skill of db.skillMarketItems) {
    if (!Object.hasOwn(skill, 'downloads')) skill.downloads = 0
    if (!Object.hasOwn(skill, 'tags')) skill.tags = []
    if (!Object.hasOwn(skill, 'status')) skill.status = 'published'
    if (skill.review && typeof skill.review === 'object') {
      if (!Object.hasOwn(skill.review, 'verdict')) skill.review.verdict = 'reject'
      if (!Object.hasOwn(skill.review, 'riskLevel')) skill.review.riskLevel = 'high'
      if (!Object.hasOwn(skill.review, 'summary')) skill.review.summary = ''
      if (!Object.hasOwn(skill.review, 'findings')) skill.review.findings = []
      if (!Object.hasOwn(skill.review, 'reviewer')) skill.review.reviewer = 'static'
      if (!Object.hasOwn(skill.review, 'reviewedAt')) skill.review.reviewedAt = skill.updatedAt || skill.createdAt || null
    }
    if (!Object.hasOwn(skill, 'createdAt')) skill.createdAt = null
    if (!Object.hasOwn(skill, 'updatedAt')) skill.updatedAt = skill.createdAt
  }
  db.skillMarketInstalls = db.skillMarketInstalls
    .filter((install) => install && install.userId && install.skillId)
    .map((install) => ({
      userId: install.userId,
      skillId: install.skillId,
      installedAt: install.installedAt || null,
    }))
}

export async function loadDb() {
  if (postgresEnabled) {
    const pool = await getPostgresPool()
    await ensurePostgresSchema(pool)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query('SELECT data, schema_version FROM story_state WHERE state_key = $1', ['default'])
      const db = await readPostgresState(client, result)
      await client.query('COMMIT')
      return db
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
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
        const result = await client.query('SELECT data, schema_version FROM story_state WHERE state_key = $1 FOR UPDATE', ['default'])
        const db = await readPostgresState(client, result)
        const previousDb = clone(db)
        const value = await mutator(db)
        await syncRelationalState(client, previousDb, db)
        await client.query(
          'UPDATE story_state SET data = $1::jsonb, schema_version = $2, updated_at = NOW() WHERE state_key = $3',
          [JSON.stringify(auxiliaryState(db)), RELATIONAL_SCHEMA_VERSION, 'default'],
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
    backend: postgresEnabled ? 'postgres-relational' : 'json',
    dataFile: postgresEnabled ? null : dataFile,
    postgres: postgresEnabled,
    schemaVersion: postgresEnabled ? RELATIONAL_SCHEMA_VERSION : null,
  }
}

export async function closeStore() {
  if (!postgresPoolPromise) return
  const pool = await postgresPoolPromise
  await pool.end()
  postgresPoolPromise = null
  postgresSchemaPromise = null
}
