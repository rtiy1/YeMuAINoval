import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: '0',
    AUTH_SECRET: 'queue-config-test-secret-with-enough-entropy',
    DATABASE_URL: '',
    REDIS_URL: 'redis://127.0.0.1:1/0',
    AI_TASK_QUEUE_ENABLED: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
const exitCode = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    child.kill('SIGTERM')
    reject(new Error('queue configuration check timed out'))
  }, 5_000)
  child.once('exit', (code) => {
    clearTimeout(timeout)
    resolve(code)
  })
})

assert.notEqual(exitCode, 0)
assert.match(stderr, /Redis AI task queue requires DATABASE_URL/)
console.log('Task queue configuration test passed: Redis workers require PostgreSQL state')
