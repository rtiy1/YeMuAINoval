import { EventEmitter } from 'node:events'
import { createTaskRedis, isTaskQueueEnabled } from './task-queue.mjs'

export const TASK_PROGRESS_CHANNEL = 'ai-tasks:v1:progress'

// Coalescing window for streams. Model deltas arrive in dense bursts (one
// `thinking_delta` per token); buffering them for this many milliseconds and
// merging consecutive same-item deltas turns N tiny SSE frames/Redis messages
// into roughly one per tick without adding perceptible latency.
const STREAM_TICK_MS = 12

const emitter = new EventEmitter()
emitter.setMaxListeners(0)

let publisher = null
let subscriber = null
let bridgePromise = null
let publishTimer = null
let flushTimer = null
// taskId -> buffered messages awaiting the next tick flush
const pendingLocal = new Map()
let pendingRedisEvents = []

function localEvent(message) {
  if (!message?.taskId || !message?.event?.type) return
  emitter.emit(String(message.taskId), message.event)
}

function isDeltaEvent(event) {
  return typeof event?.delta === 'string'
}

function sameDeltaKey(event) {
  return `${event.type}:${event.phase || ''}:${event.itemId || ''}`
}

function flushRedisEvents() {
  publishTimer = null
  const events = pendingRedisEvents
  pendingRedisEvents = []
  if (!events.length || !isTaskQueueEnabled()) return
  publisher ||= createTaskRedis()
  void publisher.publish(TASK_PROGRESS_CHANNEL, JSON.stringify(events)).catch(() => undefined)
}

function flushTaskEvents(taskId, override = null) {
  const list = pendingLocal.get(taskId)
  const buffered = list ? [...list] : []
  pendingLocal.delete(taskId)
  const messages = override ? [...buffered, override] : buffered
  if (!messages.length) return
  for (const message of messages) localEvent(message)
  if (isTaskQueueEnabled()) {
    pendingRedisEvents.push(...messages)
    if (!publishTimer) {
      publishTimer = setTimeout(flushRedisEvents, STREAM_TICK_MS)
      publishTimer.unref?.()
    }
  }
}

export function flushTaskStreamEvents() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  for (const taskId of [...pendingLocal.keys()]) flushTaskEvents(taskId)
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushTaskStreamEvents()
  }, STREAM_TICK_MS)
  flushTimer.unref?.()
}

export function publishTaskStreamEvent(taskId, event) {
  if (!taskId || !event?.type) return
  const taskKey = String(taskId)
  const message = {
    taskId: taskKey,
    event: { ...event, emittedAt: event.emittedAt || new Date().toISOString() },
  }
  if (isDeltaEvent(event)) {
    const list = pendingLocal.get(taskKey) || pendingLocal.set(taskKey, []).get(taskKey)
    const tail = list[list.length - 1]
    if (tail && isDeltaEvent(tail.event) && sameDeltaKey(tail.event) === sameDeltaKey(event)) {
      tail.event.delta = `${tail.event.delta || ''}${event.delta}`
    } else {
      list.push(message)
    }
    scheduleFlush()
    return
  }
  // Lifecycle events (start/end/tool/snapshot) flush immediately and in order,
  // so status boundaries stay crisp instead of riding the coalescing tick.
  flushTaskEvents(taskKey, message)
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
  if (flushTimer) clearTimeout(flushTimer)
  flushTaskStreamEvents()
  flushRedisEvents()
  emitter.removeAllListeners()
  const clients = [publisher, subscriber].filter(Boolean)
  publisher = null
  subscriber = null
  bridgePromise = null
  await Promise.allSettled(clients.map((client) => client.quit().catch(() => client.disconnect())))
}
