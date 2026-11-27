// 本地工作区存储层
// ---------------------------------------------------------------
// 「一个文件夹 = 一本书」。磁盘上的 Markdown 就是作品本身，可被任意编辑器修改；
// 结构化数据（会话/伏笔/记忆/关系图/统计/历史）放在工作区的 .yemu/ 下。
//
// 目录约定以 skills/story-import 的「项目骨架」为准，因为 Story Skills 的脚本
// 会直接读写这些路径（run_local_shell 传入 STORY_WORKSPACE）：
//   正文/ 大纲/ 设定/ 追踪/ 参考资料/  （对标/ 可选）
//
// 章节身份 = 文件名里的章节号：正文/第001章_雨夜.md → { number: 1, title: '雨夜' }。
// 用户改名只改标题后缀时，章节号不变，因此不会新建章节。
// ---------------------------------------------------------------
import crypto from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const META_FILE = 'yemu.json'
export const INTERNAL_DIR = '.yemu'
export const CHAPTER_DIR = '正文'
export const CONTENT_DIRS = Object.freeze(['正文', '大纲', '设定', '追踪', '参考资料'])
export const OPTIONAL_DIRS = Object.freeze(['对标'])
export const SKELETON_DIRS = Object.freeze([
  '正文',
  '大纲',
  '设定',
  '设定/世界观',
  '设定/角色',
  '设定/势力',
  '追踪',
  '追踪/逐章记录',
  '参考资料',
])
export const META_VERSION = 1
const MAX_HISTORY_SNAPSHOTS = 80
const MAX_TREE_ENTRIES = 2000
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml'])
const CHAPTER_FILE_PATTERN = /^第(\d{1,6})章(?:_(.+?))?\.(?:md|markdown|txt)$/i
const SHORT_FORM_BODY = '正文.md'
let writeSequence = 0

export class WorkspaceError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'WorkspaceError'
    this.status = status
  }
}

// 只允许工作区内的相对路径：拒绝绝对路径、盘符与 `..` 穿越。
export function normalizeRelativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').trim()
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null
  const parts = normalized.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) return null
  return parts.join('/')
}

export function resolveInside(rootDir, relativePath) {
  const relative = normalizeRelativePath(relativePath)
  if (!relative) return null
  const resolved = path.resolve(rootDir, ...relative.split('/'))
  const inside = path.relative(rootDir, resolved)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null
  return resolved
}

// 与 writing-context.workspaceSegment 同规则：Windows 非法字符替换为 '-'。
export function workspaceSegment(value, fallback) {
  const normalized = String(value || fallback || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/[.\s]+$/g, '')
    .trim()
    .slice(0, 100)
  return normalized || fallback
}

export function parseChapterFileName(fileName) {
  const match = CHAPTER_FILE_PATTERN.exec(String(fileName || ''))
  if (!match) return null
  const number = Number(match[1])
  if (!Number.isInteger(number) || number < 0) return null
  const title = (match[2] || '').trim() || `第${match[1]}章`
  return { number, title, fileName: String(fileName) }
}

export function chapterFileName(number, title) {
  const padded = String(Math.max(0, Math.trunc(Number(number) || 0))).padStart(3, '0')
  const label = workspaceSegment(title, `第${padded}章`)
  return `第${padded}章_${label}.md`
}

async function readJsonFile(filePath, fallback = null) {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return fallback
    return parsed
  } catch {
    return fallback
  }
}

// 原子写：temp + rename，Windows 上遇到 EACCES/EBUSY/EPERM 时短暂重试。
// 与 server/store.mjs 的 writeDb 保持同一策略。
async function writeFileAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tempFile = `${filePath}.${process.pid}.${++writeSequence}.tmp`
  await writeFile(tempFile, content, 'utf8')
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tempFile, filePath)
        return
      } catch (error) {
        const retryable = ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)
        if (!retryable || attempt >= 7) throw error
        await new Promise((resolve) => setTimeout(resolve, 12 * (attempt + 1)))
      }
    }
  } catch (error) {
    await unlink(tempFile).catch(() => undefined)
    throw error
  }
}

