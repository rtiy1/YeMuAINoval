import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'story-registration-'))
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: {
    ...process.env,
    NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1', AUTH_SECRET: 'registration-test-secret-with-enough-entropy',
    STORY_DATA_FILE: path.join(tempDir, 'db.json'), AI_TASK_QUEUE_ENABLED: 'false',
    REGISTRATION_MODE: 'owner-only', ALLOW_SHARED_MODEL_KEY: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

try {
  const baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('API startup timeout')), 5_000)
    child.stdout.on('data', (chunk) => {
      const match = chunk.toString().match(/Story API listening on (http:\/\/[^\s]+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    })
    child.stderr.on('data', (chunk) => reject(new Error(chunk.toString())))
    child.on('exit', (code) => reject(new Error(`API exited early: ${code}`)))
  })
  const register = (name, email) => fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'password123' }),
  })
  assert.equal((await register('站长', 'owner@example.com')).status, 201)
  const second = await register('其他作者', 'writer@example.com')
  assert.equal(second.status, 403)
  assert.equal((await second.json()).error, '当前站点未开放注册')
  console.log('Registration mode test passed: owner-only closes after the first account')
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }
  await rm(tempDir, { recursive: true, force: true })
}
