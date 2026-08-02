import crypto from 'node:crypto'

function text(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function list(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : []
}

function artifactDocument(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const rawPath = String(item.path || item.file || '').replaceAll('\\', '/').trim().slice(0, 240)
  if (rawPath.startsWith('/') || /^[A-Za-z]:\//.test(rawPath)) return null
  const parts = rawPath.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) return null
  const path = parts.join('/')
  const content = String(item.content || item.body || item.text || '').replace(/\r\n?/g, '\n').trim().slice(0, 50_000)
  const fallbackTitle = parts.at(-1).replace(/\.[^.]+$/, '')
  const title = text(item.title || fallbackTitle, 160)
  const category = text(item.category || parts[0] || '资料', 40)
  if (!path || !title || !content) return null
  return { path, title, category, content }
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
  const documents = list(artifacts.documents || artifacts.files, 80).map(artifactDocument).filter(Boolean)
  const preview = {
    projectUpdated,
    characters: characters.length,
    worldbuilding: worldbuilding.length,
    chapters: chapters.length,
    documents: documents.length,
    targets: [
      ...(projectUpdated ? [{ kind: '作品', title: '基础设定' }] : []),
      ...characters.map((item) => ({ kind: '人物卡', title: text(item.name || item.title, 80) })),
      ...worldbuilding.map((item) => ({ kind: '世界观', title: text(item.title || item.name, 120) })),
      ...chapters.map((item) => ({ kind: '章节大纲', title: text(item.title || item.name, 100) })),
      ...documents.map((item) => ({ kind: item.category || '资料文件', title: item.title })),
    ].slice(0, 24),
  }
  const parts = [
    preview.projectUpdated ? '作品设定' : '',
    preview.characters ? `${preview.characters} 张人物卡` : '',
    preview.worldbuilding ? `${preview.worldbuilding} 条世界观` : '',
    preview.chapters ? `${preview.chapters} 章大纲` : '',
    preview.documents ? `${preview.documents} 份资料文件` : '',
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
  sourcePath = '',
  timestamp,
}) {
  const normalizedTitle = title.toLocaleLowerCase('zh-CN')
  const pathTag = sourcePath ? `文件:${sourcePath}` : ''
  const existing = db.ideas.find((idea) => idea.userId === userId
    && idea.projectId === projectId
    && (pathTag
      ? (Array.isArray(idea.tags) && idea.tags.includes(pathTag))
        || (!(idea.tags || []).some((tag) => String(tag).startsWith('文件:'))
          && text(idea.title, 160).toLocaleLowerCase('zh-CN') === normalizedTitle
          && idea.folder === folder)
      : text(idea.title, 160).toLocaleLowerCase('zh-CN') === normalizedTitle && idea.folder === folder))
  if (existing) {
    existing.label = label
    existing.body = body
    existing.tags = tags
    existing.folder = folder
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
    return { applied: false, summary: '', characters: 0, worldbuilding: 0, chapters: 0, documents: 0, fileChanges: [], projectUpdated: false }
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
    upsertIdea(db, {
      userId,
      projectId,
      label: '章节大纲',
      title,
      body: outline,
      folder: '大纲',
      tags: ['Agent产物', '章节大纲'],
      color: 'yellow',
      timestamp,
    })
    chapterCount += 1
  }

  let documentCount = 0
  const fileChanges = []
  for (const item of list(artifacts.documents || artifacts.files, 80).map(artifactDocument).filter(Boolean)) {
    const folder = text(item.category || item.path.split('/')[0] || '资料', 40)
    const label = text(folder === '大纲' ? '大纲文档' : `${folder}文档`, 20)
    const change = upsertIdea(db, {
      userId,
      projectId,
      label,
      title: item.title,
      body: item.content,
      folder,
      tags: ['Skill产物', `文件:${item.path}`],
      color: folder === '大纲' ? 'yellow' : folder === '人物' ? 'coral' : 'teal',
      sourcePath: item.path,
      timestamp,
    })
    fileChanges.push({
      id: change.record.id,
      path: item.path,
      title: item.title,
      category: folder,
      action: change.created ? 'created' : 'updated',
    })
    documentCount += 1
  }

  const applied = projectUpdated || characterCount > 0 || worldbuildingCount > 0 || chapterCount > 0 || documentCount > 0
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
    documentCount ? `${documentCount} 份资料文件` : '',
  ].filter(Boolean)
  return {
    applied,
    summary: parts.length ? `已写入${parts.join('、')}` : '',
    characters: characterCount,
    worldbuilding: worldbuildingCount,
    chapters: chapterCount,
    documents: documentCount,
    fileChanges,
    projectUpdated,
  }
}
