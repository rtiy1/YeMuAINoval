import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { normalizeWritingSession, serializeSession, getSession, setSession, deleteSession, closeClient, isRedisEnabled } from '../server/chat-memory.mjs'

const REDIS_TEST_URL = process.env.REDIS_TEST_URL || ''

test('normalizeWritingSession fills defaults and caps messages', () => {
  const normalized = normalizeWritingSession({ id: 's1', phase: 'weird', messages: [{ role: 'user', text: 'a' }, { text: 'b' }] }, 'u1')
  assert.equal(normalized.phase, 'collecting_requirements')
  assert.equal(normalized.userId, 'u1')
  assert.equal(normalized.messages.length, 2)
  assert.equal(normalized.messages[0].role, 'user')
  assert.equal(normalized.messages[1].role, 'user')
  assert.deepEqual(normalized.requirements, { type: '', genre: '', style: '', premise: '', platform: '', title: '' })
  assert.equal(normalized.projectId, null)
})

test('normalizeWritingSession caps to 20 messages and clamps text', () => {
  const messages = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, role: 'user', text: String(i), createdAt: 't' }))
  const normalized = normalizeWritingSession({ id: 's2', messages }, 'u2')
  assert.equal(normalized.messages.length, 20)
  assert.equal(normalized.messages[0].text, '5')
})

test('serializeSession round-trips through normalizeWritingSession', () => {
  const session = { id: 's3', userId: 'u3', phase: 'awaiting_confirmation', messages: [{ id: 'm', role: 'assistant', text: 'hi', createdAt: 't' }], requirements: { type: '短篇' }, proposal: { title: 'X' }, projectId: 'p1' }
  const parsed = JSON.parse(serializeSession(session))
  const restored = normalizeWritingSession(parsed.session, 'u3')
  assert.equal(restored.phase, 'awaiting_confirmation')
  assert.equal(restored.projectId, 'p1')
  assert.equal(restored.proposal.title, 'X')
})

test('normalizeWritingSession returns null for invalid input', () => {
  assert.equal(normalizeWritingSession(null, 'u'), null)
  assert.equal(normalizeWritingSession('nope', 'u'), null)
})

// ---- 以下为真实 Redis 集成测试，仅当 REDIS_TEST_URL 提供时运行 ----
const redisIt = REDIS_TEST_URL ? test : test.skip

redisIt('setSession/getSession/deleteSession round-trip against live Redis', async () => {
  process.env.REDIS_URL = REDIS_TEST_URL
  const { isRedisEnabled: enabled } = await import('../server/chat-memory.mjs')
  assert.equal(enabled(), true)
  const session = { id: 'live-1', userId: 'live-user', phase: 'collecting_requirements', messages: [{ id: 'm1', role: 'user', text: '你好', createdAt: 'now' }] }
  await setSession('live-user', session)
  const fetched = await getSession('live-user')
  assert.equal(fetched.id, 'live-1')
  assert.equal(fetched.messages[0].text, '你好')
  await deleteSession('live-user')
  assert.equal(await getSession('live-user'), null)
  await closeClient()
})

function startMockAi() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || !['/v1/assistants/writing/turn', '/v1/assistants/writing/proposal'].includes(req.url)) {
        res.writeHead(404).end('{}'); return
      }
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw || '{}')
      const reqs = body.requirements || {}
      const values = { type: '', genre: '', style: '', premise: '', ...reqs }
      const msg = String(body.message || '')
      if (!values.type && msg.includes('短篇')) values.type = '短篇'
      else if (!values.genre && values.type) values.genre = '悬疑'
      else if (!values.style && values.genre) values.style = '克苏鲁'
      else if (!values.premise && values.style) values.premise = msg
      const missing = ['type', 'genre', 'style', 'premise'].filter((f) => !values[f])
      if (missing.length) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'needs_input', phase: 'collecting_requirements', reply: '继续', selected_skill: 'story-short-write', route: 't', requirements: values, missing, questions: [] })); return }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'completed', phase: 'awaiting_confirmation', missing: [], reply: '方案好了', selected_skill: 'story-short-write', route: 't', requirements: values, proposal: { title: '雾港', type: '短篇', genre: values.genre, style: values.style, tone: values.premise, chapters: [{ title: '一', content: 'a' }, { title: '二', content: 'b' }] } }))
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function spawnApi(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/index.mjs'], { cwd: path.join(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timeout = setTimeout(() => reject(new Error('API 启动超时')), 6000)
    child.stdout.on('data', (chunk) => {
      const match = chunk.toString().match(/Story API listening on (http:\/\/[^\s]+)/)
      if (match) { clearTimeout(timeout); resolve({ child, baseUrl: match[1] }) }
    })
    child.stderr.on('data', (chunk) => reject(new Error(chunk.toString())))
    child.on('exit', (code) => reject(new Error(`API 提前退出：${code}`)))
  })
}

async function call(baseUrl, token, method, route, body) {
  const headers = {}
  if (body) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${baseUrl}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const payload = response.status === 204 ? null : await response.json()
  return { response, payload }
}

redisIt('writing-assistant session survives Node restart via Redis', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'story-redis-'))
  const dataFile = path.join(tempDir, 'db.json')
  const { server: aiServer, port: aiPort } = await startMockAi()
  const baseEnv = {
    ...process.env,
    REDIS_URL: REDIS_TEST_URL,
    PORT: '0',
    HOST: '127.0.0.1',
    AUTH_SECRET: 'redis-test-secret-with-enough-entropy-xxxx',
    STORY_DATA_FILE: dataFile,
    AI_SERVICE_URL: `http://127.0.0.1:${aiPort}`,
    EMAIL_PROVIDER: 'test',
    EMAIL_VERIFICATION_EXPOSE_CODE: 'true',
  }
  try {
    const apiEnv = { ...baseEnv, NODE_ENV: 'test' }
    let { child, baseUrl } = await spawnApi(apiEnv)
    try {
      const code = await call(baseUrl, null, 'POST', '/api/auth/register/code', { email: 'r@e.com' })
      const reg = await call(baseUrl, null, 'POST', '/api/auth/register', { name: 'r', email: 'r@e.com', password: 'password123', verificationCode: code.payload.verificationCode })
      const token = reg.payload.accessToken
      await call(baseUrl, token, 'POST', '/api/writing-assistant/messages', { message: '我想写一本短篇' })
      await call(baseUrl, token, 'POST', '/api/writing-assistant/messages', { message: '悬疑' })
      const before = await call(baseUrl, token, 'GET', '/api/writing-assistant/session')
      assert.ok(before.payload.session.messages.length >= 2)
      const beforeTexts = before.payload.session.messages.map((m) => m.text)
    } finally {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.on('exit', resolve))
    }

    // 重启 Node：Redis 应保留了会话，刷新后仍可恢复
    const restarted = await spawnApi(apiEnv)
    try {
      const login = await call(restarted.baseUrl, null, 'POST', '/api/auth/login', { email: 'r@e.com', password: 'password123' })
      const token = login.payload.accessToken
      const after = await call(restarted.baseUrl, token, 'GET', '/api/writing-assistant/session')
      assert.ok(after.payload.session, '重启后会话应从 Redis 恢复')
      assert.ok(after.payload.session.messages.length >= 2, '历史消息应被持久化')
    } finally {
      restarted.child.kill('SIGTERM')
      await new Promise((resolve) => restarted.child.on('exit', resolve))
    }
  } finally {
    aiServer.close()
    await rm(tempDir, { recursive: true, force: true })
  }
})
