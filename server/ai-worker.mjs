import crypto from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { executeWritingTask } from './writing-task-executor.mjs'
import { createTaskRedis, isTaskQueueEnabled, TASK_CANCEL_CHANNEL, TASK_GROUP, TASK_STREAM } from './task-queue.mjs'
import { closeStore } from './store.mjs'

if (!isTaskQueueEnabled()) {
  console.error('REDIS_URL is required and AI_TASK_QUEUE_ENABLED must not be false')
  process.exit(1)
}

const consumer = `${process.env.HOSTNAME || 'worker'}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
const redis = createTaskRedis()
const subscriber = createTaskRedis()
let stopping = false
let activeTaskId = null
let activeController = null
let nextClaimAt = 0
const claimIdleMs = Math.max(180_000, Number(process.env.AI_TASK_CLAIM_IDLE_MS) || 180_000)
const claimIntervalMs = Math.max(10_000, Number(process.env.AI_TASK_CLAIM_INTERVAL_MS) || 30_000)
const heartbeatFile = '/tmp/story-ai-worker-ready'

await redis.xgroup('CREATE', TASK_STREAM, TASK_GROUP, '0', 'MKSTREAM').catch((error) => {
  if (!String(error.message).includes('BUSYGROUP')) throw error
})
await subscriber.subscribe(TASK_CANCEL_CHANNEL)
subscriber.on('message', (_channel, taskId) => {
  if (taskId === activeTaskId) activeController?.abort()
})

function taskIdFromEntry(entry) {
  const fields = entry?.[1] || []
  const index = fields.indexOf('taskId')
  return index >= 0 ? fields[index + 1] : null
}

async function processEntry(entry, { resumeRunning = false } = {}) {
  const messageId = entry[0]
  const taskId = taskIdFromEntry(entry)
  if (taskId) {
    activeTaskId = taskId
    activeController = new AbortController()
    const outcome = await executeWritingTask(taskId, { controller: activeController, requeueOnAbort: true, resumeRunning })
    activeTaskId = null
    activeController = null
    if (outcome?.status === 'requeued') await redis.xadd(TASK_STREAM, '*', 'taskId', taskId)
  }
  await redis.xack(TASK_STREAM, TASK_GROUP, messageId)
  await redis.xdel(TASK_STREAM, messageId)
}

async function claimStaleTasks() {
  let cursor = '0-0'
  do {
    const claimed = await redis.xautoclaim(TASK_STREAM, TASK_GROUP, consumer, claimIdleMs, cursor, 'COUNT', 10)
    cursor = claimed[0]
    for (const entry of claimed[1] || []) await processEntry(entry, { resumeRunning: true })
  } while (cursor !== '0-0' && !stopping)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true
    activeController?.abort()
  })
}

console.log(`AI task worker ${consumer} is ready`)
await writeFile(heartbeatFile, new Date().toISOString(), 'utf8')
const heartbeat = setInterval(() => {
  void writeFile(heartbeatFile, new Date().toISOString(), 'utf8')
}, 10_000)
await claimStaleTasks()
nextClaimAt = Date.now() + claimIntervalMs
while (!stopping) {
  if (Date.now() >= nextClaimAt) {
    await claimStaleTasks()
    nextClaimAt = Date.now() + claimIntervalMs
  }
  const batches = await redis.xreadgroup('GROUP', TASK_GROUP, consumer, 'COUNT', 1, 'BLOCK', 5000, 'STREAMS', TASK_STREAM, '>')
    .catch((error) => {
      if (!stopping) console.error('[ai-task-worker] read failed:', error.message)
      return null
    })
  for (const [, entries] of batches || []) {
    for (const entry of entries) await processEntry(entry)
  }
}

clearInterval(heartbeat)
await unlink(heartbeatFile).catch(() => undefined)
await subscriber.quit().catch(() => subscriber.disconnect())
await redis.quit().catch(() => redis.disconnect())
await closeStore()
