import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import {
  buildTree,
  chapterFileName,
  createChapter,
  deleteWorkspaceFile,
  ensureWorkspaceSkeleton,
  isWorkspaceDir,
  listChapters,
  listSnapshots,
  nextChapterNumber,
  openWorkspace,
  parseChapterFileName,
  readSnapshot,
  readWorkspaceState,
  readWorkspaceText,
  reconcileChapters,
  renameChapter,
  resolveInside,
  writeWorkspaceState,
  writeWorkspaceText,
} from './workspace-store.mjs'

let tempRoot = null
let workspace = null

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'yemu-ws-'))
  const dir = path.join(tempRoot, '我的小说')
  await ensureWorkspaceSkeleton(dir)
  workspace = await openWorkspace(dir)
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
  tempRoot = null
  workspace = null
})

describe('章节文件名解析', () => {
  test('解析补零编号与标题', () => {
    assert.deepEqual(parseChapterFileName('第001章_雨夜.md'), { number: 1, title: '雨夜', fileName: '第001章_雨夜.md' })
    assert.deepEqual(parseChapterFileName('第12章_未寄出的信.txt'), { number: 12, title: '未寄出的信', fileName: '第12章_未寄出的信.txt' })
  })

  test('无标题时用章节号兜底', () => {
    assert.deepEqual(parseChapterFileName('第007章.md'), { number: 7, title: '第007章', fileName: '第007章.md' })
  })

  test('非章节文件返回 null', () => {
    assert.equal(parseChapterFileName('随便一个文件.md'), null)
    assert.equal(parseChapterFileName('正文.md'), null)
    assert.equal(parseChapterFileName('第一章_雨夜.md'), null)
  })

  test('生成文件名会清洗 Windows 非法字符', () => {
    assert.equal(chapterFileName(1, '雨夜/序:章?'), '第001章_雨夜-序-章-.md')
    assert.equal(chapterFileName(23, ''), '第023章_第023章.md')
  })
})

describe('路径沙箱', () => {
  test('拒绝绝对路径与穿越', () => {
    assert.equal(resolveInside('/tmp/ws', '/etc/passwd'), null)
    assert.equal(resolveInside('/tmp/ws', '../outside.md'), null)
    assert.equal(resolveInside('/tmp/ws', 'a/../../b.md'), null)
    assert.equal(resolveInside('/tmp/ws', 'C:/Windows/system32'), null)
  })

  test('接受工作区内相对路径', () => {
    assert.equal(resolveInside('/tmp/ws', '正文/第001章_雨夜.md'), path.resolve('/tmp/ws/正文/第001章_雨夜.md'))
  })
})

describe('打开与识别工作区', () => {
  test('新建工作区写入 yemu.json 与骨架目录', async () => {
    const meta = JSON.parse(await readFile(path.join(workspace.root, 'yemu.json'), 'utf8'))
    assert.equal(meta.version, 1)
    assert.equal(meta.title, '我的小说')
    for (const dir of ['正文', '大纲', '设定/世界观', '设定/角色', '追踪/逐章记录', '参考资料', '.yemu/threads', '.yemu/history']) {
      const info = await stat(path.join(workspace.root, dir))
      assert.ok(info.isDirectory(), `${dir} 应存在`)
    }
  })

  test('缺少标记时拒绝打开普通目录', async () => {
    const plain = path.join(tempRoot, '普通文件夹')
    await ensureWorkspaceSkeleton(plain)
    // ensureWorkspaceSkeleton 不写 yemu.json；但创建了 正文/，所以会被识别为工作区
    assert.equal(await isWorkspaceDir(plain), true)
    const plainEmpty = path.join(tempRoot, '空文件夹')
    await rm(plainEmpty, { recursive: true, force: true })
    await import('node:fs/promises').then(({ mkdir }) => mkdir(plainEmpty, { recursive: true }))
    assert.equal(await isWorkspaceDir(plainEmpty), false)
    await assert.rejects(() => openWorkspace(plainEmpty), /不是作品工作区/)
  })

  test('重复打开不覆盖已有 yemu.json', async () => {
    await writeWorkspaceText(workspace, '正文/第001章_雨夜.md', '第一段')
    const reopened = await openWorkspace(workspace.root)
    assert.equal(reopened.created, false)
    assert.equal(reopened.meta.title, '我的小说')
  })
})

