// 作品文件读写（工作区版）
// ---------------------------------------------------------------
// 旧实现（db.json 里的虚拟文件）已废弃：现在正文与资料就是工作区磁盘上的
// Markdown 文件，Agent 的 read_story_file / write_story_file 直接落在真实文件上。
//
// 写入前会先在 .yemu/history 里留快照，因此 AI 改动可回滚。
// ---------------------------------------------------------------
import { currentWorkspaceRoot } from './workspace-runtime.mjs'
import { readWorkspaceText, workspacePaths, writeWorkspaceText } from './workspace-store.mjs'

function workspaceFor(root) {
  const resolved = root || currentWorkspaceRoot()
  if (!resolved) return null
  return { root: resolved, meta: null }
}

export async function readStoryDocument(path, { root } = {}) {
  const workspace = workspaceFor(root)
  if (!workspace) return null
  try {
    const file = await readWorkspaceText(workspace, path)
    const title = String(path).split('/').at(-1)?.replace(/\.[^.]+$/, '') || '作品文件'
    return {
      path: file.path,
      title,
      category: String(file.path).split('/')[0] || '资料',
      content: file.content,
      updatedAt: file.modifiedAt,
    }
  } catch (error) {
    if (error?.status === 404) return null
    throw error
  }
}

export async function writeStoryDocument(file, { root } = {}) {
  const workspace = workspaceFor(root)
  if (!workspace) throw new Error('尚未打开工作区，无法写入作品文件')
  if (!file?.path) throw new Error('作品文件缺少路径')
  const result = await writeWorkspaceText(workspace, file.path, file.content ?? '', { snapshot: true })
  return {
    file: {
      path: result.path,
      title: String(file.title || result.path.split('/').at(-1)?.replace(/\.[^.]+$/, '') || '作品文件'),
      category: String(file.category || result.path.split('/')[0] || '资料'),
      content: String(file.content ?? ''),
      updatedAt: result.modifiedAt,
    },
    snapshot: result.snapshot,
  }
}

export function workspaceHistoryRoot(root) {
  const workspace = workspaceFor(root)
  if (!workspace) return null
  return workspacePaths(workspace.root).history
}
