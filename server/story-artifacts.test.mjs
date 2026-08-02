import assert from 'node:assert/strict'
import test from 'node:test'
import { applyStoryArtifacts, summarizeStoryArtifacts } from './story-artifacts.mjs'

test('story artifacts provide a bounded mutation preview', () => {
  assert.deepEqual(summarizeStoryArtifacts({
    project: { genre: '悬疑' },
    characters: [{ name: '林雾', description: '失踪记者。' }, { name: '', description: '无效' }],
    worldbuilding: [{ title: '旧港', content: '常年有雾。' }],
    chapters: [{ title: '第一章', outline: '抵达旧港。' }],
    documents: [
      { path: '大纲/大纲.md', title: '全书大纲', category: '大纲', content: '# 全书大纲\n\n旧港迷雾逐步散去。' },
      { path: '../越界.md', title: '越界文件', category: '大纲', content: '不应写入。' },
      { path: 'C:\\绝对路径.md', title: '绝对路径', category: '大纲', content: '不应写入。' },
    ],
  }), {
    projectUpdated: true,
    characters: 1,
    worldbuilding: 1,
    chapters: 1,
    documents: 1,
    targets: [
      { kind: '作品', title: '基础设定' },
      { kind: '人物卡', title: '林雾' },
      { kind: '世界观', title: '旧港' },
      { kind: '章节大纲', title: '第一章' },
      { kind: '大纲', title: '全书大纲' },
    ],
    summary: '准备写入作品设定、1 张人物卡、1 条世界观、1 章大纲、1 份资料文件',
  })
})

test('story artifacts upsert project settings, cards, and chapter outlines idempotently', () => {
  const timestamp = '2026-07-28T00:00:00.000Z'
  const db = {
    projects: [{ id: 'project-1', userId: 'user-1', title: '未命名作品', genre: '其他', style: '', tone: '', chapters: 1 }],
    chapters: {
      'project-1': [{ id: 1, title: '第一章', outline: '', words: '0', state: 'draft', createdAt: timestamp, updatedAt: timestamp }],
    },
    drafts: { 'project-1': { 1: '' } },
    editHistory: { 'project-1': { 1: [] } },
    ideas: [],
  }
  const artifacts = {
    project: { genre: '无限流', style: '二次元异世界', premise: '枫羽通过副本不断成长。' },
    characters: [{ name: '枫羽', role: '主角', description: '普通人，被轮回系统选中。' }],
    worldbuilding: [{ title: '轮回系统', content: '通关副本获得属性与技能碎片。' }],
    chapters: [
      { title: '第一章 被选中的人', outline: '枫羽在便利店夜班时被拉入副本。' },
      { title: '第二章 迷雾森林', outline: '枫羽第一次面对副本怪物。' },
    ],
    documents: [{ path: '大纲/大纲.md', title: '全书大纲', category: '大纲', content: '# 大纲\n\n枫羽穿越多个副本，最终发现轮回系统的来源。' }],
  }

  const first = applyStoryArtifacts(db, { userId: 'user-1', projectId: 'project-1', artifacts, timestamp })
  assert.equal(first.applied, true)
  assert.equal(first.characters, 1)
  assert.equal(first.worldbuilding, 1)
  assert.equal(first.chapters, 2)
  assert.equal(first.documents, 1)
  assert.deepEqual(first.fileChanges.map((item) => ({ path: item.path, action: item.action })), [
    { path: '大纲/大纲.md', action: 'created' },
  ])
  assert.equal(db.projects[0].genre, '无限流')
  assert.equal(db.projects[0].tone, '枫羽通过副本不断成长。')
  assert.equal(db.chapters['project-1'].length, 2)
  assert.equal(db.chapters['project-1'][0].title, '第一章 被选中的人')
  assert.equal(db.chapters['project-1'][1].outline, '枫羽第一次面对副本怪物。')
  assert.deepEqual(db.ideas.map((idea) => idea.title).sort(), ['全书大纲', '枫羽', '第一章 被选中的人', '第二章 迷雾森林', '轮回系统'])
  assert.equal(db.ideas.find((idea) => idea.title === '全书大纲').folder, '大纲')
  assert.ok(db.ideas.find((idea) => idea.title === '全书大纲').tags.includes('文件:大纲/大纲.md'))

  const second = applyStoryArtifacts(db, {
    userId: 'user-1',
    projectId: 'project-1',
    artifacts: {
      ...artifacts,
      characters: [{ name: '枫羽', role: '主角', description: '普通人，已经完成第一次系统绑定。' }],
    },
    timestamp: '2026-07-28T00:01:00.000Z',
  })
  assert.equal(second.applied, true)
  assert.equal(second.fileChanges[0].action, 'updated')
  assert.equal(db.chapters['project-1'].length, 2)
  assert.equal(db.ideas.length, 5)
  assert.equal(db.ideas.find((idea) => idea.title === '枫羽').body, '普通人，已经完成第一次系统绑定。')
})
