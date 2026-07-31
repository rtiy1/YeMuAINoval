import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSlashCommand, resolveSelection } from './agent-commands.mjs'

test('editor slash commands retain the full Chinese argument', () => {
  assert.deepEqual(parseSlashCommand('/write 加强章末钩子'), { name: 'write', argument: '加强章末钩子' })
  assert.equal(parseSlashCommand('直接对话'), null)
})

test('editor selection supports index, id, exact title and unique fuzzy title', () => {
  const items = [{ id: 'a', title: '长夜将明' }, { id: 'b', title: '旧港来信' }]
  assert.equal(resolveSelection(items, '2').id, 'b')
  assert.equal(resolveSelection(items, 'a').title, '长夜将明')
  assert.equal(resolveSelection(items, '旧港').id, 'b')
})
