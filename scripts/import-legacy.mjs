// 旧版 db.json → 本地工作区 导入器
// ---------------------------------------------------------------
// 把旧版「一个全局 db.json、虚拟作品文件」的数据模型转成「一个文件夹 = 一本书」。
//
// 用法：
//   bun run import:legacy <db.json> <输出目录>            # 导入全部作品
//   bun run import:legacy <db.json> <输出目录> --project <id>
//   bun run import:legacy <db.json> <输出目录> --dry-run  # 只看计划不落盘
//
// 映射关系：
//   projects[].{title,type,genre,style,tone}  → yemu.json
//   chapters[] + drafts[projectId][id]        → 正文/第NNN章_标题.md
//   chapter.outline                           → 大纲/细纲_第NNN章.md
//   ideas（无 文件: 标签）                     → 参考资料/{folder}/{title}.md
//   ideas（带 文件: 标签）                     → 该路径原样
//   editHistory[projectId][chapterId][]       → .yemu/history/…
//   foreshadows / storyMemories               → .yemu/*.json
//   relationshipGraphs[projectId]             → .yemu/relationships.json
//   agentThreads / writingTasks               → .yemu/threads/
//   writingLog                                → .yemu/stats.json
// ---------------------------------------------------------------
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ensureWorkspaceSkeleton,
  openWorkspace,
  writeWorkspaceMeta,
  writeWorkspaceState,
  writeWorkspaceText,
  chapterFileName,
  workspaceSegment,
} from '../server/workspace-store.mjs'

const TEXT_LIKE = /\.(md|markdown|txt)$/i

function parseArgs(argv) {
  const positional = argv.filter((value) => !value.startsWith('--'))
  const options = {
    dbPath: positional[0] || '',
    outDir: positional[1] || '',
    projectId: null,
    dryRun: argv.includes('--dry-run'),
  }
  const projectIndex = argv.indexOf('--project')
  if (projectIndex !== -1) options.projectId = argv[projectIndex + 1] || null
  return options
}

function chapterTitle(chapter) {
  return String(chapter?.title || '').trim() || `第${chapter?.id ?? ''}章`
}

function chapterBody(db, projectId, chapterId) {
  const drafts = db.drafts?.[projectId]
  const value = drafts && typeof drafts === 'object' ? drafts[String(chapterId)] : ''
  return typeof value === 'string' ? value : ''
}

function taggedPath(idea) {
  const tag = Array.isArray(idea?.tags) ? idea.tags.find((item) => String(item).startsWith('文件:')) : null
  return tag ? String(tag).slice(3).trim() : ''
}

function safeRelative(value) {
  const normalized = String(value || '').replaceAll('\\', '/').trim()
  const parts = normalized.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) return ''
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return ''
  return parts.join('/')
}

function ensureMarkdown(value) {
  return TEXT_LIKE.test(value) ? value : `${value}.md`
}

function ideaTargetPath(idea) {
  const declared = safeRelative(taggedPath(idea))
  if (declared) return ensureMarkdown(declared)
  const folder = workspaceSegment(idea.folder || idea.label || '参考资料', '参考资料')
  const title = workspaceSegment(idea.title || idea.id || '未命名', '未命名')
  return `参考资料/${folder}/${title}.md`
}

function uniquePath(used, candidate) {
  if (!used.has(candidate)) {
    used.add(candidate)
    return candidate
  }
  const extension = path.extname(candidate)
  const base = candidate.slice(0, candidate.length - extension.length)
  for (let index = 2; ; index += 1) {
    const next = `${base}-${index}${extension}`
    if (!used.has(next)) {
      used.add(next)
      return next
    }
  }
}

function slugForDirectory(value) {
  return workspaceSegment(value, '未命名作品')
}

