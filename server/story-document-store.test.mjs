import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readStoryDocument, writeStoryDocument, workspaceHistoryRoot } from './story-document-store.mjs'
import { ensureWorkspaceSkeleton, listSnapshots, openWorkspace, readWorkspaceText } from './workspace-store.mjs'
import { workspaceState } from './workspace-runtime.mjs'

let tempRoot = null

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'yemu-doc-'))
  const dir = path.join(tempRoot, '测试作品')
  await ensureWorkspaceSkeleton(dir)
  workspaceState.current = await openWorkspace(dir)
})

afterEach(async () => {
  workspaceState.current = null
  await rm(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('作品文件直接落在工作区磁盘', () => {
  test('写入后读回，内容与路径一致', async () => {
    const written = await writeStoryDocument({
      path: '大纲/大纲.md',
      title: '全书大纲',
      category: '大纲',
      content: '# 全书大纲\n\n主角追查旧港失踪案。',
    })
    expect(written.file.path).toBe('大纲/大纲.md')
    expect(written.file.category).toBe('大纲')

    const disk = await readWorkspaceText(workspaceState.current, '大纲/大纲.md')
    expect(disk.content).toContain('旧港失踪案')

    const read = await readStoryDocument('大纲/大纲.md')
    expect(read.content).toContain('旧港失踪案')
    expect(read.title).toBe('大纲')
    expect(read.category).toBe('大纲')
  })

  test('覆盖写入产生历史快照', async () => {
    await writeStoryDocument({ path: '大纲/大纲.md', content: '第一版' })
    const second = await writeStoryDocument({ path: '大纲/大纲.md', content: '第二版' })
    expect(second.snapshot).toBeTruthy()

    const snapshots = await listSnapshots(workspaceState.current, '大纲/大纲.md')
    expect(snapshots).toHaveLength(1)
    expect(workspaceHistoryRoot()).toContain('.yemu')
  })

  test('读取不存在的文件返回 null', async () => {
    expect(await readStoryDocument('大纲/不存在.md')).toBeNull()
  })

  test('未打开工作区时拒绝写入', async () => {
    workspaceState.current = null
    await expect(writeStoryDocument({ path: '大纲/大纲.md', content: 'x' })).rejects.toThrow(/尚未打开工作区/)
  })

  test('拒绝路径穿越', async () => {
    await expect(writeStoryDocument({ path: '../外逃.md', content: 'x' })).rejects.toThrow(/路径无效/)
  })
})
