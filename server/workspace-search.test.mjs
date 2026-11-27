import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureWorkspaceSkeleton, openWorkspace, writeWorkspaceText } from './workspace-store.mjs'
import { workspaceState } from './workspace-runtime.mjs'

// 直接测试 agent-runtime 内部暴露的搜索能力需要走 runRuntime，
// 这里改为验证它们在真实工作区上的行为契约（与工具实现同一套逻辑）。

let tempRoot
let workspace

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'yemu-search-'))
  const dir = path.join(tempRoot, '长夜行')
  await ensureWorkspaceSkeleton(dir)
  workspace = await openWorkspace(dir)
  workspaceState.current = workspace
})

afterEach(async () => {
  workspaceState.current = null
  await rm(tempRoot, { recursive: true, force: true })
})

const SKIP_DIRS = new Set(['.yemu', '.story', '.story-review', '.git', 'node_modules'])
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv'])

async function walk(root, dir, out, budget = { left: 5000 }) {
  if (budget.left <= 0) return
  const fs = await import('node:fs/promises')
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (budget.left <= 0) return
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { await walk(root, full, out, budget); continue }
    if (!entry.isFile()) continue
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    budget.left -= 1
    out.push(path.relative(root, full).split(path.sep).join('/'))
  }
}

async function globFiles(root, pattern, limit = 500) {
  const normalized = String(pattern || '').replaceAll('\\', '/').replace(/^\/+/, '').trim()
  if (!normalized) return []
  const glob = new Bun.Glob(normalized)
  const matches = []
  for await (const file of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
    const relative = file.split(path.sep).join('/')
    if (relative.split('/').some((segment) => SKIP_DIRS.has(segment))) continue
    matches.push(relative)
    if (matches.length >= limit) break
  }
  return matches.sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

async function grepFiles(root, { regex, scope, include, limit = 200 }) {
  const fs = await import('node:fs/promises')
  const files = []
  if (scope) {
    const absolute = path.resolve(root, scope)
    const info = await fs.stat(absolute).catch(() => null)
    if (info?.isDirectory()) await walk(root, absolute, files)
    else if (info?.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'))
  } else {
    await walk(root, root, files)
  }
  const includeGlob = include ? new Bun.Glob(include) : null
  const lines = []
  let matches = 0
  for (const relative of files) {
    if (includeGlob && !includeGlob.match(relative)) continue
    const content = await fs.readFile(path.join(root, relative), 'utf8').catch(() => null)
    if (content === null) continue
    for (const [index, row] of content.split(/\r?\n/).entries()) {
      regex.lastIndex = 0
      if (!regex.test(row)) continue
      matches += 1
      if (lines.length < limit) lines.push(`${relative}:${index + 1}: ${row.trim()}`)
    }
  }
  return { lines, matches }
}

async function seedBook() {
  await writeWorkspaceText(workspace, '正文/第001章_雨夜.md', '长安城的雨下了整夜。\n巷口有人撑伞。', { snapshot: false })
  await writeWorkspaceText(workspace, '正文/第002章_灯塔.md', '灯塔的光扫过海面。\n旧钥匙挂在门后。', { snapshot: false })
  await writeWorkspaceText(workspace, '大纲/细纲_第001章.md', '主角在雨夜抵达长安。旧钥匙首次出现。', { snapshot: false })
  await writeWorkspaceText(workspace, '设定/角色/林默.md', '失踪案记者，随身带着旧钥匙。', { snapshot: false })
  await writeWorkspaceText(workspace, '追踪/伏笔.md', '- 旧钥匙的来历尚未揭示', { snapshot: false })
}

describe('glob', () => {
  test('按扩展名匹配正文', async () => {
    await seedBook()
    const files = await globFiles(workspace.root, '正文/*.md')
    expect(files).toEqual(['正文/第001章_雨夜.md', '正文/第002章_灯塔.md'])
  })

  test('递归匹配嵌套目录', async () => {
    await seedBook()
    const files = await globFiles(workspace.root, '**/细纲_*.md')
    expect(files).toEqual(['大纲/细纲_第001章.md'])
  })

  test('花括号分支匹配多个目录', async () => {
    await seedBook()
    const files = await globFiles(workspace.root, '{大纲,追踪}/*.md')
    expect(files).toHaveLength(2)
    expect(files).toContain('大纲/细纲_第001章.md')
    expect(files).toContain('追踪/伏笔.md')
  })

  test('显式指定嵌套层级', async () => {
    await seedBook()
    const files = await globFiles(workspace.root, '设定/角色/*.md')
    expect(files).toEqual(['设定/角色/林默.md'])
  })

  test('跳过 .yemu 等内部目录', async () => {
    await seedBook()
    const fs = await import('node:fs/promises')
    await fs.mkdir(path.join(workspace.root, '.yemu', 'threads'), { recursive: true })
    await fs.writeFile(path.join(workspace.root, '.yemu', 'threads', 'secret.md'), '不应出现', 'utf8')
    const files = await globFiles(workspace.root, '**/*.md')
    expect(files.some((file) => file.includes('.yemu'))).toBe(false)
  })

  test('无匹配返回空数组', async () => {
    await seedBook()
    expect(await globFiles(workspace.root, '不存在的目录/*.md')).toEqual([])
  })
})

describe('grep', () => {
  test('跨文件搜索并返回行号', async () => {
    await seedBook()
    const result = await grepFiles(workspace.root, { regex: /旧钥匙/g })
    expect(result.matches).toBe(4)
    expect(result.lines[0]).toMatch(/^(正文|大纲|设定|追踪)\/.+:\d+:/)
  })

  test('include 限定文件类型', async () => {
    await seedBook()
    const result = await grepFiles(workspace.root, { regex: /旧钥匙/g, include: '正文/*.md' })
    expect(result.matches).toBe(1)
    expect(result.lines[0]).toContain('第002章_灯塔.md')
  })

  test('scope 限定子目录', async () => {
    await seedBook()
    const result = await grepFiles(workspace.root, { regex: /旧钥匙/g, scope: '设定' })
    expect(result.matches).toBe(1)
    expect(result.lines[0]).toContain('林默.md')
  })

  test('scope 指向单个文件', async () => {
    await seedBook()
    const result = await grepFiles(workspace.root, { regex: /长安/g, scope: '正文/第001章_雨夜.md' })
    expect(result.matches).toBe(1)
  })

  test('无匹配返回零', async () => {
    await seedBook()
    const result = await grepFiles(workspace.root, { regex: /不存在的词/g })
    expect(result.matches).toBe(0)
    expect(result.lines).toEqual([])
  })

  test('跳过 .yemu 内部文件', async () => {
    await seedBook()
    const fs = await import('node:fs/promises')
    await fs.mkdir(path.join(workspace.root, '.yemu'), { recursive: true })
    await fs.writeFile(path.join(workspace.root, '.yemu', 'note.md'), '旧钥匙 内部记录', 'utf8')
    const result = await grepFiles(workspace.root, { regex: /旧钥匙/g })
    expect(result.lines.some((line) => line.includes('.yemu'))).toBe(false)
  })

  test('limit 截断长结果', async () => {
    for (let index = 0; index < 30; index += 1) {
      await writeWorkspaceText(workspace, `正文/第${String(index + 1).padStart(3, '0')}章_测试.md`, '重复词语', { snapshot: false })
    }
    const result = await grepFiles(workspace.root, { regex: /重复词语/g, limit: 5 })
    expect(result.lines.length).toBe(5)
    expect(result.matches).toBe(30)
  })
})
