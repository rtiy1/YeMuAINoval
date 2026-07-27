import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentEventDuration,
  agentResponseText,
  agentThreadMessages,
  agentTurnEvents,
  formatAgentDuration,
  isEditorAgentEdit,
  normalizeStructuredAgentQuestion,
  parseAgentChoicePrompt,
  resolveEditorAgentCommand,
  waitForAgentPoll,
} from '../src/editor-agent.mjs'

test('editor agent routes slash commands by project length', () => {
  assert.deepEqual(
    resolveEditorAgentCommand('/write 加强章末钩子', { type: '短篇' }),
    { skill: 'story-short-write', message: '加强章末钩子' },
  )
  assert.equal(resolveEditorAgentCommand('/scan', { type: '长篇' }).skill, 'story-long-scan')
  assert.deepEqual(
    resolveEditorAgentCommand('/skill story-review 检查人物动机', { type: '长篇' }),
    { skill: 'story-review', message: '检查人物动机' },
  )
})

test('editor agent distinguishes review tasks from reviewable edits', () => {
  assert.equal(isEditorAgentEdit('审查这一章', 'story-review'), false)
  assert.equal(isEditorAgentEdit('扫描作品问题', 'story-long-scan'), false)
  assert.equal(isEditorAgentEdit('保持语气并续写', 'story-long-write'), true)
  assert.equal(isEditorAgentEdit('自然化处理', 'story-deslop'), true)
})

test('editor agent renders structured result summaries', () => {
  assert.equal(
    agentResponseText({ result: { edit_proposal: { summary: '调整了章末冲突。' } } }),
    '调整了章末冲突。',
  )
  assert.match(
    agentResponseText({ result: { verdict: '需要修改', score: 72, findings: [{ issue: '动机不足', fix: '补一处行动依据' }] } }),
    /动机不足：补一处行动依据/,
  )
  assert.equal(agentResponseText({ status: 'completed', result: {} }), '任务已完成。')
})

test('editor agent converts markdown choices into structured options', () => {
  const parsed = parseAgentChoicePrompt(`# 项目状态诊断

当前项目没有明确流派，需要先确认。

**障碍问题（1个）：**

你要写哪一种无限流？

- **A** — 副本生存 / 规则怪谈
- **B** — 现代言情框架加入无限流元素
- **C** — 还没想好，先帮我确定方向

确定后我直接进入开书流程。`)

  assert.equal(parsed.intro, '项目状态诊断\n\n当前项目没有明确流派，需要先确认。')
  assert.equal(parsed.question, '你要写哪一种无限流？')
  assert.deepEqual(parsed.options.map(({ key, label }) => ({ key, label })), [
    { key: 'A', label: '副本生存 / 规则怪谈' },
    { key: 'B', label: '现代言情框架加入无限流元素' },
    { key: 'C', label: '还没想好，先帮我确定方向' },
  ])
  assert.equal(parsed.options[0].reply, 'A：副本生存 / 规则怪谈')
  assert.equal(parsed.hint, '确定后我直接进入开书流程。')
})

test('editor agent leaves ordinary prose unchanged', () => {
  assert.equal(parseAgentChoicePrompt('这是普通的章节分析，没有需要选择的内容。'), null)
})

test('editor agent converts markdown comparison tables into selectable directions', () => {
  const parsed = parseAgentChoicePrompt(`## 一个阻塞问题

**你想让读者体验打脸逆袭，还是体验熟人解谜？**

|  | 逆袭打脸型 | 熟人解谜型 |
|---|---|---|
| 单副本长度 | 10-15章 | 5-8章 |
| 节奏 | 爽点密集 | 线索密集 |

告诉我你更想要哪种，我直接进入开书流程。`)

  assert.equal(parsed.question, '你想让读者体验打脸逆袭，还是体验熟人解谜？')
  assert.deepEqual(parsed.options.map(({ key, label }) => ({ key, label })), [
    { key: 'A', label: '逆袭打脸型' },
    { key: 'B', label: '熟人解谜型' },
  ])
  assert.match(parsed.options[0].description, /单副本长度：10-15章/)
  assert.match(parsed.hint, /进入开书流程/)
})

test('editor agent renders structured blocking questions returned by skills', () => {
  const parsed = normalizeStructuredAgentQuestion({
    question: '副本核心体验选哪一种？',
    options: [
      { key: 'A', label: '规则怪谈', value: '规则怪谈', description: '强调规则推理' },
      { key: 'B', label: '生存闯关', value: '生存闯关', description: '强调资源压力' },
    ],
  })
  assert.equal(parsed.question, '副本核心体验选哪一种？')
  assert.equal(parsed.options[1].reply, 'B：生存闯关')
  assert.equal(parsed.options[0].description, '强调规则推理')
})

test('editor agent formats durations and aborts polling', async () => {
  assert.equal(formatAgentDuration(1500), '1.5 秒')
  assert.equal(formatAgentDuration(65_000), '1 分 5 秒')
  assert.equal(agentEventDuration({
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:02.000Z',
  }), '2.0 秒')

  const controller = new AbortController()
  const pending = waitForAgentPoll(10_000, controller.signal)
  controller.abort()
  await assert.rejects(pending, (error) => error?.name === 'AbortError')
})

test('editor agent restores persisted thread turns', () => {
  const messages = agentThreadMessages({
    turns: [{
      id: 'turn-1',
      taskId: 'task-1',
      message: '续写本章',
      editRequested: true,
      items: [
        { id: 'item-user', type: 'userMessage', status: 'completed' },
        { id: 'item-skill', type: 'dynamicToolCall', status: 'completed', summary: '执行写作 Skill' },
        { id: 'item-agent', type: 'agentMessage', status: 'completed' },
      ],
      source: { chapterId: '1', sourceText: '原文' },
      plan: [
        { step: '读取上下文', status: 'completed' },
        { step: '生成写作结果', status: 'completed' },
      ],
      task: {
        id: 'task-1',
        status: 'completed',
        skill: 'story-long-write',
        result: { status: 'completed', result: { output: '续写结果' } },
        events: [{ id: 'event-1', status: 'completed' }],
        progress: 100,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z',
      },
    }],
  })
  assert.equal(messages.length, 2)
  assert.deepEqual(messages.map((item) => item.role), ['user', 'agent'])
  assert.equal(messages[1].text, '续写结果')
  assert.equal(messages[1].durationMs, 2000)
  assert.equal(messages[1].source.sourceText, '原文')
  assert.equal(messages[1].turnId, 'turn-1')
  assert.equal(messages[1].events[0].label, '执行写作 Skill')
  assert.deepEqual(messages[1].plan.map((item) => item.status), ['completed', 'completed'])
})

test('editor agent maps in-progress and interrupted items to timeline events', () => {
  assert.deepEqual(agentTurnEvents({
    items: [
      { id: 'user', type: 'userMessage', status: 'completed' },
      { id: 'tool', type: 'dynamicToolCall', tool: 'story-review', status: 'inProgress' },
      { id: 'reason', type: 'reasoning', summary: '等待授权', status: 'interrupted' },
    ],
  }).map(({ type, status }) => ({ type, status })), [
    { type: 'skill', status: 'running' },
    { type: 'lifecycle', status: 'cancelled' },
  ])
})
