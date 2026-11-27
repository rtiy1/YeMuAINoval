// 工作区 HTTP 接口
// ---------------------------------------------------------------
// 桌面版的核心面：打开/关闭工作区、读写文件、章节增删改、目录树、历史快照、
// 以及 .yemu 下的结构化状态（伏笔/记忆/关系图/统计/会话）。
//
// 挂载方式：registerWorkspaceRoutes(app, { getWorkspace, openWorkspace }).
// 所有路径参数都经过 workspace-store 的沙箱校验。
// ---------------------------------------------------------------
import {
  buildTree,
  createChapter,
  deleteThread,
  deleteWorkspaceFile,
  listChapters,
  listSnapshots,
  listThreads,
  openWorkspace,
  readSnapshot,
  readThread,
  readWorkspaceState,
  readWorkspaceText,
  readWorkspaceMeta,
  reconcileChapters,
  renameChapter,
  workspaceSummary,
  writeWorkspaceMeta,
  writeWorkspaceState,
  writeThread,
  writeWorkspaceText,
  WorkspaceError,
} from './workspace-store.mjs'

const STATE_NAMES = new Set(['foreshadows', 'memories', 'relationships', 'stats', 'migration'])

function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res)
    } catch (error) {
      if (error instanceof WorkspaceError) {
        res.status(error.status || 400).json({ error: error.message })
        return
      }
      next(error)
    }
  }
}

// 前端传来的「上次已知章节列表」，用于识别外部改名/删除。
function knownChaptersFromBody(body) {
  const value = body?.knownChapters
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      number: Number(item.number),
      path: String(item.path || ''),
      title: String(item.title || ''),
    }))
    .filter((item) => Number.isFinite(item.number) && item.path)
}