async function writeJsonAtomic(filePath, value) {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2))
}

function normalizeMeta(value, fallbackTitle = '未命名作品') {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const timestamp = new Date().toISOString()
  return {
    version: META_VERSION,
    title: String(source.title || fallbackTitle).trim().slice(0, 160) || fallbackTitle,
    type: String(source.type || '长篇').slice(0, 20),
    genre: String(source.genre || '').slice(0, 30),
    style: String(source.style || '').slice(0, 80),
    premise: String(source.premise ?? source.tone ?? '').slice(0, 2000),
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : timestamp,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : timestamp,
  }
}

export function workspacePaths(rootDir) {
  const internal = path.join(rootDir, INTERNAL_DIR)
  return {
    root: rootDir,
    meta: path.join(rootDir, META_FILE),
    internal,
    threads: path.join(internal, 'threads'),
    history: path.join(internal, 'history'),
    foreshadows: path.join(internal, 'foreshadows.json'),
    memories: path.join(internal, 'memories.json'),
    relationships: path.join(internal, 'relationships.json'),
    stats: path.join(internal, 'stats.json'),
    migration: path.join(internal, 'migration.json'),
  }
}

export async function isWorkspaceDir(dir) {
  const root = path.resolve(dir)
  if (await readJsonFile(path.join(root, META_FILE))) return true
  for (const name of CONTENT_DIRS) {
    const info = await stat(path.join(root, name)).catch(() => null)
    if (info?.isDirectory()) return true
  }
  const shortForm = await stat(path.join(root, SHORT_FORM_BODY)).catch(() => null)
  return Boolean(shortForm?.isFile())
}

export async function ensureWorkspaceSkeleton(rootDir) {
  await mkdir(rootDir, { recursive: true })
  await mkdir(path.join(rootDir, INTERNAL_DIR), { recursive: true })
  const paths = workspacePaths(rootDir)
  await mkdir(paths.threads, { recursive: true })
  await mkdir(paths.history, { recursive: true })
  // 短篇结构是根目录的 正文.md，不应再创建 正文/ 目录，否则会把单文件作品变成空目录。
  const shortForm = await stat(path.join(rootDir, SHORT_FORM_BODY)).catch(() => null)
  const skipChapterDir = Boolean(shortForm?.isFile())
  for (const name of SKELETON_DIRS) {
    if (skipChapterDir && name === CHAPTER_DIR) continue
    await mkdir(path.join(rootDir, ...name.split('/')), { recursive: true })
  }
}

export async function openWorkspace(dir, { create = false, title = '' } = {}) {
  const root = path.resolve(String(dir || '').trim())
  if (!root) throw new WorkspaceError('工作区路径不能为空')
  const info = await stat(root).catch(() => null)
  if (!info) {
    if (!create) throw new WorkspaceError(`工作区不存在：${root}`, 404)
    await ensureWorkspaceSkeleton(root)
  } else if (!info.isDirectory()) {
    throw new WorkspaceError(`工作区必须是文件夹：${root}`)
  }

  const existing = await stat(path.join(root, META_FILE)).catch(() => null)
  if (!existing) {
    if (!create && !(await isWorkspaceDir(root))) {
      throw new WorkspaceError('该文件夹不是作品工作区（缺少 yemu.json 与 正文/ 等目录）')
    }
    await ensureWorkspaceSkeleton(root)
    const meta = normalizeMeta({ title: title || path.basename(root) }, path.basename(root))
    await writeJsonAtomic(workspacePaths(root).meta, meta)
    return { root, meta, created: true }
  }

  const meta = normalizeMeta(await readJsonFile(workspacePaths(root).meta), path.basename(root))
  await ensureWorkspaceSkeleton(root)
  return { root, meta, created: false }
}

export async function readWorkspaceMeta(workspace) {
  const meta = await readJsonFile(workspacePaths(workspace.root).meta)
  return normalizeMeta(meta, path.basename(workspace.root))
}

