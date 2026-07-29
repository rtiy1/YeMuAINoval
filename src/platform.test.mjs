import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeApiBase, sendAgentNotification } from './platform.mjs'

test('normalizeApiBase adds protocol and API suffix for desktop servers', () => {
  assert.equal(normalizeApiBase('127.0.0.1:8787', { desktop: true }), 'http://127.0.0.1:8787/api')
  assert.equal(normalizeApiBase('https://story.example.com/', { desktop: true }), 'https://story.example.com/api')
})

test('normalizeApiBase preserves custom prefixes ending in api', () => {
  assert.equal(normalizeApiBase('https://story.example.com/service/api?ignored=true', { desktop: true }), 'https://story.example.com/service/api')
})

test('normalizeApiBase rejects non-http schemes', () => {
  assert.throws(() => normalizeApiBase('file:///tmp/story', { desktop: true }), /HTTP/)
})

test('sendAgentNotification stays quiet while the app is focused', async () => {
  const originalDocument = globalThis.document
  globalThis.document = { visibilityState: 'visible', hasFocus: () => true }
  try {
    assert.equal(await sendAgentNotification({ title: 'done', body: 'ignored' }), false)
  } finally {
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})
