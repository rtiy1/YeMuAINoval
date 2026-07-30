import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEditHunks, composeAcceptedText, splitParagraphs } from '../src/edit-proposal.mjs'

test('splits Chinese paragraphs and rebuilds accepted replacements', () => {
  assert.deepEqual(splitParagraphs('第一段。\n\n第二段。'), ['第一段。', '第二段。'])
  const hunks = buildEditHunks('第一段。\n\n第二段。', '第一段。\n\n改写第二段。')
  assert.equal(hunks.filter((item) => item.type !== 'equal').length, 1)
  assert.equal(composeAcceptedText(hunks), '第一段。\n\n改写第二段。')
  const rejected = hunks.map((item) => item.type === 'equal' ? item : { ...item, accepted: false })
  assert.equal(composeAcceptedText(rejected), '第一段。\n\n第二段。')
})

test('handles insertions and deletions independently', () => {
  const inserted = buildEditHunks('甲。', '甲。\n\n乙。')
  assert.equal(inserted.at(-1).type, 'insert')
  assert.equal(composeAcceptedText(inserted), '甲。\n\n乙。')

  const deleted = buildEditHunks('甲。\n\n乙。', '甲。')
  assert.equal(deleted.at(-1).type, 'delete')
  assert.equal(composeAcceptedText(deleted), '甲。')
  deleted.at(-1).accepted = false
  assert.equal(composeAcceptedText(deleted), '甲。\n\n乙。')
})

test('uses supplied edit reasons', () => {
  const hunks = buildEditHunks('旧句。', '新句。', [{ original: '旧句。', replacement: '新句。', reason: '增强动作感。' }])
  assert.equal(hunks[0].reason, '增强动作感。')
})
