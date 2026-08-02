import assert from 'node:assert/strict'
import test from 'node:test'
import { EDITOR_AGENT_COMMANDS, parseCompactCommandArgs, parseSlashCommand, resolveSelection } from './agent-commands.mjs'

test('editor slash commands retain the full Chinese argument', () => {
  assert.deepEqual(parseSlashCommand('/write 加强章末钩子'), { name: 'write', argument: '加强章末钩子' })
  assert.deepEqual(parseSlashCommand('/write:加强章末钩子'), { name: 'write', argument: '加强章末钩子' })
  assert.deepEqual(parseSlashCommand('/clear'), { name: 'new', argument: '' })
  assert.deepEqual(parseSlashCommand('/q'), { name: 'quit', argument: '' })
  assert.deepEqual(parseSlashCommand('/续写 加强冲突'), { name: 'continue', argument: '加强冲突' })
  assert.deepEqual(parseSlashCommand('/重写:保留结局'), { name: 'rewrite', argument: '保留结局' })
  assert.equal(parseSlashCommand('直接对话'), null)
})

test('writing commands remain first-class entries in the slash menu', () => {
  assert.deepEqual(
    EDITOR_AGENT_COMMANDS.slice(1, 7).map((command) => command.name),
    ['write', 'continue', 'rewrite', 'outline', 'expand', 'shorten'],
  )
  assert.equal(EDITOR_AGENT_COMMANDS.find((command) => command.name === 'write')?.group, 'writing')
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
