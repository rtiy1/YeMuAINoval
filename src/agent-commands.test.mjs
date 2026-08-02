import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCompactCommandArgs, parseSlashCommand, resolveSelection } from './agent-commands.mjs'

test('editor slash commands retain the full Chinese argument', () => {
  assert.deepEqual(parseSlashCommand('/write 加强章末钩子'), { name: 'write', argument: '加强章末钩子' })
  assert.deepEqual(parseSlashCommand('/write:加强章末钩子'), { name: 'write', argument: '加强章末钩子' })
  assert.deepEqual(parseSlashCommand('/clear'), { name: 'new', argument: '' })
  assert.deepEqual(parseSlashCommand('/q'), { name: 'quit', argument: '' })
  assert.equal(parseSlashCommand('直接对话'), null)
})

test('compact command follows TUI mode and focus parsing', () => {
  assert.deepEqual(parseCompactCommandArgs(''), { mode: '', instructions: '' })
  assert.deepEqual(parseCompactCommandArgs('soft 保留人物关系'), { mode: 'soft', instructions: '保留人物关系' })
  assert.deepEqual(parseCompactCommandArgs('保留伏笔'), { mode: '', instructions: '保留伏笔' })
  assert.throws(() => parseCompactCommandArgs('snapcompact 不要丢时间线'), /不接受/)
})

test('editor selection supports index, id, exact title and unique fuzzy title', () => {
  const items = [{ id: 'a', title: '长夜将明' }, { id: 'b', title: '旧港来信' }]
  assert.equal(resolveSelection(items, '2').id, 'b')
  assert.equal(resolveSelection(items, 'a').title, '长夜将明')
  assert.equal(resolveSelection(items, '旧港').id, 'b')
})
