import crypto from 'node:crypto'

function text(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function list(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : []
}

function nextChapterId(chapters) {
  return chapters.reduce((maximum, chapter) => Math.max(maximum, Number(chapter.id) || 0), 0) + 1
}

function isBlankDefaultChapter(chapter, draft) {
  return !text(chapter?.outline, 1)
    && !text(draft, 1)
    && /^(?:第\s*[一二三四五六七八九十百千万两\d]+\s*章|未命名章节?)$/.test(text(chapter?.title, 100))
}

export function summarizeStoryArtifacts(artifacts) {
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) return null
  const projectUpdated = Boolean(artifacts.project && typeof artifacts.project === 'object'
    && ['genre', 'style', 'premise'].some((key) => text(artifacts.project[key], 1)))
  const characters = list(artifacts.characters, 24).filter((item) => item && typeof item === 'object' && text(item.name || item.title, 1) && text(item.description || item.body || item.summary, 1))
  const worldbuilding = list(artifacts.worldbuilding, 40).filter((item) => item && typeof item === 'object' && text(item.title || item.name, 1) && text(item.content || item.body || item.description, 1))
  const chapters = list(artifacts.chapters, 100).filter((item) => item && typeof item === 'object' && text(item.title || item.name, 1) && text(item.outline || item.content || item.summary, 1))
  const preview = {
    projectUpdated,
    characters: characters.length,
    worldbuilding: worldbuilding.length,
    chapters: chapters.length,
    targets: [
      ...(projectUpdated ? [{ kind: '作品', title: '基础设定' }] : []),
      ...characters.map((item) => ({ kind: '人物卡', title: text(item.name || item.title, 80) })),
      ...worldbuilding.map((item) => ({ kind: '世界观', title: text(item.title || item.name, 120) })),
      ...chapters.map((item) => ({ kind: '章节大纲', title: text(item.title || item.name, 100) })),
    ].slice(0, 24),
  }
  const parts = [
    preview.projectUpdated ? '作品设定' : '',
    preview.characters ? `${preview.characters} 张人物卡` : '',
    preview.worldbuilding ? `${preview.worldbuilding} 条世界观` : '',
    preview.chapters ? `${preview.chapters} 章大纲` : '',
  ].filter(Boolean)
  if (!parts.length) return null
  return { ...preview, summary: `准备写入${parts.join('、')}` }
}

function upsertIdea(db, {
  userId,
  projectId,
  label,
  title,
  body,
  folder,
  tags,
  color,
  timestamp,
}) {
  const normalizedTitle = title.toLocaleLowerCase('zh-CN')
  const existing = db.ideas.find((idea) => idea.userId === userId
    && idea.projectId === projectId
    && text(idea.title, 160).toLocaleLowerCase('zh-CN') === normalizedTitle
    && idea.folder === folder)
  if (existing) {
    existing.label = label
    existing.body = body
    existing.tags = tags
    existing.updatedAt = timestamp
    return { record: existing, created: false }
  }
  const record = {
    id: crypto.randomUUID(),
    userId,
    projectId,
    label,
    title,
    body,
    color,
    folder,
    tags,
    pinned: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  db.ideas.unshift(record)
  return { record, created: true }
}

export function applyStoryArtifacts(db, {
  userId,
  projectId,
  artifacts,
  timestamp = new Date().toISOString(),
} = {}) {
  const project = db?.projects?.find((item) => item.id === projectId && item.userId === userId)
  if (!project || !artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    return { applied: false, summary: '', characters: 0, worldbuilding: 0, chapters: 0, projectUpdated: false }
  }
  db.ideas ||= []
  db.chapters ||= {}
  db.drafts ||= {}
  db.editHistory ||= {}
  const chapters = db.chapters[project.id] ||= []
  const drafts = db.drafts[project.id] ||= {}
  const history = db.editHistory[project.id] ||= {}
  let projectUpdated = false
  const projectArtifact = artifacts.project && typeof artifacts.project === 'object' ? artifacts.project : {}
  const projectUpdates = {
    genre: text(projectArtifact.genre, 30),
    style: text(projectArtifact.style, 80),
    tone: text(projectArtifact.premise, 2000),
  }
  for (const [key, value] of Object.entries(projectUpdates)) {
    if (value && project[key] !== value) {
      project[key] = value
      projectUpdated = true
    }
  }

  let characterCount = 0
  for (const item of list(artifacts.characters, 24)) {
    if (!item || typeof item !== 'object') continue
    const name = text(item.name || item.title, 80)
    const description = text(item.description || item.body || item.summary, 4000)
    const role = text(item.role, 80)
    if (!name || !description) continue
    upsertIdea(db, {
      userId,
      projectId,
      label: role || '人物',
      title: name,
      body: description,
      folder: '人物',
      tags: role ? [role] : [],
      color: 'coral',
      timestamp,
    })
    characterCount += 1
  }

  let worldbuildingCount = 0
  for (const item of list(artifacts.worldbuilding, 40)) {
    if (!item || typeof item !== 'object') continue
    const title = text(item.title || item.name, 160)
    const content = text(item.content || item.body || item.description, 4000)
    if (!title || !content) continue
    upsertIdea(db, {
      userId,
      projectId,
      label: '世界设定',
      title,
      body: content,
      folder: '世界观',
      tags: ['设定'],
      color: 'teal',
      timestamp,
    })
    worldbuildingCount += 1
  }

  let chapterCount = 0
  let blankChapter = chapters.find((chapter) => isBlankDefaultChapter(chapter, drafts[String(chapter.id)]))
  for (const item of list(artifacts.chapters, 100)) {
    if (!item || typeof item !== 'object') continue
    const title = text(item.title || item.name, 100)
    const outline = text(item.outline || item.content || item.summary, 5000)
    if (!title || !outline) continue
    let chapter = chapters.find((candidate) => text(candidate.title, 100) === title)
    if (!chapter && blankChapter) {
      chapter = blankChapter
      blankChapter = null
      chapter.title = title
    }
    if (!chapter) {
      chapter = {
        id: nextChapterId(chapters),
        title,
        outline: '',
        words: '0',
        state: 'draft',
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      chapters.push(chapter)
      drafts[String(chapter.id)] = ''
      history[String(chapter.id)] = []
    }
    chapter.outline = outline
    chapter.updatedAt = timestamp
    chapterCount += 1
  }

  const applied = projectUpdated || characterCount > 0 || worldbuildingCount > 0 || chapterCount > 0
  if (applied) {
    project.chapters = chapters.length
    project.updated = '刚刚'
    project.updatedAt = timestamp
  }
  const parts = [
    projectUpdated ? '作品设定' : '',
    characterCount ? `${characterCount} 张人物卡` : '',
    worldbuildingCount ? `${worldbuildingCount} 条世界观` : '',
    chapterCount ? `${chapterCount} 章大纲` : '',
  ].filter(Boolean)
  return {
    applied,
    summary: parts.length ? `已写入${parts.join('、')}` : '',
    characters: characterCount,
    worldbuilding: worldbuildingCount,
    chapters: chapterCount,
    projectUpdated,
  }
}
