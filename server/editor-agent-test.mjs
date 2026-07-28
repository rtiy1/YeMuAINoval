import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentEventDuration,
  agentResponseText,
  agentTaskDurationMs,
  agentThreadMessages,
  agentTurnEvents,
  compactAgentEvents,
  formatAgentDuration,
  isEditorAgentEdit,
  normalizeStructuredAgentQuestion,
  parseAgentChoicePrompt,
  parseAgentChoiceResponse,
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

test('editor agent repairs malformed compatibility choices and separates their reasoning preamble', () => {
  const parsed = parseAgentChoiceResponse(`项目是空白状态，用户只给了宽泛方向，需要确认一个关键分叉。
<choice_request>
{"questions":[{"id":"infinite_flow_mode","header":"无限流模式","question":"你想要的"无限流"是哪种运转方式？","options":[{"label":"副本轮回制","description":"进入一个个独立"副本世界"完成任务"},{"label":"多元宇宙穿梭","description":"世界之间保持持续因果"},{"label":"融合流","description":"副本与长期羁绊结合"}]}]}
</choice_request>`)

  assert.equal(parsed.request.protocol, 'request_user_input')
  assert.equal(parsed.request.questions[0].id, 'infinite_flow_mode')
  assert.equal(parsed.prompt.question, '你想要的"无限流"是哪种运转方式？')
  assert.deepEqual(parsed.prompt.options.map((option) => option.label), ['副本轮回制', '多元宇宙穿梭', '融合流'])
  assert.match(parsed.prompt.options[0].description, /"副本世界"/)
  assert.match(parsed.reasoning, /需要确认一个关键分叉/)
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
  assert.equal(parsed.options[1].reply, '生存闯关')
  assert.equal(parsed.options[0].description, '强调规则推理')
})

test('editor agent keeps one question when a model packs multiple questions', () => {
  const parsed = normalizeStructuredAgentQuestion({
    question: '副本核心体验选哪一种？主角是否带记忆？',
    options: [
      { label: '规则怪谈', value: '规则怪谈' },
      { label: '生存闯关', value: '生存闯关' },
    ],
  })
  assert.equal(parsed.question, '副本核心体验选哪一种？')
})

test('editor agent preserves a structured multi-question queue', () => {
  const parsed = normalizeStructuredAgentQuestion({
    questions: [
      { id: 'genre', header: '题材', question: '选择题材？', isOther: true, options: [{ label: '无限流' }, { label: '玄幻' }] },
      { id: 'tone', header: '体验', question: '选择体验？', isOther: true, options: [{ label: '智斗' }, { label: '成长' }] },
    ],
  })
  assert.equal(parsed.questions.length, 2)
  assert.equal(parsed.questions[1].id, 'tone')
  assert.equal(parsed.questions[1].header, '体验')
  assert.equal(parsed.questions[0].options[0].reply, '无限流')
})

test('editor agent compacts repeated execution cycles and drops queue noise', () => {
  const compacted = compactAgentEvents([
    { id: 'queued', type: 'lifecycle', label: '任务已排队', status: 'completed' },
    { id: 'context-1', type: 'lifecycle', label: '读取作品、章节与连续性上下文', status: 'completed' },
    { id: 'skill-1', type: 'skill', label: '完成 story-long-write Skill', status: 'completed', meta: { selectedSkill: 'story-long-write' } },
    { id: 'input-1', type: 'lifecycle', label: '收到用户回答，继续执行', status: 'completed' },
    { id: 'context-2', type: 'lifecycle', label: '读取作品、章节与连续性上下文', status: 'completed' },
    { id: 'skill-2', type: 'skill', label: '完成 story-long-write Skill', status: 'completed', meta: { selectedSkill: 'story-long-write' } },
    { id: 'input-2', type: 'lifecycle', label: '已确认补充信息', status: 'completed' },
  ])
  assert.deepEqual(compacted.map(({ label, count }) => ({ label, count })), [
    { label: '读取作品、章节与连续性上下文', count: 2 },
    { label: '完成 story-long-write Skill', count: 2 },
    { label: '已确认补充信息', count: 2 },
  ])
})