export async function writeWorkspaceMeta(workspace, patch = {}) {
  const current = await readWorkspaceMeta(workspace)
  const next = normalizeMeta({ ...current, ...patch, updatedAt: new Date().toISOString() }, current.title)
  await writeJsonAtomic(workspacePaths(workspace.root).meta, next)
  workspace.meta = next
  return next
}

function chapterSortKey(number) {
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER
}

export function compareChapters(left, right) {
  const delta = chapterSortKey(left.number) - chapterSortKey(right.number)
  if (delta !== 0) return delta
  return String(left.path).localeCompare(String(right.path), 'zh-CN')
}

// 扫描 正文/，解析章节。无法解析编号的文件归入 unclassified（不参与章节顺序，也不删）。
export async function listChapters(workspace) {
  const root = workspace.root
  const chapterDir = path.join(root, CHAPTER_DIR)
  const entries = await readdir(chapterDir, { withFileTypes: true }).catch(() => null)
  const chapters = []
  const unclassified = []
  if (entries) {
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const extension = path.extname(entry.name).toLowerCase()
      if (!TEXT_EXTENSIONS.has(extension)) continue
      const relPath = `${CHAPTER_DIR}/${entry.name}`
      const parsed = parseChapterFileName(entry.name)
      const fileStat = await stat(path.join(chapterDir, entry.name)).catch(() => null)
      if (!parsed) {
        unclassified.push({ path: relPath, title: entry.name.replace(/\.[^.]+$/, ''), fileName: entry.name, size: fileStat?.size ?? 0, modifiedAt: fileStat?.mtime?.toISOString?.() ?? null })
        continue
      }
      chapters.push({
        number: parsed.number,
        title: parsed.title,
        path: relPath,
        fileName: entry.name,
        size: fileStat?.size ?? 0,
        modifiedAt: fileStat?.mtime?.toISOString?.() ?? null,
      })
    }
  }

  // 短篇单文件结构：根目录 正文.md，且没有 正文/ 目录。
  if (!entries) {
    const shortForm = await stat(path.join(root, SHORT_FORM_BODY)).catch(() => null)
    if (shortForm?.isFile()) {
      chapters.push({
        number: 1,
        title: '正文',
        path: SHORT_FORM_BODY,
        fileName: SHORT_FORM_BODY,
        size: shortForm.size,
        modifiedAt: shortForm.mtime.toISOString(),
        singleFile: true,
      })
    }
  }

  chapters.sort(compareChapters)
  return { chapters, unclassified }
}

export function nextChapterNumber(chapters = []) {
  return chapters.reduce((max, chapter) => {
    const value = Number(chapter?.number)
    return Number.isFinite(value) && value > max ? value : max
  }, 0) + 1
}

// 对账：以章节号为身份比较「磁盘现状」与「上次已知」。
// 编号相同但路径不同 → 改名；磁盘新增编号 → 新章节；已知编号消失 → 标记缺失（不自动删）。
export function reconcileChapters(diskChapters = [], knownChapters = []) {
  const knownByNumber = new Map()
  for (const chapter of knownChapters) {
    const number = Number(chapter?.number)
    if (Number.isFinite(number)) knownByNumber.set(number, chapter)
  }
  const diskByNumber = new Map()
  for (const chapter of diskChapters) {
    const number = Number(chapter?.number)
    if (Number.isFinite(number)) diskByNumber.set(number, chapter)
  }

  const added = []
  const renamed = []
  const unchanged = []
  for (const [number, chapter] of diskByNumber) {
    const previous = knownByNumber.get(number)
    if (!previous) {
      added.push(chapter)
    } else if (previous.path !== chapter.path) {
      renamed.push({ number, from: previous.path, to: chapter.path, title: chapter.title, previousTitle: previous.title })
    } else {
      unchanged.push(chapter)
    }
  }
  const missing = [...knownByNumber.values()].filter((chapter) => !diskByNumber.has(Number(chapter.number)))

  return {
    chapters: diskChapters,
    added: added.sort(compareChapters),
    renamed,
    missing,
    unchanged,
  }
}

