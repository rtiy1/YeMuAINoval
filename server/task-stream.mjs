import { EventEmitter } from 'node:events'

// Coalescing window for streams. Model deltas arrive in dense bursts (one
// `thinking_delta` per token); buffering them for this many milliseconds and
// merging consecutive same-item deltas turns N tiny SSE frames into roughly
// one per tick without adding perceptible latency.
//
// 单用户本地应用：任务只在 API 进程内执行，进度事件走进程内 EventEmitter，
// 不再需要 Redis 跨进程广播。
const STREAM_TICK_MS = 12

const emitter = new EventEmitter()
emitter.setMaxListeners(0)

let flushTimer = null
// taskId -> buffered messages awaiting the next tick flush
const pendingLocal = new Map()

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

function flushTaskEvents(taskId, override = null) {
  const list = pendingLocal.get(taskId)
  const buffered = list ? [...list] : []
  pendingLocal.delete(taskId)
  const messages = override ? [...buffered, override] : buffered
  for (const message of messages) localEvent(message)
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

export async function closeTaskStream() {
  if (flushTimer) clearTimeout(flushTimer)
  flushTaskStreamEvents()
  emitter.removeAllListeners()
}