test('editor agent formats durations and aborts polling', async () => {
  assert.equal(formatAgentDuration(1500), '1.5 秒')
  assert.equal(formatAgentDuration(65_000), '1 分 5 秒')
  assert.equal(agentEventDuration({
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:02.000Z',
  }), '2.0 秒')
  assert.equal(agentTaskDurationMs({
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:12:42.000Z',
    events: [
      { type: 'context', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:02.000Z' },
      { type: 'skill', startedAt: '2026-01-01T00:00:02.000Z', completedAt: '2026-01-01T00:00:20.000Z' },
      { type: 'input', startedAt: '2026-01-01T00:12:00.000Z', completedAt: '2026-01-01T00:12:00.000Z' },
      { type: 'context', startedAt: '2026-01-01T00:12:00.000Z', completedAt: '2026-01-01T00:12:02.000Z' },
      { type: 'skill', startedAt: '2026-01-01T00:12:02.000Z', completedAt: '2026-01-01T00:12:42.000Z' },
    ],
  }), 62_000)

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

test('editor agent restores steer messages and maps collaboration agents', () => {
  const thread = {
    turns: [{
      id: 'turn-team',
      taskId: 'task-team',
      message: '续写',
      task: {
        id: 'task-team',
        status: 'completed',
        steeringHistory: [{ id: 'steer-team', text: '改成第三人称', status: 'applied' }],
        result: { result: { output: '第三人称正文' } },
      },
      items: [{
        id: 'subagent-team',
        type: 'collabAgentToolCall',
        status: 'completed',
        summary: '连续性子代理已返回报告',
        meta: { role: 'continuity_guard', reportSummary: '时间线一致。' },
      }],
    }],
  }
  const messages = agentThreadMessages(thread)
  assert.deepEqual(messages.map((item) => item.role), ['user', 'user', 'agent'])
  assert.equal(messages[1].steer, true)
  assert.equal(messages[2].events[0].type, 'subagent')
  assert.equal(messages[2].events[0].meta.reportSummary, '时间线一致。')
})

test('editor agent restores an in-flight partial output without substituting the status label', () => {
  const messages = agentThreadMessages({
    turns: [{
      id: 'turn-running',
      taskId: 'task-running',
      message: '继续写',
      task: {
        id: 'task-running',
        status: 'running',
        partialOutput: '已经生成的半段正文',
        statusMessage: '正在生成回复',
      },
      items: [],
    }],
  })
  assert.equal(messages[1].text, '已经生成的半段正文')
  assert.equal(messages[1].status, 'running')
})

test('editor agent restores resolved answers and all reasoning summaries', () => {
  const messages = agentThreadMessages({
    turns: [{
      id: 'turn-history',
      taskId: 'task-history',
      message: '设计一个副本',
      items: [],
      task: {
        id: 'task-history',
        status: 'completed',
        result: { status: 'completed', result: { output: '副本设计完成' } },
        inputHistory: [{
          requestId: 'call-history',
          response: { answerText: '题材：规则怪谈' },
        }],
        reasoningHistory: [{ id: 'reason-1', summary: '先确认题材。' }],
        reasoningSummary: '根据题材完成设计。',
        usage: { input_tokens: 120, output_tokens: 50, total_tokens: 170 },
      },
    }],
  })
  assert.deepEqual(messages.map((item) => item.role), ['user', 'user', 'agent'])
  assert.equal(messages[1].text, '题材：规则怪谈')
  assert.equal(messages[2].reasoningHistory[0].summary, '先确认题材。')
  assert.equal(messages[2].reasoningSummary, '根据题材完成设计。')
  assert.equal(messages[2].usage.total_tokens, 170)
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

test('editor agent does not render model reasoning as a fake lifecycle event', () => {
  assert.deepEqual(agentTurnEvents({
    items: [{
      id: 'model-reasoning',
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: '核对上下文。' }],
      meta: { modelReasoning: true },
    }],
  }), [])
})