export async function readWorkspaceText(workspace, relativePath) {
  const target = resolveInside(workspace.root, relativePath)
  if (!target) throw new WorkspaceError('文件路径无效')
  const info = await stat(target).catch(() => null)
  if (!info?.isFile()) throw new WorkspaceError(`文件不存在：${relativePath}`, 404)
  const content = await readFile(target, 'utf8')
  return {
    path: normalizeRelativePath(relativePath),
    content: content.replace(/\r\n?/g, '\n'),
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
  }
}

// 快照目录：.yemu/history/<去掉扩展名的相对路径>/<时间戳>.md
function snapshotDirFor(workspace, relativePath) {
  const normalized = normalizeRelativePath(relativePath)
  if (!normalized) return null
  const withoutExtension = normalized.replace(/\.[^./]+$/, '')
  return resolveInside(path.join(workspace.root, INTERNAL_DIR), path.join('history', ...withoutExtension.split('/')))
}

function snapshotStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

export async function snapshotFile(workspace, relativePath, content, { timestamp = new Date() } = {}) {
  const dir = snapshotDirFor(workspace, relativePath)
  if (!dir) return null
  const text = String(content ?? '')
  if (!text.length) return null
  await mkdir(dir, { recursive: true })
  const fileName = `${snapshotStamp(timestamp)}.md`
  const target = path.join(dir, fileName)
  await writeFileAtomic(target, text)
  await pruneSnapshots(workspace, relativePath)
  return { path: path.relative(workspace.root, target).split(path.sep).join('/'), createdAt: timestamp.toISOString() }
}

async function pruneSnapshots(workspace, relativePath) {
  const dir = snapshotDirFor(workspace, relativePath)
  if (!dir) return
  const entries = await readdir(dir).catch(() => null)
  if (!entries || entries.length <= MAX_HISTORY_SNAPSHOTS) return
  const sorted = entries.filter((name) => name.endsWith('.md')).sort()
  const excess = sorted.slice(0, Math.max(0, sorted.length - MAX_HISTORY_SNAPSHOTS))
  for (const name of excess) await unlink(path.join(dir, name)).catch(() => undefined)
}

export async function listSnapshots(workspace, relativePath) {
  const dir = snapshotDirFor(workspace, relativePath)
  if (!dir) return []
  const entries = await readdir(dir).catch(() => null)
  if (!entries) return []
  return entries
    .filter((name) => name.endsWith('.md'))
    .sort()
    .reverse()
    .map((name) => ({
      id: name.replace(/\.md$/, ''),
      path: path.relative(workspace.root, path.join(dir, name)).split(path.sep).join('/'),
    }))
}

export async function readSnapshot(workspace, relativePath, snapshotId) {
  const dir = snapshotDirFor(workspace, relativePath)
  if (!dir) throw new WorkspaceError('快照路径无效')
  const safeId = String(snapshotId || '').replace(/[^0-9A-Za-z_-]/g, '')
  if (!safeId) throw new WorkspaceError('快照编号无效')
  const target = path.join(dir, `${safeId}.md`)
  const content = await readFile(target, 'utf8').catch(() => null)
  if (content === null) throw new WorkspaceError('快照不存在', 404)
  return { id: safeId, content: content.replace(/\r\n?/g, '\n') }
}

