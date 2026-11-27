import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { buildWritingContext, enrichStoryAgentPayload, resolveStoryAttachments, workspaceChapters } from './writing-context.mjs'
import { ensureWorkspaceSkeleton, openWorkspace, writeWorkspaceText } from './workspace-store.mjs'
import { workspaceState } from './workspace-runtime.mjs'

const project = { id: 'project-1', userId: 'local-user', title: '旧港来信', type: '长篇', genre: '悬疑', style: '克制', tone: '追查失踪案' }
const now = '2026-07-28T00:00:00.000Z'

let tempRoot = null
let workspace = null

function emptyDb() {
  return {
    projects: [{ ...project }],
    chapters: { [project.id]: [] },
    drafts: { [project.id]: {} },
    ideas: [],
    foreshadows: [],
    storyMemories: [],
  }
}

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'yemu-ctx-'))
  const dir = path.join(tempRoot, '旧港来信')
  await ensureWorkspaceSkeleton(dir)
  workspace = await openWorkspace(dir)
  workspaceState.current = workspace
})

afterEach(async () => {
  workspaceState.current = null
  await rm(tempRoot, { recursive: true, force: true })
  tempRoot = null
  workspace = null
})

async function seedBook() {
  for (let index = 1; index <= 15; index += 1) {
    await writeWorkspaceText(workspace, `正文/第${String(index).padStart(3, '0')}章_第${index}章.md`, `正文 ${index}\n章末 ${index}`, { snapshot: false })
  }
  await writeWorkspaceText(workspace, '大纲/大纲.md', '# 大纲\n\n主角追查旧港失踪案。', { snapshot: false })
  await writeWorkspaceText(workspace, '大纲/细纲_第015章.md', '# 第十五章细纲\n\n主角进入灯塔。', { snapshot: false })
  await writeWorkspaceText(workspace, '大纲/细纲_第001章.md', '# 第一章细纲\n\n主角初到旧港。', { snapshot: false })
  await writeWorkspaceText(workspace, '大纲/卷纲_第一卷.md', '# 第一卷\n\n- 章节范围：第1-15章\n- 灯塔谜案告一段落。', { snapshot: false })
  await writeWorkspaceText(workspace, '追踪/伏笔.md', '# 伏笔\n\n第三封信尚未回收。', { snapshot: false })
  await writeWorkspaceText(workspace, '设定/题材定位.md', '悬疑 · 克制叙事', { snapshot: false })
}

describe('工作区写作上下文', () => {
  test('章节从磁盘派生，正文按章节路径读取', async () => {
    await seedBook()
    const chapters = await workspaceChapters(workspace)
    assert.equal(chapters.length, 15)
    assert.deepEqual(chapters.slice(0, 3).map((chapter) => chapter.number), [1, 2, 3])
    assert.equal(chapters[14].path, '正文/第015章_第15章.md')
    assert.match(chapters[14].outline, /进入灯塔/, '细纲应作为 chapter.outline')
  })

  test('上下文分层与优先文件排序', async () => {
    await seedBook()
    const db = emptyDb()
    const chapters = await workspaceChapters(workspace)
    const context = await buildWritingContext(db, project, chapters[14], '续写第15章')

    assert.equal(context.version, 4)
    assert.deepEqual(context.layers.near.chapters.map((item) => item.id), [12, 13, 14])
    assert.deepEqual(context.layers.far.chapters.map((item) => item.id), [1, 2])
    assert.equal(context.summaryStatus.previousChapterCount, 14)

    const inventoryPaths = context.storyFiles.inventory.map((item) => item.path)
    assert.ok(inventoryPaths.includes('大纲/大纲.md'))
    assert.ok(inventoryPaths.includes('追踪/伏笔.md'))
    assert.ok(inventoryPaths.includes('设定/题材定位.md'))
    assert.ok(!inventoryPaths.includes('设定/角色'), '目录不应出现在 inventory')

    const loaded = context.storyFiles.loaded
    assert.equal(loaded[0].path, '大纲/细纲_第015章.md', '当前章细纲应最先加载')
    assert.match(loaded[0].content, /进入灯塔/)
    assert.ok(!loaded.some((item) => item.path === '正文/第001章_第1章.md'), '非当前章正文不加载')
    assert.equal(loaded.filter((item) => item.path.startsWith('正文/')).length, 1, '只加载当前章正文')
  })

  test('当前章正文被加载且内容来自磁盘', async () => {
    await seedBook()
    await writeWorkspaceText(workspace, '正文/第015章_第15章.md', '外部改写后的第十五章正文', { snapshot: false })
    const chapters = await workspaceChapters(workspace)
    const context = await buildWritingContext(emptyDb(), project, chapters[14], '续写第15章')
    const current = context.storyFiles.loaded.find((item) => item.path === '正文/第015章_第15章.md')
    assert.ok(current)
    assert.match(current.content, /外部改写后的第十五章正文/)
    // near 层是「之前」的章节，不含当前章；它取的是第14章的章末。
    assert.deepEqual(context.layers.near.chapters.map((item) => item.id), [12, 13, 14])
    assert.match(context.layers.near.chapters.at(-1).ending, /章末 14/)
  })

  test('未打开工作区时降级为空上下文', async () => {
    workspaceState.current = null
    const context = await buildWritingContext(emptyDb(), project, { id: 1, title: '第一章' }, '续写')
    assert.deepEqual(context.storyFiles.inventory, [])
    assert.deepEqual(context.storyFiles.loaded, [])
  })
})

