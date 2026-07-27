import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentThreadPublic,
  agentTurnItems,
  agentTurnPlan,
  agentTurnPublic,
  normalizeAgentThreads,
  taskResultText,
  threadCompactionPlan,
  threadConversation,
} from './agent-thread.mjs'

test('normalizes legacy databases without agent threads', () => {
  const db = {}
  assert.deepEqual(normalizeAgentThreads(db), [])
  assert.deepEqual(db.agentThreads, [])
})

test('thread conversation includes only completed task pairs', () => {
  const thread = {
    turns: [
      { id: 'turn-1', taskId: 'task-1', message: '第一问' },
      { id: 'turn-2', taskId: 'task-2', message: '第二问' },
    ],
  }
  const tasks = [
    { id: 'task-1', status: 'completed', result: { result: { output: '第一答' } } },
    { id: 'task-2', status: 'running', result: null },
  ]
  assert.deepEqual(threadConversation(thread, tasks), [
    { role: 'user', text: '第一问' },
    { role: 'assistant', text: '第一答' },
  ])
})

test('failed turns do not displace older completed context', () => {
  const thread = {
    turns: [
      { id: 'turn-ok', taskId: 'task-ok', message: '保留这一问' },
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `turn-failed-${index}`,
        taskId: `task-failed-${index}`,
        message: '失败的问题',
      })),
    ],
  }
  const tasks = [
    { id: 'task-ok', status: 'completed', result: { result: { output: '保留这一答' } } },
    ...Array.from({ length: 9 }, (_, index) => ({ id: `task-failed-${index}`, status: 'failed' })),
  ]
  assert.deepEqual(threadConversation(thread, tasks), [
    { role: 'user', text: '保留这一问' },
    { role: 'assistant', text: '保留这一答' },
  ])
})

test('thread conversation excludes turns already represented by the rolling summary', () => {
  const thread = {
    compactedTurnIds: ['turn-1'],
    turns: [
      { id: 'turn-1', taskId: 'task-1', message: '旧问题' },
      { id: 'turn-2', taskId: 'task-2', message: '新问题' },
    ],
  }
  const tasks = [
    { id: 'task-1', status: 'completed', result: { result: { output: '旧回答' } } },
    { id: 'task-2', status: 'completed', result: { result: { output: '新回答' } } },
  ]
  assert.deepEqual(threadConversation(thread, tasks), [
    { role: 'user', text: '新问题' },
    { role: 'assistant', text: '新回答' },
  ])
})

test('context compaction keeps six recent turns raw and selects older turns', () => {
  const turns = Array.from({ length: 10 }, (_, index) => ({
    id: `turn-${index + 1}`,
    taskId: `task-${index + 1}`,
    message: `第 ${index + 1} 次要求 ${'继续推进剧情'.repeat(120)}`,
  }))
  const tasks = turns.map((turn, index) => ({
    id: turn.taskId,
    status: 'completed',
    result: { result: { output: `第 ${index + 1} 次结果 ${'剧情事实'.repeat(160)}` } },
  }))
  const plan = threadCompactionPlan({ turns }, tasks, { contextWindow: 4000, maxTokens: 800 })
  assert.ok(plan)
  assert.deepEqual(plan.turnIds, ['turn-1', 'turn-2', 'turn-3', 'turn-4'])
  assert.equal(plan.messages.length, 8)
})

test('turn plan only exposes an explicit runtime plan', () => {
  assert.deepEqual(agentTurnPlan({ status: 'running', events: [] }), [])
  assert.deepEqual(agentTurnPlan({
    plan: [
      { step: '读取当前章节', status: 'completed' },
      { step: '核对伏笔', status: 'inProgress' },
      { step: '', status: 'completed' },
    ],
  }), [
    { step: '读取当前章节', status: 'completed' },
    { step: '核对伏笔', status: 'inProgress' },
  ])
})

test('turn public response exposes Codex-style items and lifecycle', () => {
  const thread = { id: 'thread-1' }
  const turn = { id: 'turn-1', taskId: 'task-1', message: '续写', createdAt: '2026-01-01T00:00:00.000Z' }
  const task = {
    id: 'task-1',
    status: 'completed',
    skill: 'story-long-write',
    message: '续写',
    events: [
      { id: 'event-1', type: 'context', label: '读取上下文', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z' },
      { id: 'event-2', type: 'skill', label: '执行写作 Skill', status: 'completed', startedAt: '2026-01-01T00:00:01.000Z', completedAt: '2026-01-01T00:00:02.000Z' },
      { id: 'event-3', type: 'result', label: '整理结果', status: 'completed', startedAt: '2026-01-01T00:00:02.000Z', completedAt: '2026-01-01T00:00:02.000Z' },
    ],
    result: { result: { output: '续写结果' } },
    updatedAt: '2026-01-01T00:00:02.000Z',
  }
  assert.deepEqual(agentTurnItems(turn, task).map((item) => item.type), [
    'userMessage',
    'reasoning',
    'dynamicToolCall',
    'agentMessage',
  ])
  const output = agentTurnPublic(thread, turn, task, (value) => ({ id: value.id }))
  assert.equal(output.status, 'completed')
  assert.equal(output.threadId, 'thread-1')
  assert.equal(output.items.at(-1).content[0].text, '续写结果')
  assert.deepEqual(output.plan, [])
})

test('plan collaboration turns expose a plan item without a fake progress checklist', () => {
  const thread = { id: 'thread-plan' }
  const turn = { id: 'turn-plan', taskId: 'task-plan', message: '规划下一卷' }
  const task = {
    id: 'task-plan',
    status: 'completed',
    input: { payload: { collaboration_mode: 'plan' } },
    result: { result: { output: '## 下一卷计划\n\n1. 回收旧伏笔' } },
  }
  const output = agentTurnPublic(thread, turn, task, (value) => ({ id: value.id }))
  assert.deepEqual(output.plan, [])
  assert.equal(output.items.at(-1).type, 'plan')
  assert.equal(output.source.mode, 'plan')
})

test('thread public response restores task source without exposing raw input', () => {
  const thread = {
    id: 'thread-1',
    projectId: 'project-1',
    chapterId: '2',
    status: 'active',
    turns: [{ id: 'turn-1', taskId: 'task-1', message: '润色', editRequested: true }],
  }
  const task = {
    id: 'task-1',
    chapterId: '2',
    status: 'completed',
    input: {
      payload: {
        chapter_title: '第二章',
        source_text: '原文',
        selected_text: '选区',
        selection_start: 1,
        selection_end: 3,
      },
    },
    result: { result: { edit_proposal: { summary: '已润色' } } },
  }
  const output = agentThreadPublic(thread, [task], (value) => ({ id: value.id, status: value.status }))
  assert.equal(output.turns[0].source.sourceText, '原文')
  assert.equal(output.turns[0].source.selectedText, '选区')
  assert.deepEqual(output.turns[0].task, { id: 'task-1', status: 'completed' })
  assert.equal(Object.hasOwn(output.turns[0].task, 'input'), false)
  assert.equal(taskResultText(task), '已润色')
})
