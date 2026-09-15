import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { applyStoryArtifacts } from './story-artifacts.mjs'
import { storeInfo } from './store.mjs'
import { chapterStoryFilePath, readStoryFileForAgent, storyFilePath } from './writing-context.mjs'

// 桌面端/本地模式专属：把作品的虚拟「作品文件」物化为真实目录，供本地命令/Skill 脚本操作；
// 任务结束后再把磁盘改动回收进数据库（applyStoryArtifacts 负责章节正文与资料的归位）。
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml'])
const MAX_IMPORT_FILES = 400
const MAX_IMPORT_CHARS = 50_000

export function projectWorkspaceDir(projectId) {
  const dataFile = storeInfo().dataFile
  if (!dataFile) return null
  const safeId = String(projectId || '').replace(/[^\w-]/g, '_')
  if (!safeId) return null
  return path.join(path.dirname(dataFile), 'workspace', `project-${safeId}`)
}

function resolveInside(rootDir, relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/').trim()
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null
  const parts = normalized.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) return null
  const resolved = path.resolve(rootDir, ...parts)
  const relative = path.relative(rootDir, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return resolved
}

async function listWorkspaceFiles(rootDir) {
  const files = []
  const walk = async (dir) => {
    if (files.length >= MAX_IMPORT_FILES) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (files.length >= MAX_IMPORT_FILES) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full)
    }
  }
  await walk(rootDir)
  return files
}

export function collectProjectFiles(db, userId, projectId) {
  const files = new Map()
  const project = db.projects?.find((item) => item.id === projectId && item.userId === userId)
  if (!project) return files
  const chapters = db.chapters?.[projectId] || []
  for (const chapter of chapters) {
    const relPath = chapterStoryFilePath(chapter)
    if (!relPath) continue
    files.set(relPath, String(db.drafts?.[projectId]?.[String(chapter.id)] || '').replace(/\r\n?/g, '\n'))
  }
  for (const idea of db.ideas || []) {
    if (idea.userId !== userId || idea.projectId !== projectId) continue
    const relPath = storyFilePath(idea)
    if (!relPath || files.has(relPath)) continue
    files.set(relPath, String(idea.body || '').replace(/\r\n?/g, '\n'))
  }
  return files
}

export async function materializeProjectWorkspace(db, userId, projectId, workspaceDir) {
  await rm(workspaceDir, { recursive: true, force: true })
  await mkdir(workspaceDir, { recursive: true })
  let written = 0
  for (const [relPath, content] of collectProjectFiles(db, userId, projectId)) {
    const target = resolveInside(workspaceDir, relPath)
    if (!target) continue
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    written += 1
  }
  return written
}

export async function writeWorkspaceFile(workspaceDir, relPath, content) {
  const target = resolveInside(workspaceDir, relPath)
  if (!target) return false
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, String(content ?? '').replace(/\r\n?/g, '\n'), 'utf8')
  return true
}

export function importWorkspaceChangesToState(db, userId, projectId, workspaceDir, diskFiles) {
  const documents = []
  for (const [absolutePath, content] of diskFiles) {
    if (!content.trim() || content.length > MAX_IMPORT_CHARS) continue
    const relPath = path.relative(workspaceDir, absolutePath).split(path.sep).join('/')
    const existing = readStoryFileForAgent(db, userId, projectId, relPath)
    if (existing && existing.content === content.trim()) continue
    documents.push({ path: relPath, content })
  }
  if (!documents.length) return { applied: false, imported: 0 }
  const application = applyStoryArtifacts(db, { userId, projectId, artifacts: { documents } })
  return { applied: application.applied, imported: application.documents || documents.length }
}

export async function importWorkspaceChanges(db, userId, projectId, workspaceDir) {
  const files = await listWorkspaceFiles(workspaceDir)
  const diskFiles = new Map()
  for (const absolutePath of files) {
    const content = await readFile(absolutePath, 'utf8').catch(() => null)
    if (typeof content === 'string') diskFiles.set(absolutePath, content.replace(/\r\n?/g, '\n'))
  }
  return importWorkspaceChangesToState(db, userId, projectId, workspaceDir, diskFiles)
}