// 规划：把一个 project 的 db 记录转成「相对路径 → 内容」的文件清单。
export function planProject(db, project) {
  const files = new Map()
  const used = new Set()
  const chapters = Array.isArray(db.chapters?.[project.id]) ? db.chapters[project.id] : []
  const chapterIdToPath = {}

  for (const [index, chapter] of chapters.entries()) {
    const number = Number.isFinite(Number(chapter.id)) ? Number(chapter.id) : index + 1
    const fileName = chapterFileName(number, chapterTitle(chapter))
    const relativePath = uniquePath(used, `正文/${fileName}`)
    files.set(relativePath, chapterBody(db, project.id, chapter.id))
    chapterIdToPath[String(chapter.id)] = relativePath
    const outline = String(chapter.outline || '').trim()
    if (outline) {
      const outlinePath = uniquePath(used, `大纲/细纲_第${String(number).padStart(3, '0')}章.md`)
      files.set(outlinePath, `# 第${String(number).padStart(3, '0')}章：${chapterTitle(chapter)}\n\n${outline}\n`)
    }
  }

  for (const idea of db.ideas || []) {
    if (idea?.projectId && idea.projectId !== project.id) continue
    if (idea?.userId && project.userId && idea.userId !== project.userId) continue
    const body = String(idea?.body ?? '').replace(/\r\n?/g, '\n')
    if (!body.trim()) continue
    const relativePath = uniquePath(used, ideaTargetPath(idea))
    files.set(relativePath, body)
  }

  const history = []
  const projectHistory = db.editHistory?.[project.id]
  if (projectHistory && typeof projectHistory === 'object') {
    for (const [chapterId, snapshots] of Object.entries(projectHistory)) {
      if (!Array.isArray(snapshots)) continue
      const chapterPath = chapterIdToPath[chapterId]
      for (const [index, snapshot] of snapshots.entries()) {
        if (!snapshot || typeof snapshot.content !== 'string') continue
        history.push({
          chapterPath: chapterPath || `正文/第${String(chapterId).padStart(3, '0')}章.md`,
          content: snapshot.content.replace(/\r\n?/g, '\n'),
          createdAt: snapshot.createdAt || null,
          ordinal: index,
        })
      }
    }
  }

  return {
    meta: {
      title: project.title || '未命名作品',
      type: project.type || '长篇',
      genre: project.genre || '',
      style: project.style || '',
      premise: project.tone || '',
      createdAt: project.createdAt || null,
      updatedAt: project.updatedAt || null,
    },
    files,
    chapterIdToPath,
    history,
  }
}

function stateForProject(db, project) {
  const byProject = (item) => item && (!item.projectId || item.projectId === project.id)
  const byUser = (item) => !item.userId || !project.userId || item.userId === project.userId
  return {
    foreshadows: (db.foreshadows || []).filter((item) => byProject(item) && byUser(item)),
    memories: (db.storyMemories || []).filter((item) => byProject(item) && byUser(item)),
    relationships: db.relationshipGraphs?.[project.id] || null,
    stats: (db.writingLog || []).filter((item) => byProject(item) && byUser(item)),
    threads: (db.agentThreads || []).filter((item) => byProject(item) && byUser(item)),
  }
}

async function directoryIsEmpty(dir) {
  const entries = await readdir(dir).catch(() => null)
  if (!entries) return true
  return entries.filter((name) => !name.startsWith('.')).length === 0
}

// 写入与 workspace-store.snapshotFile 相同布局的快照：
// .yemu/history/<去掉扩展名的相对路径>/<ISO 时间戳>.md
async function writeHistorySnapshot(rootDir, relativePath, content, timestamp) {
  const withoutExtension = String(relativePath).replace(/\.[^./]+$/, '')
  const dir = path.join(rootDir, '.yemu', 'history', ...withoutExtension.split('/'))
  await mkdir(dir, { recursive: true })
  const stamp = timestamp.toISOString().replace(/[:.]/g, '-')
  await writeFile(path.join(dir, `${stamp}.md`), String(content ?? ''), 'utf8')
}

async function uniqueWorkspaceDir(parent) {
  const base = path.join(parent)
  await mkdir(base, { recursive: true })
  return base
}

