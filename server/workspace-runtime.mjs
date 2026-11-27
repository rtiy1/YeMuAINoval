// 工作区运行时状态
// ---------------------------------------------------------------
// 两个职责：
//   1. 进程内保存「当前打开的工作区」（workspaceState.current）。
//   2. 把「最近打开」列表持久化到应用数据目录（不是工作区里，因为它是全局偏好）。
//
// 数据目录沿用现有约定：
//   - Tauri sidecar 由 Rust 壳注入 DESKTOP_DATA_DIR / STORY_DATA_FILE；
//   - 本地服务用 scripts/desktop-start.mjs 的 DESKTOP_DATA_DIR（默认 .data/desktop）。
// ---------------------------------------------------------------
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { openWorkspace, WorkspaceError } from './workspace-store.mjs'

const RECENT_LIMIT = 12
const RECENT_FILE = 'recent-workspaces.json'

export const workspaceState = { current: null }

function dataDir() {
  if (process.env.DESKTOP_DATA_DIR) return path.resolve(process.env.DESKTOP_DATA_DIR)
  if (process.env.STORY_DATA_FILE) return path.dirname(path.resolve(process.env.STORY_DATA_FILE))
  return path.resolve(process.cwd(), '.data', 'desktop')
}

function recentFile() {
  return path.join(dataDir(), RECENT_FILE)
}

async function readRecent() {
  try {
    const raw = await readFile(recentFile(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => item && typeof item.path === 'string' && item.path)
      .map((item) => ({
        path: item.path,
        title: String(item.title || path.basename(item.path)),
        openedAt: String(item.openedAt || ''),
      }))
  } catch {
    return []
  }
}

async function writeRecent(items) {
  await mkdir(dataDir(), { recursive: true })
  const target = recentFile()
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(items, null, 2), 'utf8')
  await rename(temp, target)
}

export async function getRecentWorkspaces() {
  return readRecent()
}

export async function rememberWorkspace(root, title) {
  if (!root) return
  const items = await readRecent()
  const next = [
    { path: root, title: String(title || path.basename(root)), openedAt: new Date().toISOString() },
    ...items.filter((item) => item.path !== root),
  ].slice(0, RECENT_LIMIT)
  await writeRecent(next)
}

export async function forgetWorkspace(root) {
  const items = await readRecent()
  await writeRecent(items.filter((item) => item.path !== root))
}

// 启动时尝试恢复上次工作区：
//   - 优先用显式传入的 STORY_WORKSPACE；
//   - 否则取最近打开列表中仍然存在的那一个。
// 失败一律静默降级为「未打开」，由前端展示选择页。
export async function initialWorkspace() {
  const explicit = String(process.env.STORY_WORKSPACE || '').trim()
  if (explicit) {
    try {
      const workspace = await openWorkspace(explicit)
      workspaceState.current = workspace
      return workspace
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error
      console.warn(`[workspace] 无法打开 STORY_WORKSPACE=${explicit}: ${error.message}`)
    }
  }
  const recent = await readRecent()
  for (const item of recent) {
    try {
      const workspace = await openWorkspace(item.path)
      workspaceState.current = workspace
      return workspace
    } catch {
      // 路径已不存在或不再是工作区，继续尝试下一个。
    }
  }
  return null
}

export function currentWorkspace() {
  return workspaceState.current
}

export function currentWorkspaceRoot() {
  return workspaceState.current?.root || null
}

export async function closeWorkspaceRuntime() {
  workspaceState.current = null
}
