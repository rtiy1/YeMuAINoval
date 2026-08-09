import { describe, expect, test } from 'bun:test'
import {
  canReplaceActiveDraft,
  changedChapterIds,
  shouldRefreshActiveDraft,
} from './artifact-sync.mjs'

describe('generated artifact editor synchronization', () => {
  test('identifies chapter draft changes from artifact applications', () => {
    const application = {
      fileChanges: [
        { id: 'chapter:1', category: '正文', path: '正文/第一章.md' },
        { id: 'idea-1', category: '大纲', path: '大纲/总纲.md' },
        { id: 'chapter:chapter-2', path: '正文/第二章.md' },
      ],
    }

    expect([...changedChapterIds(application)]).toEqual(['1', 'chapter-2'])
    expect(shouldRefreshActiveDraft(application, 1)).toBe(true)
    expect(shouldRefreshActiveDraft(application, '2')).toBe(false)
  })

  test('replaces the editor only when it still shows the saved draft', () => {
    expect(canReplaceActiveDraft({
      activeKey: 'project-1:1',
      expectedKey: 'project-1:1',
      currentDraft: '旧正文',
      savedDraft: '旧正文',
    })).toBe(true)
    expect(canReplaceActiveDraft({
      activeKey: 'project-1:1',
      expectedKey: 'project-1:1',
      currentDraft: '用户正在修改',
      savedDraft: '旧正文',
    })).toBe(false)
  })
})
