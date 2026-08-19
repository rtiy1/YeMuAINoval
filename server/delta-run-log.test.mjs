import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDeltaRunLog,
  DELTA_RUN_MAX_CHARS,
  resumeAssistantTail,
} from './delta-run-log.mjs'

test('delta run log keeps every token boundary lossless and in first-append order', () => {
  const log = createDeltaRunLog()
  log.record('text', 'assistant-1', '你')
  log.record('text', 'assistant-1', '推')
  log.record('text', 'assistant-1', '开窗')
  log.record('text', 'assistant-2', '好的')
  const runs = log.snapshot()
  assert.deepEqual(runs.map((run) => [run.kind, run.segmentKey, run.texts]), [
    ['text', 'assistant-1', ['你', '推', '开窗']],
    ['text', 'assistant-2', ['好的']],
  ])
  assert.deepEqual(runs.map((run) => run.seq0), [0, 1])
})

test('reasoning deltas are never persisted into the durable log (privacy invariant)', () => {
  const log = createDeltaRunLog()
  log.record('reasoning', 'assistant-1', '这是不能被落库的思考内容')
  log.record('text', 'assistant-1', '可见正文')
  const runs = log.snapshot()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].kind, 'text')
  assert.deepEqual(runs[0].texts, ['可见正文'])
  assert.ok(!JSON.stringify(runs).includes('思考内容'))
})

test('delta run log drops oldest runs when character cap is exceeded', () => {
  const log = createDeltaRunLog({ maxChars: 6 })
  log.record('text', 'segment-a', 'abcdef')
  log.record('text', 'segment-b', 'xy')
  // Crossing the cap drops the oldest run (segment-a); the newest run stays.
  assert.deepEqual(log.snapshot().map((run) => run.segmentKey), ['segment-b'])
  assert.equal(log.chars(), 2)
})

test('delta run log drops oldest run once run-count cap is exceeded', () => {
  const log = createDeltaRunLog({ maxChars: 100, maxRuns: 2 })
  log.record('text', 'a', '1')
  log.record('text', 'b', '2')
  log.record('text', 'c', '3')
  assert.deepEqual(log.snapshot().map((run) => run.segmentKey), ['b', 'c'])
})

test('resumeAssistantTail prefers the exact delta run tail', () => {
  const task = {
    partialOutput: 'aaaaaaaaaaaaaaaa',
    deltaRuns: [
      { kind: 'text', segmentKey: 'assistant-1', seq0: 0, time0: 1, texts: ['你', '推', '开', '窗'] },
    ],
  }
  assert.equal(resumeAssistantTail(task, 12_000), '你推开窗')
})

test('resumeAssistantTail falls back to the aggregate tail without delta runs', () => {
  const task = { partialOutput: '0123456789' }
  assert.equal(resumeAssistantTail(task, 5), '56789')
  assert.equal(resumeAssistantTail({}, 5), '')
})

test('resumeAssistantTail slices delta-run tail to the resume budget', () => {
  const task = {
    deltaRuns: [
      { kind: 'text', segmentKey: 'assistant-1', seq0: 0, time0: 1, texts: ['0123456789'] },
    ],
  }
  assert.equal(resumeAssistantTail(task, 4), '6789')
})

test('constants stay within whole-file db.json write budget', () => {
  assert.ok(DELTA_RUN_MAX_CHARS <= 512_000 * 2)
})
