import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const defaultWorkspaceRoot = path.join(serverDir, 'data', 'workspaces')
const MAX_STORY_FILE_CHARS = 50_000

function safeOwnerSegment(value, label) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error(`${label} 不能为空`)
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(raw)) return raw
  return `${label}-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)}`
}

export function normalizeWorkspaceStoryPath(value) {
  const raw = String(value || '').replaceAll('\\', '/').trim().slice(0, 240)
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    throw new Error('作品文件路径必须是相对路径')
  }
  const parts = raw.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error('作品文件路径无效')
  }
  return parts.join('/')
}

function workspaceRoot() {
  return process.env.STORY_WORKSPACE_DIR
    ? path.resolve(process.env.STORY_WORKSPACE_DIR)
    : defaultWorkspaceRoot
}

export function storyProjectWorkspacePath(userId, projectId) {
  return path.join(workspaceRoot(), safeOwnerSegment(userId, 'user'), safeOwnerSegment(projectId, 'project'))
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function existingProjectRoot(userId, projectId) {
  const projectRoot = storyProjectWorkspacePath(userId, projectId)
  try {
    const realRoot = await fs.realpath(projectRoot)
    return { projectRoot, realRoot }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function writeStoryWorkspaceFile(userId, projectId, file) {
  const relativePath = normalizeWorkspaceStoryPath(file?.path)
  const projectRoot = storyProjectWorkspacePath(userId, projectId)
  await fs.mkdir(projectRoot, { recursive: true })
  const realRoot = await fs.realpath(projectRoot)
  const requestedParent = path.join(projectRoot, ...relativePath.split('/').slice(0, -1))
  await fs.mkdir(requestedParent, { recursive: true })
  const realParent = await fs.realpath(requestedParent)
  if (!isInside(realRoot, realParent)) throw new Error('作品文件路径越界')

  const target = path.join(realParent, relativePath.split('/').at(-1))
  if (!isInside(realRoot, target)) throw new Error('作品文件路径越界')
  try {
    const existing = await fs.lstat(target)
    if (existing.isSymbolicLink()) throw new Error('不允许通过符号链接写入作品文件')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const content = String(file?.content ?? '').replace(/\r\n?/g, '\n').slice(0, MAX_STORY_FILE_CHARS)
  await fs.writeFile(target, content, 'utf8')
  return {
    path: relativePath,
    title: String(file?.title || path.basename(relativePath, path.extname(relativePath))).slice(0, 160),
    category: String(file?.category || relativePath.split('/')[0] || '资料').slice(0, 40),
    content,
    updatedAt: new Date().toISOString(),
  }
}

export async function readStoryWorkspaceFile(userId, projectId, requestedPath) {
  const relativePath = normalizeWorkspaceStoryPath(requestedPath)
  const root = await existingProjectRoot(userId, projectId)
  if (!root) return null
  const requested = path.join(root.projectRoot, ...relativePath.split('/'))
  let realFile
  try {
    realFile = await fs.realpath(requested)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (!isInside(root.realRoot, realFile)) throw new Error('作品文件路径越界')
  const stat = await fs.stat(realFile)
  if (!stat.isFile()) return null
  const content = (await fs.readFile(realFile, 'utf8')).replace(/\r\n?/g, '\n').slice(0, MAX_STORY_FILE_CHARS)
  return {
    path: relativePath,
    title: path.basename(relativePath, path.extname(relativePath)),
    category: relativePath.split('/')[0] || '资料',
    content,
    updatedAt: stat.mtime.toISOString(),
  }
}
