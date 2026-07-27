import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Redis = require('ioredis')

export const TASK_STREAM = 'ai-tasks:v1:stream'
export const TASK_GROUP = 'ai-task-workers:v1'
export const TASK_CANCEL_CHANNEL = 'ai-tasks:v1:cancel'

let producerPromise = null

export function isTaskQueueEnabled() {
  return Boolean(String(process.env.REDIS_URL || '').trim()) && process.env.AI_TASK_QUEUE_ENABLED !== 'false'
}

export function createTaskRedis(options = {}) {
  if (!isTaskQueueEnabled()) return null
  const client = new Redis(String(process.env.REDIS_URL).trim(), {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    ...options,
  })
  client.on('error', (error) => {
    if (process.env.NODE_ENV !== 'test') console.error('[ai-task-queue] redis error:', error.message)
  })
  return client
}

function producer() {
  if (!producerPromise) producerPromise = createTaskRedis()
  return producerPromise
}

export async function enqueueWritingTask(taskId) {
  if (!isTaskQueueEnabled()) return false
  try {
    await producer().xadd(TASK_STREAM, '*', 'taskId', taskId)
    return true
  } catch (error) {
    throw Object.assign(new Error(`AI 任务队列暂不可用：${error.message}`), { status: 503 })
  }
}

export async function publishTaskCancellation(taskId) {
  if (!isTaskQueueEnabled()) return false
  try {
    await producer().publish(TASK_CANCEL_CHANNEL, taskId)
    return true
  } catch {
    return false
  }
}

export async function closeTaskQueue() {
  if (!producerPromise) return
  const client = producerPromise
  producerPromise = null
  await client.quit().catch(() => client.disconnect())
}
