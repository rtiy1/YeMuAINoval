import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSlashCommand, resolveSelection, skillForProject } from './commands.mjs'
import { NovelApiClient, normalizeApiBase } from './api-client.mjs'
import { contentToText, extractAgentText, extractWritableText } from './result-text.mjs'
import { changedTaskEvents, terminalDiffHunks } from './task-view.mjs'

test('contentToText normalizes provider content blocks', () => {
  assert.equal(contentToText([{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }]), '第一段\n第二段')
  assert.equal(contentToText({ content: [{ text: '正文' }] }), '正文')
})

test('extractAgentText never leaks object coercion', () => {
  const response = { result: { message: { text: '模型配置错误' } } }
  assert.equal(extractAgentText(response), '模型配置错误')
  assert.notEqual(extractAgentText(response), '[object Object]')
})

test('extractWritableText prefers a structured edit proposal', () => {
  const response = {
    result: {
      output: '备用稿',
      edit_proposal: { revised_text: [{ type: 'text', text: '完整建议稿' }] },
    },
  }
  assert.equal(extractWritableText(response), '完整建议稿')
})

test('slash commands retain the full Chinese argument', () => {
  assert.deepEqual(parseSlashCommand('/write 加强章末钩子'), { name: 'write', argument: '加强章末钩子' })
  assert.equal(parseSlashCommand('直接对话'), null)
})

test('selection supports index, id, exact title and unique fuzzy title', () => {
  const items = [{ id: 'a', title: '长夜将明' }, { id: 'b', title: '旧港来信' }]
  assert.equal(resolveSelection(items, '2').id, 'b')
  assert.equal(resolveSelection(items, 'a').title, '长夜将明')
  assert.equal(resolveSelection(items, '旧港').id, 'b')
})

test('project length selects only novel writing skills', () => {
  assert.equal(skillForProject({ type: '短篇' }, 'write'), 'story-short-write')
  assert.equal(skillForProject({ type: '长篇' }, 'scan'), 'story-long-scan')
})

test('API base accepts both host and explicit api path', () => {
  assert.equal(normalizeApiBase('http://127.0.0.1:8787'), 'http://127.0.0.1:8787/api')
  assert.equal(normalizeApiBase('http://127.0.0.1:8787/api/'), 'http://127.0.0.1:8787/api')
})

test('task events are emitted again when their lifecycle changes', () => {
  const running = [{ id: 'task:1', type: 'skill', label: '执行 Skill', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' }]
  const first = changedTaskEvents(running)
  assert.equal(first.changed.length, 1)
  const unchanged = changedTaskEvents(running, first.next)
  assert.equal(unchanged.changed.length, 0)
  const completed = changedTaskEvents([{ ...running[0], status: 'completed', completedAt: '2026-01-01T00:00:01.000Z' }], unchanged.next)
  assert.equal(completed.changed.length, 1)
  assert.equal(completed.changed[0].status, 'completed')
})

test('terminal diff keeps only reviewable red and green changes', () => {
  const hunks = terminalDiffHunks('保留段落\n\n旧段落', '保留段落\n\n新段落')
  assert.equal(hunks.length, 1)
  assert.equal(hunks[0].type, 'replace')
  assert.equal(hunks[0].original, '旧段落')
  assert.equal(hunks[0].replacement, '新段落')
})

test('terminal API client uses asynchronous task lifecycle routes', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options })
    return new Response(JSON.stringify({ task: { id: 'task-1', status: 'queued' }, tasks: [] }), {
      status: url.includes('/ai/tasks') && options.method === 'POST' ? 202 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const client = new NovelApiClient({ baseUrl: 'http://127.0.0.1:8787', accessToken: 'token' })
    const controller = new AbortController()
    await client.createTask('续写', 'story-long-write', { projectId: 'book' }, { idempotencyKey: 'once', signal: controller.signal })
    await client.getTask('task-1', { signal: controller.signal })
    await client.getTasks('book')
    await client.cancelTask('task-1')
    await client.retryTask('task-1', { signal: controller.signal })
    assert.deepEqual(requests.map((item) => new URL(item.url).pathname), [
      '/api/ai/tasks',
      '/api/ai/tasks/task-1',
      '/api/ai/tasks',
      '/api/ai/tasks/task-1/cancel',
      '/api/ai/tasks/task-1/retry',
    ])
    assert.equal(new URL(requests[2].url).searchParams.get('projectId'), 'book')
    assert.equal(JSON.parse(requests[0].options.body).idempotencyKey, 'once')
    assert.equal(requests[0].options.signal, controller.signal)
  } finally {
    globalThis.fetch = originalFetch
  }
})
