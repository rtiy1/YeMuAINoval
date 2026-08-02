import assert from 'node:assert/strict'
import test from 'node:test'
import {
  accumulateTaskUsage,
  agentThreadPublic,
  agentTurnItems,
  agentTurnPlan,
  agentTurnPublic,
  normalizeAgentInputAnswers,
  normalizeAgentThreads,
  taskInputHistory,
  taskResultText,
  taskSteeringHistory,
  taskSubagents,
  threadCompactionPlan,
  threadConversation,
} from './agent-thread.mjs'

test('normalizes legacy databases without agent threads', () => {
  const db = {}
  assert.deepEqual(normalizeAgentThreads(db), [])
  assert.deepEqual(db.agentThreads, [])
})

test('normalizes and exposes thread history metadata', () => {
  const db = {
    agentThreads: [{
      id: 'thread-history',
      userId: 'user-1',
      projectId: 'project-1',
      chapterId: 2,
      isFavorited: true,
      turns: [{ id: 'turn-1', taskId: 'task-1', message: '  继续写拍卖会  ' }],
    }],
    writingTasks: [{ id: 'task-1', userId: 'user-1', status: 'completed', result: { result: { output: '完成' } } }],
  }
  normalizeAgentThreads(db)
  const output = agentThreadPublic(db.agentThreads[0], db.writingTasks, (task) => ({ id: task.id }))
  assert.equal(output.chapterId, '2')
  assert.equal(output.title, '继续写拍卖会')
  assert.equal(output.latestMessage, '继续写拍卖会')
  assert.equal(output.turnCount, 1)
  assert.equal(output.isFavorited, true)
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

test('thread conversation preserves resolved request-user-input exchanges', () => {
  const thread = {
    turns: [{ id: 'turn-1', taskId: 'task-1', message: '帮我设计副本' }],
  }
  const tasks = [{
    id: 'task-1',
    status: 'completed',
    input: {
      payload: {
        request_user_input_history: [{
          requestId: 'call-1',
          questions: [{ id: 'genre', header: '题材', question: '副本偏哪种体验？', options: [{ label: '规则怪谈' }, { label: '生存闯关' }] }],
          response: {
            answers: { genre: { answers: ['规则怪谈'] } },
            questionText: '题材：副本偏哪种体验？',
            answerText: '题材：规则怪谈',
          },
        }],
      },
    },
    result: { result: { output: '已按规则怪谈设计副本。' } },
  }]
  assert.deepEqual(threadConversation(thread, tasks), [
    { role: 'user', text: '帮我设计副本' },
    { role: 'assistant', text: '题材：副本偏哪种体验？' },
    { role: 'user', text: '题材：规则怪谈' },
    { role: 'assistant', text: '已按规则怪谈设计副本。' },
  ])
  assert.equal(taskInputHistory(tasks[0])[0].response.answers.genre.answers[0], '规则怪谈')
})

test('thread conversation preserves applied steer messages in the same turn', () => {
  const thread = {
    turns: [{ id: 'turn-steer', taskId: 'task-steer', message: '续写这一章' }],
  }
  const task = {
    id: 'task-steer',
    status: 'completed',
    steeringHistory: [
      { id: 'steer-1', text: '改成第三人称', revision: 1, status: 'applied' },
      { id: 'steer-2', text: '这个指令已取消', revision: 2, status: 'cancelled' },
    ],
    result: { result: { output: '第三人称版本' } },
  }
  assert.deepEqual(threadConversation(thread, [task]), [
    { role: 'user', text: '续写这一章' },
    { role: 'user', text: '改成第三人称' },
    { role: 'assistant', text: '第三人称版本' },
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
      { id: 'turn-1:tool:write-1', type: 'tool', label: '写入作品文件 · 设定/人物.md', status: 'completed', meta: { toolName: 'write_story_file', arguments: { path: '设定/人物.md' }, details: { path: '设定/人物.md', chars: 1200 } }, startedAt: '2026-01-01T00:00:01.000Z', completedAt: '2026-01-01T00:00:02.000Z' },
      { id: 'event-3', type: 'result', label: '整理结果', status: 'completed', startedAt: '2026-01-01T00:00:02.000Z', completedAt: '2026-01-01T00:00:02.000Z' },
    ],
    result: { result: { output: '续写结果' } },
    updatedAt: '2026-01-01T00:00:02.000Z',
  }
  assert.deepEqual(agentTurnItems(turn, task).map((item) => item.type), [
    'userMessage',
    'lifecycle',
    'dynamicToolCall',
    'dynamicToolCall',
    'agentMessage',
  ])
  const fileTool = agentTurnItems(turn, task).find((item) => item.id === 'turn-1:tool:write-1')
  assert.equal(fileTool.tool, 'write_story_file')
  assert.equal(fileTool.arguments.path, '设定/人物.md')
  const output = agentTurnPublic(thread, turn, task, (value) => ({ id: value.id }))
  assert.equal(output.status, 'completed')
  assert.equal(output.threadId, 'thread-1')
  assert.equal(output.items.at(-1).content[0].text, '续写结果')
  assert.deepEqual(output.plan, [])
})

test('turn items expose steer input, bounded subagents, and attempt-aware output ids', () => {
  const turn = { id: 'turn-team', taskId: 'task-team', message: '续写' }
  const task = {
    id: 'task-team',
    status: 'completed',
    interactionAttempt: 2,
    steeringHistory: [{ id: 'steer-team', text: '改成第三人称', revision: 1, status: 'applied' }],
    subagents: [
      {
        id: 'continuity:1',
        path: '/root/continuity_guard',
        role: 'continuity_guard',
        ordinal: 0,
        status: 'completed',
        summary: '时间线一致。',
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
      {
        id: 'planner:2',
        path: '/root/scene_planner',
        role: 'scene_planner',
        ordinal: 1,
        status: 'failed',
        error: '已降级',
      },
    ],
    result: { result: { output: '最终正文' } },
  }
  const items = agentTurnItems(turn, task)
  assert.equal(items.find((item) => item.id === 'steer-team')?.meta.steer, true)
  const subagents = items.filter((item) => item.type === 'collabAgentToolCall')
  assert.equal(subagents.length, 2)
  assert.equal(subagents[0].meta.reportSummary, '时间线一致。')
  assert.equal(items.at(-1).id, 'turn-team:agent:2')
  assert.equal(taskSteeringHistory(task)[0].idempotencyKey, undefined)
  assert.deepEqual(taskSubagents(task).map((item) => item.role), ['continuity_guard', 'scene_planner'])
})

test('normalization keeps private steer idempotency without exposing it', () => {
  const db = {
    agentThreads: [],
    writingTasks: [{
      id: 'task-private-steer',
      steeringHistory: [{
        id: 'steer-private',
        idempotencyKey: 'client-key',
        text: '保留语气',
        revision: 1,
        status: 'pending',
      }],
    }],
  }
  normalizeAgentThreads(db)
  assert.equal(db.writingTasks[0].steeringHistory[0].idempotencyKey, 'client-key')
  assert.equal(taskSteeringHistory(db.writingTasks[0])[0].idempotencyKey, undefined)
})

test('turn items keep each model reasoning attempt and resolved input item', () => {
  const items = agentTurnItems(
    { id: 'turn-reasoning', taskId: 'task-reasoning', message: '继续设计' },
    {
      id: 'task-reasoning',
      turnId: 'turn-reasoning',
      status: 'completed',
      interactionAttempt: 2,
      reasoningHistory: [{
        id: 'turn-reasoning:reasoning:1',
        interactionAttempt: 1,
        summary: '先确认副本类型。',
        completedAt: '2026-01-01T00:00:01.000Z',
      }],
      reasoningSummary: '根据补充信息完成设计。',
      input: {
        payload: {
          request_user_input_history: [{
            requestId: 'call-reasoning',
            interactionAttempt: 1,
            questions: [{ id: 'genre', header: '题材', question: '选择类型？', options: [{ label: '规则怪谈' }, { label: '生存闯关' }] }],
            response: { answers: { genre: { answers: ['规则怪谈'] } }, answerText: '题材：规则怪谈' },
            resolvedAt: '2026-01-01T00:00:02.000Z',
          }],
        },
      },
      result: { result: { output: '设计完成' } },
      updatedAt: '2026-01-01T00:00:03.000Z',
    },
  )
  const reasoning = items.filter((item) => item.type === 'reasoning')
  assert.equal(reasoning.length, 2)
  assert.deepEqual(reasoning.map((item) => item.status), ['completed', 'completed'])
  assert.equal(reasoning[0].summary[0].text, '先确认副本类型。')
  assert.equal(items.find((item) => item.type === 'requestUserInput')?.status, 'completed')
  assert.equal(items.find((item) => item.id === 'call-reasoning:answer')?.content[0].text, '题材：规则怪谈')
})

test('task usage accumulates across model attempts without double-counting a run', () => {
  const task = { interactionAttempt: 1 }
  const first = {
    run_id: 'run-1',
    status: 'needs_input',
    result: { usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 130 } },
  }
  accumulateTaskUsage(task, first, '2026-01-01T00:00:01.000Z')
  task.interactionAttempt = 2
  const second = {
    run_id: 'run-2',
    status: 'completed',
    result: { usage: { input_tokens: 80, output_tokens: 40, reasoning_output_tokens: 5, total_tokens: 120, estimated: true } },
  }
  accumulateTaskUsage(task, second, '2026-01-01T00:00:02.000Z')
  accumulateTaskUsage(task, second, '2026-01-01T00:00:03.000Z')
  assert.deepEqual(task.usage, {
    input_tokens: 180,
    cached_input_tokens: 20,
    output_tokens: 70,
    reasoning_output_tokens: 15,
    total_tokens: 250,
    estimated: true,
  })
  assert.equal(task.usageHistory.length, 2)
  assert.deepEqual(second.result.usage, task.usage)
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

test('choice turns expose a structured request-user-input item', () => {
  const items = agentTurnItems(
    { id: 'turn-choice', taskId: 'task-choice', message: '开一本小说' },
    {
      id: 'task-choice',
      status: 'completed',
      result: {
        status: 'needs_input',
        result: {
          question: {
            requestId: 'call-choice',
            questions: [{ id: 'genre', header: '题材', question: '选题材？', isOther: true, options: [{ label: '无限流' }, { label: '玄幻' }] }],
          },
        },
      },
    },
  )
  const request = items.find((item) => item.type === 'requestUserInput')
  assert.equal(request?.status, 'inProgress')
  assert.equal(request?.requestId, 'call-choice')
})

test('agent input answers follow the request-user-input response shape', () => {
  const normalized = normalizeAgentInputAnswers({
    questions: [
      { id: 'advantage', header: '主角优势', question: '主角的优势是什么？' },
      { id: 'system_rule', header: '系统规则', question: '系统如何结算？' },
    ],
  }, {
    advantage: '熟悉剧情套路',
    system_rule: { answers: ['任务积分'] },
    ignored: '不能进入模型上下文',
  })
  assert.deepEqual(normalized.answers, {
    advantage: { answers: ['熟悉剧情套路'] },
    system_rule: { answers: ['任务积分'] },
  })
  assert.match(normalized.questionText, /主角的优势是什么/)
  assert.match(normalized.answerText, /系统规则：任务积分/)
  assert.doesNotMatch(normalized.answerText, /不能进入/)
})

test('agent input answers require every displayed question', () => {
  assert.throws(() => normalizeAgentInputAnswers({
    questions: [
      { id: 'one', header: '一', question: '第一问？' },
      { id: 'two', header: '二', question: '第二问？' },
    ],
  }, { one: '回答' }), /请回答“二”/)
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