// 写入正文/资料文件；默认先做历史快照，再原子写。
export async function writeWorkspaceText(workspace, relativePath, content, { snapshot = true } = {}) {
  const normalized = normalizeRelativePath(relativePath)
  if (!normalized) throw new WorkspaceError('文件路径无效')
  if (normalized === META_FILE) throw new WorkspaceError('作品元信息请通过专门的接口保存')
  if (normalized.startsWith(`${INTERNAL_DIR}/`)) throw new WorkspaceError('.yemu 目录不对普通文件写入开放')
  const target = resolveInside(workspace.root, normalized)
  if (!target) throw new WorkspaceError('文件路径无效')

  const text = String(content ?? '').replace(/\r\n?/g, '\n')
  const existing = await readFile(target, 'utf8').catch(() => null)
  let snapshotRecord = null
  if (snapshot && existing !== null && existing !== text) {
    snapshotRecord = await snapshotFile(workspace, normalized, existing)
  }
  await writeFileAtomic(target, text)
  const info = await stat(target).catch(() => null)
  return {
    path: normalized,
    size: info?.size ?? Buffer.byteLength(text),
    modifiedAt: info?.mtime?.toISOString?.() ?? new Date().toISOString(),
    snapshot: snapshotRecord,
  }
}

export async function createChapter(workspace, { title = '', content = '', number = null } = {}) {
  const { chapters } = await listChapters(workspace)
  const target = Number.isInteger(number) && number > 0 ? number : nextChapterNumber(chapters)
  const fileName = chapterFileName(target, title || `第${target}章`)
  const relPath = `${CHAPTER_DIR}/${fileName}`
  if (chapters.some((chapter) => chapter.number === target)) {
    throw new WorkspaceError(`第 ${target} 章已存在`, 409)
  }
  await writeWorkspaceText(workspace, relPath, content, { snapshot: false })
  return { number: target, title: title || `第${target}章`, path: relPath, fileName }
}

// 改名只动标题后缀，章节号保持不变；若目标已存在则拒绝。
export async function renameChapter(workspace, relativePath, nextTitle) {
  const normalized = normalizeRelativePath(relativePath)
  if (!normalized) throw new WorkspaceError('章节路径无效')
  const fileName = normalized.split('/').at(-1)
  const parsed = parseChapterFileName(fileName)
  if (!parsed) throw new WorkspaceError('该文件不是可识别的章节文件')
  const nextFileName = chapterFileName(parsed.number, nextTitle)
  if (nextFileName === fileName) return { path: normalized, title: parsed.title, unchanged: true }
  const source = resolveInside(workspace.root, normalized)
  if (!source) throw new WorkspaceError('章节路径无效')
  const nextRelative = `${CHAPTER_DIR}/${nextFileName}`
  const target = resolveInside(workspace.root, nextRelative)
  if (!target) throw new WorkspaceError('章节路径无效')
  const conflict = await stat(target).catch(() => null)
  if (conflict) throw new WorkspaceError(`目标文件已存在：${nextFileName}`, 409)
  await rename(source, target)
  return { path: nextRelative, fileName: nextFileName, number: parsed.number, title: workspaceSegment(nextTitle, parsed.title) }
}

export async function deleteWorkspaceFile(workspace, relativePath, { keepSnapshot = true } = {}) {
  const normalized = normalizeRelativePath(relativePath)
  if (!normalized) throw new WorkspaceError('文件路径无效')
  if (normalized === META_FILE || normalized.startsWith(`${INTERNAL_DIR}/`)) {
    throw new WorkspaceError('该文件不允许从工作台删除')
  }
  const target = resolveInside(workspace.root, normalized)
  if (!target) throw new WorkspaceError('文件路径无效')
  if (keepSnapshot) {
    const existing = await readFile(target, 'utf8').catch(() => null)
    if (existing) await snapshotFile(workspace, normalized, existing)
  }
  await rm(target, { force: true })
  return { path: normalized, deleted: true }
}

// .yemu 下的结构化状态：每个关注点一个 JSON 文件，便于人工 diff 与局部写。
const STATE_FILES = {
  foreshadows: 'foreshadows',
  memories: 'memories',
  relationships: 'relationships',
  stats: 'stats',
  migration: 'migration',
}

function stateFilePath(workspace, name) {
  const key = STATE_FILES[name]
  if (!key) throw new WorkspaceError(`未知的工作区状态：${name}`)
  return workspacePaths(workspace.root)[key]
}

