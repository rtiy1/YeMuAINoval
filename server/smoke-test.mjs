import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'story-api-'))
const dataFile = path.join(tempDir, 'db.json')
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AUTH_SECRET: 'smoke-test-secret-with-enough-entropy', STORY_DATA_FILE: dataFile },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let baseUrl
let accessToken
let refreshHeader

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';')[0]
}

async function call(method, route, body, options = {}) {
  const headers = {}
  if (body) headers['content-type'] = 'application/json'
  if (accessToken && options.auth !== false) headers.authorization = `Bearer ${accessToken}`
  if (options.cookie) headers.cookie = options.cookie
  if (options.origin) headers.origin = options.origin
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = response.status === 204 ? null : await response.json()
  return { response, payload }
}

try {
  baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('API 启动超时')), 5000)
    child.stdout.on('data', (chunk) => {
      const match = chunk.toString().match(/Story API listening on (http:\/\/[^\s]+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    })
    child.stderr.on('data', (chunk) => reject(new Error(chunk.toString())))
    child.on('exit', (code) => reject(new Error(`API 提前退出：${code}`)))
  })

  const health = await call('GET', '/api/health', null, { auth: false })
  assert.equal(health.response.status, 200)
  assert.equal(health.payload.users, 0)

  const sameOrigin = await call('POST', '/api/auth/refresh', null, { auth: false, origin: baseUrl })
  assert.equal(sameOrigin.response.status, 401)
  const foreignOrigin = await call('POST', '/api/auth/refresh', null, { auth: false, origin: 'https://invalid.example' })
  assert.equal(foreignOrigin.response.status, 403)

  const anonymous = await call('GET', '/api/projects', null, { auth: false })
  assert.equal(anonymous.response.status, 401)

  const invalid = await call('POST', '/api/auth/register', { name: '测试', email: 'bad-email', password: 'password123' }, { auth: false })
  assert.equal(invalid.response.status, 400)

  const registered = await call('POST', '/api/auth/register', { name: '第一作者', email: 'author@example.com', password: 'password123' }, { auth: false })
  assert.equal(registered.response.status, 201)
  assert.equal(registered.payload.user.email, 'author@example.com')
  assert.equal(registered.payload.user.passwordHash, undefined)
  accessToken = registered.payload.accessToken
  refreshHeader = cookieFrom(registered.response)
  assert.ok(refreshHeader?.startsWith('story_refresh='))

  const seededProjects = await call('GET', '/api/projects')
  assert.equal(seededProjects.payload.projects.length, 1)
  assert.equal(seededProjects.payload.projects[0].title, '我的第一本书')
  const privateProjectId = seededProjects.payload.projects[0].id

  const refreshed = await call('POST', '/api/auth/refresh', null, { auth: false, cookie: refreshHeader })
  assert.equal(refreshed.response.status, 200)
  accessToken = refreshed.payload.accessToken
  refreshHeader = cookieFrom(refreshed.response)

  const created = await call('POST', '/api/projects', { title: '自动化测试作品', type: '短篇', genre: '悬疑推理' })
  assert.equal(created.response.status, 201)
  const projectId = created.payload.project.id

  const initialChapters = await call('GET', `/api/projects/${projectId}/chapters`)
  assert.equal(initialChapters.response.status, 200)
  assert.equal(initialChapters.payload.chapters.length, 1)
  const firstChapterId = initialChapters.payload.chapters[0].id
  assert.equal((await call('PATCH', `/api/projects/${projectId}/chapters/${firstChapterId}`, { title: '第一章 雨夜' })).response.status, 200)

  const draft = await call('PUT', `/api/projects/${projectId}/chapters/${firstChapterId}/draft`, { content: '雨落下来。真相仍在门后。' })
  assert.equal(draft.response.status, 200)
  assert.equal(draft.payload.project.words, '12')
  assert.equal(draft.payload.chapter.words, '12')
  assert.equal(draft.payload.stats.todayWords, 12)

  const secondChapter = await call('POST', `/api/projects/${projectId}/chapters`, { title: '第二章 门后' })
  assert.equal(secondChapter.response.status, 201)
  const secondDraft = await call('PUT', `/api/projects/${projectId}/chapters/${secondChapter.payload.chapter.id}/draft`, { content: '第二章内容' })
  assert.equal(secondDraft.response.status, 200)
  assert.equal(secondDraft.payload.project.words, '17')
  assert.equal((await call('GET', `/api/projects/${projectId}/chapters/${firstChapterId}/draft`)).payload.content, '雨落下来。真相仍在门后。')
  assert.equal((await call('GET', `/api/projects/${projectId}/chapters/${secondChapter.payload.chapter.id}/draft`)).payload.content, '第二章内容')

  const dashboard = await call('GET', '/api/dashboard')
  assert.equal(dashboard.response.status, 200)
  assert.ok(dashboard.payload.stats.projectCount >= 2)
  assert.ok(dashboard.payload.stats.chapterCount >= 3)
  assert.equal(dashboard.payload.stats.todayWords, 17)

  const imported = await call('POST', '/api/projects/import', {
    title: '导入测试作品', type: '长篇', genre: '都市现实',
    chapters: [{ title: '序章', content: '这是序章。' }, { title: '第一章 归来', content: '城市灯火重新亮起。' }],
  })
  assert.equal(imported.response.status, 201)
  assert.equal(imported.payload.chapters.length, 2)
  assert.equal(imported.payload.project.chapters, 2)
  assert.equal(imported.payload.project.words, '14')
  assert.equal((await call('GET', `/api/projects/${imported.payload.project.id}/chapters/2/draft`)).payload.content, '城市灯火重新亮起。')
  assert.equal((await call('DELETE', `/api/projects/${imported.payload.project.id}`)).response.status, 204)

  const idea = await call('POST', '/api/ideas', { label: '线索', title: '反锁的门', body: '门从里面反锁，但屋里没有人。', projectId, folder: '第一卷', tags: ['密室', '伏笔'] })
  assert.equal(idea.response.status, 201)
  assert.deepEqual(idea.payload.idea.tags, ['密室', '伏笔'])
  const pinnedIdea = await call('PATCH', `/api/ideas/${idea.payload.idea.id}`, { pinned: true, folder: '核心线索' })
  assert.equal(pinnedIdea.response.status, 200)
  assert.equal(pinnedIdea.payload.idea.pinned, true)
  assert.equal((await call('GET', '/api/ideas')).payload.ideas[0].folder, '核心线索')
  assert.equal((await call('DELETE', `/api/projects/${projectId}`)).response.status, 204)

  const second = await call('POST', '/api/auth/register', { name: '第二作者', email: 'second@example.com', password: 'password456' }, { auth: false })
  assert.equal(second.response.status, 201)
  accessToken = second.payload.accessToken
  const secondProjects = await call('GET', '/api/projects')
  assert.equal(secondProjects.payload.projects.length, 1)
  assert.equal((await call('GET', `/api/projects/${privateProjectId}`)).response.status, 404)

  const loggedIn = await call('POST', '/api/auth/login', { email: 'author@example.com', password: 'password123' }, { auth: false })
  assert.equal(loggedIn.response.status, 200)
  accessToken = loggedIn.payload.accessToken
  refreshHeader = cookieFrom(loggedIn.response)
  assert.equal((await call('GET', '/api/projects')).payload.projects.length, 1)

  const loggedOut = await call('POST', '/api/auth/logout', null, { auth: false, cookie: refreshHeader })
  assert.equal(loggedOut.response.status, 204)
  assert.equal((await call('POST', '/api/auth/refresh', null, { auth: false, cookie: refreshHeader })).response.status, 401)

  console.log('API smoke test passed: auth, refresh rotation, isolation, validation, CRUD, logout')
} finally {
  child.kill('SIGTERM')
  await rm(tempDir, { recursive: true, force: true })
}
