import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWritingContext, enrichStoryAgentPayload, resolveStoryAttachments } from './writing-context.mjs'

const now = '2026-07-28T00:00:00.000Z'
const project = { id: 'project-1', userId: 'user-1', title: '旧港来信', type: '长篇', genre: '悬疑', style: '克制', tone: '追查失踪案' }
const chapters = Array.from({ length: 15 }, (_, index) => ({ id: index + 1, title: `第${index + 1}章`, outline: `大纲 ${index + 1}`, state: 'done' }))
const db = {
  projects: [project],
  chapters: { [project.id]: chapters },
  drafts: { [project.id]: Object.fromEntries(chapters.map((chapter) => [chapter.id, `正文 ${chapter.id}\n章末 ${chapter.id}`])) },
  ideas: [
    { id: 'idea-1', userId: 'user-1', projectId: project.id, label: '线索', title: '灯塔', body: '灯塔每晚闪三次。', tags: ['旧港'], updatedAt: now },
    { id: 'idea-2', userId: 'user-1', projectId: project.id, label: '大纲文档', folder: '大纲', title: '全书大纲', body: '# 大纲\n\n主角追查旧港失踪案。', tags: ['Skill产物', '文件:大纲/大纲.md'], updatedAt: now },
    { id: 'idea-3', userId: 'user-1', projectId: project.id, label: '大纲文档', folder: '大纲', title: '第十五章细纲', body: '# 第十五章细纲\n\n主角进入灯塔。', tags: ['Skill产物', '文件:大纲/细纲_第015章.md'], updatedAt: now },
    { id: 'idea-4', userId: 'user-1', projectId: project.id, label: '大纲文档', folder: '大纲', title: '第一卷卷纲', body: '# 第一卷\n\n- 章节范围：第1-15章\n- 灯塔谜案告一段落。', tags: ['Skill产物', '文件:大纲/卷纲_第一卷.md'], updatedAt: now },
    { id: 'idea-5', userId: 'user-1', projectId: project.id, label: '追踪文档', folder: '追踪', title: '伏笔追踪', body: '# 伏笔\n\n第三封信尚未回收。', tags: ['Skill产物', '文件:追踪/伏笔.md'], updatedAt: now },
    { id: 'idea-6', userId: 'user-1', projectId: project.id, label: '大纲文档', folder: '大纲', title: '第一章细纲', body: '# 第一章细纲\n\n主角初到旧港。', tags: ['Skill产物', '文件:大纲/细纲_第001章.md'], updatedAt: now },
  ],
  foreshadows: [{ id: 'foreshadow-1', userId: 'user-1', projectId: project.id, title: '第三封信', content: '第三封信来自失踪记者。', status: 'planted', importance: 5 }],
  storyMemories: [
    { id: 'memory-1', userId: 'user-1', projectId: project.id, type: 'chapter_summary', title: '第一章摘要', content: '主角抵达旧港。', sourceChapterId: 1, importance: 4, status: 'active', updatedAt: now },
    { id: 'memory-2', userId: 'user-1', projectId: project.id, type: 'canon_fact', title: '记者身份', content: '记者曾在灯塔工作。', importance: 5, status: 'active', updatedAt: now },
  ],
}

test('writing context separates chapter layers and loads Skill files by path', () => {
  const context = buildWritingContext(db, project, chapters[14], '续写第15章')
  assert.equal(context.version, 4)
  assert.deepEqual(context.layers.near.chapters.map((item) => item.id), [12, 13, 14])
  assert.deepEqual(context.layers.mid.chapters.map((item) => item.id), [3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.deepEqual(context.layers.far.chapters.map((item) => item.id), [1, 2])
  assert.equal(context.layers.far.chapters[0].summarySource, 'memory')
  assert.equal(context.summaryStatus.previousChapterCount, 14)
  assert.deepEqual(context.summaryStatus.missingChapterIds.slice(0, 2), [2, 3])
  assert.deepEqual(context.storyFiles.inventory.map((item) => item.path).sort(), [
    '大纲/卷纲_第一卷.md',
    '大纲/大纲.md',
    '大纲/细纲_第001章.md',
    '大纲/细纲_第015章.md',
    '追踪/伏笔.md',
  ])
  assert.equal(context.storyFiles.loaded[0].path, '大纲/细纲_第015章.md')
  assert.match(context.storyFiles.loaded[0].content, /进入灯塔/)
  assert.equal(context.storyFiles.loaded[1].path, '大纲/卷纲_第一卷.md')
  assert.ok(context.storyFiles.loaded.findIndex((item) => item.path === '追踪/伏笔.md')
    < context.storyFiles.loaded.findIndex((item) => item.path === '大纲/细纲_第001章.md'))
  const serialized = JSON.stringify(context)
  assert.ok(serialized.indexOf('"storyFiles"') < serialized.indexOf('"previousChapters"'))
  assert.deepEqual(context.materials.map((item) => item.title), ['灯塔'])
})

test('typed attachments resolve current data at invocation time', () => {
  const references = [
    { name: 'stale', kind: 'stale', content: '旧内容', reference: { type: 'chapter', id: '2' } },
    { name: 'stale', kind: 'stale', content: '旧内容', reference: { type: 'idea', id: 'idea-1' } },
    { name: 'stale', kind: 'stale', content: '旧内容', reference: { type: 'foreshadow', id: 'foreshadow-1' } },
    { name: 'stale', kind: 'stale', content: '旧内容', reference: { type: 'memory', id: 'memory-2' } },
  ]
  const resolved = resolveStoryAttachments(db, project, 'user-1', references)
  assert.match(resolved[0].content, /正文 2/)
  assert.match(resolved[1].content, /灯塔每晚闪三次/)
  assert.match(resolved[2].content, /第三封信来自失踪记者/)
  assert.match(resolved[3].content, /记者曾在灯塔工作/)
  assert.ok(resolved.every((item) => !item.content.includes('旧内容')))
})

test('agent payload enforces a bounded permission policy', () => {
  const payload = enrichStoryAgentPayload(db, 'user-1', {
    project_id: project.id,
    chapter_id: 15,
    attached_files: [{ name: '灯塔', reference: { type: 'idea', id: 'idea-1' } }],
    tool_policy: { externalSearch: 'allow', mutateStoryData: 'propose', deleteStoryData: 'allow' },
  }, '续写第15章')
  assert.equal(payload.tool_policy.externalSearch, 'allow')
  assert.equal(payload.tool_policy.mutateStoryData, 'propose')
  assert.equal(payload.tool_policy.deleteStoryData, 'deny')
  assert.match(payload.attached_files[0].content, /灯塔每晚闪三次/)
  assert.equal(payload.writing_context.storyFiles.loaded[0].path, '大纲/细纲_第015章.md')
})