export async function readWorkspaceState(workspace, name, fallback = null) {
  const value = await readJsonFile(stateFilePath(workspace, name))
  return value ?? fallback
}

export async function writeWorkspaceState(workspace, name, value) {
  await writeJsonAtomic(stateFilePath(workspace, name), value)
  return value
}

export async function readThread(workspace, threadId) {
  const safeId = String(threadId || '').replace(/[^0-9A-Za-z_-]/g, '')
  if (!safeId) throw new WorkspaceError('会话编号无效')
  return readJsonFile(path.join(workspacePaths(workspace.root).threads, `${safeId}.json`))
}

export async function writeThread(workspace, threadId, value) {
  const safeId = String(threadId || '').replace(/[^0-9A-Za-z_-]/g, '')
  if (!safeId) throw new WorkspaceError('会话编号无效')
  const target = path.join(workspacePaths(workspace.root).threads, `${safeId}.json`)
  await writeJsonAtomic(target, value)
  return target
}

export async function listThreads(workspace) {
  const dir = workspacePaths(workspace.root).threads
  const entries = await readdir(dir).catch(() => null)
  if (!entries) return []
  const threads = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const value = await readJsonFile(path.join(dir, name))
    if (value) threads.push(value)
  }
  return threads
}

export async function deleteThread(workspace, threadId) {
  const safeId = String(threadId || '').replace(/[^0-9A-Za-z_-]/g, '')
  if (!safeId) throw new WorkspaceError('会话编号无效')
  await rm(path.join(workspacePaths(workspace.root).threads, `${safeId}.json`), { force: true })
  return { deleted: true }
}

// 目录树：给前端文件树用。跳过 .yemu 内部细节，只标记它存在。
export async function buildTree(workspace, { maxEntries = MAX_TREE_ENTRIES } = {}) {
  const root = workspace.root
  let budget = maxEntries

  async function walk(dir, relativeDir, depth) {
    if (budget <= 0 || depth > 8) return []
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const nodes = []
    const sorted = [...entries].sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1
      return left.name.localeCompare(right.name, 'zh-CN')
    })
    for (const entry of sorted) {
      if (budget <= 0) break
      if (entry.name.startsWith('.')) continue
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        budget -= 1
        nodes.push({
          type: 'directory',
          name: entry.name,
          path: relativePath,
          children: await walk(path.join(dir, entry.name), relativePath, depth + 1),
        })
        continue
      }
      if (!entry.isFile()) continue
      const extension = path.extname(entry.name).toLowerCase()
      if (!TEXT_EXTENSIONS.has(extension)) continue
      budget -= 1
      const info = await stat(path.join(dir, entry.name)).catch(() => null)
      const parsed = relativeDir === CHAPTER_DIR ? parseChapterFileName(entry.name) : null
      nodes.push({
        type: 'file',
        name: entry.name,
        path: relativePath,
        size: info?.size ?? 0,
        modifiedAt: info?.mtime?.toISOString?.() ?? null,
        ...(parsed ? { chapter: { number: parsed.number, title: parsed.title } } : {}),
      })
    }
    return nodes
  }

  const tree = await walk(root, '', 0)
  const internalPath = path.join(root, INTERNAL_DIR)
  const hasInternal = Boolean(await stat(internalPath).catch(() => null))
  return { root, nodes: tree, hasInternal, truncated: budget <= 0 }
}

export function workspaceSummary(workspace, chapters = [], tree = null) {
  const words = chapters.reduce((total, chapter) => total + (Number(chapter.words) || 0), 0)
  return {
    root: workspace.root,
    meta: workspace.meta,
    chapterCount: chapters.length,
    unclassifiedCount: chapters.filter((chapter) => !chapter.number).length,
    fileCount: tree ? countFiles(tree.nodes) : undefined,
    words,
  }
}

function countFiles(nodes = []) {
  let total = 0
  for (const node of nodes) {
    if (node.type === 'file') total += 1
    else total += countFiles(node.children || [])
  }
  return total
}

export function textSha256(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex')
}
