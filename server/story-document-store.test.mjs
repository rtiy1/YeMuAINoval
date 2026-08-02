import { expect, test } from 'bun:test'
import { writeStoryDocumentToState } from './story-document-store.mjs'

function database() {
  return {
    users: [{ id: 'user-1' }],
    projects: [{ id: 'project-1', userId: 'user-1', title: '测试作品' }],
    ideas: [],
    chapters: { 'project-1': [] },
    drafts: { 'project-1': {} },
    editHistory: { 'project-1': {} },
  }
}

test('Agent documents are upserted into the database-backed left rail store', () => {
  const db = database()
  const first = writeStoryDocumentToState(db, 'user-1', 'project-1', {
    path: '大纲/大纲.md',
    title: '全书大纲',
    category: '大纲',
    content: '# 全书大纲\n\n主角追查旧港失踪案。',
  })
  expect(first.file?.path).toBe('大纲/大纲.md')
  expect(first.application.fileChanges).toEqual([expect.objectContaining({ action: 'created', category: '大纲' })])
  expect(db.ideas).toHaveLength(1)
  expect(db.ideas[0]?.folder).toBe('大纲')

  const second = writeStoryDocumentToState(db, 'user-1', 'project-1', {
    path: '大纲/大纲.md',
    title: '全书大纲',
    category: '大纲',
    content: '# 全书大纲\n\n主角最终找到灯塔。',
  })
  expect(second.application.fileChanges[0]?.action).toBe('updated')
  expect(db.ideas).toHaveLength(1)
  expect(db.ideas[0]?.body).toContain('灯塔')
})
