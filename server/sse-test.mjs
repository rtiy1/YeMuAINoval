import assert from 'node:assert/strict'
import test from 'node:test'
import { consumeSseStream, parseSseBlock } from '../src/sse.mjs'

test('parses named SSE events and ignores heartbeats', () => {
  assert.deepEqual(parseSseBlock('event: task\ndata: {\"status\":\"running\"}'), {
    event: 'task',
    data: '{"status":"running"}',
  })
  assert.equal(parseSseBlock(': keep-alive'), null)
})

test('consumes SSE frames split across stream chunks', async () => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: task\ndata: {\"status\":'))
      controller.enqueue(encoder.encode('\"running\"}\n\nevent: task\ndata: {\"status\":\"completed\"}\n\n'))
      controller.close()
    },
  })
  const events = []
  await consumeSseStream(stream, (event) => events.push(event))
  assert.deepEqual(events.map((item) => JSON.parse(item.data).status), ['running', 'completed'])
})
