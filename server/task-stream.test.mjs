import assert from 'node:assert/strict'
import test from 'node:test'
import { publishTaskStreamEvent, subscribeTaskStream } from './task-stream.mjs'

test('task stream delivers model deltas directly to local SSE subscribers', () => {
  const received = []
  const unsubscribe = subscribeTaskStream('task-live', (event) => received.push(event))
  publishTaskStreamEvent('task-live', { type: 'reasoning_delta', delta: '先检查上下文' })
  publishTaskStreamEvent('task-live', { type: 'output_delta', delta: '第一段' })
  publishTaskStreamEvent('task-live', { type: 'tool_event', phase: 'start', toolName: 'write_story_file' })
  unsubscribe()
  publishTaskStreamEvent('task-live', { type: 'output_delta', delta: '不应收到' })
  assert.deepEqual(received.map((event) => [event.type, event.delta]), [
    ['reasoning_delta', '先检查上下文'],
    ['output_delta', '第一段'],
    ['tool_event', undefined],
  ])
})

test('task stream keeps segmented reasoning lifecycle events in order', () => {
  const received = []
  const unsubscribe = subscribeTaskStream('task-reasoning-segments', (event) => received.push(event))
  publishTaskStreamEvent('task-reasoning-segments', { type: 'reasoning_event', phase: 'start', itemId: 'reasoning-1' })
  publishTaskStreamEvent('task-reasoning-segments', { type: 'reasoning_event', phase: 'delta', itemId: 'reasoning-1', delta: '先读取文件' })
  publishTaskStreamEvent('task-reasoning-segments', { type: 'reasoning_event', phase: 'end', itemId: 'reasoning-1' })
  publishTaskStreamEvent('task-reasoning-segments', { type: 'tool_event', phase: 'start', toolName: 'read_story_file' })
  unsubscribe()
  assert.deepEqual(received.map((event) => `${event.type}:${event.phase || ''}`), [
    'reasoning_event:start',
    'reasoning_event:delta',
    'reasoning_event:end',
    'tool_event:start',
  ])
})
