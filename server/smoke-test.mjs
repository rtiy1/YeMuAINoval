import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'story-api-'))
const dataFile = path.join(tempDir, 'db.json')
const aiServer = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !['/v1/assistants/writing/proposal', '/v1/agents/story'].includes(req.url)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'not found' }))
    return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw || '{}')
  if (req.url === '/v1/agents/story') {
    if (String(body.message || '').includes('取消任务')) await new Promise((resolve) => setTimeout(resolve, 300))
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'completed', route: 'story', selected_skill: body.skill || 'story', result: { output: '测试 AI 输出' } }))
    return
  }
  const requirements = body.requirements || {}
  const payload = {
    status: 'completed', phase: 'awaiting_confirmation', missing: [],
    reply: '建书方案已经准备好，请确认后创建。',
    selected_skill: requirements.type === '短篇' ? 'story-short-write' : 'story-long-write',
    proposal: {
      title: '雾港回声', type: requirements.type, genre: requirements.genre, style: requirements.style,
      tone: requirements.premise,
      chapters: [{ title: '第一章 来信', content: '主角收到一封来自失踪记者的信，并发现日期来自未来。' }, { title: '第二章 旧港', content: '主角前往封闭的旧港寻找第一条线索。' }, { title: '第三章 回声', content: '谎言被揭开一角，新的追踪者出现。' }],
    },
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
})
await new Promise((resolve, reject) => {
  aiServer.once('error', reject)
  aiServer.listen(0, '127.0.0.1', resolve)
})
const aiAddress = aiServer.address()
const aiServiceUrl = `http://127.0.0.1:${aiAddress.port}`
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AUTH_SECRET: 'smoke-test-secret-with-enough-entropy', STORY_DATA_FILE: dataFile, AI_SERVICE_URL: aiServiceUrl },
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
  assert.equal(health.payload.storage.backend, 'json')

  const sameOrigin = await call('POST', '/api/auth/refresh', null, { auth: false, origin: baseUrl })
  assert.equal(sameOrigin.response.status, 401)
  const foreignOrigin = await call('POST', '/api/auth/refresh', null, { auth: false, origin: 'https://invalid.example' })
  assert.equal(foreignOrigin.response.status, 403)
  if (process.env.CODESPACES === 'true' && process.env.CODESPACE_NAME) {
    const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'
    const codespacesOrigin = await call('POST', '/api/auth/refresh', null, { auth: false, origin: `https://${process.env.CODESPACE_NAME}-5173.${domain}` })
    assert.equal(codespacesOrigin.response.status, 401)
  }

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

  assert.equal((await call('POST', '/api/projects', { title: '无效篇幅', type: '超长篇', genre: '悬疑推理' })).response.status, 400)
  assert.equal((await call('PATCH', `/api/projects/${projectId}`, { type: '超长篇' })).response.status, 400)
  assert.equal((await call('PATCH', `/api/projects/${projectId}`, { status: '暂停更新' })).response.status, 400)

  assert.equal((await call('PUT', '/api/settings', { apiBaseUrl: 'ftp://invalid.example/v1' })).response.status, 400)
  assert.equal((await call('PUT', '/api/settings', { apiBaseUrl: 'https://user:password@example.com/v1' })).response.status, 400)

  assert.equal((await call('GET', '/api/writing-assistant/session')).payload.session, null)
  const assistantStart = await call('POST', '/api/writing-assistant/messages', { message: '我想写一本小说' })
  assert.equal(assistantStart.payload.phase, 'collecting_requirements')
  assert.deepEqual(assistantStart.payload.missing, ['type', 'genre', 'style', 'premise'])
  const assistantType = await call('POST', '/api/writing-assistant/messages', { message: '短篇' })
  assert.equal(assistantType.payload.requirements.type, '短篇')
  const assistantGenre = await call('POST', '/api/writing-assistant/messages', { message: '悬疑推理' })
  assert.equal(assistantGenre.payload.requirements.genre, '悬疑推理')
  const assistantStyle = await call('POST', '/api/writing-assistant/messages', { message: '克苏鲁悬疑' })
  assert.equal(assistantStyle.payload.requirements.style, '克苏鲁悬疑')
  const assistantProposal = await call('POST', '/api/writing-assistant/messages', { message: '失踪记者留下三封来自未来的信，主角必须在旧港找到真相。' })
  assert.equal(assistantProposal.response.status, 200)
  assert.equal(assistantProposal.payload.phase, 'awaiting_confirmation')
  assert.equal(assistantProposal.payload.selectedSkill, 'story-short-write')
  assert.equal(assistantProposal.payload.proposal.style, '克苏鲁悬疑')
  const assistantSessionId = assistantProposal.payload.session.id
  const assistantCreated = await call('POST', '/api/writing-assistant/confirm', { sessionId: assistantSessionId, proposal: assistantProposal.payload.proposal })
  assert.equal(assistantCreated.response.status, 201)
  assert.equal(assistantCreated.payload.project.style, '克苏鲁悬疑')
  assert.equal(assistantCreated.payload.chapters.length, 3)
  const assistantDuplicate = await call('POST', '/api/writing-assistant/confirm', { sessionId: assistantSessionId, proposal: assistantProposal.payload.proposal })
  assert.equal(assistantDuplicate.response.status, 200)
  assert.equal(assistantDuplicate.payload.project.id, assistantCreated.payload.project.id)
  assert.equal((await call('DELETE', `/api/projects/${assistantCreated.payload.project.id}`)).response.status, 204)
  assert.equal((await call('DELETE', '/api/writing-assistant/session')).response.status, 204)

  const initialChapters = await call('GET', `/api/projects/${projectId}/chapters`)
  assert.equal(initialChapters.response.status, 200)
  assert.equal(initialChapters.payload.chapters.length, 1)
  const firstChapterId = initialChapters.payload.chapters[0].id
  assert.equal((await call('PATCH', `/api/projects/${projectId}/chapters/${firstChapterId}`, { title: '第一章 雨夜' })).response.status, 200)
  assert.equal((await call('PATCH', `/api/projects/${projectId}/chapters/${firstChapterId}`, { state: 'published' })).response.status, 400)

  const draft = await call('PUT', `/api/projects/${projectId}/chapters/${firstChapterId}/draft`, { content: '雨落下来。真相仍在门后。' })
  assert.equal(draft.response.status, 200)
  assert.equal(draft.payload.project.words, '12')
  assert.equal(draft.payload.chapter.words, '12')
  assert.equal(draft.payload.stats.todayWords, 12)

  const historySnapshot = await call('POST', `/api/projects/${projectId}/chapters/${firstChapterId}/history`, { content: '雨落下来。' })
  assert.equal(historySnapshot.response.status, 201)
  const duplicateSnapshot = await call('POST', `/api/projects/${projectId}/chapters/${firstChapterId}/history`, { content: '雨落下来。' })
  assert.equal(duplicateSnapshot.response.status, 200)
  assert.equal(duplicateSnapshot.payload.duplicate, true)
  const persistedHistory = await call('GET', `/api/projects/${projectId}/chapters/${firstChapterId}/history`)
  assert.equal(persistedHistory.payload.snapshots.length, 1)
  assert.equal(persistedHistory.payload.snapshots[0].content, '雨落下来。')

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

  const beforeInvalidSmart = (await call('GET', '/api/projects')).payload.projects.length
  const invalidSmart = await call('POST', '/api/projects/smart', { title: '不完整方案', genre: '悬疑', tone: '寻找真相', chapters: [] })
  assert.equal(invalidSmart.response.status, 400)
  assert.equal((await call('GET', '/api/projects')).payload.projects.length, beforeInvalidSmart)
  const smart = await call('POST', '/api/projects/smart', {
    title: '雾港来信', type: '长篇', genre: '悬疑推理', style: '克苏鲁悬疑', tone: '失踪记者留下三封互相矛盾的信。',
    chapters: [{ title: '第一章 无人来信', content: '主角收到第一封信，并发现邮戳来自未来。' }, { title: '第二章 旧港', content: '主角回到封闭多年的旧港调查。' }],
  })
  assert.equal(smart.response.status, 201)
  assert.equal(smart.payload.chapters.length, 2)
  assert.equal(smart.payload.project.title, '雾港来信')
  assert.equal(smart.payload.project.style, '克苏鲁悬疑')
  assert.equal(smart.payload.chapters[0].outline, '主角收到第一封信，并发现邮戳来自未来。')
  assert.equal((await call('GET', `/api/projects/${smart.payload.project.id}/chapters/1/draft`)).payload.content, '')

  const smartIdea = await call('POST', '/api/ideas', { label: '线索', title: '未来邮戳', body: '邮戳日期比寄信日早三天。', projectId: smart.payload.project.id, pinned: true })
  assert.equal(smartIdea.response.status, 201)
  const smartForeshadow = await call('POST', '/api/foreshadows', { projectId: smart.payload.project.id, title: '第三封信', content: '第三封信会揭示失踪记者的真实身份。', status: 'planted', importance: 5, plantChapterId: '1', targetChapterId: '2' })
  assert.equal(smartForeshadow.response.status, 201)
  const smartContext = await call('GET', `/api/projects/${smart.payload.project.id}/chapters/2/context`)
  assert.equal(smartContext.response.status, 200)
  assert.equal(smartContext.payload.context.chapter.outline, '主角回到封闭多年的旧港调查。')
  assert.equal(smartContext.payload.context.materials[0].title, '未来邮戳')
  assert.equal(smartContext.payload.context.unresolvedForeshadows[0].title, '第三封信')
  assert.equal((await call('DELETE', `/api/projects/${smart.payload.project.id}`)).response.status, 204)

  const idea = await call('POST', '/api/ideas', { label: '线索', title: '反锁的门', body: '门从里面反锁，但屋里没有人。', projectId, folder: '第一卷', tags: ['密室', '伏笔'] })
  assert.equal(idea.response.status, 201)
  assert.deepEqual(idea.payload.idea.tags, ['密室', '伏笔'])
  const pinnedIdea = await call('PATCH', `/api/ideas/${idea.payload.idea.id}`, { pinned: true, folder: '核心线索' })
  assert.equal(pinnedIdea.response.status, 200)
  assert.equal(pinnedIdea.payload.idea.pinned, true)
  assert.equal((await call('GET', '/api/ideas')).payload.ideas[0].folder, '核心线索')

  const foreshadow = await call('POST', '/api/foreshadows', { projectId, title: '门后的回声', content: '每次雨夜都能听见门后传来三下敲门声。', category: '案件线索', importance: 4, plantChapterId: String(firstChapterId), targetChapterId: String(secondChapter.payload.chapter.id) })
  assert.equal(foreshadow.response.status, 201)
  assert.equal(foreshadow.payload.foreshadow.status, 'planned')
  const foreshadows = await call('GET', `/api/foreshadows?projectId=${projectId}`)
  assert.equal(foreshadows.response.status, 200)
  assert.equal(foreshadows.payload.foreshadows[0].title, '门后的回声')
  const plantedForeshadow = await call('PATCH', `/api/foreshadows/${foreshadow.payload.foreshadow.id}`, { status: 'planted' })
  assert.equal(plantedForeshadow.payload.foreshadow.status, 'planted')
  const resolvedForeshadow = await call('PATCH', `/api/foreshadows/${foreshadow.payload.foreshadow.id}`, { status: 'resolved', chapterId: String(secondChapter.payload.chapter.id) })
  assert.equal(resolvedForeshadow.payload.foreshadow.status, 'resolved')
  assert.equal(resolvedForeshadow.payload.foreshadow.resolvedChapterId, String(secondChapter.payload.chapter.id))
  assert.equal((await call('GET', `/api/foreshadows?projectId=${projectId}&status=resolved`)).payload.foreshadows.length, 1)
  const resolvedAtCreation = await call('POST', '/api/foreshadows', { projectId, title: '旧照片', content: '照片背后的日期解释了失踪时间。', status: 'resolved', resolvedChapterId: String(secondChapter.payload.chapter.id) })
  assert.equal(resolvedAtCreation.payload.foreshadow.resolvedChapterId, String(secondChapter.payload.chapter.id))
  assert.equal((await call('DELETE', `/api/foreshadows/${resolvedAtCreation.payload.foreshadow.id}`)).response.status, 204)
  assert.equal((await call('DELETE', `/api/projects/${projectId}/chapters/${secondChapter.payload.chapter.id}`)).response.status, 204)
  const cleanedForeshadow = await call('GET', `/api/foreshadows?projectId=${projectId}`)
  assert.equal(cleanedForeshadow.payload.foreshadows[0].status, 'planted')
  assert.equal(cleanedForeshadow.payload.foreshadows[0].targetChapterId, null)
  assert.equal(cleanedForeshadow.payload.foreshadows[0].resolvedChapterId, null)

  const task = await call('POST', '/api/ai/tasks', { skill: 'story', message: '继续写作', payload: { project_id: projectId, chapter_id: String(firstChapterId), content: '雨落下来。' } })
  assert.equal(task.response.status, 202)
  assert.equal(task.payload.task.status, 'queued')
  let completedTask
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    completedTask = await call('GET', `/api/ai/tasks/${task.payload.task.id}`)
    if (['completed', 'failed', 'cancelled'].includes(completedTask.payload.task.status)) break
  }
  assert.equal(completedTask.payload.task.status, 'completed')
  assert.equal(completedTask.payload.task.result.result.output, '测试 AI 输出')
  const cancelTask = await call('POST', '/api/ai/tasks', { skill: 'story', message: '取消任务', payload: { project_id: projectId, chapter_id: String(firstChapterId) } })
  assert.equal(cancelTask.response.status, 202)
  const cancelled = await call('POST', `/api/ai/tasks/${cancelTask.payload.task.id}/cancel`)
  assert.equal(cancelled.response.status, 200)
  assert.equal(cancelled.payload.task.status, 'cancelled')

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
  aiServer.close()
  await rm(tempDir, { recursive: true, force: true })
}
