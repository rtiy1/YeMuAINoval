import assert from 'node:assert/strict'
import test from 'node:test'
import { applyStoryArtifacts } from './story-artifacts.mjs'

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
  }

  const first = applyStoryArtifacts(db, { userId: 'user-1', projectId: 'project-1', artifacts, timestamp })
  assert.equal(first.applied, true)
  assert.equal(first.characters, 1)
  assert.equal(first.worldbuilding, 1)
  assert.equal(first.chapters, 2)
  assert.equal(db.projects[0].genre, '无限流')
  assert.equal(db.projects[0].tone, '枫羽通过副本不断成长。')
  assert.equal(db.chapters['project-1'].length, 2)
  assert.equal(db.chapters['project-1'][0].title, '第一章 被选中的人')
  assert.equal(db.chapters['project-1'][1].outline, '枫羽第一次面对副本怪物。')
  assert.deepEqual(db.ideas.map((idea) => idea.title).sort(), ['枫羽', '轮回系统'])

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
  assert.equal(db.chapters['project-1'].length, 2)
  assert.equal(db.ideas.length, 2)
  assert.equal(db.ideas.find((idea) => idea.title === '枫羽').body, '普通人，已经完成第一次系统绑定。')
})
