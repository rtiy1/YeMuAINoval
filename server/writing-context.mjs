const STORY_MEMORY_ORDER = new Map(['canon_fact', 'world_rule', 'character_state', 'voice_habit', 'event', 'chapter_summary'].map((type, index) => [type, index]))

export { STORY_MEMORY_ORDER }

function contextExcerpt(value, maxLength = 1600) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.floor(maxLength * 0.35))}\n…\n${text.slice(-Math.floor(maxLength * 0.65))}`
}

function workspaceSegment(value, fallback) {
  const normalized = String(value || fallback || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/[.\s]+$/g, '')
    .trim()
    .slice(0, 100)
  return normalized || fallback
}

function taggedStoryFilePath(idea) {
  const tag = Array.isArray(idea?.tags)
    ? idea.tags.find((item) => String(item).startsWith('文件:'))
    : null
  return tag ? String(tag).slice(3).trim() : ''
}

export function storyFilePath(idea) {
  const taggedPath = taggedStoryFilePath(idea)
  if (taggedPath) return taggedPath
  if (!idea?.title) return ''
  const folder = workspaceSegment(idea.folder || idea.label, '资料')
  const title = workspaceSegment(idea.title, idea.id || '未命名')
  return `${folder}/${title}.md`
}

export function chapterStoryFilePath(chapter) {
  const id = String(chapter?.id ?? '').padStart(3, '0')
  const title = workspaceSegment(chapter?.title, `第${id}章`)
  return `正文/${id}-${title}.md`
}

export function readStoryFileForAgent(db, userId, projectId, requestedPath) {
  const rawPath = String(requestedPath || '').replaceAll('\\', '/').trim().slice(0, 240)
  if (!rawPath || rawPath.startsWith('/') || /^[A-Za-z]:\//.test(rawPath)) return null
  const parts = rawPath.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) return null
  const path = parts.join('/')
  const project = db.projects.find((item) => item.id === projectId && item.userId === userId)
  if (!project) return null
  const idea = (db.ideas || []).find((item) => item.userId === userId
    && item.projectId === projectId
    && storyFilePath(item) === path)
  if (idea) {
    return {
      path,
      title: String(idea.title || path.split('/').at(-1) || '作品文件').slice(0, 160),
      category: String(idea.folder || idea.label || path.split('/')[0] || '资料').slice(0, 40),
      content: String(idea.body || '').replace(/\r\n?/g, '\n').slice(0, 50_000),
      updatedAt: idea.updatedAt || idea.createdAt || '',
    }
  }
  const chapter = (db.chapters?.[projectId] || []).find((item) => chapterStoryFilePath(item) === path)
  if (!chapter) return null
  return {
    path,
    title: String(chapter.title || path.split('/').at(-1) || '章节正文').slice(0, 160),
    category: '正文',
    content: String(db.drafts?.[projectId]?.[String(chapter.id)] || '').replace(/\r\n?/g, '\n').slice(0, 50_000),
    updatedAt: chapter.updatedAt || chapter.createdAt || '',
  }
}

function buildStoryFiles(db, project, chapter, instruction = '') {
  const cue = String(instruction || '')
  const chapterNumber = Number(chapter?.id)
  const chapterToken = Number.isFinite(chapterNumber) ? `第${String(chapterNumber).padStart(3, '0')}章` : ''
  const writingIntent = /续写|日更|继续写|接着写|正文|写第\s*[一二三四五六七八九十百千万两\d]+\s*章/.test(cue)
  const ideaRecords = (db.ideas || [])
    .filter((idea) => idea.userId === project.userId && idea.projectId === project.id && storyFilePath(idea))
  const chapterRecords = (db.chapters?.[project.id] || []).map((item) => ({
    id: `chapter:${item.id}`,
    title: item.title,
    body: db.drafts?.[project.id]?.[String(item.id)] || '',
    folder: '正文',
    label: '章节正文',
    tags: [`文件:${chapterStoryFilePath(item)}`],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    chapterId: item.id,
  }))
  const records = [...ideaRecords, ...chapterRecords]
    .map((idea) => {
      const path = storyFilePath(idea)
      let relevance = 0
      if (path.startsWith('正文/')) relevance += writingIntent ? 20 : 5
      if (String(idea.chapterId ?? '') === String(chapter?.id ?? '')) relevance += 30
      if (path === '大纲/大纲.md') relevance += 320
      if (path === '设定/题材定位.md') relevance += 270
      if (path === '设定/题材正文提示卡.md') relevance += 280
      if (writingIntent && path === '追踪/角色状态.md') relevance += 310
      if (writingIntent && path === '追踪/伏笔.md') relevance += 300
      if (writingIntent && path === '追踪/时间线.md') relevance += 290
      if (writingIntent && path === '追踪/上下文.md') relevance += 285
      if (/^大纲\/卷纲_/.test(path)) {
        relevance += 180
        const range = String(idea.body || '').match(/章节范围[：:]\s*第?\s*(\d+)\s*[-—~～至到]\s*第?\s*(\d+)\s*章/)
        if (chapterNumber && range && chapterNumber >= Number(range[1]) && chapterNumber <= Number(range[2])) relevance += 260
      }
      if (chapterToken && path.includes(`细纲_${chapterToken}`)) relevance += 500
      if (!writingIntent && /开书|大纲|卷纲|细纲|剧情/.test(cue) && path.startsWith('大纲/')) relevance += 100
      if (/设定|世界观|人物|角色|势力|关系/.test(cue) && path.startsWith('设定/')) relevance += 100
      if (/追踪|伏笔|时间线|状态/.test(cue) && path.startsWith('追踪/')) relevance += 100
      return { idea, path, relevance }
    })
    .sort((left, right) => right.relevance - left.relevance
      || String(right.idea.updatedAt || '').localeCompare(String(left.idea.updatedAt || '')))

  const inventory = records.slice(0, 80).map(({ idea, path }) => ({
    path,
    title: idea.title,
    category: idea.folder || idea.label || path.split('/')[0] || '资料',
    updatedAt: idea.updatedAt || idea.createdAt || '',
  }))
  const loaded = []
  let remaining = 48_000
  for (const { idea, path } of records) {
    if (loaded.length >= 10 || remaining <= 0) break
    if (path.startsWith('正文/') && String(idea.chapterId ?? '') !== String(chapter?.id ?? '')) continue
    const content = contextExcerpt(idea.body, Math.min(10_000, remaining))
    if (!content) continue
    loaded.push({
      path,
      title: idea.title,
      category: idea.folder || idea.label || path.split('/')[0] || '资料',
      content,
    })
    remaining -= content.length
  }
  return { inventory, loaded }
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

export function buildWritingContext(db, project, chapter, instruction = '') {
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
  const storyFiles = buildStoryFiles(db, project, chapter, instruction)
  const materials = db.ideas
    .filter((idea) => idea.userId === project.userId
      && (!idea.projectId || idea.projectId === project.id)
      && !taggedStoryFilePath(idea))
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
    version: 4,
    project: { id: project.id, title: project.title, type: project.type, genre: project.genre, style: project.style || '', premise: project.tone || '' },
    chapter: { id: chapter.id, title: chapter.title, outline: contextExcerpt(chapter.outline, 2400), state: chapter.state },
    storyFiles,
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

export function enrichStoryAgentPayload(db, userId, payload, instruction = '') {
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
    ? buildWritingContext(db, project, chapter, instruction)
    : {
      version: 2,
      project: { id: project.id, title: project.title, type: project.type, genre: project.genre, style: project.style || '', premise: project.tone || '' },
      storyFiles: buildStoryFiles(db, project, null, instruction),
    }
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
