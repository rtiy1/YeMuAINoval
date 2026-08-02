import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeWorkspaceStoryPath, readStoryWorkspaceFile, storyProjectWorkspacePath, writeStoryWorkspaceFile } from './story-workspace.mjs'

let tempRoot = null

afterEach(async () => {
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true })
  tempRoot = null
  delete process.env.STORY_WORKSPACE_DIR
})

describe('story project workspace', () => {
  test('writes and reads a real project-scoped file', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yemu-story-workspace-'))
    process.env.STORY_WORKSPACE_DIR = tempRoot
    const written = await writeStoryWorkspaceFile('user-1', 'project-1', {
      path: '设定/世界规则.md',
      title: '世界规则',
      category: '设定',
      content: '# 世界规则\r\n\r\n能力需要代价。',
    })
    const absolutePath = path.join(storyProjectWorkspacePath('user-1', 'project-1'), '设定', '世界规则.md')
    expect(await fs.readFile(absolutePath, 'utf8')).toBe('# 世界规则\n\n能力需要代价。')
    expect(written.path).toBe('设定/世界规则.md')
    expect((await readStoryWorkspaceFile('user-1', 'project-1', written.path))?.content).toContain('能力需要代价')
  })

  test('rejects absolute and traversal paths', () => {
    expect(() => normalizeWorkspaceStoryPath('../db.json')).toThrow('路径无效')
    expect(() => normalizeWorkspaceStoryPath('C:/Windows/system.ini')).toThrow('相对路径')
    expect(() => normalizeWorkspaceStoryPath('/etc/passwd')).toThrow('相对路径')
  })
})
