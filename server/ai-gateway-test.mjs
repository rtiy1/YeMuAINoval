import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolvePython } from './python-path.mjs'

const root = path.join(import.meta.dirname, '..')
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'story-gateway-'))
const processes = []

function start(command, args, env) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  processes.push(child)
  return child
}

function waitForUrl(child, pattern, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(timeoutMessage)), 10_000)
    const inspect = (chunk) => {
      const match = chunk.toString().match(pattern)
      if (match) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.on('exit', (code) => reject(new Error(`服务提前退出：${code}`)))
  })
}

try {
  const ai = start(
    resolvePython(root),
    ['-m', 'uvicorn', 'app.main:app', '--app-dir', 'ai-service', '--host', '127.0.0.1', '--port', '0', '--no-use-colors'],
    { AI_SERVICE_TOKEN: 'integration-service-token', OPENAI_API_KEY: '' },
  )
  const aiUrl = await waitForUrl(ai, /Uvicorn running on (http:\/\/[^\s]+)/, 'AI 服务启动超时')

  const api = start(process.execPath, ['server/index.mjs'], {
    HOST: '127.0.0.1',
    PORT: '0',
    AUTH_SECRET: 'integration-auth-secret-with-enough-entropy',
    STORY_DATA_FILE: path.join(tempDir, 'db.json'),
    AI_SERVICE_URL: aiUrl,
    AI_SERVICE_TOKEN: 'integration-service-token',
  })
  const apiUrl = await waitForUrl(api, /Story API listening on (http:\/\/[^\s]+)/, 'API 网关启动超时')

  const registration = await fetch(`${apiUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '集成测试', email: 'integration@example.com', password: 'password123' }),
  })
  assert.equal(registration.status, 201)
  const session = await registration.json()

  const settingsResponse = await fetch(`${apiUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({
      apiBaseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'fake-user-model-key',
      model: 'integration-invalid-model',
      maxTokens: 64,
      contextWindow: 2048,
    }),
  })
  assert.equal(settingsResponse.status, 200)

  const configuredRun = await fetch(`${apiUrl}/api/ai/agent/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({
      message: '帮我写一份长篇大纲',
      skill: 'story-long-write',
      payload: { genre: '悬疑' },
    }),
  })
  const configuredPayload = await configuredRun.json()
  assert.equal(configuredRun.status, 200)
  assert.equal(configuredPayload.status, 'failed')
  assert.notEqual(configuredPayload.status, 'needs_model')

  const skillsResponse = await fetch(`${apiUrl}/api/ai/skills`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  })
  const skillsPayload = await skillsResponse.json()
  assert.equal(skillsResponse.status, 200)
  assert.equal(skillsPayload.skills.find((skill) => skill.name === 'story-review').status, 'ready')

  const agentRun = await fetch(`${apiUrl}/api/ai/agent/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({
      message: '审查这一章',
      skill: 'story-review',
      payload: { title: '雨夜', genre: '悬疑', platform: '番茄', content: '雨落下来。门从里面反锁，但屋里没有人。' },
    }),
  })
  const agentPayload = await agentRun.json()
  assert.equal(agentRun.status, 200)
  assert.equal(agentPayload.selected_skill, 'story-review')
  assert.equal(agentPayload.result.Rubric, 'fanqie')

  const review = await fetch(`${apiUrl}/api/ai/reviews/chapter`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({ title: '雨夜', genre: '悬疑', content: '雨落下来。门从里面反锁，但屋里没有人。' }),
  })
  const payload = await review.json()
  assert.equal(review.status, 200)
  assert.equal(payload.status, 'completed')
  assert.equal(payload.result.metrics.characters, 19)
  console.log('AI gateway integration passed: account -> Node auth -> Story Agent -> Skill capability -> LangGraph result')
} finally {
  for (const child of processes.reverse()) child.kill('SIGTERM')
  await rm(tempDir, { recursive: true, force: true })
}
