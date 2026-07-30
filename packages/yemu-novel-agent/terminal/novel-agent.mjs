#!/usr/bin/env node

import readline from 'node:readline/promises'
import process from 'node:process'
import { NOVEL_COMMANDS, parseSlashCommand, resolveSelection, skillForProject } from './commands.mjs'
import { NovelApiClient } from './api-client.mjs'
import { loadLocalState, saveLocalState } from './local-state.mjs'
import { errorText, extractAgentText, extractWritableText } from './result-text.mjs'
import { changedTaskEvents, terminalDiffHunks } from './task-view.mjs'

const VERSION = '0.1.0'
const ACTIVE_TASK_STATUSES = new Set(['queued', 'running'])

function waitForPoll(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function parseArgs(argv) {
  const options = { json: false, yes: false, color: true }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--json') options.json = true
    else if (value === '--yes') options.yes = true
    else if (value === '--no-color') options.color = false
    else if (value === '--help' || value === '-h') options.help = true
    else if (value === '--version' || value === '-v' || value === '-V') options.version = true
    else if (['--api', '--email', '--token', '--project', '--chapter', '--skill', '--prompt', '-p'].includes(value)) {
      const next = argv[index + 1]
      if (!next) throw new Error(`${value} 缺少参数`)
      const key = value === '-p' ? 'prompt' : value.slice(2)
      options[key] = next
      index += 1
    } else {
      throw new Error(`未知参数：${value}`)
    }
  }
  return options
}

function createTheme(enabled) {
  const color = (code, value) => enabled ? `\u001b[${code}m${value}\u001b[0m` : String(value)
  return {
    title: (value) => color('1;38;5;151', value),
    accent: (value) => color('38;5;109', value),
    dim: (value) => color('2', value),
    success: (value) => color('38;5;114', value),
    warning: (value) => color('38;5;179', value),
    error: (value) => color('38;5;203', value),
    added: (value) => color('38;5;114', value),
    removed: (value) => color('38;5;203', value),
  }
}

async function readSecret(prompt, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    const rl = readline.createInterface({ input, output })
    const value = await rl.question(prompt)
    rl.close()
    return value
  }

  output.write(prompt)
  input.setRawMode(true)
  input.resume()
  input.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let value = ''
    const cleanup = () => {
      input.off('data', onData)
      input.setRawMode(false)
      output.write('\n')
    }
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup()
          reject(new Error('已取消登录'))
          return
        }
        if (character === '\r' || character === '\n') {
          cleanup()
          resolve(value)
          return
        }
        if (character === '\u007f' || character === '\b') {
          if (value) {
            value = value.slice(0, -1)
            output.write('\b \b')
          }
          continue
        }
        if (character >= ' ') {
          value += character
          output.write('*')
        }
      }
    }
    input.on('data', onData)
  })
}

function usage() {
  return `夜雨小说终端 Agent ${VERSION}

用法：
  npm run novel
  npm run novel -- -p "续写当前章节" --project 作品名 --chapter 1

选项：
  --api <URL>       API 地址，默认 http://127.0.0.1:8787/api
  --email <EMAIL>   登录邮箱
  --token <TOKEN>   直接使用访问令牌
  --project <值>    作品序号、名称或 ID
  --chapter <值>    章节序号、名称或 ID
  --skill <名称>    非交互模式直接指定 Story Skill
  -p, --prompt <文> 非交互执行一条指令
  --json            非交互模式输出原始 JSON
  --yes             自动确认正文写入
  --no-color        禁用 ANSI 颜色
  -h, --help        显示帮助
  -v, --version     显示版本`
}

class NovelTerminal {
  constructor(options) {
    this.options = options
    this.theme = createTheme(options.color && process.stdout.isTTY && !process.env.NO_COLOR)
    this.localState = {}
    this.api = null
    this.user = null
    this.settings = null
    this.skills = []
    this.projects = []
    this.chapters = []
    this.project = null
    this.chapter = null
    this.assistantSession = null
    this.lastProposal = null
    this.lastTaskId = null
    this.activeTaskId = null
    this.activeTaskController = null
    this.activeCancelPromise = null
    this.taskEventStates = new Map()
  }

  print(value = '') {
    process.stdout.write(`${value}\n`)
  }

