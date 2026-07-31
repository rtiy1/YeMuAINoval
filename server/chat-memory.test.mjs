import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeWritingSession,
  serializeSession,
  getSession,
  setSession,
  deleteSession,
  closeClient,
} from './chat-memory.mjs'

const REDIS_TEST_URL = process.env.REDIS_TEST_URL || ''

test('normalizeWritingSession fills defaults and caps messages', () => {
  const normalized = normalizeWritingSession({ id: 's1', phase: 'weird', messages: [{ role: 'user', text: 'a' }, { text: 'b' }] }, 'u1')
  assert.equal(normalized.phase, 'collecting_requirements')
  assert.equal(normalized.userId, 'u1')
  assert.equal(normalized.messages.length, 2)
  assert.equal(normalized.messages[0].role, 'user')
  assert.equal(normalized.messages[1].role, 'user')
  assert.deepEqual(normalized.requirements, { type: '', genre: '', style: '', premise: '', platform: '', title: '' })
  assert.equal(normalized.projectId, null)
})

test('normalizeWritingSession caps to 20 messages and clamps text', () => {
  const messages = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, role: 'user', text: String(i), createdAt: 't' }))
  const normalized = normalizeWritingSession({ id: 's2', messages }, 'u2')
  assert.equal(normalized.messages.length, 20)
  assert.equal(normalized.messages[0].text, '5')
})

test('serializeSession round-trips through normalizeWritingSession', () => {
  const session = { id: 's3', userId: 'u3', phase: 'awaiting_confirmation', messages: [{ id: 'm', role: 'assistant', text: 'hi', createdAt: 't' }], requirements: { type: '短篇' }, proposal: { title: 'X' }, projectId: 'p1' }
  const parsed = JSON.parse(serializeSession(session))
  const restored = normalizeWritingSession(parsed.session, 'u3')
  assert.equal(restored.phase, 'awaiting_confirmation')
  assert.equal(restored.projectId, 'p1')
  assert.equal(restored.proposal.title, 'X')
})

test('normalizeWritingSession returns null for invalid input', () => {
  assert.equal(normalizeWritingSession(null, 'u'), null)
  assert.equal(normalizeWritingSession('nope', 'u'), null)
})

const redisIt = REDIS_TEST_URL ? test : test.skip

redisIt('setSession/getSession/deleteSession round-trip against live Redis', async () => {
  process.env.REDIS_URL = REDIS_TEST_URL
  const session = { id: 'live-1', userId: 'live-user', phase: 'collecting_requirements', messages: [{ id: 'm1', role: 'user', text: '你好', createdAt: 'now' }] }
  await setSession('live-user', session)
  const fetched = await getSession('live-user')
  assert.equal(fetched.id, 'live-1')
  assert.equal(fetched.messages[0].text, '你好')
  await deleteSession('live-user')
  assert.equal(await getSession('live-user'), null)
  await closeClient()
})
