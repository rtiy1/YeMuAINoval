import assert from 'node:assert/strict'
import { closeStore, loadDb, replaceDb, storeInfo, updateDb } from './store.mjs'

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required')

const now = new Date().toISOString()
const fixture = {
  users: [{ id: 'pg-user', name: '数据库作者', email: 'postgres@example.com', passwordHash: 'test-hash', settings: { provider: 'openai', model: 'test-model' }, createdAt: now }],
  sessions: [{ id: 'pg-session', userId: 'pg-user', tokenHash: 'pg-token-hash', userAgent: 'integration-test', createdAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }],
  projects: [{ id: 'pg-project', userId: 'pg-user', title: '关系表验收', type: '长篇', genre: '悬疑推理', status: '连载中', progress: 12, words: '8', updated: '刚刚', chapters: 1, style: '群像成长', tone: '雨夜追查真相', cover: 'cover-new', isActive: true, createdAt: now, updatedAt: now }],
  chapters: { 'pg-project': [{ id: 1, title: '第一章 雨夜', outline: '主角发现异常来信。', words: '8', state: 'current', createdAt: now, updatedAt: now }] },
  drafts: { 'pg-project': { 1: '雨落在旧港码头。' } },
  editHistory: { 'pg-project': { 1: [] } },
  writingSessions: {},
  writingTasks: [],
  agentThreads: [{ id: 'pg-thread', userId: 'pg-user', projectId: 'pg-project', chapterId: '1', status: 'active', turns: [], createdAt: now, updatedAt: now }],
  foreshadows: [],
  storyMemories: [],
  ideas: [{ id: 'pg-idea', userId: 'pg-user', projectId: 'pg-project', label: '线索', title: '未来邮戳', body: '邮戳来自三天后。', color: 'teal', folder: '核心线索', tags: ['邮戳', '时间'], pinned: true, createdAt: now, updatedAt: now }],
  writingLog: [],
}

try {
  await replaceDb(fixture)
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    await pool.query(
      'INSERT INTO users (id, name, email, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
      ['external-user', '并发作者', 'external@example.com', 'external-hash', now],
    )
    await pool.query(
      `INSERT INTO projects (id, user_id, title, type, genre, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ['external-project', 'external-user', '不相关作品', '短篇', '都市现实', '构思中', now, now],
    )
    await pool.query(
      `INSERT INTO chapters (project_id, chapter_id, position, title, outline, created_at, updated_at)
       VALUES ($1, $2, 0, $3, $4, $5, $6)`,
      ['external-project', '1', '外部章节', '这条记录不应被其他作品的更新删除。', now, now],
    )
    await pool.query(
      'INSERT INTO drafts (project_id, chapter_id, content, updated_at) VALUES ($1, $2, $3, $4)',
      ['external-project', '1', '保留这段正文。', now],
    )

    await updateDb((db) => {
      db.drafts['pg-project']['1'] = '雨落在旧港码头，灯塔忽明忽暗。'
      db.projects.find((project) => project.id === 'pg-project').status = '连载中'
    })
    const restored = await loadDb()
    assert.equal(storeInfo().backend, 'postgres-relational')
    assert.equal(storeInfo().schemaVersion, 2)
    assert.equal(restored.users.find((user) => user.id === 'pg-user').email, 'postgres@example.com')
    assert.equal(restored.sessions[0].userAgent, 'integration-test')
    assert.equal(restored.projects.find((project) => project.id === 'pg-project').title, '关系表验收')
    assert.equal(restored.chapters['pg-project'][0].outline, '主角发现异常来信。')
    assert.equal(restored.drafts['pg-project']['1'], '雨落在旧港码头，灯塔忽明忽暗。')
    assert.deepEqual(restored.ideas[0].tags, ['邮戳', '时间'])
    assert.equal(restored.agentThreads[0].id, 'pg-thread')
    assert.equal(restored.agentThreads[0].chapterId, '1')
    assert.equal(restored.projects.find((project) => project.id === 'external-project').title, '不相关作品')
    assert.equal(restored.drafts['external-project']['1'], '保留这段正文。')

    const counts = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM users) AS users,
      (SELECT COUNT(*)::int FROM sessions) AS sessions,
      (SELECT COUNT(*)::int FROM projects) AS projects,
      (SELECT COUNT(*)::int FROM chapters) AS chapters,
      (SELECT COUNT(*)::int FROM drafts) AS drafts,
      (SELECT COUNT(*)::int FROM ideas) AS ideas`)
    assert.deepEqual(counts.rows[0], { users: 2, sessions: 1, projects: 2, chapters: 2, drafts: 2, ideas: 1 })
    const state = await pool.query("SELECT data, schema_version FROM story_state WHERE state_key = 'default'")
    assert.equal(state.rows[0].schema_version, 2)
    for (const key of ['users', 'sessions', 'projects', 'chapters', 'drafts', 'ideas']) {
      assert.equal(Object.hasOwn(state.rows[0].data, key), false, `${key} must not remain in story_state JSONB`)
    }
    assert.equal(state.rows[0].data.agentThreads[0].id, 'pg-thread')
    await pool.query('DELETE FROM users WHERE id = $1', ['external-user'])
  } finally {
    await pool.end()
  }
  console.log('PostgreSQL relational integration test passed')
} finally {
  await closeStore()
}
