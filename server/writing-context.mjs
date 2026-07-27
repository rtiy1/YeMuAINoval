const STORY_MEMORY_ORDER = new Map(['canon_fact', 'world_rule', 'character_state', 'voice_habit', 'event', 'chapter_summary'].map((type, index) => [type, index]))

export { STORY_MEMORY_ORDER }

function contextExcerpt(value, maxLength = 1600) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.floor(maxLength * 0.35))}\n…\n${text.slice(-Math.floor(maxLength * 0.65))}`
}

function draftMapFor(db, projectId) {
  const current = db.drafts[projectId]
  return current && typeof current === 'object' && !Array.isArray(current) ? current : {}
}

export function buildWritingContext(db, project, chapter) {
  const chapters = db.chapters[project.id] || []
  const chapterIndex = chapters.findIndex((item) => String(item.id) === String(chapter.id))
  const drafts = draftMapFor(db, project.id)
  const previousChapters = chapters
    .slice(Math.max(0, chapterIndex - 6), chapterIndex)
    .map((item) => ({
      id: item.id,
      title: item.title,
      outline: contextExcerpt(item.outline, 900),
      ending: contextExcerpt(drafts[String(item.id)], 1200).slice(-1200),
    }))
  const materials = db.ideas
    .filter((idea) => idea.userId === project.userId && (!idea.projectId || idea.projectId === project.id))
    .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, 20)
    .map((idea) => ({ label: idea.label, title: idea.title, body: contextExcerpt(idea.body, 500), tags: idea.tags || [] }))
  const unresolvedForeshadows = db.foreshadows
    .filter((item) => item.userId === project.userId && item.projectId === project.id && !['resolved', 'abandoned'].includes(item.status))
    .sort((left, right) => Number(right.importance || 0) - Number(left.importance || 0))
    .slice(0, 20)
    .map((item) => ({ title: item.title, content: contextExcerpt(item.content, 700), status: item.status, targetChapterId: item.targetChapterId || null }))
  const storyMemory = db.storyMemories
    .filter((item) => item.userId === project.userId && item.projectId === project.id && item.status !== 'archived')
    .sort((left, right) => (STORY_MEMORY_ORDER.get(left.type) ?? 99) - (STORY_MEMORY_ORDER.get(right.type) ?? 99)
      || Number(right.importance || 0) - Number(left.importance || 0)
      || String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, 60)
    .map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      content: contextExcerpt(item.content, 900),
      importance: item.importance || 3,
      characterName: item.characterName || '',
      sourceChapterId: item.sourceChapterId || null,
      tags: item.tags || [],
    }))
  return {
    version: 2,
    project: { id: project.id, title: project.title, type: project.type, genre: project.genre, style: project.style || '', premise: project.tone || '' },
    chapter: { id: chapter.id, title: chapter.title, outline: contextExcerpt(chapter.outline, 2400), state: chapter.state },
    previousChapters,
    storyMemory,
    materials,
    unresolvedForeshadows,
  }
}

export function enrichStoryAgentPayload(db, userId, payload) {
  const projectId = payload.project_id || payload.projectId
  const chapterId = payload.chapter_id || payload.chapterId
  if (!projectId) return payload
  const project = db.projects.find((item) => item.id === projectId && item.userId === userId)
  if (!project) throw Object.assign(new Error('作品不存在'), { status: 404 })
  const chapter = chapterId
    ? (db.chapters[project.id] || []).find((item) => String(item.id) === String(chapterId))
    : null
  if (chapterId && !chapter) throw Object.assign(new Error('章节不存在'), { status: 404 })
  const writingContext = chapter
    ? buildWritingContext(db, project, chapter)
    : { version: 1, project: { id: project.id, title: project.title, type: project.type, genre: project.genre, style: project.style || '', premise: project.tone || '' } }
  return { ...payload, writing_context: writingContext }
}