describe('章节读写', () => {
  test('写入后能列出，并按编号排序', async () => {
    await writeWorkspaceText(workspace, '正文/第003章_三.md', '三')
    await writeWorkspaceText(workspace, '正文/第001章_一.md', '一')
    await writeWorkspaceText(workspace, '正文/第002章_二.md', '二')
    const { chapters } = await listChapters(workspace)
    assert.deepEqual(chapters.map((chapter) => chapter.number), [1, 2, 3])
    assert.deepEqual(chapters.map((chapter) => chapter.title), ['一', '二', '三'])
  })

  test('无法解析编号的文件归入 unclassified 且不删除', async () => {
    await writeWorkspaceText(workspace, '正文/散稿.md', '草稿')
    await writeWorkspaceText(workspace, '正文/第001章_一.md', '一')
    const { chapters, unclassified } = await listChapters(workspace)
    assert.equal(chapters.length, 1)
    assert.deepEqual(unclassified.map((item) => item.fileName), ['散稿.md'])
  })

  test('短篇单文件结构被识别为第 1 章', async () => {
    const shortDir = path.join(tempRoot, '短篇')
    await ensureWorkspaceSkeleton(shortDir)
    await writeFile(path.join(shortDir, '正文.md'), '短篇正文', 'utf8')
    await rm(path.join(shortDir, '正文'), { recursive: true, force: true })
    const ws = await openWorkspace(shortDir)
    const { chapters } = await listChapters(ws)
    assert.equal(chapters.length, 1)
    assert.equal(chapters[0].singleFile, true)
    assert.equal(chapters[0].path, '正文.md')
  })

  test('创建章节自动分配下一个编号', async () => {
    await writeWorkspaceText(workspace, '正文/第001章_一.md', '一')
    const created = await createChapter(workspace, { title: '二', content: '内容' })
    assert.equal(created.number, 2)
    assert.equal(created.path, '正文/第002章_二.md')
    assert.equal(await readFile(path.join(workspace.root, created.path), 'utf8'), '内容')
  })

  test('创建重复编号章节会被拒绝', async () => {
    await writeWorkspaceText(workspace, '正文/第001章_一.md', '一')
    await assert.rejects(() => createChapter(workspace, { number: 1, title: '重复' }), /已存在/)
  })

  test('nextChapterNumber 取最大值加一（不补空洞）', () => {
    assert.equal(nextChapterNumber([{ number: 1 }, { number: 7 }]), 8)
    assert.equal(nextChapterNumber([]), 1)
  })

  test('改名只改标题，章节号不变', async () => {
    await writeWorkspaceText(workspace, '正文/第001章_雨夜.md', '正文内容')
    const result = await renameChapter(workspace, '正文/第001章_雨夜.md', '暴雨')
    assert.equal(result.path, '正文/第001章_暴雨.md')
    assert.equal(result.number, 1)
    assert.equal(await readFile(path.join(workspace.root, result.path), 'utf8'), '正文内容')
    const names = await readdir(path.join(workspace.root, '正文'))
    assert.deepEqual(names, ['第001章_暴雨.md'])
  })

  test('改名到已存在的文件会被拒绝', async () => {
    await writeWorkspaceText(workspace, '正文/第001章_雨夜.md', '一')
    await writeWorkspaceText(workspace, '正文/第001章_暴雨.md', '二')
    await assert.rejects(() => renameChapter(workspace, '正文/第001章_雨夜.md', '暴雨'), /目标文件已存在/)
  })

  test('删除章节前保留快照', async () => {
    await writeWorkspaceText(workspace, '正文/第001章_雨夜.md', '将被删除')
    await deleteWorkspaceFile(workspace, '正文/第001章_雨夜.md')
    await assert.rejects(() => readWorkspaceText(workspace, '正文/第001章_雨夜.md'), /文件不存在/)
    const snapshots = await listSnapshots(workspace, '正文/第001章_雨夜.md')
    assert.equal(snapshots.length, 1)
    const restored = await readSnapshot(workspace, '正文/第001章_雨夜.md', snapshots[0].id)
    assert.equal(restored.content, '将被删除')
  })
})

describe('对账', () => {
  test('编号相同路径不同 → 识别为改名', async () => {
    await writeWorkspaceText(workspace, '正文/第001章_雨夜.md', '一')
    const before = (await listChapters(workspace)).chapters
    await writeWorkspaceText(workspace, '正文/第001章_暴雨.md', '一')
    await rm(path.join(workspace.root, '正文/第001章_雨夜.md'))
    const after = (await listChapters(workspace)).chapters
    const result = reconcileChapters(after, before)
    assert.equal(result.renamed.length, 1)
    assert.equal(result.renamed[0].from, '正文/第001章_雨夜.md')
    assert.equal(result.renamed[0].to, '正文/第001章_暴雨.md')
    assert.equal(result.added.length, 0)
    assert.equal(result.missing.length, 0)
  })

  test('磁盘新增编号 → 识别为新增章节', async () => {
    const before = (await listChapters(workspace)).chapters
    await writeWorkspaceText(workspace, '正文/第005章_五.md', '五')
    const after = (await listChapters(workspace)).chapters
    const result = reconcileChapters(after, before)
    assert.deepEqual(result.added.map((chapter) => chapter.number), [5])
  })

  test('已知章节消失 → 标记缺失但不删除', async () => {
    await writeWorkspaceText(workspace, '正文/第001章_一.md', '一')
    const before = (await listChapters(workspace)).chapters
    await rm(path.join(workspace.root, '正文/第001章_一.md'))
    const after = (await listChapters(workspace)).chapters
    const result = reconcileChapters(after, before)
    assert.deepEqual(result.missing.map((chapter) => chapter.number), [1])
    assert.equal(await stat(path.join(workspace.root, '正文')).then(() => true), true)
  })
})