export function registerWorkspaceRoutes(app, { workspaceState, getRecentWorkspaces, rememberWorkspace }) {
  const requireWorkspace = () => {
    const workspace = workspaceState.current
    if (!workspace) throw new WorkspaceError('尚未打开工作区', 409)
    return workspace
  }

  app.get('/api/workspace', wrap(async (_req, res) => {
    const workspace = workspaceState.current
    const recent = await getRecentWorkspaces()
    if (!workspace) {
      res.json({ workspace: null, recent })
      return
    }
    const meta = await readWorkspaceMeta(workspace)
    const { chapters, unclassified } = await listChapters(workspace)
    res.json({
      workspace: { ...workspaceSummary(workspace, chapters), meta, unclassified },
      recent,
    })
  }))

  app.post('/api/workspace/open', wrap(async (req, res) => {
    const dir = String(req.body?.path || '').trim()
    if (!dir) throw new WorkspaceError('请提供工作区路径')
    const workspace = await openWorkspace(dir, {
      create: req.body?.create === true,
      title: String(req.body?.title || '').trim(),
    })
    workspaceState.current = workspace
    await rememberWorkspace(workspace.root, workspace.meta.title)
    const { chapters, unclassified } = await listChapters(workspace)
    res.json({ workspace: { ...workspaceSummary(workspace, chapters), meta: workspace.meta, unclassified } })
  }))

  app.post('/api/workspace/close', wrap(async (_req, res) => {
    workspaceState.current = null
    res.json({ workspace: null })
  }))

  app.get('/api/workspace/tree', wrap(async (_req, res) => {
    const workspace = requireWorkspace()
    const [tree, chapters] = await Promise.all([buildTree(workspace), listChapters(workspace)])
    res.json({ tree, chapters: chapters.chapters, unclassified: chapters.unclassified })
  }))

  app.get('/api/workspace/reconcile', wrap(async (req, res) => {
    const workspace = requireWorkspace()
    const { chapters, unclassified } = await listChapters(workspace)
    const known = String(req.query.known || '')
      .split(',')
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .map((number) => ({ number }))
    res.json({ chapters, unclassified, changes: reconcileChapters(chapters, known) })
  }))

  app.post('/api/workspace/reconcile', wrap(async (req, res) => {
    const workspace = requireWorkspace()
    const { chapters, unclassified } = await listChapters(workspace)
    res.json({
      chapters,
      unclassified,
      changes: reconcileChapters(chapters, knownChaptersFromBody(req.body)),
    })
  }))

  app.get('/api/workspace/meta', wrap(async (_req, res) => {
    res.json({ meta: await readWorkspaceMeta(requireWorkspace()) })
  }))

  app.put('/api/workspace/meta', wrap(async (req, res) => {
    const workspace = requireWorkspace()
    const meta = await writeWorkspaceMeta(workspace, req.body || {})
    await rememberWorkspace(workspace.root, meta.title)
    res.json({ meta })
  }))

  app.get('/api/workspace/file', wrap(async (req, res) => {
    const workspace = requireWorkspace()
    const file = await readWorkspaceText(workspace, String(req.query.path || ''))
    res.json({ file })
  }))

  app.put('/api/workspace/file', wrap(async (req, res) => {
    const workspace = requireWorkspace()
    const result = await writeWorkspaceText(workspace, String(req.body?.path || ''), req.body?.content ?? '', {
      snapshot: req.body?.snapshot !== false,
    })
    res.json({ file: result })
  }))

  app.delete('/api/workspace/file', wrap(async (req, res) => {
    const workspace = requireWorkspace()
    const result = await deleteWorkspaceFile(workspace, String(req.query.path || ''))
    res.json({ result })
  }))

  app.get('/api/workspace/chapters', wrap(async (_req, res) => {
    const { chapters, unclassified } = await listChapters(requireWorkspace())
    res.json({ chapters, unclassified })
  }))

  app.post('/api/workspace/chapters', wrap(async (req, res) => {
    const chapter = await createChapter(requireWorkspace(), {
      title: String(req.body?.title || '').trim(),
      content: typeof req.body?.content === 'string' ? req.body.content : '',
    })
    res.status(201).json({ chapter })
  }))

  app.patch('/api/workspace/chapters', wrap(async (req, res) => {
    const workspace = requireWorkspace()
    const target = String(req.body?.path || '')
    if (req.body?.title !== undefined) {
      const renamed = await renameChapter(workspace, target, String(req.body.title))
      res.json({ chapter: renamed })
      return
    }
    if (req.body?.content !== undefined) {
      const written = await writeWorkspaceText(workspace, target, req.body.content, {
        snapshot: req.body?.snapshot !== false,
      })
      res.json({ chapter: written })
      return
    }
    throw new WorkspaceError('请提供 title 或 content')
  }))

  app.delete('/api/workspace/chapters', wrap(async (req, res) => {
    const result = await deleteWorkspaceFile(requireWorkspace(), String(req.query.path || ''))
    res.json({ result })
  }))

  app.get('/api/workspace/history', wrap(async (req, res) => {
    const snapshots = await listSnapshots(requireWorkspace(), String(req.query.path || ''))
    res.json({ snapshots })
  }))

  app.get('/api/workspace/history/:snapshotId', wrap(async (req, res) => {
    const snapshot = await readSnapshot(requireWorkspace(), String(req.query.path || ''), req.params.snapshotId)
    res.json({ snapshot })
  }))

  app.get('/api/workspace/state/:name', wrap(async (req, res) => {
    const name = String(req.params.name || '')
    if (!STATE_NAMES.has(name)) throw new WorkspaceError('未知的工作区状态')
    const value = await readWorkspaceState(requireWorkspace(), name, [])
    res.json({ name, value })
  }))

  app.put('/api/workspace/state/:name', wrap(async (req, res) => {
    const name = String(req.params.name || '')
    if (!STATE_NAMES.has(name)) throw new WorkspaceError('未知的工作区状态')
    if (req.body?.value === undefined) throw new WorkspaceError('请提供 value')
    const value = await writeWorkspaceState(requireWorkspace(), name, req.body.value)
    res.json({ name, value })
  }))

  app.get('/api/workspace/threads', wrap(async (_req, res) => {
    res.json({ threads: await listThreads(requireWorkspace()) })
  }))

  app.get('/api/workspace/threads/:threadId', wrap(async (req, res) => {
    const thread = await readThread(requireWorkspace(), req.params.threadId)
    if (!thread) throw new WorkspaceError('会话不存在', 404)
    res.json({ thread })
  }))

  app.put('/api/workspace/threads/:threadId', wrap(async (req, res) => {
    if (req.body?.thread === undefined) throw new WorkspaceError('请提供 thread')
    await writeThread(requireWorkspace(), req.params.threadId, req.body.thread)
    res.json({ thread: req.body.thread })
  }))

  app.delete('/api/workspace/threads/:threadId', wrap(async (req, res) => {
    const result = await deleteThread(requireWorkspace(), req.params.threadId)
    res.json({ result })
  }))
}
