import assert from 'node:assert/strict'
import test from 'node:test'
import { publishTaskStreamEvent, subscribeTaskStream } from './task-stream.mjs'

test('task stream delivers model deltas directly to local SSE subscribers', () => {
  const received = []
  const unsubscribe = subscribeTaskStream('task-live', (event) => received.push(event))
  publishTaskStreamEvent('task-live', { type: 'reasoning_delta', delta: '先检查上下文' })
  publishTaskStreamEvent('task-live', { type: 'output_delta', delta: '第一段' })
  unsubscribe()
  publishTaskStreamEvent('task-live', { type: 'output_delta', delta: '不应收到' })
  assert.deepEqual(received.map((event) => [event.type, event.delta]), [
    ['reasoning_delta', '先检查上下文'],
    ['output_delta', '第一段'],
  ])
})