describe('历史快照', () => {
  test('覆盖写入前自动快照旧内容', async () => {
    await writeWorkspaceText(workspace, '正文/第001章_一.md', '第一版')
    const second = await writeWorkspaceText(workspace, '正文/第001章_一.md', '第二版')
    assert.ok(second.snapshot)
    const snapshots = await listSnapshots(workspace, '正文/第001章_一.md')
    assert.equal(snapshots.length, 1)
    const previous = await readSnapshot(workspace, '正文/第001章_一.md', snapshots[0].id)
    assert.equal(previous.content, '第一版')
    assert.equal((await readWorkspaceText(workspace, '正文/第001章_一.md')).content, '第二版')
  })

  test('内容未变化时不产生快照', async () => {
    await writeWorkspaceText(workspace, '正文/第001章_一.md', '相同')
    const again = await writeWorkspaceText(workspace, '正文/第001章_一.md', '相同')
    assert.equal(again.snapshot, null)
    assert.deepEqual(await listSnapshots(workspace, '正文/第001章_一.md'), [])
  })

  test('拒绝写入 .yemu 与元信息', async () => {
    await assert.rejects(() => writeWorkspaceText(workspace, '.yemu/foreshadows.json', '{}'), /不对普通文件写入开放/)
    await assert.rejects(() => writeWorkspaceText(workspace, 'yemu.json', '{}'), /作品元信息/)
  })
})

describe('工作区状态', () => {
  test('读写各自独立的 JSON', async () => {
    await writeWorkspaceState(workspace, 'foreshadows', [{ id: 'f1', title: '旧钥匙' }])
    await writeWorkspaceState(workspace, 'memories', [{ id: 'm1', title: '设定' }])
    assert.deepEqual(await readWorkspaceState(workspace, 'foreshadows'), [{ id: 'f1', title: '旧钥匙' }])
    assert.deepEqual(await readWorkspaceState(workspace, 'memories'), [{ id: 'm1', title: '设定' }])
    assert.equal(await readWorkspaceState(workspace, 'stats', []).then((value) => Array.isArray(value)), true)
    const names = await readdir(path.join(workspace.root, '.yemu'))
    assert.deepEqual(names.sort(), ['foreshadows.json', 'history', 'memories.json', 'threads'])
  })

  test('未知状态名被拒绝', async () => {
    await assert.rejects(() => readWorkspaceState(workspace, 'unknown'), /未知的工作区状态/)
  })
})

describe('目录树', () => {
  test('返回文件与目录，跳过点文件', async () => {
    await writeWorkspaceText(workspace, '正文/第001章_一.md', '一')
    await writeWorkspaceText(workspace, '大纲/大纲.md', '# 大纲')
    await writeFile(path.join(workspace.root, '.hidden.md'), '隐藏', 'utf8')
    const tree = await buildTree(workspace)
    const topLevel = tree.nodes.map((node) => node.name)
    assert.ok(topLevel.includes('正文'))
    assert.ok(topLevel.includes('大纲'))
    assert.ok(!topLevel.includes('.hidden.md'), '点文件不应出现在树里')
    const chaptersDir = tree.nodes.find((node) => node.name === '正文')
    const file = chaptersDir.children.find((node) => node.name === '第001章_一.md')
    assert.equal(file.chapter.number, 1)
    assert.equal(file.chapter.title, '一')
    assert.equal(tree.hasInternal, true)
  })

  test('非文本文件被忽略', async () => {
    await writeFile(path.join(workspace.root, 'cover.png'), 'not really png', 'utf8')
    const tree = await buildTree(workspace)
    assert.ok(!tree.nodes.some((node) => node.name === 'cover.png'))
  })
})

describe('读取文件', () => {
  test('统一换行符并返回修改时间', async () => {
    const target = path.join(workspace.root, '大纲/大纲.md')
    await writeFile(target, '第一行\r\n第二行', 'utf8')
    const result = await readWorkspaceText(workspace, '大纲/大纲.md')
    assert.equal(result.content, '第一行\n第二行')
    assert.ok(result.modifiedAt)
  })

  test('不存在的文件返回 404', async () => {
    await assert.rejects(() => readWorkspaceText(workspace, '大纲/不存在.md'), (error) => error.status === 404)
  })
})
