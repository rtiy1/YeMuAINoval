import assert from 'node:assert/strict'
import test from 'node:test'
import { purgeReasoningData } from './purge-reasoning.mjs'

test('purge removes reasoning summary, history, timestamps and reasoning events', () => {
  const db = {
    writingTasks: [{
      id: 'task-1',
      partialOutput: '可见正文',
      reasoningSummary: '不应保留的思考摘要',
      reasoningHistory: [{ id: 'h1', summary: 'x' }],
      reasoningStartedAt: '2026-01-01T00:00:00Z',
      reasoningCompletedAt: '2026-01-01T00:00:01Z',
      events: [
        { id: 'e1', type: 'reasoning', meta: { summary: '很长的思考' } },
        { id: 'e2', type: 'output', meta: { text: '可见' } },
        { id: 'e3', type: 'tool' },
      ],
    }],
    agentThreads: [{ id: 't1', reasoningSummary: 'thread thinking' }],
  }
  const result = purgeReasoningData(db)
  assert.deepEqual(result, { changed: true, purgedTasks: 2, purgedEvents: 1, purgedHistory: 1 })
  const task = db.writingTasks[0]
  assert.equal(task.reasoningSummary, undefined)
  assert.equal(task.reasoningHistory, undefined)
  assert.equal(task.reasoningStartedAt, undefined)
  assert.equal(task.reasoningCompletedAt, undefined)
  assert.deepEqual(task.events.map((event) => event.id), ['e2', 'e3'])
  assert.equal(task.partialOutput, '可见正文')
  assert.equal(db.agentThreads[0].reasoningSummary, undefined)
})

test('purge is idempotent and reports no change on already-clean data', () => {
  const db = {
    writingTasks: [{ id: 'task-1', partialOutput: 'ok', events: [{ id: 'e1', type: 'output' }] }],
    agentThreads: [],
  }
  assert.deepEqual(purgeReasoningData(db), { changed: false, purgedTasks: 0, purgedEvents: 0, purgedHistory: 0 })
  assert.deepEqual(purgeReasoningData(db), { changed: false, purgedTasks: 0, purgedEvents: 0, purgedHistory: 0 })
})

test('purge tolerates missing collections', () => {
  assert.deepEqual(purgeReasoningData({}), { changed: false, purgedTasks: 0, purgedEvents: 0, purgedHistory: 0 })
  assert.deepEqual(purgeReasoningData(null), { changed: false, purgedTasks: 0, purgedEvents: 0, purgedHistory: 0 })
  assert.deepEqual(purgeReasoningData({ writingTasks: null }), { changed: false, purgedTasks: 0, purgedEvents: 0, purgedHistory: 0 })
})
