import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_EDITOR_PREFERENCES,
  EDITOR_PREFERENCES_KEY,
  getApiBase,
  mergeEditorPreferences,
  normalizeApiBase,
  normalizeEditorPreferences,
  readEditorPreferences,
  resolveEditorTheme,
  sendAgentNotification,
  writeEditorPreferences,
} from './platform.mjs'

test('normalizeApiBase adds protocol and API suffix for configured web servers', () => {
  assert.equal(normalizeApiBase('127.0.0.1:8787'), 'http://127.0.0.1:8787/api')
  assert.equal(normalizeApiBase('https://story.example.com/'), 'https://story.example.com/api')
})

test('normalizeApiBase preserves custom prefixes ending in api', () => {
  assert.equal(normalizeApiBase('https://story.example.com/service/api?ignored=true'), 'https://story.example.com/service/api')
})

test('normalizeApiBase rejects non-http schemes', () => {
  assert.throws(() => normalizeApiBase('file:///tmp/story'), /HTTP/)
})

test('getApiBase defaults to the same-origin web API', () => {
  assert.equal(getApiBase(), '/api')
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

function preferenceStorage(values = {}) {
  const entries = new Map(Object.entries(values))
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  }
}

test('editor preferences default safely and return independent widths', () => {
  for (const value of [undefined, null, [], 'invalid']) {
    assert.deepEqual(normalizeEditorPreferences(value), DEFAULT_EDITOR_PREFERENCES)
  }
  const normalized = normalizeEditorPreferences()
  normalized.panelWidths.chapter = 350
  assert.equal(DEFAULT_EDITOR_PREFERENCES.panelWidths.chapter, 300)
  assert.deepEqual(readEditorPreferences(preferenceStorage()), DEFAULT_EDITOR_PREFERENCES)
})

test('editor preferences validate choices, clamp widths and discard unrelated fields', () => {
  assert.deepEqual(normalizeEditorPreferences({
    theme: 'sepia', fontSize: 99, lineHeight: NaN, apiKey: 'fixture-only',
    panelWidths: { chapter: 999, assistant: 100 },
  }), { theme: 'system', fontSize: 16, lineHeight: 2.05, panelWidths: { chapter: 420, assistant: 320 } })
  assert.deepEqual(normalizeEditorPreferences({ panelWidths: { chapter: Infinity, assistant: -1 } }).panelWidths, { chapter: 300, assistant: 420 })
  assert.equal(normalizeEditorPreferences({ panelWidths: { chapter: 333.8 } }).panelWidths.chapter, 334)
})

test('editor preferences migrate legacy theme and widths without deleting them', () => {
  const storage = preferenceStorage({
    'story-studio-theme': 'dark',
    'yemu:editor-panel-widths': JSON.stringify({ chapter: 340, assistant: 480 }),
  })
  const preferences = readEditorPreferences(storage)
  assert.deepEqual(preferences, { theme: 'dark', fontSize: 16, lineHeight: 2.05, panelWidths: { chapter: 340, assistant: 480 } })
  assert.equal(writeEditorPreferences(preferences, storage), true)
  assert.equal(storage.getItem('story-studio-theme'), 'dark')
  assert.equal(storage.getItem('yemu:editor-panel-widths'), JSON.stringify({ chapter: 340, assistant: 480 }))
})

test('new editor preferences take precedence and round trip only allowed fields', () => {
  const storage = preferenceStorage({ 'story-studio-theme': 'dark' })
  const preferences = { theme: 'system', fontSize: 18, lineHeight: 2.35, panelWidths: { chapter: 360, assistant: 460 } }
  assert.equal(writeEditorPreferences({ ...preferences, apiKey: 'fixture-only' }, storage), true)
  assert.deepEqual(JSON.parse(storage.getItem(EDITOR_PREFERENCES_KEY)), preferences)
  assert.deepEqual(readEditorPreferences(storage), preferences)
})

test('corrupt preference JSON falls back without losing valid legacy theme', () => {
  for (const invalid of ['{broken', 'null', '[]', '"invalid"']) {
    const storage = preferenceStorage({
      [EDITOR_PREFERENCES_KEY]: invalid,
      'story-studio-theme': 'light',
      'yemu:editor-panel-widths': '{broken',
    })
    assert.deepEqual(readEditorPreferences(storage), { ...DEFAULT_EDITOR_PREFERENCES, theme: 'light' })
  }
})

test('unavailable preference storage is safe and reports write failure', () => {
  const storage = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('quota') },
  }
  assert.deepEqual(readEditorPreferences(storage), DEFAULT_EDITOR_PREFERENCES)
  assert.equal(writeEditorPreferences(DEFAULT_EDITOR_PREFERENCES, storage), false)
})

test('partial editor preference updates and layout reset preserve other values', () => {
  const original = { theme: 'dark', fontSize: 18, lineHeight: 2.35, panelWidths: { chapter: 360, assistant: 480 } }
  const changed = mergeEditorPreferences(original, { panelWidths: { chapter: 380 } })
  assert.deepEqual(changed, { ...original, panelWidths: { chapter: 380, assistant: 480 } })
  assert.deepEqual(mergeEditorPreferences(changed, { panelWidths: DEFAULT_EDITOR_PREFERENCES.panelWidths }), {
    ...original, panelWidths: { chapter: 300, assistant: 420 },
  })
  assert.equal(original.panelWidths.chapter, 360)
})

test('system theme follows media preference while explicit modes stay fixed', () => {
  assert.equal(resolveEditorTheme('system', true), 'dark')
  assert.equal(resolveEditorTheme('system', false), 'light')
  assert.equal(resolveEditorTheme('dark', false), 'dark')
  assert.equal(resolveEditorTheme('light', true), 'light')
})
