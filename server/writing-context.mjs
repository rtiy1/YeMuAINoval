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

function chapterSummaryMap(memories) {
  const summaries = new Map()
  for (const memory of memories) {
    if (memory.type !== 'chapter_summary' || !memory.sourceChapterId || memory.status === 'archived') continue
    const key = String(memory.sourceChapterId)
    if (!summaries.has(key) || Number(memory.importance || 0) > Number(summaries.get(key).importance || 0)) {
      summaries.set(key, memory)
    }
  }
  return summaries
}

function summarizedChapter(chapter, drafts, summaries, maxLength = 900) {
  const summary = summaries.get(String(chapter.id))
  const fallback = [chapter.outline, contextExcerpt(drafts[String(chapter.id)], 500)].filter(Boolean).join('\n')
  return {
    id: chapter.id,
    title: chapter.title,
    summary: contextExcerpt(summary?.content || fallback, maxLength),
    summarySource: summary ? 'memory' : 'outline_fallback',
  }
}

function referenceError() {
  return Object.assign(new Error('引用内容不存在或不属于当前作品'), { status: 404 })
}

function referenceContent(db, project, userId, reference) {
  const type = String(reference?.type || '')
  const id = String(reference?.id || '')
  if (!type || !id) throw Object.assign(new Error('引用格式无效'), { status: 400 })
  if (type === 'project') {
    if (id !== String(project.id)) throw referenceError()
    return {
      name: `${project.title}.story.md`,
      kind: '作品设定',
      content: `# ${project.title}\n\n篇幅：${project.type || '未设置'}\n题材：${project.genre || '未设置'}\n流派：${project.style || '未设置'}\n创作基调：${project.tone || '未设置'}`,
    }
  }
  if (type === 'chapter') {
    const chapter = (db.chapters[project.id] || []).find((item) => String(item.id) === id)
    if (!chapter) throw referenceError()
    const content = draftMapFor(db, project.id)[String(chapter.id)] || ''
    return {
      name: `${String(chapter.id).padStart(2, '0')}-${chapter.title}.md`,
      kind: '章节正文',
      content: `# ${chapter.title}\n\n章节大纲：${chapter.outline || '未设置'}\n\n${content}`,
    }
  }
  if (type === 'idea') {
    const idea = (db.ideas || []).find((item) => String(item.id) === id && item.userId === userId && (!item.projectId || item.projectId === project.id))
    if (!idea) throw referenceError()
    return {
      name: idea.title,
      kind: idea.label || '灵感卡片',
      content: `# ${idea.title}\n\n${idea.body || ''}\n\n标签：${(idea.tags || []).join('、') || '无'}`,
    }
  }
  if (type === 'foreshadow') {
    const item = (db.foreshadows || []).find((value) => String(value.id) === id && value.userId === userId && value.projectId === project.id)
    if (!item) throw referenceError()
    return {
      name: item.title,
      kind: '伏笔',
      content: `# ${item.title}\n\n状态：${item.status || '未设置'}\n重要度：${item.importance || 3}\n\n${item.content || ''}`,
    }
  }
  if (type === 'memory') {
    const item = (db.storyMemories || []).find((value) => String(value.id) === id && value.userId === userId && value.projectId === project.id && value.status !== 'archived')
    if (!item) throw referenceError()
    return {
      name: item.title,
      kind: '作品记忆',
      content: `# ${item.title}\n\n类型：${item.type || '未设置'}\n重要度：${item.importance || 3}\n\n${item.content || ''}`,
    }
  }
  throw Object.assign(new Error(`不支持的引用类型：${type}`), { status: 400 })
}

export function resolveStoryAttachments(db, project, userId, attachments) {
  if (!Array.isArray(attachments)) return []
  return attachments.slice(0, 6).map((attachment) => {
    const reference = attachment?.reference && typeof attachment.reference === 'object'
      ? { type: String(attachment.reference.type || ''), id: String(attachment.reference.id || '') }
      : null
    const resolved = reference ? referenceContent(db, project, userId, reference) : null
    return {
      name: contextExcerpt(resolved?.name || attachment?.name, 240),
      kind: contextExcerpt(resolved?.kind || attachment?.kind || '外部文件', 80),
      content: contextExcerpt(resolved?.content || attachment?.content, 60_000),
      ...(reference ? { reference } : {}),
    }
  }).filter((item) => item.name && item.content)
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
  const projectMemories = (db.storyMemories || [])
    .filter((item) => item.userId === project.userId && item.projectId === project.id && item.status !== 'archived')
  const summaries = chapterSummaryMap(projectMemories)
  const priorChapters = chapters.slice(0, Math.max(0, chapterIndex))
  const nearChapters = priorChapters.slice(-3).map((item) => ({
    id: item.id,
    title: item.title,
    outline: contextExcerpt(item.outline, 900),
    ending: contextExcerpt(drafts[String(item.id)], 1600).slice(-1600),
  }))
  const midChapters = priorChapters.slice(Math.max(0, priorChapters.length - 12), Math.max(0, priorChapters.length - 3))
    .map((item) => summarizedChapter(item, drafts, summaries, 900))
  const farSource = priorChapters.slice(0, Math.max(0, priorChapters.length - 12))
  const farChapters = farSource.slice(-40).map((item) => summarizedChapter(item, drafts, summaries, 500))
  const summaryStatus = {
    previousChapterCount: priorChapters.length,
    summarizedChapterCount: priorChapters.filter((item) => summaries.has(String(item.id))).length,
    missingChapterIds: priorChapters.filter((item) => !summaries.has(String(item.id))).map((item) => item.id),
  }
  summaryStatus.complete = summaryStatus.missingChapterIds.length === 0
  const storyMemory = projectMemories
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
    version: 3,
    project: { id: project.id, title: project.title, type: project.type, genre: project.genre, style: project.style || '', premise: project.tone || '' },
    chapter: { id: chapter.id, title: chapter.title, outline: contextExcerpt(chapter.outline, 2400), state: chapter.state },
    previousChapters,
    layers: {
      near: { strategy: 'outline_and_ending', chapters: nearChapters },
      mid: { strategy: 'summary_with_outline_fallback', chapters: midChapters },
      far: { strategy: 'summary_catalog', chapters: farChapters, omittedChapterCount: Math.max(0, farSource.length - farChapters.length) },
    },
    summaryStatus,
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
  const attachedFiles = resolveStoryAttachments(db, project, userId, payload.attached_files)
  const requestedPolicy = payload.tool_policy && typeof payload.tool_policy === 'object' ? payload.tool_policy : {}
  const toolPolicy = {
    version: 1,
    readProjectContext: 'allow',
    externalSearch: requestedPolicy.externalSearch === 'allow' ? 'allow' : 'deny',
    mutateStoryData: requestedPolicy.mutateStoryData === 'allow' ? 'allow' : 'propose',
    deleteStoryData: 'deny',
  }
  return { ...payload, attached_files: attachedFiles, writing_context: writingContext, tool_policy: toolPolicy }
}