  async initialize() {
    this.localState = await loadLocalState()
    this.lastTaskId = this.localState.lastTaskId || null
    const baseUrl = this.options.api || process.env.NOVEL_AGENT_API || this.localState.apiBase
    this.api = new NovelApiClient({ baseUrl, accessToken: this.options.token || process.env.NOVEL_AGENT_TOKEN })
    await this.authenticate()

    const [projects, skills, settings, session] = await Promise.all([
      this.api.getProjects(),
      this.api.getSkills(),
      this.api.getSettings(),
      this.api.getAssistantSession(),
    ])
    this.projects = projects.projects || []
    this.skills = skills.skills || []
    this.settings = settings.settings || {}
    this.assistantSession = session.session || null

    const fallbackProject = this.projects.find((item) => item.isActive) || this.projects[0] || null
    this.project = this.options.project
      ? resolveSelection(this.projects, this.options.project, '作品')
      : this.tryResolve(this.projects, this.localState.projectId, '作品') || fallbackProject
    if (this.project) {
      await this.loadProject(
        this.project,
        this.options.chapter || this.localState.chapterId,
        Boolean(this.options.chapter),
      )
    }
    await this.persistSelection()
  }

  async authenticate() {
    if (this.api.accessToken) {
      try {
        const payload = await this.api.me()
        this.user = payload.user
        return
      } catch {
        this.api.accessToken = null
      }
    }

    let email = this.options.email || process.env.NOVEL_AGENT_EMAIL || this.localState.email
    if (!email) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      email = (await rl.question('登录邮箱：')).trim()
      rl.close()
    }
    const password = process.env.NOVEL_AGENT_PASSWORD || await readSecret('登录密码：')
    const payload = await this.api.login(email, password)
    this.user = payload.user
    this.localState.email = email
  }

  tryResolve(items, selector, label) {
    try {
      return resolveSelection(items, selector, label)
    } catch {
      return null
    }
  }

  async loadProject(project, chapterSelector = null, strictChapter = false) {
    this.project = project
    const payload = await this.api.getChapters(project.id)
    this.chapters = payload.chapters || []
    const fallbackChapter = this.chapters.find((item) => item.state === 'current') || this.chapters.at(-1) || this.chapters[0] || null
    this.chapter = chapterSelector
      ? (strictChapter ? resolveSelection(this.chapters, chapterSelector, '章节') : this.tryResolve(this.chapters, chapterSelector, '章节') || fallbackChapter)
      : fallbackChapter
    this.lastProposal = null
    await this.persistSelection()
  }

  async persistSelection() {
    await saveLocalState({
      apiBase: this.api?.baseUrl,
      email: this.localState.email || this.options.email || process.env.NOVEL_AGENT_EMAIL,
      projectId: this.project?.id,
      chapterId: this.chapter?.id,
      lastTaskId: this.lastTaskId,
    })
  }

  printBanner() {
    this.print(this.theme.title('夜雨 Novel Agent'))
    this.print(this.theme.dim('只处理构思、设定、拆章、写作、润色、审稿、资料与连续性。输入 /help 查看命令。'))
    this.print()
    this.printStatus()
  }

  printStatus() {
    const model = this.settings?.model || '未配置模型'
    const provider = this.settings?.provider === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'
    this.print(`${this.theme.dim('模型')} ${model === '未配置模型' ? this.theme.warning(model) : this.theme.accent(`${provider} / ${model}`)}`)
    this.print(`${this.theme.dim('作品')} ${this.project ? this.project.title : this.theme.warning('未选择')}  ${this.theme.dim('章节')} ${this.chapter ? this.chapter.title : this.theme.warning('未选择')}`)
    if (this.lastTaskId) this.print(`${this.theme.dim('任务')} ${this.lastTaskId}`)
  }

  async buildPayload({ includeDraft = true, reviewableEdit = false } = {}) {
    if (!this.project || !this.chapter) return {}
    const requests = [this.api.getContext(this.project.id, this.chapter.id)]
    if (includeDraft) requests.push(this.api.getDraft(this.project.id, this.chapter.id))
    const [contextPayload, draftPayload] = await Promise.all(requests)
    return {
      projectId: this.project.id,
      chapterId: this.chapter.id,
      title: this.chapter.title,
      genre: this.project.genre || '网络小说',
      project: this.project,
      chapter: this.chapter,
      writing_context: contextPayload.context,
      content: draftPayload?.content || '',
      reviewable_edit: reviewableEdit,
    }
  }

  async sendConversation(message, extra = {}) {
    const payload = await this.buildPayload()
    const response = await this.api.sendMessage(message, { payload, ...extra })
    this.assistantSession = response.session || this.assistantSession
    this.renderResponse(response)
    return response
  }

  renderTaskEvents(task) {
    const state = this.taskEventStates.get(task.id) || new Map()
    const { changed, next } = changedTaskEvents(task.events, state)
    this.taskEventStates.set(task.id, next)
    for (const event of changed) {
      const marker = event.status === 'running'
        ? this.theme.accent('>')
        : event.status === 'completed'
          ? this.theme.success('✓')
          : ['failed', 'cancelled', 'interrupted'].includes(event.status)
            ? this.theme.error('×')
            : this.theme.dim('○')
      const startedAt = new Date(event.startedAt || 0).getTime()
      const completedAt = new Date(event.completedAt || 0).getTime()
      const seconds = Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt
        ? ` · ${((completedAt - startedAt) / 1000).toFixed(1)}s`
        : ''
      this.print(`${marker} ${event.label}${this.theme.dim(seconds)}`)
    }
  }

  async rememberTask(taskId) {
    this.lastTaskId = taskId
    await this.persistSelection()
  }

  async waitForTask(initialTask, { signal, quiet = false } = {}) {
    let task = initialTask
    if (!quiet) {
      this.print(this.theme.dim(`任务 ${task.id} · ${task.skill || 'story'}`))
      this.renderTaskEvents(task)
    }
    while (ACTIVE_TASK_STATUSES.has(task.status)) {
      await waitForPoll(350, signal)
      task = (await this.api.getTask(task.id, { signal })).task
      if (!quiet) this.renderTaskEvents(task)
    }
    return task
  }

  async executeTask(initialTask, { quiet = false } = {}) {
    const controller = new AbortController()
    this.activeTaskId = initialTask.id
    this.activeTaskController = controller
    await this.rememberTask(initialTask.id)
    try {
      return await this.waitForTask(initialTask, { signal: controller.signal, quiet })
    } catch (error) {
      if (error?.name !== 'AbortError') throw error
      if (this.activeCancelPromise) {
        const cancelled = await this.activeCancelPromise.catch(() => null)
        if (cancelled?.task) return cancelled.task
      }
      return { ...initialTask, status: 'cancelled', statusMessage: '任务已在本地停止', errorCode: 'cancelled' }
    } finally {
      if (this.activeTaskId === initialTask.id) {
        this.activeTaskId = null
        this.activeTaskController = null
        this.activeCancelPromise = null
      }
    }
  }

  async cancelActiveTask() {
    if (!this.activeTaskId) return false
    const taskId = this.activeTaskId
    if (this.activeCancelPromise) return this.activeCancelPromise
    this.print(this.theme.warning(`正在停止任务 ${taskId}…`))
    this.activeCancelPromise = this.api.cancelTask(taskId)
      .then((payload) => {
        this.renderTaskEvents(payload.task)
        this.print(this.theme.warning('任务已取消，可用 /retry 重试。'))
        return payload
      })
      .finally(() => this.activeTaskController?.abort())
    return this.activeCancelPromise
  }

  renderProposalDiff(originalText, revisedText, blocks = []) {
    const hunks = terminalDiffHunks(originalText, revisedText, blocks)
    if (!hunks.length) return
    this.print(this.theme.dim(`变更预览 · ${hunks.length} 处`))
    for (const [index, hunk] of hunks.entries()) {
      this.print(this.theme.dim(`@@ 修改 ${index + 1} · ${hunk.reason || '正文变更'} @@`))
      if (hunk.original) this.print(this.theme.removed(`- ${hunk.original}`))
      if (hunk.replacement) this.print(this.theme.added(`+ ${hunk.replacement}`))
    }
  }

  taskResponse(task) {
    if (task.status === 'completed' && task.result) return task.result
    return {
      status: task.status,
      result: { status: task.status, message: task.error || task.statusMessage || '任务未完成。' },
    }
  }

  async runSkill(skill, instruction, { writable = false, quiet = false } = {}) {
    const payload = await this.buildPayload({ reviewableEdit: writable })
    const baseContent = payload.content || ''
    const idempotencyKey = `terminal-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const created = await this.api.createTask(instruction, skill, payload, { idempotencyKey })
    const task = await this.executeTask(created.task, { quiet })
    const response = this.taskResponse(task)
    if (!quiet) this.renderResponse(response)
    const output = writable ? extractWritableText(response) : ''
    if (output) {
      this.lastProposal = { skill, output, baseContent, projectId: this.project.id, chapterId: String(this.chapter.id), taskId: task.id }
      if (!quiet) {
        this.renderProposalDiff(baseContent, output, response.result?.edit_proposal?.blocks || [])
        this.print(this.theme.warning('这是正文建议，尚未写入。输入 /apply 审阅确认后应用。'))
      }
    }
    return response
  }

  renderResponse(response) {
    const skill = response.selectedSkill || response.selected_skill || response.result?.skill
    const route = response.route
    const status = response.status || response.result?.status || 'completed'
    if (skill || route) this.print(this.theme.dim(`[${skill || 'story'}] ${status}${route ? ` · ${route}` : ''}`))
    this.print(extractAgentText(response))
    for (const question of response.questions || []) {
      this.print(this.theme.accent(question.question || '需要补充信息'))
      if (question.options?.length) {
        this.print(question.options.map((item, index) => `${index + 1}. ${item.label}${item.description ? `（${item.description}）` : ''}`).join('  '))
      }
    }
    if (response.proposal) {
      this.print(this.theme.warning(`建书方案《${response.proposal.title}》已生成，共 ${response.proposal.chapters?.length || 0} 章。输入 /confirm 创建作品。`))
    }
  }

  requireChapter() {
    if (!this.project) throw new Error('请先用 /use 选择作品')
    if (!this.chapter) throw new Error('请先用 /chapter 选择章节')
  }

  async confirm(question) {
    if (this.options.yes) return true
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    rl.close()
    return answer === 'y' || answer === 'yes' || answer === '是'
  }

  async applyProposal() {
    this.requireChapter()
    if (!this.lastProposal) throw new Error('当前没有可应用的正文建议')
    if (this.lastProposal.projectId !== this.project.id || this.lastProposal.chapterId !== String(this.chapter.id)) {
      throw new Error('正文建议属于另一个章节，请切回原章节后再应用')
    }
    const current = await this.api.getDraft(this.project.id, this.chapter.id)
    if (current.content !== this.lastProposal.baseContent) {
      throw new Error('生成建议后正文已发生变化，为避免覆盖新内容，本次应用已取消')
    }
    if (!await this.confirm(`确认用 ${this.lastProposal.skill} 的建议替换《${this.chapter.title}》正文？`)) {
      this.print(this.theme.dim('未写入正文。'))
      return
    }
    const saved = await this.api.saveDraft(this.project.id, this.chapter.id, this.lastProposal.output)
    this.chapter = saved.chapter || this.chapter
    this.lastProposal = null
    this.print(this.theme.success(`已写入《${this.chapter.title}》，原稿已自动进入历史记录。`))
  }

  async undo() {
    this.requireChapter()
    const [history, current] = await Promise.all([
      this.api.getHistory(this.project.id, this.chapter.id),
      this.api.getDraft(this.project.id, this.chapter.id),
    ])
    const snapshots = history.snapshots || []
    const snapshot = [...snapshots].reverse().find((item) => item.content !== current.content)
    if (!snapshot) throw new Error('没有可恢复的历史正文')
    if (!await this.confirm(`恢复 ${new Date(snapshot.createdAt).toLocaleString('zh-CN')} 的历史正文？`)) return
    await this.api.saveDraft(this.project.id, this.chapter.id, snapshot.content)
    this.lastProposal = null
    this.print(this.theme.success('历史正文已恢复；恢复前的版本也已保留。'))
  }

  listProjects() {
    if (!this.projects.length) {
      this.print(this.theme.warning('还没有作品，可在对话中描述新书想法。'))
      return
    }
    this.projects.forEach((item, index) => {
      const active = item.id === this.project?.id ? this.theme.success('*') : ' '
      this.print(`${active} ${String(index + 1).padStart(2)}  ${item.title}  ${this.theme.dim(`${item.type} · ${item.genre} · ${item.words || 0} 字`)}`)
    })
  }

  listChapters() {
    this.requireChapter()
    this.chapters.forEach((item, index) => {
      const active = String(item.id) === String(this.chapter?.id) ? this.theme.success('*') : ' '
      this.print(`${active} ${String(index + 1).padStart(2)}  ${item.title}  ${this.theme.dim(`${item.state || 'draft'} · ${item.words || 0} 字`)}`)
    })
  }

  listSkills() {
    this.skills
      .filter((item) => item.name?.startsWith('story'))
      .forEach((item) => this.print(`${item.status === 'ready' ? this.theme.success('ready') : this.theme.warning(item.status)}  ${item.name}  ${this.theme.dim(item.description || '')}`))
  }

  async listTasks() {
    const payload = await this.api.getTasks()
    const tasks = payload.tasks || []
    if (!tasks.length) {
      this.print(this.theme.dim('还没有 Agent 任务。'))
      return
    }
    for (const task of tasks.slice(0, 20)) {
      const status = task.status === 'completed'
        ? this.theme.success(task.status)
        : ['failed', 'cancelled'].includes(task.status)
          ? this.theme.error(task.status)
          : this.theme.accent(task.status)
      const current = task.id === this.lastTaskId ? this.theme.success('*') : ' '
      this.print(`${current} ${task.id}  ${status}  ${task.skill || 'story'}  ${this.theme.dim(task.message || '')}`)
    }
  }

  async showTask(selector = '') {
    const taskId = String(selector || this.lastTaskId || '').trim()
    if (!taskId) throw new Error('没有最近任务，请提供任务 ID')
    let task = (await this.api.getTask(taskId)).task
    await this.rememberTask(task.id)
    if (ACTIVE_TASK_STATUSES.has(task.status)) task = await this.executeTask(task)
    else this.renderTaskEvents(task)
    this.renderResponse(this.taskResponse(task))
    return task
  }

  async cancelTask(selector = '') {
    const taskId = String(selector || this.activeTaskId || this.lastTaskId || '').trim()
    if (!taskId) throw new Error('没有可取消的任务，请提供任务 ID')
    if (taskId === this.activeTaskId) return this.cancelActiveTask()
    const payload = await this.api.cancelTask(taskId)
    await this.rememberTask(payload.task.id)
    this.renderTaskEvents(payload.task)
    this.print(payload.task.status === 'cancelled' ? this.theme.warning('任务已取消，可用 /retry 重试。') : this.theme.dim(`任务状态：${payload.task.status}`))
    return payload.task
  }

  async retryTask(selector = '') {
    const taskId = String(selector || this.lastTaskId || '').trim()
    if (!taskId) throw new Error('没有可重试的任务，请提供任务 ID')
    const payload = await this.api.retryTask(taskId)
    const task = await this.executeTask(payload.task)
    this.renderResponse(this.taskResponse(task))
    return task
  }

  async switchProject(selector) {
    const project = resolveSelection(this.projects, selector, '作品')
    await this.loadProject(project)
    this.printStatus()
  }

  async switchChapter(selector) {
    this.requireChapter()
    this.chapter = resolveSelection(this.chapters, selector, '章节')
    this.lastProposal = null
    await this.persistSelection()
    this.printStatus()
  }

  async previewDraft() {
    this.requireChapter()
    const draft = await this.api.getDraft(this.project.id, this.chapter.id)
    const content = draft.content || ''
    if (!content) {
      this.print(this.theme.warning('当前章节还没有正文。'))
      return
    }
    const preview = content.length > 2400 ? `${content.slice(0, 2400)}\n\n…（共 ${content.length} 字符）` : content
    this.print(preview)
  }

  showHistory() {
    const messages = this.assistantSession?.messages || []
    if (!messages.length) {
      this.print(this.theme.dim('当前没有对话历史。'))
      return
    }
    for (const message of messages.slice(-12)) {
      const label = message.role === 'assistant' ? this.theme.accent('夜雨') : this.theme.dim('你')
      this.print(`${label}  ${extractAgentText(message)}`)
    }
  }

  async handleCommand(command) {
    const argument = command.argument
    switch (command.name) {
      case 'help':
        NOVEL_COMMANDS.forEach(([name, description]) => this.print(`${this.theme.accent(name.padEnd(28))}${description}`))
        return true
      case 'status': this.printStatus(); return true
      case 'projects': this.listProjects(); return true
      case 'use': await this.switchProject(argument); return true
      case 'chapters': this.listChapters(); return true
      case 'chapter': await this.switchChapter(argument); return true
      case 'skills': this.listSkills(); return true
      case 'tasks': await this.listTasks(); return true
      case 'task': await this.showTask(argument); return true
      case 'cancel': await this.cancelTask(argument); return true
      case 'retry': await this.retryTask(argument); return true
      case 'draft': await this.previewDraft(); return true
      case 'history': this.showHistory(); return true
      case 'apply': await this.applyProposal(); return true
      case 'undo': await this.undo(); return true
      case 'new':
        await this.api.clearAssistantSession()
        this.assistantSession = null
        this.lastProposal = null
        this.print(this.theme.success('已开始新的创作会话。'))
        return true
      case 'confirm': {
        const sessionPayload = await this.api.getAssistantSession()
        const session = sessionPayload.session
        if (!session?.proposal) throw new Error('当前没有待确认的建书方案')
        const created = await this.api.confirmAssistant(session.id, session.proposal)
        this.projects = (await this.api.getProjects()).projects || []
        await this.loadProject(created.project)
        this.print(this.theme.success(`《${created.project.title}》已创建并选中。`))
        return true
      }
      case 'write':
        this.requireChapter()
        await this.runSkill(skillForProject(this.project, 'write'), argument || '在不改变既定设定的前提下续写当前章节，强化冲突推进和章末钩子。返回包含现有正文在内的完整建议稿。', { writable: true })
        return true
      case 'review':
        this.requireChapter()
        await this.runSkill('story-review', argument || '审查当前章节，优先指出会影响读者继续阅读的问题。')
        return true
      case 'polish':
      case 'deslop':
        this.requireChapter()
        await this.runSkill('story-deslop', argument || '保留剧情、设定和人物声口，对当前章节去 AI 味。', { writable: true })
        return true
      case 'analyze':
        if (!this.project) throw new Error('请先选择作品')
        await this.runSkill(skillForProject(this.project, 'analyze'), argument || '分析当前作品的结构、人物动机和后续推进空间。')
        return true
      case 'scan':
        if (!this.project) throw new Error('请先选择作品')
        await this.runSkill(skillForProject(this.project, 'scan'), argument || '扫描当前作品的连续性、节奏和结构问题。')
        return true
      case 'search':
        if (!argument) throw new Error('请提供搜索关键词')
        await this.sendConversation(argument, { web_search: true })
        return true
      case 'skill': {
        const separator = argument.search(/\s/)
        const skill = separator === -1 ? argument : argument.slice(0, separator)
        const instruction = separator === -1 ? '' : argument.slice(separator).trim()
        if (!skill) throw new Error('用法：/skill <名称> <要求>')
        await this.runSkill(skill, instruction || `执行 ${skill}`)
        return true
      }
      case 'quit':
      case 'exit': return false
      default: throw new Error(`未知命令：/${command.name}，输入 /help 查看可用命令`)
    }
  }

  async runInteractive() {
    this.printBanner()
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let running = true
    rl.on('SIGINT', () => {
      if (this.activeTaskId) void this.cancelActiveTask().catch((error) => this.print(this.theme.error(errorText(error))))
      else rl.close()
    })
    while (running) {
      let input
      try {
        const context = this.chapter ? `${this.project.title}/${this.chapter.title}` : '新故事'
        input = await rl.question(`${this.theme.accent(context)} > `)
      } catch {
        break
      }
      const text = input.trim()
      if (!text) continue
      try {
        const command = parseSlashCommand(text)
        running = command ? await this.handleCommand(command) : (await this.sendConversation(text), true)
      } catch (error) {
        this.print(this.theme.error(errorText(error)))
      }
      if (running) this.print()
    }
    rl.close()
    this.print(this.theme.dim('会话已保存。'))
  }

  async runHeadless() {
    if (this.options.project) await this.switchProject(this.options.project)
    if (this.options.chapter) await this.switchChapter(this.options.chapter)
    let response
    if (this.options.skill) {
      response = await this.runSkill(this.options.skill, this.options.prompt, { quiet: this.options.json })
    } else {
      const payload = await this.buildPayload()
      response = await this.api.sendMessage(this.options.prompt, { payload })
    }
    if (this.options.json) this.print(JSON.stringify(response, null, 2))
    else if (!this.options.skill) this.renderResponse(response)
    return response.status === 'failed' || response.result?.status === 'failed' ? 1 : 0
  }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n\n${usage()}\n`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  try {
    const terminal = new NovelTerminal(options)
    await terminal.initialize()
    process.exitCode = options.prompt ? await terminal.runHeadless() : (await terminal.runInteractive(), 0)
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`)
    process.exitCode = 1
  }
}

await main()

export { NovelTerminal, parseArgs, readSecret }