export async function importProject(db, project, outRoot, { dryRun = false } = {}) {
  const plan = planProject(db, project)
  const folderName = slugForDirectory(plan.meta.title)
  let targetDir = path.join(outRoot, folderName)
  // 同名作品追加序号，避免覆盖。
  for (let index = 2; ; index += 1) {
    const exists = await stat(targetDir).catch(() => null)
    if (!exists) break
    if (await directoryIsEmpty(targetDir)) break
    targetDir = path.join(outRoot, `${folderName}-${index}`)
  }

  if (dryRun) {
    return { targetDir, plan, dryRun: true }
  }

  await ensureWorkspaceSkeleton(targetDir)
  const workspace = await openWorkspace(targetDir)
  await writeWorkspaceMeta(workspace, plan.meta)

  for (const [relativePath, content] of plan.files) {
    await writeWorkspaceText(workspace, relativePath, content, { snapshot: false })
  }

  // 历史快照：直接写进 .yemu/history，不触碰正文。
  for (const entry of plan.history) {
    const stamp = entry.createdAt && !Number.isNaN(Date.parse(entry.createdAt))
      ? new Date(entry.createdAt)
      : new Date(Date.now() - (1000 - entry.ordinal) * 1000)
    await writeHistorySnapshot(targetDir, entry.chapterPath, entry.content, stamp)
  }
  const states = stateForProject(db, project)
  if (states.foreshadows.length) await writeWorkspaceState(workspace, 'foreshadows', states.foreshadows)
  if (states.memories.length) await writeWorkspaceState(workspace, 'memories', states.memories)
  if (states.relationships) await writeWorkspaceState(workspace, 'relationships', states.relationships)
  if (states.stats.length) await writeWorkspaceState(workspace, 'stats', states.stats)
  for (const thread of states.threads) {
    if (!thread?.id) continue
    await mkdir(path.join(targetDir, '.yemu', 'threads'), { recursive: true })
    await writeFile(path.join(targetDir, '.yemu', 'threads', `${thread.id}.json`), JSON.stringify(thread, null, 2), 'utf8')
  }

  await writeWorkspaceState(workspace, 'migration', {
    version: 1,
    sourceProjectId: project.id,
    importedAt: new Date().toISOString(),
    chapterIdToPath: plan.chapterIdToPath,
  })

  return { targetDir, plan, dryRun: false }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.dbPath || !options.outDir) {
    console.error('用法: bun run import:legacy <db.json> <输出目录> [--project <id>] [--dry-run]')
    process.exitCode = 1
    return
  }

  const dbFile = await Bun.file(options.dbPath).json().catch((error) => {
    console.error(`无法读取 ${options.dbPath}: ${error.message}`)
    process.exitCode = 1
    return null
  })
  if (!dbFile) return

  const projects = (dbFile.projects || []).filter((project) => !options.projectId || project.id === options.projectId)
  if (!projects.length) {
    console.error(options.projectId ? `没有找到作品 ${options.projectId}` : 'db.json 里没有作品')
    process.exitCode = 1
    return
  }

  const outRoot = path.resolve(options.outDir)
  await uniqueWorkspaceDir(outRoot)

  let imported = 0
  for (const project of projects) {
    const result = await importProject(dbFile, project, outRoot, { dryRun: options.dryRun })
    const fileCount = result.plan.files.size
    if (options.dryRun) {
      console.log(`[计划] 《${result.plan.meta.title}》 → ${result.targetDir}（${fileCount} 个文件）`)
      for (const relativePath of result.plan.files.keys()) console.log(`        ${relativePath}`)
    } else {
      console.log(`[导入] 《${result.plan.meta.title}》 → ${result.targetDir}（${fileCount} 个文件）`)
      imported += 1
    }
  }
  if (!options.dryRun) console.log(`完成：导入 ${imported} 本作品到 ${outRoot}`)
}

if (import.meta.main) {
  await main()
}
