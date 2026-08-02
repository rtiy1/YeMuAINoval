import { EventEmitter } from 'node:events'
import { createTaskRedis, isTaskQueueEnabled } from './task-queue.mjs'

export const TASK_PROGRESS_CHANNEL = 'ai-tasks:v1:progress'

const emitter = new EventEmitter()
emitter.setMaxListeners(0)

let publisher = null
let subscriber = null
let bridgePromise = null
let publishTimer = null
let pendingRedisEvents = []

function localEvent(message) {
  if (!message?.taskId || !message?.event?.type) return
  emitter.emit(String(message.taskId), message.event)
}

function flushRedisEvents() {
  publishTimer = null
  const events = pendingRedisEvents
  pendingRedisEvents = []
  if (!events.length || !isTaskQueueEnabled()) return
  publisher ||= createTaskRedis()
  void publisher.publish(TASK_PROGRESS_CHANNEL, JSON.stringify(events)).catch(() => undefined)
}

export function publishTaskStreamEvent(taskId, event) {
  if (!taskId || !event?.type) return
  const message = {
    taskId: String(taskId),
    event: { ...event, emittedAt: event.emittedAt || new Date().toISOString() },
  }
  localEvent(message)
  if (!isTaskQueueEnabled()) return
  pendingRedisEvents.push(message)
  if (!publishTimer) {
    publishTimer = setTimeout(flushRedisEvents, 12)
    publishTimer.unref?.()
  }
}

export function subscribeTaskStream(taskId, listener) {
  const key = String(taskId)
  emitter.on(key, listener)
  return () => emitter.off(key, listener)
}

export async function startTaskStreamBridge() {
  if (!isTaskQueueEnabled()) return false
  if (!bridgePromise) {
    bridgePromise = (async () => {
      subscriber = createTaskRedis()
      await subscriber.subscribe(TASK_PROGRESS_CHANNEL)
      subscriber.on('message', (_channel, raw) => {
        try {
          const parsed = JSON.parse(raw)
          for (const message of Array.isArray(parsed) ? parsed : [parsed]) localEvent(message)
        } catch {
          // Ignore malformed or stale progress messages; database snapshots remain the recovery path.
        }
      })
      return true
    })().catch((error) => {
      bridgePromise = null
      subscriber?.disconnect()
      subscriber = null
      throw error
    })
  }
  return await bridgePromise
}

export async function closeTaskStream() {
  if (publishTimer) clearTimeout(publishTimer)
  flushRedisEvents()
  emitter.removeAllListeners()
  const clients = [publisher, subscriber].filter(Boolean)
  publisher = null
  subscriber = null
  bridgePromise = null
  await Promise.allSettled(clients.map((client) => client.quit().catch(() => client.disconnect())))
}
