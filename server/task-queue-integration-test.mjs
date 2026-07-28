import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { closeStore, loadDb, replaceDb, updateDb } from './store.mjs'
import { closeTaskQueue, enqueueWritingTask } from './task-queue.mjs'

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required')
assert.ok(process.env.REDIS_URL, 'REDIS_URL is required')

const received = []
const aiServer = http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw || '{}')
  received.push(body)
  if (body.message === '停机恢复') await new Promise((resolve) => setTimeout(resolve, 1_000))
  const response = { status: 'completed', result: { output: 'worker 输出' } }
  if (req.url?.endsWith('/stream')) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write(`event: item/agentMessage/delta\ndata: ${JSON.stringify({ delta: 'worker ' })}\n\n`)
    res.end(`event: response/completed\ndata: ${JSON.stringify({ response })}\n\n`)
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(response))
})
await new Promise((resolve, reject) => {
  aiServer.once('error', reject)
  aiServer.listen(0, '127.0.0.1', resolve)
})

const now = new Date().toISOString()
const input = { skill: 'story', message: '继续写作', payload: { project_id: 'queue-project', chapter_id: '1' } }
await replaceDb({
  users: [{ id: 'queue-user', name: '队列作者', email: 'queue@example.com', passwordHash: 'test-hash', createdAt: now }],
  sessions: [],
  projects: [{ id: 'queue-project', userId: 'queue-user', title: '队列验收', type: '短篇', genre: '悬疑推理', status: '构思中', progress: 0, words: '4', updated: '刚刚', chapters: 1, style: '', tone: '追查旧港', cover: 'cover-new', isActive: true, createdAt: now, updatedAt: now }],
  chapters: { 'queue-project': [{ id: 1, title: '第一章', outline: '收到一封信。', words: '4', state: 'current', createdAt: now, updatedAt: now }] },
  drafts: { 'queue-project': { 1: '雨落旧港。' } },
  editHistory: { 'queue-project': { 1: [] } },
  writingSessions: {},
  writingTasks: [{ id: 'queue-task', userId: 'queue-user', projectId: 'queue-project', chapterId: '1', skill: 'story', message: input.message, input, requestKey: 'queue-request', parentTaskId: null, attempt: 1, status: 'queued', progress: 0, statusMessage: '任务已排队', result: null, error: null, errorCode: null, retryable: false, cancelRequested: false, createdAt: now, updatedAt: now }],
  foreshadows: [],
  storyMemories: [],
  ideas: [{ id: 'queue-idea', userId: 'queue-user', projectId: 'queue-project', label: '线索', title: '灯塔', body: '灯塔忽明忽暗。', color: 'teal', folder: '核心线索', tags: ['灯塔'], pinned: true, createdAt: now, updatedAt: now }],
  writingLog: [],
})

function startWorker() {
  return spawn(process.execPath, ['server/ai-worker.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, AI_SERVICE_URL: `http://127.0.0.1:${aiServer.address().port}`, AI_TASK_QUEUE_ENABLED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function waitForWorker(worker) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker startup timeout')), 10_000)
    worker.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('is ready')) {
        clearTimeout(timer)
        resolve()
      }
    })
    worker.stderr.on('data', (chunk) => reject(new Error(chunk.toString())))
    worker.on('exit', (code) => reject(new Error(`worker exited early: ${code}`)))
  })
}

async function stopWorker(worker) {
  if (!worker || worker.exitCode !== null) return
  worker.kill('SIGTERM')
  await new Promise((resolve) => worker.once('exit', resolve))
}

let worker = startWorker()

try {
  await waitForWorker(worker)
  await enqueueWritingTask('queue-task')
  await enqueueWritingTask('queue-task')
  let task
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    task = (await loadDb()).writingTasks.find((item) => item.id === 'queue-task')
    if (task?.status === 'completed') break
  }
  assert.equal(task?.status, 'completed')
  assert.equal(task.result.result.output, 'worker 输出')
  assert.equal(received.length, 1)
  assert.equal(received[0].payload.writing_context.chapter.outline, '收到一封信。')

  const recoveryInput = { ...input, message: '停机恢复' }
  await updateDb((db) => {
    db.writingTasks.push({
      id: 'recovery-task', userId: 'queue-user', projectId: 'queue-project', chapterId: '1',
      skill: 'story', message: recoveryInput.message, input: recoveryInput, requestKey: 'recovery-request',
      parentTaskId: null, attempt: 1, status: 'queued', progress: 0, statusMessage: '任务已排队',
      result: null, error: null, errorCode: null, retryable: false, cancelRequested: false,
      createdAt: now, updatedAt: now,
    })
  })
  await enqueueWritingTask('recovery-task')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    task = (await loadDb()).writingTasks.find((item) => item.id === 'recovery-task')
    if (task?.status === 'running') break
  }
  assert.equal(task?.status, 'running')
  await stopWorker(worker)
  assert.equal((await loadDb()).writingTasks.find((item) => item.id === 'recovery-task')?.status, 'queued')

  worker = startWorker()
  await waitForWorker(worker)
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    task = (await loadDb()).writingTasks.find((item) => item.id === 'recovery-task')
    if (task?.status === 'completed') break
  }
  assert.equal(task?.status, 'completed')
  assert.equal(received.filter((body) => body.message === '停机恢复').length, 2)
  console.log('Redis AI task worker integration test passed: deduplication and immediate shutdown recovery')
} finally {
  await stopWorker(worker)
  aiServer.close()
  await closeTaskQueue()
  await closeStore()
}
