// 工作区 → 旧接口适配层
// ---------------------------------------------------------------
// 现有前端（App.jsx）通过 /api/projects/:projectId/chapters/:chapterId/draft
// 这类接口工作，其中 projectId 是作品 id、chapterId 是整数章节号。
//
// 本地工作区模式下：
//   projectId = 工作区根路径
//   chapterId = 从「正文/第NNN章_标题.md」解析出的章节号
//
// 这一层让现有 UI 无需改动就能跑在「文件夹即真相」之上。
// ---------------------------------------------------------------
import path from 'node:path'
import {
  chapterFileName,
  createChapter,
  deleteWorkspaceFile,
  listChapters,
  listSnapshots,
  readSnapshot,
  readWorkspaceMeta,
  readWorkspaceText,
  renameChapter,
  snapshotFile,
  writeWorkspaceMeta,
  writeWorkspaceText,
} from './workspace-store.mjs'
import { currentWorkspaceRoot, workspaceState } from './workspace-runtime.mjs'

export function workspaceRoot() {
  return currentWorkspaceRoot()
}

// projectId 既可能是工作区根路径，也可能是旧 db 里的 uuid。只有前者走磁盘。
export function isWorkspaceProjectId(projectId) {
  const root = workspaceRoot()
  return Boolean(root) && String(projectId) === String(root)
}

function workspaceFor(root = workspaceRoot()) {
  if (!root) throw Object.assign(new Error('尚未打开工作区'), { status: 409 })
  return { root, meta: null }
}

function countWords(text) {
  return String(text || '').replace(/\s/g, '').length
}

function formatWords(value) {
  return Number(value || 0).toLocaleString('en-US')
}

// 前端「作品」对象：字段与旧 db.projects 保持一致，值来自 yemu.json 与磁盘统计。
export async function workspaceProject(root = workspaceRoot()) {
  const workspace = workspaceFor(root)
  const meta = await readWorkspaceMeta(workspace)
  const { chapters } = await listChapters(workspace)
  let totalWords = 0
  for (const chapter of chapters) {
    const file = await readWorkspaceText(workspace, chapter.path).catch(() => null)
    totalWords += countWords(file?.content)
  }
  const updatedAt = chapters.reduce((latest, chapter) => {
    const value = String(chapter.modifiedAt || '')
    return value > latest ? value : latest
  }, meta.updatedAt || '')
  return {
    id: workspace.root,
    userId: 'local-user',
    title: meta.title,
    type: meta.type,
    genre: meta.genre,
    style: meta.style,
    tone: meta.premise,
    premise: meta.premise,
    status: '连载中',
    progress: 0,
    words: formatWords(totalWords),
    updated: updatedAt ? '刚刚' : '',
    chapters: chapters.length,
    cover: 'cover-new',
    isActive: true,
    createdAt: meta.createdAt,
    updatedAt: updatedAt || meta.updatedAt,
  }
}

// 前端「章节」对象：id 用章节号，字段与旧 db.chapters 对齐。
export async function workspaceChapterList(root = workspaceRoot()) {
  const workspace = workspaceFor(root)
  const { chapters } = await listChapters(workspace)
  const output = []
  for (const [index, chapter] of chapters.entries()) {
    const file = await readWorkspaceText(workspace, chapter.path).catch(() => null)
    output.push({
      id: chapter.number,
      number: chapter.number,
      title: chapter.title,
      path: chapter.path,
      fileName: chapter.fileName,
      outline: '',
      state: index === chapters.length - 1 ? 'current' : 'done',
      words: formatWords(countWords(file?.content)),
      createdAt: chapter.modifiedAt || '',
      updatedAt: chapter.modifiedAt || '',
      singleFile: Boolean(chapter.singleFile),
    })
  }
  return output
}

export async function findWorkspaceChapter(chapterId, root = workspaceRoot()) {
  const chapters = await workspaceChapterList(root)
  return chapters.find((chapter) => String(chapter.id) === String(chapterId)) || null
}