describe('权限策略', () => {
  test('打开工作区时本地命令恒为 allow，删除恒为 deny', async () => {
    await seedBook()
    const chapters = await workspaceChapters(workspace)
    const payload = await enrichStoryAgentPayload(emptyDb(), 'local-user', {
      project_id: project.id,
      chapter_id: chapters[14].number,
      tool_policy: { mutateStoryData: 'propose', deleteStoryData: 'allow' },
    }, '续写第15章')
    assert.equal(payload.tool_policy.mutateStoryData, 'propose')
    assert.equal(payload.tool_policy.deleteStoryData, 'deny')
    assert.equal(payload.tool_policy.localShell, 'allow')
    assert.equal(payload.writing_context.storyFiles.loaded[0].path, '大纲/细纲_第015章.md')
  })

  test('未打开工作区且项目不存在时返回 404', async () => {
    workspaceState.current = null
    await assert.rejects(
      () => enrichStoryAgentPayload({ ...emptyDb(), projects: [] }, 'local-user', { project_id: 'missing' }, 'test'),
      (error) => error.status === 404,
    )
  })
})

describe('附件解析', () => {
  test('有效引用解析为当前内容', async () => {
    const db = emptyDb()
    db.ideas.push({ id: 'idea-1', userId: 'local-user', projectId: project.id, label: '线索', title: '灯塔', body: '灯塔每晚闪三次。', tags: [], updatedAt: now })
    const resolved = resolveStoryAttachments(db, project, 'local-user', [
      { name: '灯塔', reference: { type: 'idea', id: 'idea-1' } },
    ])
    assert.equal(resolved.length, 1)
    assert.match(resolved[0].content, /灯塔每晚闪三次/)
  })

  test('失效引用按既有约定抛错', async () => {
    assert.throws(
      () => resolveStoryAttachments(emptyDb(), project, 'local-user', [
        { name: 'x', reference: { type: 'idea', id: 'missing' } },
      ]),
      /引用内容不存在/,
    )
  })
})

describe('短篇结构', () => {
  test('根目录 正文.md 作为唯一章节', async () => {
    const shortDir = path.join(tempRoot, '短篇')
    await ensureWorkspaceSkeleton(shortDir)
    await writeFile(path.join(shortDir, '正文.md'), '短篇正文内容', 'utf8')
    await rm(path.join(shortDir, '正文'), { recursive: true, force: true })
    const shortWorkspace = await openWorkspace(shortDir)
    workspaceState.current = shortWorkspace
    const chapters = await workspaceChapters(shortWorkspace)
    assert.equal(chapters.length, 1)
    assert.equal(chapters[0].title, '正文')
    assert.equal(chapters[0].singleFile, true)
  })
})
