import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  collectProjectFiles,
  importWorkspaceChanges,
  materializeProjectWorkspace,
  projectWorkspaceDir,
  writeWorkspaceFile,
} from './local-workspace.mjs'
import { readStoryFileForAgent } from './writing-context.mjs'

const project = { id: 'project-1', userId: 'user-1', title: '旧港来信', type: '长篇' }

function buildDb() {
  return {
    projects: [project],
    chapters: { [project.id]: [{ id: 1, title: '第一章', state: 'draft', createdAt: '2026-01-01T00:00:00Z' }] },
    drafts: { [project.id]: { '1': '旧港的第一夜。' } },
    ideas: [
      {
        id: 'idea-1', userId: 'user-1', projectId: project.id, label: '大纲文档', folder: '大纲',
        title: '全书大纲', body: '# 大纲\n主角追查失踪案。', tags: ['Skill产物', '文件:大纲/大纲.md'],
      },
    ],
    editHistory: {},
    relationshipGraphs: {},
  }
}

async function tempWorkspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'yemu-workspace-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('project workspace dir is derived from the local data file', () => {
  const dir = projectWorkspaceDir('project-1')
  assert.ok(dir === null || dir.endsWith(path.join('workspace', 'project-project-1')))
  assert.equal(projectWorkspaceDir(''), null)
  const sanitized = projectWorkspaceDir('a/b')
  assert.ok(sanitized === null || sanitized.endsWith(path.join('workspace', 'project-a_b')))
})

test('materialize writes chapters and idea files into a real directory', async (t) => {
  const dir = await tempWorkspace(t)
  const db = buildDb()
  const written = await materializeProjectWorkspace(db, 'user-1', project.id, dir)
  assert.equal(written, 2)
  assert.equal(await readFile(path.join(dir, '正文', '001-第一章.md'), 'utf8'), '旧港的第一夜。')
  assert.equal(await readFile(path.join(dir, '大纲', '大纲.md'), 'utf8'), '# 大纲\n主角追查失踪案。')
})

test('materialize ignores projects owned by another user', async (t) => {
  const dir = await tempWorkspace(t)
  const written = await materializeProjectWorkspace(buildDb(), 'other-user', project.id, dir)
  assert.equal(written, 0)
})

test('writeWorkspaceFile mirrors files and rejects path escape', async (t) => {
  const dir = await tempWorkspace(t)
  assert.equal(await writeWorkspaceFile(dir, '追踪/伏笔.md', '第三封信'), true)
  assert.equal(await readFile(path.join(dir, '追踪', '伏笔.md'), 'utf8'), '第三封信')
  assert.equal(await writeWorkspaceFile(dir, '../escape.md', 'bad'), false)
  assert.equal(await writeWorkspaceFile(dir, '/abs.md', 'bad'), false)
})

test('import picks up script-created and edited files without touching unchanged ones', async (t) => {
  const dir = await tempWorkspace(t)
  const db = buildDb()
  await materializeProjectWorkspace(db, 'user-1', project.id, dir)

  const created = await importWorkspaceChanges(db, 'user-1', project.id, dir)
  assert.equal(created.applied, false)

  await writeFile(path.join(dir, '正文', '001-第一章.md'), '旧港的第一夜。雨开始下了。')
  await mkdir(path.join(dir, '追踪'), { recursive: true })
  await writeFile(path.join(dir, '追踪', '伏笔.md'), '# 伏笔\n- 第三封信未回收')
  await mkdir(path.join(dir, '脚本输出'), { recursive: true })
  await writeFile(path.join(dir, '脚本输出', 'wordcount.json'), '{"total": 12}')

  const result = await importWorkspaceChanges(db, 'user-1', project.id, dir)
  assert.equal(result.imported, 3)
  assert.equal(db.drafts[project.id]['1'], '旧港的第一夜。雨开始下了。')
  assert.equal(db.editHistory[project.id]['1'].length, 1)

  const tracking = readStoryFileForAgent(db, 'user-1', project.id, '追踪/伏笔.md')
  assert.match(tracking.content, /第三封信未回收/)

  const scriptOutput = readStoryFileForAgent(db, 'user-1', project.id, '脚本输出/wordcount.json')
  assert.match(scriptOutput.content, /total/)

  const second = await importWorkspaceChanges(db, 'user-1', project.id, dir)
  assert.equal(second.applied, false)
  assert.equal(db.editHistory[project.id]['1'].length, 1)
})