export async function readChapterContent(chapterId, root = workspaceRoot()) {
  const chapter = await findWorkspaceChapter(chapterId, root)
  if (!chapter) return null
  const file = await readWorkspaceText(workspaceFor(root), chapter.path)
  return { chapter, content: file.content, modifiedAt: file.modifiedAt }
}

export async function writeChapterContent(chapterId, content, root = workspaceRoot()) {
  const chapter = await findWorkspaceChapter(chapterId, root)
  if (!chapter) throw Object.assign(new Error('章节不存在'), { status: 404 })
  const result = await writeWorkspaceText(workspaceFor(root), chapter.path, content, { snapshot: true })
  return { chapter, content: String(content ?? ''), snapshot: result.snapshot, words: formatWords(countWords(content)) }
}

export async function createWorkspaceChapter(title, content = '', root = workspaceRoot()) {
  const created = await createChapter(workspaceFor(root), { title, content })
  const chapters = await workspaceChapterList(root)
  return chapters.find((chapter) => chapter.path === created.path) || {
    id: created.number,
    number: created.number,
    title: created.title,
    path: created.path,
    state: 'current',
    words: formatWords(countWords(content)),
  }
}

export async function renameWorkspaceChapter(chapterId, title, root = workspaceRoot()) {
  const chapter = await findWorkspaceChapter(chapterId, root)
  if (!chapter) throw Object.assign(new Error('章节不存在'), { status: 404 })
  const renamed = await renameChapter(workspaceFor(root), chapter.path, title)
  return { ...chapter, title: renamed.title, path: renamed.path, fileName: renamed.fileName }
}

export async function deleteWorkspaceChapter(chapterId, root = workspaceRoot()) {
  const chapters = await workspaceChapterList(root)
  if (chapters.length <= 1) throw Object.assign(new Error('每个作品至少保留一个章节'), { status: 400 })
  const chapter = chapters.find((item) => String(item.id) === String(chapterId))
  if (!chapter) throw Object.assign(new Error('章节不存在'), { status: 404 })
  await deleteWorkspaceFile(workspaceFor(root), chapter.path)
  return { deleted: chapter }
}

// .yemu/history 下的文件名是 ISO 时间戳（冒号替换成短横线）：
// 2026-11-27T08-12-51-218Z → 2026-11-27T08:12:51.218Z
function snapshotTimestamp(id) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(String(id || ''))
  if (!match) return null
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
}

// 历史快照：映射成前端期望的 { id, content, words, createdAt }。
export async function workspaceChapterHistory(chapterId, root = workspaceRoot()) {
  const chapter = await findWorkspaceChapter(chapterId, root)
  if (!chapter) return []
  const snapshots = await listSnapshots(workspaceFor(root), chapter.path)
  const output = []
  for (const snapshot of snapshots) {
    const record = await readSnapshot(workspaceFor(root), chapter.path, snapshot.id).catch(() => null)
    if (!record) continue
    output.push({
      id: snapshot.id,
      content: record.content,
      words: countWords(record.content),
      createdAt: snapshotTimestamp(snapshot.id),
    })
  }
  return output
}

export async function createHistorySnapshot(chapterId, content, root = workspaceRoot()) {
  const chapter = await findWorkspaceChapter(chapterId, root)
  if (!chapter) throw Object.assign(new Error('章节不存在'), { status: 404 })
  const current = await readWorkspaceText(workspaceFor(root), chapter.path).catch(() => null)
  if (current && current.content === String(content ?? '')) {
    return { snapshot: null, duplicate: true }
  }
  const snapshot = await snapshotFile(workspaceFor(root), chapter.path, String(content ?? ''))
  return { snapshot, duplicate: false }
}

export async function updateWorkspaceMeta(patch, root = workspaceRoot()) {
  const meta = await writeWorkspaceMeta(workspaceFor(root), patch)
  return workspaceProject(root)
}

// 新建工作区时写入的元信息（供 /api/projects 新建走文件系统）。
export function defaultWorkspaceMeta({ title, type, genre, style, premise }) {
  return {
    title: String(title || '未命名作品').trim() || '未命名作品',
    type: type || '长篇',
    genre: genre || '',
    style: style || '',
    premise: premise || '',
  }
}

export { chapterFileName, path }
