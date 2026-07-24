import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpDown,
  ArrowUpRight,
  AlignLeft,
  BookOpen,
  BookMarked,
  BookOpenCheck,
  BookPlus,
  Bot,
  BrainCircuit,
  Check,
  CheckSquare2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Copy,
  Clock3,
  Download,
  FileText,
  FolderOpen,
  Gem,
  Globe,
  Grid2X2,
  Highlighter,
  History,
  Image,
  Info,
  Italic,
  LayoutDashboard,
  Library,
  Lightbulb,
  List,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Maximize2,
  MessageCircle,
  Mail,
  Menu,
  Minimize2,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  PenLine,
  Pin,
  Plus,
  Redo2,
  Search,
  SearchCode,
  Send,
  Settings2,
  Sparkles,
  Split,
  Target,
  Tags,
  Trash2,
  Type,
  Undo2,
  UserRound,
  UsersRound,
  Users,
  Volume2,
  Wand2,
  WandSparkles,
  X,
  Zap,
} from 'lucide-react'
import { api } from './api'
import { buildEditHunks, composeAcceptedText } from './edit-proposal.mjs'

const ASSISTANT_NAME = '夜雨'
const SIDEBAR_COLLAPSED_KEY = 'story-studio-sidebar-collapsed'
const callableSkill = (skill) => skill?.status === 'ready' || skill?.status === 'needs_model'

const primaryNavItems = [
  { id: 'overview', label: '总览', icon: LayoutDashboard },
  { id: 'assistant', label: ASSISTANT_NAME, icon: MessageCircle },
  { id: 'works', label: '我的作品', icon: BookOpen },
  { id: 'library', label: '素材库', icon: Library },
]

const moreNavItems = [
  { id: 'toolkit', label: '高级工具', icon: Grid2X2 },
  { id: 'deconstruct', label: '拆文台', icon: BookOpenCheck },
]

const navItems = [...primaryNavItems, ...moreNavItems]

const editorFeatureActions = [
  { key: 'write', label: 'AI写作', tone: 'violet', icon: WandSparkles, skill: 'story', command: '结合当前作品设定，帮我继续规划并写作下一段。' },
  { key: 'continue', label: '续写', tone: 'blue', icon: PenLine, skill: 'story', command: '根据当前章节上下文续写，保持人物和叙事风格一致。' },
  { key: 'workflow', label: '写作计划', tone: 'teal', icon: Grid2X2, skill: 'story', command: '为当前章节整理从情节目标到正文推进的写作计划，先不要直接修改正文。' },
  { key: 'edit', label: '章节诊断', tone: 'green', icon: BrainCircuit, skill: 'story-review', command: '诊断当前章节的结构、人物和节奏问题，输出修改建议报告，不直接修改正文。' },
  { key: 'expand', label: 'AI扩写', tone: 'purple', icon: Maximize2, skill: 'story', command: '扩写当前选中的情节，增加细节、动作和情绪推进。' },
  { key: 'polish', label: '自然化润色', tone: 'green', icon: Wand2, skill: 'story-deslop', command: '对当前章节去 AI 味，让语言更自然、更像作者本人。' },
  { key: 'brainstorm', label: '灵感风暴', tone: 'orange', icon: Lightbulb, skill: 'story', command: '围绕当前章节生成 5 个可用的剧情转折和灵感。' },
  { key: 'proofread', label: '文字检查', tone: 'red', icon: CheckSquare2, skill: 'story-review', command: '检查当前章节的错别字、病句、逻辑和格式问题，输出纠错报告，不直接修改正文。' },
  { key: 'characters', label: '人物', tone: 'indigo', icon: UsersRound, tab: '人物' },
  { key: 'terms', label: '词条', tone: 'indigo', icon: Tags, tab: '词条' },
]

const authQuotes = [
  { chapter: '第 8 章', title: '风从旧码头来', text: '“她终于明白，潮水从来不是为了带走什么。它只是一次次回来，提醒岸边的人，时间仍在往前。”' },
  { chapter: '第 1 章', title: '雨落之前', text: '“故事往往从一个微不足道的决定开始，而命运只负责把它推向更远的地方。”' },
  { chapter: '第 17 章', title: '无人回信', text: '“他把最后一句话写在信里，等了很久，直到窗外的灯一盏一盏熄灭。”' },
  { chapter: '尾声', title: '仍在路上', text: '“写下去不是为了抵达结局，而是为了让此刻的心声，终于有一个可以回去的地方。”' },
]

// 每个 skill 的默认指令和功能标签
const skillMeta = {
  'story': { label: '智能创作路由', command: '我想写小说' },
  'story-long-write': { label: '长篇写作', command: '帮我规划并创作一本长篇小说', needsContent: false },
  'story-short-write': { label: '短篇写作', command: '帮我规划并创作一篇短篇小说', needsContent: false },
  'story-long-analyze': { label: '长篇正文分析', command: '分析我提供的长篇正文结构', needsContent: true },
  'story-short-analyze': { label: '短篇正文分析', command: '分析我提供的短篇正文结构', needsContent: true },
  'story-long-scan': { label: '长篇题材趋势', command: '分析长篇网文的题材与市场趋势；不要声称获取了实时榜单', needsContent: false },
  'story-short-scan': { label: '短篇题材趋势', command: '分析短篇网文的题材与市场趋势；不要声称获取了实时榜单', needsContent: false },
  'story-deslop': { label: '自然化润色', command: '对以下正文去 AI 味', needsContent: true },
  'story-review': { label: '章节诊断报告', command: '审查这一章并输出报告，不直接修改正文', needsContent: true },
  'story-import': { label: '粘贴文稿分析', command: '分析我粘贴的小说正文结构', needsContent: true },
  'story-setup': { label: '写作准备建议', command: '给我一份开始写书前的准备建议，不执行系统部署', needsContent: false },
}

// 需要正文的 skill
const contentSkills = new Set(['story-deslop', 'story-review', 'story-long-analyze', 'story-short-analyze', 'story-import'])

function formatNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN')
}

function formatRelativeTime(value, fallback = '刚刚') {
  if (!value) return fallback
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return fallback
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function toastKind(message) {
  const text = String(message || '')
  if (/正在|请稍候|读取中|载入中|保存中|导入中|导出中|创建中|删除中|分章中/.test(text)) return 'loading'
  if (/失败|错误|无效|不能为空|不存在|不可|不能|没有|未找到|暂不可|请先|已过期/.test(text)) return 'error'
  return 'success'
}

function sortIdeas(items) {
  return [...items].sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))
}

function parseNovelText(rawText) {
  const normalized = String(rawText || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []
  const headingPattern = /^(?:第.{1,16}[章回节卷部篇集](?:\s+|[:：、._-])?.*|(?:chapter|chap\.?)\s*\d+(?:\s+|[:：、._-])?.*|序章|楔子|前言|引子|尾声|后记|番外(?:\s*[一二三四五六七八九十百千万两\d]+)?.*)$/i
  const chapters = []
  const preface = []
  let current = null
  let foundHeading = false

  function pushCurrent() {
    if (!current) return
    chapters.push({ title: current.title.slice(0, 100), content: current.lines.join('\n').trim() })
  }

  for (const line of normalized.split('\n')) {
    const candidate = line.trim()
    if (candidate && candidate.length <= 100 && headingPattern.test(candidate)) {
      if (!foundHeading && preface.join('\n').trim()) chapters.push({ title: '前言', content: preface.join('\n').trim() })
      pushCurrent()
      current = { title: candidate, lines: [] }
      foundHeading = true
    } else if (current) {
      current.lines.push(line)
    } else {
      preface.push(line)
    }
  }
  pushCurrent()
  if (!foundHeading) return [{ title: '第一章', content: normalized }]
  return chapters.length ? chapters : [{ title: '第一章', content: normalized }]
}

function parseSmartProposal(response) {
  const source = response?.result || {}
  const raw = source.output ?? source
  let parsed = raw && typeof raw === 'object' ? raw : null
  if (!parsed && typeof raw === 'string') {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    try {
      parsed = JSON.parse(text)
    } catch {
      const objectText = text.match(/\{[\s\S]*\}/)?.[0]
      try { parsed = objectText ? JSON.parse(objectText) : null } catch { parsed = null }
      if (!parsed) {
        const title = text.match(/(?:书名|作品名|标题)\s*[:：]\s*[「『“"]?([^」』”"\n]+)/)?.[1]?.trim()
        const genre = text.match(/题材\s*[:：]\s*([^\n]+)/)?.[1]?.trim()
        const tone = text.match(/(?:主线|故事主线|核心冲突)\s*[:：]\s*([^\n]+)/)?.[1]?.trim()
        const chapters = [...text.matchAll(/(?:^|\n)\s*(第.{1,30}[章回节]|序章|楔子|番外[^\n]*)\s*[:：、-]?\s*([^\n]+)/g)].map((match) => ({ title: match[1].trim(), content: match[2].trim() }))
        parsed = { title, genre, tone, chapters }
      }
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  const title = String(parsed.title || parsed.book_title || parsed.bookName || parsed.name || '').trim()
  const type = String(parsed.type || parsed.length || '长篇').trim() === '短篇' ? '短篇' : '长篇'
  const genre = String(parsed.genre || parsed.category || parsed.type_name || '').trim()
  const style = String(parsed.style || parsed.school || parsed.trope || '').trim()
  const tone = String(parsed.tone || parsed.mainline || parsed.main_line || parsed.storyline || parsed.synopsis || parsed.summary || '').trim()
  const sourceChapters = parsed.chapters || parsed.outline || parsed.chapter_outline || parsed.chapterOutline || []
  const chapters = Array.isArray(sourceChapters) ? sourceChapters.map((chapter, index) => {
    if (typeof chapter === 'string') return { title: `第 ${index + 1} 章`, content: chapter.trim() }
    return {
      title: String(chapter?.title || chapter?.name || `第 ${index + 1} 章`).trim(),
      content: String(chapter?.content || chapter?.outline || chapter?.summary || chapter?.plot || '').trim(),
    }
  }).filter((chapter) => chapter.title && chapter.content) : []
  if (!title || !genre || !tone || !chapters.length) return null
  return { title: title.slice(0, 80), type, genre: genre.slice(0, 30), style: style.slice(0, 80), tone: tone.slice(0, 2000), chapters: chapters.slice(0, 100).map((chapter) => ({ title: chapter.title.slice(0, 100), content: chapter.content.slice(0, 5000) })) }
}

function App() {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [authMode, setAuthMode] = useState('login')
  const [authError, setAuthError] = useState('')
  const [activeSection, setActiveSection] = useState('overview')
  const [projects, setProjects] = useState([])
  const [activeProject, setActiveProject] = useState(null)
  const [chapters, setChapters] = useState([])
  const [activeChapterId, setActiveChapterId] = useState(null)
  const [ideas, setIdeas] = useState([])
  const [foreshadows, setForeshadows] = useState([])
  const [storyMemories, setStoryMemories] = useState([])
  const [dashboard, setDashboard] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const [importProjectOpen, setImportProjectOpen] = useState(false)
  const [importProjectLoading, setImportProjectLoading] = useState(false)
  const [showMobileMenu, setShowMobileMenu] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [toast, setToast] = useState('')
  const [skillCatalog, setSkillCatalog] = useState([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [reviewReport, setReviewReport] = useState(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewPlatform, setReviewPlatform] = useState('通用网文')
  const [runnerSkill, setRunnerSkill] = useState(null)
  const [runnerCommand, setRunnerCommand] = useState('')
  const [runnerContext, setRunnerContext] = useState(null)
  const [runnerOpen, setRunnerOpen] = useState(false)
  const [runnerLoading, setRunnerLoading] = useState(false)
  const [runnerResult, setRunnerResult] = useState(null)
  const [editorApplyRequest, setEditorApplyRequest] = useState(null)
  const [lastAiRestore, setLastAiRestore] = useState(null)
  const [deslopLoading, setDeslopLoading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [editProjectTarget, setEditProjectTarget] = useState(null)
  const [draft, setDraft] = useState('')
  const [draftStatus, setDraftStatus] = useState('saved')
  const [draftLoading, setDraftLoading] = useState(false)
  const [historySnapshots, setHistorySnapshots] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [smartProposal, setSmartProposal] = useState(null)
  const [smartCreateLoading, setSmartCreateLoading] = useState(false)
  const [writingAssistantSession, setWritingAssistantSession] = useState(null)
  const [writingAssistantLoading, setWritingAssistantLoading] = useState(false)
  const [aiTasks, setAiTasks] = useState([])
  const draftRef = useRef('')
  const savedDraftRef = useRef('')
  const activeDraftKeyRef = useRef('')
  const saveQueueRef = useRef(Promise.resolve())
  const skillSubmissionRef = useRef(null)

  useEffect(() => {
    let mounted = true
    api.restoreSession()
      .then((session) => { if (mounted) setUser(session?.user || null) })
      .catch(() => { if (mounted) setUser(null) })
      .finally(() => { if (mounted) setAuthLoading(false) })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    const handleExpired = () => {
      setUser(null)
      setAuthMode('login')
      setAuthError('登录已过期，请重新登录')
    }
    window.addEventListener('story-auth-expired', handleExpired)
    return () => window.removeEventListener('story-auth-expired', handleExpired)
  }, [])

  useEffect(() => {
    if (!user) return undefined
    let mounted = true
    Promise.all([api.getProjects(), api.getIdeas(), api.getForeshadows(), api.getStoryMemories(), api.getDashboard()])
      .then(([projectResponse, ideaResponse, foreshadowResponse, memoryResponse, dashboardResponse]) => {
        if (!mounted) return
        const nextProjects = projectResponse.projects || []
        setProjects(nextProjects)
        setActiveProject((current) => nextProjects.find((project) => project.id === current?.id) || nextProjects.find((project) => project.isActive) || nextProjects[0])
        if (ideaResponse.ideas) setIdeas(ideaResponse.ideas)
        setForeshadows(foreshadowResponse.foreshadows || [])
        setStoryMemories(memoryResponse.memories || [])
        setDashboard(dashboardResponse.stats || null)
      })
      .catch(() => {
        if (mounted) setToast('账号数据读取失败，请检查后端服务')
      })
    return () => { mounted = false }
  }, [user])

  useEffect(() => {
    if (!user) {
      setAiTasks([])
      return undefined
    }
    let mounted = true
    async function refreshTasks() {
      try {
        const response = await api.getAiTasks()
        if (mounted) setAiTasks(response.tasks || [])
      } catch {
        // Task history is supplementary; the editor remains usable if it is unavailable.
      }
    }
    void refreshTasks()
    const timer = window.setInterval(refreshTasks, 1800)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [user])

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed))
    } catch {
      // 浏览器禁用本地存储时仍可在当前会话使用折叠状态。
    }
  }, [sidebarCollapsed])

  useEffect(() => {
    if (!user) return undefined
    let mounted = true
    setSkillsLoading(true)
    api.getSkills()
      .then((response) => { if (mounted) setSkillCatalog(response.skills || []) })
      .catch(() => undefined)
      .finally(() => { if (mounted) setSkillsLoading(false) })
    return () => { mounted = false }
  }, [user])

  useEffect(() => {
    if (!user) {
      setWritingAssistantSession(null)
      return undefined
    }
    let mounted = true
    api.getWritingAssistantSession()
      .then((response) => { if (mounted) setWritingAssistantSession(response.session || null) })
      .catch(() => { if (mounted) setWritingAssistantSession(null) })
    return () => { mounted = false }
  }, [user])

  useEffect(() => {
    if (!user || !activeProject?.id) return undefined
    let mounted = true
    setDraftLoading(true)
    setActiveChapterId(null)
    setChapters([])
    setDraft('')
    draftRef.current = ''
    savedDraftRef.current = ''
    activeDraftKeyRef.current = ''
    setHistorySnapshots([])
    setHistoryLoading(false)
    api.getChapters(activeProject.id)
      .then(async (chapterResponse) => {
        let nextChapters = chapterResponse.chapters || []
        if (!nextChapters.length) {
          const created = await api.createChapter(activeProject.id, '第一章')
          nextChapters = [created.chapter]
        }
        if (!mounted) return
        setChapters(nextChapters)
        const nextChapter = nextChapters.find((chapter) => chapter.state === 'current') || nextChapters.reduce((latest, chapter) => String(chapter.updatedAt || '') > String(latest.updatedAt || '') ? chapter : latest, nextChapters[0])
        setActiveChapterId(nextChapter?.id ?? null)
      })
      .catch(() => {
        if (mounted) {
          setDraftLoading(false)
          setToast('作品数据读取失败，请检查后端服务')
        }
      })
    return () => { mounted = false }
  }, [activeProject?.id, user])

  useEffect(() => {
    if (!user || !activeProject?.id || activeChapterId == null) {
      setDraftLoading(false)
      return undefined
    }
    const key = `${activeProject.id}:${activeChapterId}`
    activeDraftKeyRef.current = key
    setDraftLoading(true)
    let mounted = true
    api.getChapterDraft(activeProject.id, activeChapterId)
      .then((response) => {
        if (!mounted || activeDraftKeyRef.current !== key) return
        const content = response.content || ''
        setDraft(content)
        draftRef.current = content
        savedDraftRef.current = content
        setDraftStatus('saved')
      })
      .catch((error) => {
        if (mounted) {
          setDraftStatus('error')
          setToast(error.message || '章节正文读取失败')
        }
      })
      .finally(() => { if (mounted && activeDraftKeyRef.current === key) setDraftLoading(false) })
    return () => { mounted = false }
  }, [activeChapterId, activeProject?.id, user])

  useEffect(() => {
    if (!user || !activeProject?.id || activeChapterId == null) {
      setHistorySnapshots([])
      setHistoryLoading(false)
      return undefined
    }
    let mounted = true
    setHistoryLoading(true)
    api.getChapterHistory(activeProject.id, activeChapterId)
      .then((response) => { if (mounted) setHistorySnapshots(response.snapshots || []) })
      .catch(() => { if (mounted) setHistorySnapshots([]) })
      .finally(() => { if (mounted) setHistoryLoading(false) })
    return () => { mounted = false }
  }, [activeChapterId, activeProject?.id, user])

  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  useEffect(() => {
    if (draftLoading || !activeProject?.id || activeChapterId == null || draft === savedDraftRef.current) return undefined
    const projectId = activeProject.id
    const chapterId = activeChapterId
    const content = draft
    const key = `${projectId}:${chapterId}`
    setDraftStatus('dirty')
    const timer = setTimeout(() => {
      if (activeDraftKeyRef.current === key) void persistDraft(projectId, chapterId, content, { silent: true })
    }, 1000)
    return () => clearTimeout(timer)
  }, [activeChapterId, activeProject?.id, draft, draftLoading])

  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(''), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    function handleKeydown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault()
        setSearchOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [])

  const currentProject = projects.find((project) => project.id === activeProject?.id) || projects[0] || null
  const activeChapter = useMemo(() => chapters.find((chapter) => String(chapter.id) === String(activeChapterId)) || null, [activeChapterId, chapters])
  const wordCount = useMemo(() => draft.replace(/\s/g, '').length, [draft])
  const hasUnsavedDraft = Boolean(currentProject?.id && activeChapterId != null && draft !== savedDraftRef.current)

  async function refreshSkills({ notifyResult = true } = {}) {
    if (skillsLoading) return false
    setSkillsLoading(true)
    try {
      const response = await api.getSkills()
      setSkillCatalog(response.skills || [])
      if (notifyResult) setToast('能力目录已刷新')
      return true
    } catch (error) {
      if (notifyResult) setToast(error.message || '能力目录刷新失败，已保留当前状态')
      return false
    } finally {
      setSkillsLoading(false)
    }
  }

  async function refreshDashboard() {
    try {
      const response = await api.getDashboard()
      setDashboard(response.stats || null)
    } catch {
      // 写作主流程不应被统计刷新阻断。
    }
  }

  async function persistDraft(projectId, chapterId, content, { silent = false } = {}) {
    const key = `${projectId}:${chapterId}`
    if (activeDraftKeyRef.current === key) setDraftStatus('saving')
    try {
      const request = saveQueueRef.current.catch(() => undefined).then(() => api.saveChapterDraft(projectId, chapterId, content))
      saveQueueRef.current = request
      const response = await request
      if (response.project) {
        setProjects((current) => current.map((project) => project.id === response.project.id ? response.project : project))
        setActiveProject((current) => current?.id === response.project.id ? response.project : current)
      }
      if (response.chapter) setChapters((current) => current.map((chapter) => String(chapter.id) === String(response.chapter.id) ? response.chapter : chapter))
      if (response.stats) setDashboard(response.stats)
      if (activeDraftKeyRef.current === key) {
        savedDraftRef.current = content
        setDraftStatus(draftRef.current === content ? 'saved' : 'dirty')
      }
      if (!silent) setToast('章节已保存')
      return response
    } catch (error) {
      if (activeDraftKeyRef.current === key) setDraftStatus('error')
      setToast(error.message)
      throw error
    }
  }

  async function openProject(project) {
    if (hasUnsavedDraft) {
      try {
        await saveDraft({ silent: true })
      } catch {
        return
      }
    }
    setActiveProject(project)
    setActiveSection('editor')
    setShowMobileMenu(false)
  }

  async function createProject(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const title = String(form.get('title') || '').trim()
    if (!title) return
    try {
      if (hasUnsavedDraft) await saveDraft({ silent: true })
      const response = await api.createProject({ title, type: String(form.get('type') || '长篇'), genre: String(form.get('genre') || '现代言情'), style: String(form.get('style') || '') })
      const project = response.project
      setProjects((current) => [project, ...current.map((item) => ({ ...item, isActive: false }))])
      setActiveProject(project)
      setShowNew(false)
      setActiveSection('editor')
      setToast('作品已创建，开始写下第一章吧')
      void refreshDashboard()
    } catch (error) {
      setToast(error.message)
    }
  }

  async function createSmartProject(proposal) {
    if (smartCreateLoading || !proposal?.chapters?.length) return
    setSmartCreateLoading(true)
    try {
      if (hasUnsavedDraft) await saveDraft({ silent: true })
      const response = proposal.assistantSessionId
        ? await api.confirmWritingAssistant(proposal.assistantSessionId, proposal)
        : await api.createSmartProject(proposal)
      setProjects((current) => [response.project, ...current.map((project) => ({ ...project, isActive: false }))])
      setActiveProject(response.project)
      setChapters(response.chapters || [])
      setActiveChapterId(response.chapters?.[0]?.id ?? null)
      if (proposal.assistantSessionId) setWritingAssistantSession((current) => current ? { ...current, phase: 'writing', projectId: response.project.id } : current)
      setSmartProposal(null)
      setActiveSection('editor')
      setToast(`已根据 AI 方案创建《${response.project.title}》`)
      void refreshDashboard()
    } catch (error) {
      setToast(error.message || '智能创建失败，原方案仍保留')
    } finally {
      setSmartCreateLoading(false)
    }
  }

  async function sendWritingAssistant(message, options = {}) {
    const text = String(message || '').trim()
    if (!text || writingAssistantLoading) return
    setWritingAssistantLoading(true)
    try {
      const response = await api.sendWritingAssistantMessage(text, options)
      setWritingAssistantSession(response.session || null)
      if (response.proposal) setSmartProposal({ ...response.proposal, assistantSessionId: response.session?.id })
      if (response.status === 'needs_model') setToast('需求已保存，请先在设置中配置模型')
      else if (response.status === 'failed') setToast(response.reply || '方案生成失败，请重试')
    } catch (error) {
      setToast(error.message || `${ASSISTANT_NAME}暂时不可用`)
    } finally {
      setWritingAssistantLoading(false)
    }
  }

  async function clearWritingAssistant() {
    if (writingAssistantLoading) return
    try {
      await api.clearWritingAssistantSession()
      setWritingAssistantSession(null)
      setSmartProposal(null)
    } catch (error) {
      setToast(error.message || '清理创作会话失败')
    }
  }

  async function importProject(data) {
    if (!data?.chapters?.length) return
    setImportProjectLoading(true)
    try {
      if (hasUnsavedDraft) await saveDraft({ silent: true })
      const response = await api.importProject(data)
      setProjects((current) => [response.project, ...current.map((project) => ({ ...project, isActive: false }))])
      setActiveProject(response.project)
      setChapters(response.chapters || [])
      setActiveChapterId(response.chapters?.[0]?.id ?? null)
      setImportProjectOpen(false)
      setActiveSection('editor')
      setToast(`已导入《${response.project.title}》· ${response.chapters?.length || 0} 章`)
      void refreshDashboard()
    } catch (error) {
      setToast(error.message || '导入失败')
    } finally {
      setImportProjectLoading(false)
    }
  }

  async function saveDraft({ silent = false } = {}) {
    if (!currentProject?.id || activeChapterId == null || draftLoading) return null
    if (draft === savedDraftRef.current) {
      setDraftStatus('saved')
      if (!silent) setToast('章节已是最新版本')
      return null
    }
    return persistDraft(currentProject.id, activeChapterId, draft, { silent })
  }

  function updateDraft(content) {
    setDraft(content)
    draftRef.current = content
    setDraftStatus(content === savedDraftRef.current ? 'saved' : 'dirty')
  }

  async function createChapter() {
    if (!currentProject?.id) return
    try {
      if (hasUnsavedDraft) await saveDraft({ silent: true })
      const nextNumber = chapters.reduce((max, chapter) => Math.max(max, Number(chapter.id) || 0), 0) + 1
      const response = await api.createChapter(currentProject.id, `第 ${nextNumber} 章`)
      setChapters((current) => [...current, response.chapter])
      setActiveChapterId(response.chapter.id)
      setToast('新章节已加入目录')
      void Promise.all([api.getProject(currentProject.id), api.getDashboard()]).then(([projectResponse, dashboardResponse]) => {
        if (projectResponse.project) {
          setProjects((current) => current.map((project) => project.id === projectResponse.project.id ? projectResponse.project : project))
          setActiveProject(projectResponse.project)
        }
        setDashboard(dashboardResponse.stats || null)
      }).catch(() => undefined)
    } catch (error) {
      setToast(error.message)
    }
  }

  async function splitChapter(position, title) {
    if (!currentProject?.id || activeChapterId == null) return false
    const splitAt = Number(position)
    const before = draft.slice(0, splitAt).trimEnd()
    const after = draft.slice(splitAt).trimStart()
    if (!before || !after) {
      setToast('拆分位置前后都需要有正文')
      return false
    }
    let createdChapter = null
    let currentChapterShortened = false
    try {
      const currentResponse = await persistDraft(currentProject.id, activeChapterId, before, { silent: true })
      currentChapterShortened = true
      const nextNumber = chapters.reduce((max, chapter) => Math.max(max, Number(chapter.id) || 0), 0) + 1
      const created = await api.createChapter(currentProject.id, title?.trim() || `第 ${nextNumber} 章`)
      createdChapter = created.chapter
      const nextResponse = await api.saveChapterDraft(currentProject.id, created.chapter.id, after)
      const currentChapter = currentResponse?.chapter
      const nextChapter = nextResponse?.chapter || created.chapter
      setChapters((current) => [...current.map((chapter) => String(chapter.id) === String(currentChapter?.id) ? currentChapter : chapter), nextChapter])
      if (nextResponse?.project) {
        setProjects((current) => current.map((project) => project.id === nextResponse.project.id ? nextResponse.project : project))
        setActiveProject(nextResponse.project)
      }
      if (nextResponse?.stats) setDashboard(nextResponse.stats)
      setDraft(before)
      draftRef.current = before
      savedDraftRef.current = before
      setDraftStatus('saved')
      setActiveChapterId(nextChapter.id)
      setToast(`已拆分并新建《${nextChapter.title}》`)
      return true
    } catch (error) {
      if (createdChapter?.id != null) {
        await api.deleteChapter(currentProject.id, createdChapter.id).catch(() => undefined)
      }
      if (currentChapterShortened) {
        await persistDraft(currentProject.id, activeChapterId, draft, { silent: true }).catch(() => undefined)
      }
      setToast(error.message || '拆分章节失败')
      return false
    }
  }

  async function selectChapter(chapter) {
    if (!chapter || String(chapter.id) === String(activeChapterId)) return
    try {
      if (hasUnsavedDraft) await saveDraft({ silent: true })
      setActiveChapterId(chapter.id)
    } catch {
      // 保存失败时留在当前章节，避免覆盖未保存内容。
    }
  }

  async function renameChapter(chapter, title) {
    if (!currentProject?.id) return
    try {
      const response = await api.updateChapter(currentProject.id, chapter.id, { title })
      setChapters((current) => current.map((c) => c.id === chapter.id ? response.chapter : c))
      setToast('章节已重命名')
    } catch (error) {
      setToast(error.message)
    }
  }

  async function updateChapterState(chapter, state) {
    if (!currentProject?.id) return
    try {
      const response = await api.updateChapter(currentProject.id, chapter.id, { state })
      setChapters((current) => current.map((item) => String(item.id) === String(chapter.id) ? response.chapter : item))
      setToast(state === 'done' ? '章节已标记完成' : '章节已恢复为草稿')
    } catch (error) {
      setToast(error.message)
    }
  }

  async function deleteChapter(chapter) {
    if (!currentProject?.id) return
    if (chapters.length <= 1) {
      setToast('每个作品至少保留一个章节')
      return
    }
    try {
      await api.deleteChapter(currentProject.id, chapter.id)
      const remaining = chapters.filter((item) => String(item.id) !== String(chapter.id))
      setChapters(remaining)
      if (String(activeChapterId) === String(chapter.id)) {
        const deletedIndex = chapters.findIndex((item) => String(item.id) === String(chapter.id))
        const nextChapter = remaining[Math.min(deletedIndex, remaining.length - 1)] || remaining.at(-1)
        setActiveChapterId(nextChapter?.id ?? null)
      }
      const [projectResponse, dashboardResponse] = await Promise.all([api.getProject(currentProject.id), api.getDashboard()])
      if (projectResponse.project) {
        setProjects((current) => current.map((project) => project.id === projectResponse.project.id ? projectResponse.project : project))
        setActiveProject(projectResponse.project)
      }
      setDashboard(dashboardResponse.stats || null)
      setToast('章节已删除')
    } catch (error) {
      setToast(error.message)
    }
  }

  async function createIdea(data) {
    try {
      const projectId = data && Object.prototype.hasOwnProperty.call(data, 'projectId') ? data.projectId : currentProject?.id
      const response = await api.createIdea({
        label: data?.label || '灵感',
        title: data?.title || '未命名灵感',
        body: data?.body || '记录下此刻的想法。',
        projectId: projectId || null,
        folder: data?.folder || '未分类',
        tags: data?.tags || [],
        pinned: data?.pinned === true,
      })
      setIdeas((current) => sortIdeas([response.idea, ...current]))
      setToast('新灵感卡已创建')
    } catch (error) {
      setToast(error.message)
    }
  }

  async function editIdea(idea, data) {
    try {
      const response = await api.updateIdea(idea.id, { title: data.title, body: data.body, label: data.label, projectId: data.projectId || null, folder: data.folder, tags: data.tags, pinned: data.pinned })
      setIdeas((current) => sortIdeas(current.map((i) => i.id === idea.id ? response.idea : i)))
      setToast('灵感卡已更新')
    } catch (error) {
      setToast(error.message)
    }
  }

  async function deleteIdea(idea) {
    try {
      await api.deleteIdea(idea.id)
      setIdeas((current) => current.filter((i) => i.id !== idea.id))
      setToast('灵感卡已删除')
    } catch (error) {
      setToast(error.message)
    }
  }

  async function createForeshadow(data) {
    try {
      const response = await api.createForeshadow({ ...data, projectId: data.projectId || currentProject?.id })
      setForeshadows((current) => [response.foreshadow, ...current])
      setToast('伏笔已加入作品')
      return response.foreshadow
    } catch (error) {
      setToast(error.message)
      return null
    }
  }

  async function updateForeshadow(foreshadow, updates) {
    try {
      const response = await api.updateForeshadow(foreshadow.id, updates)
      setForeshadows((current) => current.map((item) => item.id === foreshadow.id ? response.foreshadow : item))
      setToast('伏笔状态已更新')
      return response.foreshadow
    } catch (error) {
      setToast(error.message)
      return null
    }
  }

  async function deleteForeshadow(foreshadow) {
    try {
      await api.deleteForeshadow(foreshadow.id)
      setForeshadows((current) => current.filter((item) => item.id !== foreshadow.id))
      setToast('伏笔已删除')
      return true
    } catch (error) {
      setToast(error.message)
      return false
    }
  }

  async function editProject(project, updates) {
    try {
      const response = await api.updateProject(project.id, updates)
      setProjects((current) => current.map((p) => p.id === project.id ? response.project : p))
      if (activeProject?.id === project.id) setActiveProject(response.project)
      setToast('作品已更新')
      void refreshDashboard()
    } catch (error) {
      setToast(error.message)
    }
  }

  async function deleteProject(project) {
    try {
      await api.deleteProject(project.id)
      const remaining = projects.filter((p) => p.id !== project.id)
      setProjects(remaining)
      setForeshadows((current) => current.filter((item) => item.projectId !== project.id))
      if (activeProject?.id === project.id) {
        setActiveProject(remaining[0] || null)
        setActiveChapterId(null)
        setChapters([])
        setDraft('')
        draftRef.current = ''
        savedDraftRef.current = ''
      }
      setToast('作品已删除')
      void refreshDashboard()
      return true
    } catch (error) {
      setToast(error.message)
      return false
    }
  }

  async function deleteStoryMemory(memory) {
    try {
      await api.deleteStoryMemory(memory.id)
      setStoryMemories((current) => current.filter((item) => item.id !== memory.id))
      setToast('作品记忆已删除')
      return true
    } catch (error) {
      setToast(error.message || '删除作品记忆失败')
      return false
    }
  }

  async function updateStoryMemory(memory, updates) {
    try {
      const response = await api.updateStoryMemory(memory.id, updates)
      setStoryMemories((current) => current.map((item) => item.id === memory.id ? response.memory : item))
      setToast(response.memory.status === 'archived' ? '作品记忆已归档' : '作品记忆已更新')
      return response.memory
    } catch (error) {
      setToast(error.message || '更新作品记忆失败')
      return null
    }
  }

  async function confirmStoryMemories(candidates) {
    if (!currentProject?.id || !candidates.length) return false
    try {
      const response = await api.confirmStoryMemories(currentProject.id, candidates.map((candidate) => ({ ...candidate, characterName: candidate.characterName ?? candidate.character_name ?? '', replacesMemoryId: candidate.replacesMemoryId ?? candidate.replaces_memory_id ?? null, sourceChapterId: activeChapterId })))
      setStoryMemories((current) => [...response.created, ...response.updated, ...current.filter((item) => !response.updated.some((updated) => updated.id === item.id))])
      setToast(`已确认 ${response.created.length + response.updated.length} 条作品记忆`)
      return true
    } catch (error) {
      setToast(error.message || '确认作品记忆失败')
      return false
    }
  }

  async function createHistorySnapshot(content, options = {}) {
    if (!currentProject?.id || activeChapterId == null || typeof content !== 'string') return null
    const request = api.createChapterHistory(currentProject.id, activeChapterId, content)
    if (options.awaitSave) return request
    void request.catch(() => undefined)
    return null
  }

  async function reviewChapter(title = '未命名章节') {
    if (!draft.trim()) {
      setToast('先写一点正文，再开始章节审查')
      return
    }
    setReviewLoading(true)
    setToast('正在审查章节，请稍候')
    try {
      const response = await api.runStoryAgent({
        message: `使用 story-review 审查章节《${title}》`,
        skill: 'story-review',
        payload: { title, genre: currentProject?.genre || '网络小说', platform: reviewPlatform, mode: 'full', content: draft },
      })
      setReviewReport(response.result)
      setReviewOpen(true)
      setToast(`Skill 审稿完成 · ${response.result.verdict} · ${response.result.score} 分`)
    } catch (error) {
      setToast(error.message)
    } finally {
      setReviewLoading(false)
    }
  }

  function openSkillRunner(skill, command = '', context = null) {
    setRunnerSkill(skill)
    setRunnerCommand(command || skillMeta[skill]?.command || '')
    setRunnerContext(context)
    setRunnerResult(null)
    setRunnerOpen(true)
  }

  function applySkillOutput(content, mode, meta = {}) {
    const output = String(content || '').trim()
    if (!output || activeSection !== 'editor' || !currentProject?.id || activeChapterId == null) {
      setToast('当前没有可写入的章节')
      return
    }
    const selectionStart = Number(runnerContext?.selectionStart)
    const selectionEnd = Number(runnerContext?.selectionEnd)
    const hasSelection = runnerContext?.selectedText && Number.isFinite(selectionStart) && Number.isFinite(selectionEnd) && selectionEnd > selectionStart
    const sourceMatches = hasSelection
      ? draft.slice(selectionStart, selectionEnd) === runnerContext.selectedText
      : draft === (runnerContext?.sourceText ?? draft)
    if (String(runnerContext?.chapterId ?? '') !== String(activeChapterId) || !sourceMatches) {
      setToast('正文已发生变化，这份 AI 建议已过期，请重新运行 Skill')
      return
    }
    setEditorApplyRequest({ id: `${Date.now()}-${Math.random()}`, content: output, mode, context: runnerContext, meta })
    setRunnerOpen(false)
  }

  async function runSkill(skill, message, payload = {}) {
    if (skillSubmissionRef.current) return skillSubmissionRef.current
    const idempotencyKey = `${skill}:${payload.project_id || ''}:${payload.chapter_id || ''}:${Date.now()}`
    const request = (async () => {
      setRunnerLoading(true)
    setRunnerResult(null)
    setToast(`已提交 ${skillMeta[skill]?.label || skill} 任务`)
    try {
      const created = await api.createAiTask({ message, skill, payload, idempotencyKey })
      if (created.task.reused) setToast('已复用进行中的相同任务')
      setAiTasks((current) => [created.task, ...current.filter((task) => task.id !== created.task.id)].slice(0, 50))
      let task = created.task
      for (let attempt = 0; attempt < 240 && ['queued', 'running'].includes(task.status); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 700))
        const response = await api.getAiTask(task.id)
        task = response.task
        setAiTasks((current) => [task, ...current.filter((item) => item.id !== task.id)].slice(0, 50))
      }
      if (task.status === 'completed' && task.result) {
        setRunnerResult({ ...task.result, taskId: task.id })
        setToast(`${skillMeta[skill]?.label || skill} 执行完成 · ${task.result.status}`)
      } else {
        setRunnerResult({ status: task.status === 'cancelled' ? 'failed' : 'failed', result: { message: task.error || task.statusMessage || 'AI 任务未完成' }, selected_skill: skill, route: 'task' })
        setToast(task.status === 'cancelled' ? 'AI 任务已取消' : task.error || 'AI 任务执行失败')
      }
    } catch (error) {
      setRunnerResult({ status: 'failed', result: { message: error.message }, selected_skill: skill, route: 'error' })
      setToast(error.message)
    } finally {
      setRunnerLoading(false)
    }
    })()
    skillSubmissionRef.current = request
    try {
      return await request
    } finally {
      skillSubmissionRef.current = null
    }
  }

  async function retryAiTask(taskId) {
    try {
      const response = await api.retryAiTask(taskId)
      setAiTasks((current) => [response.task, ...current.filter((task) => task.id !== response.task.id)].slice(0, 50))
      setToast(`已重新提交任务 · 第 ${response.task.attempt || 2} 次`)
    } catch (error) {
      setToast(error.message || '重新提交 AI 任务失败')
    }
  }

  async function cancelAiTask(taskId) {
    try {
      const response = await api.cancelAiTask(taskId)
      setAiTasks((current) => [response.task, ...current.filter((task) => task.id !== taskId)])
    } catch (error) {
      setToast(error.message || '取消 AI 任务失败')
    }
  }

  async function deslopChapter() {
    if (!draft.trim()) {
      setToast('先写一点正文，再去 AI 味')
      return
    }
    setDeslopLoading(true)
    setToast('正在去 AI 味，请稍候')
    try {
      const response = await api.runStoryAgent({
        message: '对以下正文去 AI 味',
        skill: 'story-deslop',
        payload: { content: draft },
      })
      setRunnerSkill('story-deslop')
      setRunnerCommand('对以下正文去 AI 味')
      setRunnerContext({ chapterId: activeChapterId, chapterTitle: chapters.find((chapter) => String(chapter.id) === String(activeChapterId))?.title || '当前章节', selectionStart: draft.length, selectionEnd: draft.length, selectedText: '' })
      setRunnerResult(response)
      setRunnerOpen(true)
      setToast(`去 AI 味完成 · ${response.status}`)
    } catch (error) {
      setToast(error.message)
    } finally {
      setDeslopLoading(false)
    }
  }

  async function selectSection(id) {
    if (activeSection === 'editor' && id !== 'editor' && hasUnsavedDraft) {
      try {
        await saveDraft({ silent: true })
      } catch {
        return
      }
    }
    setActiveSection(id)
    setShowMobileMenu(false)
  }

  function notify(message) {
    setToast(message)
  }

  async function submitAuth(credentials) {
    setAuthError('')
    try {
      const response = authMode === 'register' ? await api.register(credentials) : await api.login(credentials)
      setUser(response.user)
      setActiveSection('overview')
    } catch (error) {
      setAuthError(error.message)
    }
  }

  async function logout() {
    if (hasUnsavedDraft) {
      try {
        await saveDraft({ silent: true })
      } catch {
        return
      }
    }
    await api.logout()
    setUser(null)
    setProjects([])
    setActiveProject(null)
    setActiveChapterId(null)
    setChapters([])
    setIdeas([])
    setDashboard(null)
    setDraft('')
    draftRef.current = ''
    savedDraftRef.current = ''
    activeDraftKeyRef.current = ''
    setDraftStatus('saved')
    setActiveSection('overview')
    setAuthMode('login')
  }

  if (authLoading) {
    return <div className="auth-loading"><div className="brand-mark"><span>叙</span></div><LoaderCircle size={20} className="spin" /><span>正在恢复创作空间</span></div>
  }

  if (!user) {
    return <AuthScreen mode={authMode} error={authError} onModeChange={(mode) => { setAuthMode(mode); setAuthError('') }} onSubmit={submitAuth} />
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`sidebar ${showMobileMenu ? 'is-open' : ''}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><span>叙</span></div>
          <div className="brand-copy">
            <div className="brand-name">叙事工坊</div>
            <div className="brand-subtitle">STORY STUDIO</div>
          </div>
          <button type="button" className="sidebar-collapse-button" aria-label={sidebarCollapsed ? '展开左侧栏' : '收起左侧栏'} title={sidebarCollapsed ? '展开左侧栏' : '收起左侧栏'} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}>
            {sidebarCollapsed ? <PanelRight size={16} /> : <PanelLeft size={16} />}
          </button>
        </div>

        <div className="sidebar-section-label">工作台</div>
        <nav className="primary-nav" aria-label="主导航">
          {primaryNavItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${activeSection === id ? 'active' : ''}`} aria-label={label} title={sidebarCollapsed ? label : undefined} onClick={() => selectSection(id)}>
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {id === 'library' && <span className="nav-count">{ideas.length}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-section-label more-label">更多</div>
        <nav className="primary-nav secondary-nav" aria-label="更多功能">
          {moreNavItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${activeSection === id ? 'active' : ''}`} aria-label={label} title={sidebarCollapsed ? label : undefined} onClick={() => selectSection(id)}>
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-section-label recent-label">最近打开</div>
        <div className="recent-projects">
          {projects.slice(0, 3).map((project) => (
            <button key={project.id} className="recent-project" onClick={() => openProject(project)}>
              <span className={`mini-cover ${project.cover}`} aria-hidden="true">{project.title.slice(0, 1)}</span>
              <span className="recent-project-name">{project.title}</span>
              {project.isActive && <span className="active-dot" />}
            </button>
          ))}
        </div>

        <div className="sidebar-bottom">
          <button className="nav-item" aria-label="设置" title={sidebarCollapsed ? '设置' : undefined} onClick={() => setSettingsOpen(true)}><Settings2 size={17} strokeWidth={1.8} /><span>设置</span></button>
          <button className="nav-item" aria-label="退出登录" title={sidebarCollapsed ? '退出登录' : undefined} onClick={logout}><LogOut size={17} strokeWidth={1.8} /><span>退出登录</span></button>
          <div className="profile-chip">
            <div className="avatar">{user.name.slice(0, 1)}</div>
            <div className="profile-copy"><strong>{user.name}</strong><span>{user.email}</span></div>
            <MoreHorizontal size={16} />
          </div>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <button className="mobile-menu-button icon-button" aria-label="打开菜单" onClick={() => setShowMobileMenu((open) => !open)} title="打开菜单"><Menu size={20} /></button>
          <div className="breadcrumbs">
            <span>工作台</span>
            {activeSection === 'editor' && <><ChevronRight size={14} /><span>{currentProject?.title}</span></>}
            {activeSection !== 'overview' && activeSection !== 'editor' && <><ChevronRight size={14} /><span>{navItems.find((item) => item.id === activeSection)?.label}</span></>}
          </div>
          <div className="topbar-actions">
            <button className="search-button" onClick={() => setSearchOpen(true)}><Search size={17} /><span>搜索</span><kbd>⌘ K</kbd></button>
            <button className="icon-button" aria-label="高级工具" onClick={() => selectSection('toolkit')} title="高级工具"><Grid2X2 size={18} /></button>
            <button className="primary-button top-new-button" onClick={() => setShowNew(true)}><Plus size={17} />新建作品</button>
          </div>
        </header>

        <div className="content-wrap">
          {activeSection === 'overview' && <Overview projects={projects} stats={dashboard} onOpen={openProject} onNew={() => setShowNew(true)} onNavigate={selectSection} />}
          {activeSection === 'assistant' && <WritingAssistantPage session={writingAssistantSession} loading={writingAssistantLoading} skills={skillCatalog} onSend={sendWritingAssistant} onClear={clearWritingAssistant} onReviewProposal={() => writingAssistantSession?.proposal && setSmartProposal({ ...writingAssistantSession.proposal, assistantSessionId: writingAssistantSession.id })} onOpenSettings={() => setSettingsOpen(true)} onNotify={notify} onOpenProject={(projectId) => { const project = projects.find((item) => item.id === projectId); if (project) openProject(project); else selectSection('works') }} />}
          {activeSection === 'editor' && currentProject && <Editor project={currentProject} chapters={chapters} activeChapter={activeChapter} ideas={ideas} foreshadows={foreshadows} storyMemories={storyMemories.filter((memory) => memory.projectId === currentProject.id)} onUpdateStoryMemory={updateStoryMemory} onDeleteStoryMemory={deleteStoryMemory} onConfirmStoryMemories={confirmStoryMemories} onCreateForeshadow={createForeshadow} onUpdateForeshadow={updateForeshadow} onDeleteForeshadow={deleteForeshadow} draft={draft} onDraftChange={updateDraft} draftStatus={draftStatus} draftLoading={draftLoading} wordCount={wordCount} historySnapshots={historySnapshots} historyLoading={historyLoading} onCreateHistory={createHistorySnapshot} lastAiRestore={lastAiRestore} onAiApplied={(snapshot) => setLastAiRestore(snapshot)} onAiRestored={() => setLastAiRestore(null)} onBack={() => selectSection('overview')} onNotify={notify} onSave={saveDraft} onReview={reviewChapter} reviewLoading={reviewLoading} reviewPlatform={reviewPlatform} onPlatformChange={setReviewPlatform} onDeslop={deslopChapter} deslopLoading={deslopLoading} onNewChapter={createChapter} onSplitChapter={splitChapter} onSelectChapter={selectChapter} onRenameChapter={renameChapter} onUpdateChapterState={updateChapterState} onDeleteChapter={deleteChapter} onOpenSkill={openSkillRunner} applyRequest={editorApplyRequest} onApplyRequestHandled={() => setEditorApplyRequest(null)} />}
          {activeSection === 'editor' && !currentProject && <div className="page inner-page"><div className="empty-state"><div className="empty-state-icon"><BookOpen size={28} /></div><h2>没有打开的作品</h2><p>从「我的作品」中选择一个作品开始写作。</p><button className="primary-button" onClick={() => selectSection('works')}><BookOpen size={17} />前往我的作品</button></div></div>}
          {activeSection === 'works' && <Works projects={projects} onOpen={openProject} onNew={() => setShowNew(true)} onEdit={(p) => setEditProjectTarget(p)} onDelete={deleteProject} onSmartCreate={() => selectSection('assistant')} onImport={() => setImportProjectOpen(true)} />}
          {activeSection === 'library' && <LibraryView ideas={ideas} onCreate={createIdea} onEditIdea={editIdea} onDeleteIdea={deleteIdea} projects={projects} />}
          {activeSection === 'deconstruct' && <Deconstruct onNotify={notify} onRunSkill={openSkillRunner} />}
          {activeSection === 'toolkit' && <Toolkit onNotify={notify} skills={skillCatalog} skillsLoading={skillsLoading} onRefreshSkills={refreshSkills} onRunSkill={openSkillRunner} onOpenSettings={() => setSettingsOpen(true)} onNavigate={selectSection} />}
        </div>
      </main>

      <div className="mobile-nav">
        {primaryNavItems.map(({ id, label, icon: Icon }) => (
          <button key={id} className={activeSection === id ? 'active' : ''} onClick={() => selectSection(id)}><Icon size={18} /><span>{label}</span></button>
        ))}
      </div>

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} onCreate={createProject} />}
      {importProjectOpen && <ImportProjectModal loading={importProjectLoading} onClose={() => !importProjectLoading && setImportProjectOpen(false)} onImport={importProject} />}
      {reviewOpen && reviewReport && <ReviewReport report={reviewReport} onClose={() => setReviewOpen(false)} />}
      {runnerOpen && runnerSkill && <SkillRunnerModal skill={runnerSkill} skills={skillCatalog} loading={runnerLoading} result={runnerResult} onClose={() => setRunnerOpen(false)} onRun={runSkill} draft={draft} initialMessage={runnerCommand} context={runnerContext} canApplyToDraft={activeSection === 'editor' && Boolean(currentProject?.id && activeChapterId != null)} onApplyOutput={applySkillOutput} smartCreateMode={runnerContext?.purpose === 'smart-create'} onUseSmartResult={(result) => { const proposal = parseSmartProposal(result); if (!proposal) { setToast('AI 结果缺少书名、题材、主线或章节大纲，请重新生成'); return } setSmartProposal(proposal); setRunnerOpen(false) }} />}
      {smartProposal && <SmartCreateModal proposal={smartProposal} loading={smartCreateLoading} onClose={() => !smartCreateLoading && setSmartProposal(null)} onCreate={createSmartProject} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} onNotify={notify} />}
      {searchOpen && <SearchModal projects={projects} chapters={chapters} ideas={ideas} onClose={() => setSearchOpen(false)} onOpenProject={openProject} onSelectChapter={selectChapter} onNavigate={selectSection} />}
      {editProjectTarget && <EditProjectModal project={editProjectTarget} onClose={() => setEditProjectTarget(null)} onSave={(updates) => { editProject(editProjectTarget, updates); setEditProjectTarget(null) }} />}
      <AiTaskTray tasks={aiTasks} onCancel={cancelAiTask} onRetry={retryAiTask} />
      {toast && <div className={`toast ${toastKind(toast)}`} role="status" aria-live="polite">{toastKind(toast) === 'loading' ? <LoaderCircle size={16} className="spin" /> : toastKind(toast) === 'error' ? <Info size={16} /> : <Check size={16} />}{toast}</div>}
    </div>
  )
}

function AiTaskTray({ tasks, onCancel, onRetry }) {
  const visible = tasks.filter((task) => ['queued', 'running'].includes(task.status) || task.createdAt && Date.now() - new Date(task.createdAt).getTime() < 90_000).slice(0, 4)
  if (!visible.length) return null
  return <aside className="ai-task-tray" aria-label="AI 任务"><div className="ai-task-tray-heading"><span><Clock3 size={14} />AI 任务</span><small>{visible.filter((task) => ['queued', 'running'].includes(task.status)).length} 进行中</small></div>{visible.map((task) => <div className="ai-task-item" key={task.id}><div className="ai-task-item-top"><strong>{task.skill || '智能路由'}</strong><span>{task.status === 'completed' ? '完成' : task.status === 'failed' ? '失败' : task.status === 'cancelled' ? '已取消' : `${task.progress || 0}%`}</span></div><p>{task.statusMessage || task.message}</p>{['queued', 'running'].includes(task.status) && <button type="button" className="icon-button small" aria-label="取消 AI 任务" title="取消 AI 任务" onClick={() => onCancel(task.id)}><X size={13} /></button>}{['failed', 'cancelled'].includes(task.status) && <button type="button" className="icon-button small task-retry-button" aria-label="重试 AI 任务" title="使用原参数重新提交" onClick={() => onRetry(task.id)}><Redo2 size={13} /></button>}<div className="ai-task-progress"><span style={{ width: `${Math.max(3, Number(task.progress) || 0)}%` }} /></div></div>)}</aside>
}

function AuthScreen({ mode, error, onModeChange, onSubmit }) {
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState('')
  const [quoteIndex, setQuoteIndex] = useState(0)
  const isRegister = mode === 'register'
  const quote = authQuotes[quoteIndex]

  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    if (reduceMotion) return undefined
    const timer = window.setInterval(() => setQuoteIndex((current) => (current + 1) % authQuotes.length), 6200)
    return () => window.clearInterval(timer)
  }, [])

  async function submit(event) {
    event.preventDefault()
    setLocalError('')
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') || '')
    if (isRegister && password !== String(form.get('confirmPassword') || '')) {
      setLocalError('两次输入的密码不一致')
      return
    }
    setSubmitting(true)
    await onSubmit({
      name: String(form.get('name') || ''),
      email: String(form.get('email') || ''),
      password,
    })
    setSubmitting(false)
  }

  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <div className="auth-brand">
          <div className="brand-mark"><span>叙</span></div>
          <div><div className="brand-name">叙事工坊</div><div className="brand-subtitle">STORY STUDIO</div></div>
        </div>
        <div className="auth-quote" aria-live="polite">
          <span className="section-overline">今日摘句 · {quote.title}</span>
          <div className="auth-quote-slide" key={`${quoteIndex}-${quote.title}`}>
            <blockquote>{quote.text}</blockquote>
            <div className="auth-quote-meta"><span>{quote.chapter}</span><span>{quote.title}</span></div>
          </div>
        </div>
        <div className="auth-progress-art" aria-hidden="true">
          {authQuotes.map((item, index) => <span className={index === quoteIndex ? 'active' : ''} key={item.title} />)}
        </div>
        <p className="auth-copyright">叙事工坊 · 你的故事只属于你</p>
      </section>

      <section className="auth-form-panel">
        <div className="auth-form-wrap">
          <div className="auth-mode" aria-label="认证方式">
            <button className={mode === 'login' ? 'active' : ''} onClick={() => onModeChange('login')}>登录</button>
            <button className={mode === 'register' ? 'active' : ''} onClick={() => onModeChange('register')}>注册</button>
          </div>
          <div className="auth-heading">
            <span className="section-overline">{isRegister ? '创建创作空间' : '欢迎回来'}</span>
            <h1>{isRegister ? '写下第一行。' : '继续你的故事。'}</h1>
            <p>{isRegister ? '建立账号后，作品会隔离保存在你的空间中。' : '登录后回到上次停笔的位置。'}</p>
          </div>
          <form className="auth-form" onSubmit={submit}>
            {isRegister && <label><span>昵称</span><div className="auth-input"><UserRound size={16} /><input name="name" autoComplete="name" placeholder="你的创作者昵称" required maxLength="40" /></div></label>}
            <label><span>邮箱</span><div className="auth-input"><Mail size={16} /><input name="email" type="email" autoComplete="email" placeholder="name@example.com" required maxLength="160" /></div></label>
            <label><span>密码</span><div className="auth-input"><LockKeyhole size={16} /><input name="password" type="password" autoComplete={isRegister ? 'new-password' : 'current-password'} placeholder="至少 8 个字符" required minLength="8" maxLength="128" /></div></label>
            {isRegister && <label><span>确认密码</span><div className="auth-input"><LockKeyhole size={16} /><input name="confirmPassword" type="password" autoComplete="new-password" placeholder="再次输入密码" required minLength="8" maxLength="128" /></div></label>}
            {(localError || error) && <div className="auth-error" role="alert">{localError || error}</div>}
            <button className="auth-submit" disabled={submitting} type="submit">{submitting ? <LoaderCircle size={17} className="spin" /> : <ArrowUpRight size={17} />}{submitting ? '请稍候' : isRegister ? '创建账号' : '进入工作台'}</button>
          </form>
          <p className="auth-security"><LockKeyhole size={13} />密码经过加盐哈希处理，登录会话可随时退出。</p>
        </div>
      </section>
    </main>
  )
}

function Overview({ projects, stats, onOpen, onNew, onNavigate }) {
  const active = projects.find((project) => project.isActive) || projects[0]
  const today = new Date()
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][today.getDay()]
  const dateLabel = `${today.getFullYear()} 年 ${today.getMonth() + 1} 月 ${today.getDate()} 日 · 星期${weekday}`
  const greeting = today.getHours() < 6 ? '夜深了，注意休息' : today.getHours() < 12 ? '早上好' : today.getHours() < 18 ? '下午好' : '晚上好'
  return (
    <div className="page overview-page">
      <section className="welcome-row">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" />{dateLabel}</div>
          <h1>{projects.length ? `${greeting}，继续写下去。` : `${greeting}，从第一本书开始。`}</h1>
          <p className="welcome-copy">{projects.length ? '回到正在推进的故事，或者先和夜雨理清下一步。' : '和夜雨聊聊你的想法，或手动建立第一部作品。'}</p>
        </div>
        <div className="welcome-actions">
          {active ? <><button className="secondary-button" onClick={() => onNavigate('assistant')}><MessageCircle size={16} />问问{ASSISTANT_NAME}</button><button className="primary-button" onClick={() => onOpen(active)}><PenLine size={17} />继续写作</button></> : <><button className="secondary-button" onClick={onNew}><BookPlus size={16} />手动新建</button><button className="primary-button" onClick={() => onNavigate('assistant')}><MessageCircle size={17} />和{ASSISTANT_NAME}开始构思</button></>}
        </div>
      </section>

      {!active ? (
        <section className="empty-state hero-empty">
          <div className="empty-state-icon"><BookOpen size={28} /></div>
          <h2>开始你的第一本书</h2>
          <p>告诉{ASSISTANT_NAME}你想写什么，它会选择合适的 Skill 并只追问真正影响下一步的信息。</p>
          <div className="empty-state-actions"><button className="primary-button" onClick={() => onNavigate('assistant')}><MessageCircle size={17} />和{ASSISTANT_NAME}开始构思</button><button className="secondary-button" onClick={onNew}><BookPlus size={16} />手动新建</button></div>
        </section>
      ) : (
        <>
          <section className="focus-section overview-focus-section">
            <div className="section-heading"><div><span className="section-overline">正在进行</span><h2>当前作品</h2></div><button className="text-button" onClick={() => onNavigate('works')}>查看全部 <ArrowUpRight size={15} /></button></div>
            <div className="focus-project">
              <div className={`large-cover ${active.cover}`}><span>{active.title}</span><i>STORY<br />NO. 01</i></div>
              <div className="focus-copy">
                <div className="tag-row"><span className="status-tag"><span className="status-pulse" />{active.status}</span><span className="muted-tag">{active.type} · {active.genre}</span></div>
                <h3>{active.title}</h3><p>{active.tone}</p>
                <div className="progress-line"><span style={{ width: `${active.progress}%` }} /></div>
                <div className="focus-metrics"><span><strong>{active.progress}%</strong> 完成度</span><span><strong>{active.words}</strong> 字</span><span>更新于 {formatRelativeTime(active.updatedAt, active.updated)}</span></div>
                <button className="dark-button" onClick={() => onOpen(active)}>继续写作 <ArrowUpRight size={16} /></button>
              </div>
              <div className="focus-side-note"><span className="note-label">下一章提示</span><p>继续推进当前章节的情节。</p><button className="icon-button small" aria-label="打开章节提示" onClick={() => onOpen(active)} title="打开章节提示"><ChevronRight size={16} /></button></div>
            </div>
          </section>

          <section className="dashboard-summary dashboard-stat-strip" aria-label="创作数据概览">
            <div className="summary-card"><span className="summary-icon coral"><FileText size={16} /></span><div><small>累计字数</small><strong>{formatNumber(stats?.totalWords)}</strong></div></div>
            <div className="summary-card"><span className="summary-icon teal"><PenLine size={16} /></span><div><small>今日新增</small><strong>{formatNumber(stats?.todayWords)}</strong></div></div>
            <div className="summary-card"><span className="summary-icon yellow"><BookOpen size={16} /></span><div><small>章节总数</small><strong>{formatNumber(stats?.chapterCount)}</strong></div></div>
            <div className="summary-card"><span className="summary-icon purple"><Clock3 size={16} /></span><div><small>本周活跃</small><strong>{formatNumber(stats?.activeDays)} 天</strong></div></div>
          </section>

          <section className="dashboard-grid overview-pulse-grid">
            <WritingPulse stats={stats} />
            <section className="overview-secondary-links" aria-label="工作区入口">
              <div className="section-heading compact"><div><span className="section-overline">工作区</span><h2>需要时再打开</h2></div></div>
              <div className="overview-link-list">
                <button onClick={() => onNavigate('library')}><span className="quick-action-icon teal"><Library size={16} /></span><span><strong>素材库</strong><small>人物、设定与灵感</small></span><ChevronRight size={15} /></button>
                <button onClick={() => onNavigate('toolkit')}><span className="quick-action-icon yellow"><Target size={16} /></span><span><strong>高级工具</strong><small>题材趋势、自然化润色与章节诊断</small></span><ChevronRight size={15} /></button>
                <button onClick={() => onNavigate('deconstruct')}><span className="quick-action-icon purple"><BookOpenCheck size={16} /></span><span><strong>拆文台</strong><small>分析所提供参考正文的结构</small></span><ChevronRight size={15} /></button>
              </div>
            </section>
          </section>

          <section className="recent-section"><div className="section-heading compact"><div><span className="section-overline">作品空间</span><h2>最近的作品</h2></div><button className="text-button" onClick={() => onNavigate('works')}>管理作品 <ArrowUpRight size={15} /></button></div><div className="project-grid">{projects.map((project) => <ProjectCard key={project.id} project={project} onOpen={onOpen} />)}</div></section>
        </>
      )}
    </div>
  )
}

function WritingAssistantPage({ session, loading, skills, onSend, onClear, onReviewProposal, onOpenSettings, onNotify, onOpenProject }) {
  const [input, setInput] = useState('')
  const [selectedSkill, setSelectedSkill] = useState('')
  const [webSearch, setWebSearch] = useState(false)
  const [model, setModel] = useState('')
  const [modelList, setModelList] = useState([])
  const [modelLoading, setModelLoading] = useState(false)
  const [modelSaving, setModelSaving] = useState(false)
  const conversationRef = useRef(null)
  const requirements = session?.requirements || {}
  const messages = session?.messages || []
  const questions = session?.questions || []
  const hasStarted = messages.length > 0
  const needsModel = messages.at(-1)?.role === 'assistant' && messages.at(-1)?.text?.includes('配置模型')
  const availableSkills = (skills || []).filter((item) => item.name !== 'story' && callableSkill(item))
  const starterPrompts = [
    '我想写一本小说',
    '我想写一个现代都市故事',
    '帮我构思一个悬疑短篇',
  ]

  useEffect(() => {
    if (selectedSkill && !availableSkills.some((item) => item.name === selectedSkill)) setSelectedSkill('')
  }, [availableSkills, selectedSkill])

  useEffect(() => {
    let mounted = true
    api.getSettings()
      .then((response) => { if (mounted) setModel(response.settings?.model || '') })
      .catch(() => undefined)
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    const node = conversationRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [messages, loading, session?.phase])

  async function loadModels() {
    if (modelLoading || modelList.length) return
    setModelLoading(true)
    try {
      const response = await api.getModels()
      setModelList(response.models || [])
    } catch (error) {
      onNotify(error.message || '获取模型列表失败')
    } finally {
      setModelLoading(false)
    }
  }

  async function changeModel(nextModel) {
    setModel(nextModel)
    setModelSaving(true)
    try {
      await api.updateSettings({ model: nextModel })
      onNotify(`已切换全局模型：${nextModel}`)
    } catch (error) {
      onNotify(error.message || '切换模型失败')
    } finally {
      setModelSaving(false)
    }
  }

  function send(message) {
    const options = {}
    if (selectedSkill) options.skill = selectedSkill
    if (webSearch) options.web_search = true
    onSend(message, options)
  }

  function submit(event) {
    event?.preventDefault()
    const message = input.trim()
    if (!message || loading) return
    setInput('')
    send(message)
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit(event)
    }
  }

  return (
    <div className="page assistant-page">
      <div className="assistant-chat-shell">
        <header className="assistant-chat-header">
          <div className="assistant-chat-title">
            <span className="assistant-chat-mark"><Bot size={18} /></span>
            <div>
              <small>统一 AI 创作入口</small>
              <h1>{ASSISTANT_NAME}</h1>
            </div>
          </div>
          <div className="assistant-chat-actions">
            {session && <button className="text-button" disabled={loading} onClick={onClear}>{session.phase === 'writing' ? '开始另一本' : '新对话'}</button>}
          </div>
        </header>

        <div className="assistant-chat-stream" ref={conversationRef} aria-live="polite">
          {!hasStarted && !loading && (
            <div className="assistant-chat-empty">
              <div className="assistant-chat-empty-icon"><Bot size={28} /></div>
              <h2>从一个想法开始</h2>
              <p>描述你的目标。我会自动选择合适的 Skill；信息不足时，会像计划模式一样只确认真正影响下一步的内容。</p>
              <div className="assistant-chat-starters">
                {starterPrompts.map((item) => <button type="button" key={item} disabled={loading} onClick={() => send(item)}>{item}</button>)}
              </div>
            </div>
          )}

          {messages.map((message) => (
            <div className={`assistant-chat-message ${message.role}`} key={message.id}>
              <div className="assistant-chat-avatar" aria-hidden="true">{message.role === 'assistant' ? <Bot size={15} /> : <UserRound size={15} />}</div>
              <div className="assistant-chat-bubble"><p>{message.text}</p></div>
            </div>
          ))}

          {questions.length > 0 && !loading && session?.phase !== 'awaiting_confirmation' && (
            <div className="assistant-plan-questions">
              {questions.map((question) => (
                <section className="assistant-plan-question" key={question.id}>
                  <span>需要确认</span>
                  <h3>{question.question}</h3>
                  {question.options?.length > 0 && <div>{question.options.map((option) => <button type="button" key={option.value} onClick={() => send(option.value)}><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</button>)}</div>}
                </section>
              ))}
            </div>
          )}

          {loading && (
            <div className="assistant-chat-message assistant loading">
              <div className="assistant-chat-avatar" aria-hidden="true"><LoaderCircle size={15} className="spin" /></div>
              <div className="assistant-chat-bubble"><p>正在理解目标并规划下一步…</p></div>
            </div>
          )}
        </div>

        <div className="assistant-chat-composer">
          {session?.phase === 'awaiting_confirmation' && session.proposal && <button type="button" className="dark-button assistant-chat-proposal" onClick={onReviewProposal}><BookOpenCheck size={16} />查看并确认建书方案</button>}
          {needsModel && <button type="button" className="secondary-button assistant-chat-settings" onClick={onOpenSettings}><Settings2 size={15} />配置模型</button>}
          {session?.phase === 'writing' && session.projectId && <div className="assistant-chat-complete"><p><Check size={15} />作品已创建，可以进入编辑器继续写作。</p><button type="button" className="primary-button" onClick={() => onOpenProject(session.projectId)}><PenLine size={15} />打开作品</button></div>}

          {session?.phase !== 'writing' && (
            <>
              <form className="assistant-chat-form" onSubmit={submit}>
                <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKeyDown} rows={1} maxLength={4000} disabled={loading || session?.phase === 'awaiting_confirmation'} placeholder={hasStarted ? '继续补充，或直接提出新的创作任务…' : '描述你的创作目标…'} aria-label="输入创作想法" />
                <button type="submit" className="assistant-send" disabled={loading || !input.trim()} aria-label="发送创作想法" title="发送"><Send size={16} /></button>
              </form>
              <div className="assistant-composer-tools">
                <button type="button" className={`composer-toggle ${webSearch ? 'active' : ''}`} aria-pressed={webSearch} title={webSearch ? '已开启联网搜索：夜雨会先检索再回答' : '开启后夜雨会先联网检索再回答'} onClick={() => setWebSearch((value) => !value)}><Globe size={13} /><span>联网搜索</span></button>
                <label title="自动选择或强制指定 Skill"><Wand2 size={13} /><select value={selectedSkill} onChange={(event) => setSelectedSkill(event.target.value)}><option value="">自动选择 Skill</option>{availableSkills.map((item) => <option key={item.name} value={item.name}>{skillMeta[item.name]?.label || item.name}</option>)}</select></label>
                <label title="切换后同步到全局设置"><Bot size={13} /><select value={model} disabled={modelSaving} onFocus={loadModels} onChange={(event) => changeModel(event.target.value)}><option value="">{modelLoading ? '读取模型中…' : '选择模型'}</option>{model && !modelList.includes(model) && <option value={model}>{model}</option>}{modelList.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
              </div>
            </>
          )}
          <p className="assistant-chat-hint">Enter 发送 · Shift+Enter 换行 · 模型切换同步全局设置</p>
        </div>
      </div>
    </div>
  )
}

function WritingPulse({ stats }) {
  const daily = stats?.daily?.length ? stats.daily : Array.from({ length: 7 }, (_, index) => ({ date: `empty-${index}`, words: 0 }))
  const maxWords = Math.max(...daily.map((item) => Number(item.words) || 0), 1)
  const growth = stats?.growthPercent
  const firstDate = /^\d{4}-\d{2}-\d{2}$/.test(daily[0]?.date || '') ? new Date(`${daily[0].date}T00:00:00`) : null
  const lastDate = /^\d{4}-\d{2}-\d{2}$/.test(daily.at(-1)?.date || '') ? new Date(`${daily.at(-1).date}T00:00:00`) : null
  return <div className="pulse-panel"><div className="section-heading compact"><div><span className="section-overline">本周写作</span><h2>{stats?.weekWords ? '保持住这个节奏' : '从今天开始积累'}</h2></div><span className="tiny-meta">活跃 {stats?.activeDays || 0} 天</span></div><div className="pulse-number"><strong>{formatNumber(stats?.weekWords)}</strong><span>字</span>{growth != null && <em className={growth < 0 ? 'negative' : ''}><ArrowUpRight size={13} />{growth > 0 ? '+' : ''}{growth}%</em>}</div><div className="bar-chart" aria-label="近七天写作字数图表">{daily.map((item, index) => <span key={item.date} style={{ height: `${Math.max(6, Math.round((Number(item.words || 0) / maxWords) * 100))}%` }} className={index === daily.length - 1 ? 'today' : ''} title={`${item.date} · ${formatNumber(item.words)} 字`} />)}</div><div className="chart-labels"><span>{firstDate ? `${firstDate.getMonth() + 1}/${firstDate.getDate()}` : '7 天前'}</span><span>今天</span><span>{lastDate ? `${lastDate.getMonth() + 1}/${lastDate.getDate()}` : '今天'}</span></div></div>
}

function ProjectCard({ project, onOpen }) {
  return <button className="project-card" onClick={() => onOpen(project)}><div className={`card-cover ${project.cover}`}><span>{project.title.slice(0, 1)}</span></div><div className="card-content"><div className="card-topline"><span>{project.type}</span><MoreHorizontal size={15} /></div><h3>{project.title}</h3><p>{project.genre}</p><div className="card-footer"><span>{project.words} 字</span><span>{project.progress}%</span></div><div className="mini-progress"><span style={{ width: `${project.progress}%` }} /></div></div></button>
}

function Editor({ project, chapters, activeChapter, ideas, foreshadows = [], storyMemories = [], onUpdateStoryMemory, onDeleteStoryMemory, onConfirmStoryMemories, onCreateForeshadow, onUpdateForeshadow, onDeleteForeshadow, draft, onDraftChange, draftStatus, draftLoading, wordCount, historySnapshots = [], historyLoading = false, onCreateHistory, lastAiRestore = null, onAiApplied, onAiRestored, onBack, onNotify, onSave, onReview, reviewLoading, reviewPlatform, onPlatformChange, onDeslop, deslopLoading, onNewChapter, onSplitChapter, onSelectChapter, onRenameChapter, onUpdateChapterState, onDeleteChapter, onOpenSkill, applyRequest, onApplyRequestHandled }) {
  const [menuOpenId, setMenuOpenId] = useState(null)
  const [renameTarget, setRenameTarget] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [ideaPickerOpen, setIdeaPickerOpen] = useState(false)
  const [foreshadowOpen, setForeshadowOpen] = useState(false)
  const [foreshadowTarget, setForeshadowTarget] = useState(null)
  const [railTab, setRailTab] = useState('目录')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [readingMode, setReadingMode] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(true)
  const [mobileRailOpen, setMobileRailOpen] = useState(false)
  const [chapterOrder, setChapterOrder] = useState('asc')
  const [unfinishedOnly, setUnfinishedOnly] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [frequencyOpen, setFrequencyOpen] = useState(false)
  const [splitOpen, setSplitOpen] = useState(false)
  const [splitPosition, setSplitPosition] = useState(0)
  const [splitTitle, setSplitTitle] = useState('')
  const [splitLoading, setSplitLoading] = useState(false)
  const [memoryReviewOpen, setMemoryReviewOpen] = useState(false)
  const [memoryCandidates, setMemoryCandidates] = useState([])
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryEditing, setMemoryEditing] = useState(null)
  const [exportingBook, setExportingBook] = useState(false)
  const [assistantInput, setAssistantInput] = useState('')
  const [assistantMessages, setAssistantMessages] = useState([])
  const [, setHistoryVersion] = useState(0)
  const historyRef = useRef({ past: [], future: [] })
  const historyTimerRef = useRef(null)
  const historyPendingRef = useRef(null)
  const textareaRef = useRef(null)
  const displayChapter = activeChapter || chapters.at(-1) || { id: 1, title: '第一章', words: '0' }
  const activeIndex = Math.max(0, chapters.findIndex((chapter) => String(chapter.id) === String(displayChapter.id)))
  const visibleChapters = useMemo(() => [...chapters]
    .filter((chapter) => !unfinishedOnly || chapter.state !== 'done' || String(chapter.id) === String(displayChapter.id))
    .sort((left, right) => chapterOrder === 'asc' ? Number(left.id) - Number(right.id) : Number(right.id) - Number(left.id)), [chapterOrder, chapters, displayChapter.id, unfinishedOnly])
  const statusText = {
    saved: '已自动保存',
    dirty: '有未保存更改',
    saving: '正在自动保存',
    error: '保存失败，点击重试',
  }[draftStatus] || '已自动保存'

  useEffect(() => {
    if (historyTimerRef.current) {
      window.clearTimeout(historyTimerRef.current)
      historyTimerRef.current = null
    }
    historyRef.current = { past: [], future: [] }
    historyPendingRef.current = null
    setHistoryVersion((version) => version + 1)
    setSearchOpen(false)
    setSearchQuery('')
    setAssistantMessages([])
  }, [displayChapter.id])

  useEffect(() => {
    if (historyLoading) return
    historyRef.current = {
      past: historySnapshots.map((snapshot) => snapshot.content).filter((content) => typeof content === 'string').slice(-40),
      future: [],
    }
    setHistoryVersion((version) => version + 1)
  }, [displayChapter.id, historyLoading])

  useEffect(() => {
    function handleSaveShortcut(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void onSave()
      }
    }
    window.addEventListener('keydown', handleSaveShortcut)
    return () => window.removeEventListener('keydown', handleSaveShortcut)
  }, [onSave])

  useEffect(() => () => {
    if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current)
  }, [])

  useEffect(() => {
    if (!applyRequest?.id || draftLoading) return
    const content = String(applyRequest.content || '').trim()
    if (!content) {
      onApplyRequestHandled?.()
      return
    }
    let cancelled = false
    async function apply() {
      const contextMatches = String(applyRequest.context?.chapterId ?? '') === String(displayChapter.id)
      const requestedStart = contextMatches ? Number(applyRequest.context?.selectionStart) : draft.length
      const requestedEnd = contextMatches ? Number(applyRequest.context?.selectionEnd) : requestedStart
      const start = Number.isFinite(requestedStart) ? Math.min(Math.max(0, requestedStart), draft.length) : draft.length
      const end = Number.isFinite(requestedEnd) ? Math.min(Math.max(start, requestedEnd), draft.length) : start
      const hasSelection = end > start && Boolean(applyRequest.context?.selectedText)
      const sourceMatches = contextMatches && (hasSelection
        ? draft.slice(start, end) === applyRequest.context.selectedText
        : draft === (applyRequest.context?.sourceText ?? draft))
      if (!sourceMatches) {
        onApplyRequestHandled?.()
        onNotify('正文已发生变化，这份 AI 建议已过期')
        return
      }
      try {
        await onCreateHistory?.(draft, { awaitSave: true })
      } catch {
        onNotify('应用前快照保存失败，已取消修改')
        onApplyRequestHandled?.()
        return
      }
      if (cancelled) return
      let next = content
      let cursor = content.length
      if (applyRequest.mode !== 'replace') {
        const insertingAtEnd = start === draft.length && end === draft.length
        const separator = insertingAtEnd && draft.trim() && !draft.endsWith('\n') ? '\n\n' : ''
        next = `${draft.slice(0, start)}${separator}${content}${draft.slice(end)}`
        cursor = start + separator.length + content.length
      }
      const before = draft
      commitDraftChange(next)
      onAiApplied?.({ chapterId: displayChapter.id, content: before, taskId: applyRequest.meta?.taskId || null })
      onApplyRequestHandled?.()
      requestAnimationFrame(() => {
        const textarea = textareaRef.current
        if (!textarea) return
        textarea.focus()
        textarea.setSelectionRange(cursor, cursor)
      })
      onNotify(applyRequest.mode === 'replace' ? 'AI 结果已替换当前正文，可一键恢复' : end > start ? 'AI 修改已应用，可一键恢复' : 'AI 结果已插入正文，可一键恢复')
    }
    void apply()
    return () => { cancelled = true }
  }, [applyRequest?.id, draftLoading])

  function startRename(chapter) {
    setRenameTarget(chapter)
    setRenameValue(chapter.title)
    setMenuOpenId(null)
  }

  async function selectEditorChapter(chapter) {
    setMobileRailOpen(false)
    await onSelectChapter?.(chapter)
  }

  async function confirmRename(event) {
    event.preventDefault()
    const title = renameValue.trim()
    if (!title || !renameTarget) return
    await onRenameChapter?.(renameTarget, title)
    setRenameTarget(null)
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    await onDeleteChapter?.(deleteTarget)
    setDeleteTarget(null)
  }

  function applyFormat(prefix, suffix = prefix) {
    const textarea = textareaRef.current
    if (!textarea || draftLoading) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = draft.slice(start, end)
    const next = `${draft.slice(0, start)}${prefix}${selected}${suffix}${draft.slice(end)}`
    commitDraftChange(next)
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.selectionStart = start + prefix.length
      textarea.selectionEnd = end + prefix.length
    })
  }

  function rememberDraft(previous) {
    if (previous === undefined || historyRef.current.past.at(-1) === previous) return
    historyRef.current.past = [...historyRef.current.past, previous].slice(-40)
    historyRef.current.future = []
    setHistoryVersion((version) => version + 1)
    onCreateHistory?.(previous)
  }

  function flushPendingHistory() {
    if (historyTimerRef.current) {
      window.clearTimeout(historyTimerRef.current)
      historyTimerRef.current = null
    }
    if (historyPendingRef.current !== null) {
      rememberDraft(historyPendingRef.current)
      historyPendingRef.current = null
    }
  }

  function commitDraftChange(next) {
    if (next === draft) return
    flushPendingHistory()
    rememberDraft(draft)
    onDraftChange(next)
  }

  function handleDraftInput(next) {
    if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current)
    if (historyPendingRef.current === null) historyPendingRef.current = draft
    onDraftChange(next)
    historyTimerRef.current = window.setTimeout(() => {
      rememberDraft(historyPendingRef.current)
      historyPendingRef.current = null
      historyTimerRef.current = null
    }, 650)
  }

  function handleEditorKeyDown(event) {
    if (event.isComposing || !(event.ctrlKey || event.metaKey)) return
    const key = event.key.toLowerCase()
    if (key === 'z' && event.shiftKey) {
      event.preventDefault()
      redoDraft()
      return
    }
    if (key === 'y') {
      event.preventDefault()
      redoDraft()
      return
    }
    if (key === 'z') {
      event.preventDefault()
      undoDraft()
    }
  }

  function undoDraft() {
    flushPendingHistory()
    const previous = historyRef.current.past.pop()
    if (previous === undefined) {
      onNotify('没有可撤销的编辑')
      return
    }
    historyRef.current.future.push(draft)
    setHistoryVersion((version) => version + 1)
    onDraftChange(previous)
  }

  function redoDraft() {
    flushPendingHistory()
    const next = historyRef.current.future.pop()
    if (next === undefined) {
      onNotify('没有可重做的编辑')
      return
    }
    historyRef.current.past.push(draft)
    setHistoryVersion((version) => version + 1)
    onDraftChange(next)
  }

  function insertMaterial(idea) {
    const textarea = textareaRef.current
    const start = textarea?.selectionStart ?? draft.length
    const end = textarea?.selectionEnd ?? start
    const leading = start > 0 && !draft.slice(0, start).endsWith('\n') ? '\n\n' : ''
    const content = `${leading}${idea.body}`
    const next = `${draft.slice(0, start)}${content}${draft.slice(end)}`
    commitDraftChange(next)
    setIdeaPickerOpen(false)
    requestAnimationFrame(() => {
      if (!textarea) return
      textarea.focus()
      textarea.selectionStart = textarea.selectionEnd = start + content.length
    })
    onNotify(`已插入素材《${idea.title}》`)
  }

  async function copyChapter() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(draft)
      onNotify('本章正文已复制')
    } catch {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.select()
      document.execCommand('copy')
      onNotify('本章正文已复制')
    }
  }

  function selectAllText() {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus()
    textarea.select()
    onNotify('已选中本章全文')
  }

  function autoFormatChapter() {
    const formatted = draft.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (formatted === draft) {
      onNotify('当前正文已经是整洁格式')
      return
    }
    commitDraftChange(formatted)
    onNotify('已完成自动排版')
  }

  function readChapterAloud() {
    if (!draft.trim()) {
      onNotify('本章还没有正文')
      return
    }
    if (!('speechSynthesis' in window)) {
      onNotify('当前浏览器不支持朗读')
      return
    }
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(draft))
    onNotify('已开始朗读本章')
  }

  function jumpToSearch(direction = 1) {
    const query = searchQuery.trim()
    const textarea = textareaRef.current
    if (!query || !textarea) return
    const source = draft.toLowerCase()
    const needle = query.toLowerCase()
    let index = direction < 0
      ? source.lastIndexOf(needle, Math.max(0, textarea.selectionStart - 1))
      : source.indexOf(needle, textarea.selectionEnd)
    if (index < 0) index = direction < 0 ? source.lastIndexOf(needle) : source.indexOf(needle)
    if (index < 0) {
      onNotify(`没有找到「${query}」`)
      return
    }
    textarea.focus()
    textarea.setSelectionRange(index, index + query.length)
  }

  function openSplitDialog() {
    if (!draft.trim()) {
      onNotify('先写一点正文，再按光标拆分章节')
      return
    }
    const textarea = textareaRef.current
    const selectedPosition = textarea?.selectionStart || 0
    const fallbackPosition = Math.floor(draft.length / 2)
    const paragraphBreaks = [...draft.matchAll(/\n{2,}/g)].map((match) => Number(match.index) + match[0].length).filter((position) => position > 0 && position < draft.length)
    const nearestParagraph = paragraphBreaks.reduce((nearest, position) => Math.abs(position - fallbackPosition) < Math.abs(nearest - fallbackPosition) ? position : nearest, fallbackPosition)
    const position = selectedPosition > 0 && selectedPosition < draft.length ? selectedPosition : nearestParagraph
    const nextNumber = chapters.reduce((max, chapter) => Math.max(max, Number(chapter.id) || 0), 0) + 1
    setSplitPosition(position)
    setSplitTitle(`第 ${nextNumber} 章`)
    setSplitOpen(true)
  }

  async function confirmSplit(event) {
    event.preventDefault()
    if (!splitTitle.trim() || !onSplitChapter) return
    setSplitLoading(true)
    const success = await onSplitChapter(splitPosition, splitTitle)
    setSplitLoading(false)
    if (success) setSplitOpen(false)
  }

  function restoreHistory(snapshot) {
    if (snapshot === undefined || snapshot === draft) return
    flushPendingHistory()
    const snapshotIndex = historyRef.current.past.lastIndexOf(snapshot)
    if (snapshotIndex >= 0) {
      const newerSnapshots = [...historyRef.current.past.slice(snapshotIndex + 1), draft].reverse()
      historyRef.current.past = historyRef.current.past.slice(0, snapshotIndex)
      historyRef.current.future = newerSnapshots
    } else {
      historyRef.current.future.push(draft)
    }
    setHistoryVersion((version) => version + 1)
    onDraftChange(snapshot)
    setHistoryOpen(false)
    onNotify('已恢复这次编辑快照')
  }

  const frequentWords = useMemo(() => {
    if (!draft.trim()) return []
    const counts = new Map()
    try {
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
        for (const part of segmenter.segment(draft)) {
          const word = String(part.segment || '').trim()
          if (part.isWordLike && word.length >= 2 && /[\u3400-\u9fffA-Za-z]/.test(word)) counts.set(word, (counts.get(word) || 0) + 1)
        }
      }
    } catch {
      // 浏览器没有 Intl.Segmenter 时使用下面的简易切分。
    }
    if (!counts.size) {
      for (const word of draft.match(/[\u3400-\u9fff]{2,4}/g) || []) counts.set(word, (counts.get(word) || 0) + 1)
    }
    return [...counts.entries()].filter(([, count]) => count > 1).sort((left, right) => right[1] - left[1] || right[0].length - left[0].length).slice(0, 16)
  }, [draft])

  function locateFrequentWord(word) {
    const index = draft.toLowerCase().indexOf(String(word).toLowerCase())
    if (index < 0) return
    setFrequencyOpen(false)
    setSearchOpen(true)
    setSearchQuery(word)
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(index, index + word.length)
    })
  }

  async function extractMemories() {
    if (!project?.id || !displayChapter?.id || !draft.trim() || memoryLoading) {
      if (!draft.trim()) onNotify('先写一点正文，再整理本章记忆')
      return
    }
    setMemoryLoading(true)
    try {
      const response = await api.extractChapterMemories(project.id, displayChapter.id)
      if (response.status !== 'completed') {
        onNotify(response.message || '作品记忆整理未完成')
        return
      }
      setMemoryCandidates((response.candidates || []).map((candidate, index) => ({ ...candidate, id: `candidate-${index}`, selected: true })))
      setMemoryReviewOpen(true)
    } catch (error) {
      onNotify(error.message || '作品记忆整理失败')
    } finally {
      setMemoryLoading(false)
    }
  }

  async function saveMemoryCandidates() {
    const selected = memoryCandidates.filter((candidate) => candidate.selected).map(({ id, selected, ...candidate }) => candidate)
    if (!selected.length) {
      onNotify('请至少选择一条候选记忆')
      return
    }
    setMemoryLoading(true)
    const saved = await onConfirmStoryMemories?.(selected)
    setMemoryLoading(false)
    if (saved) setMemoryReviewOpen(false)
  }

  function updateMemoryCandidate(id, field, value) {
    setMemoryCandidates((current) => current.map((candidate) => candidate.id === id ? { ...candidate, [field]: value } : candidate))
  }

  function openEditorSkill(skill, command) {
    const textarea = textareaRef.current
    const selectionStart = textarea?.selectionStart ?? draft.length
    const selectionEnd = textarea?.selectionEnd ?? selectionStart
    onOpenSkill?.(skill, command, {
      projectId: project.id,
      projectType: project.type,
      genre: project.genre,
      style: project.style || '',
      premise: project.tone || '',
      preferredWritingSkill: project.type === '短篇' ? 'story-short-write' : 'story-long-write',
      chapterId: displayChapter.id,
      chapterTitle: displayChapter.title,
      selectionStart,
      selectionEnd,
      selectedText: draft.slice(selectionStart, selectionEnd).slice(0, 20000),
      sourceText: draft,
    })
  }

  function submitAssistant(event, quickMessage = '') {
    event?.preventDefault()
    const message = String(quickMessage || assistantInput).trim()
    if (!message) return
    setAssistantMessages((current) => [...current.slice(-3), { id: `${Date.now()}-${current.length}`, text: message }])
    setAssistantInput('')
    openEditorSkill('story', message)
  }

  function exportChapter() {
    const filename = `${project?.title || '章节'} - ${displayChapter.title || '未命名'}.txt`
    const blob = new Blob([draft], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(url)
    onNotify('章节已导出为 TXT')
  }

  async function exportProject() {
    if (!project?.id || !chapters.length || exportingBook) return
    setExportingBook(true)
    onNotify('正在整理全书正文')
    try {
      if (draftStatus !== 'saved') await onSave({ silent: true })
      const drafts = await Promise.all(chapters.map((chapter) => api.getChapterDraft(project.id, chapter.id)))
      const content = chapters.map((chapter, index) => `${chapter.title}\n\n${drafts[index]?.content || ''}`.trimEnd()).join('\n\n\n')
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${project.title || '未命名作品'} - 全书.txt`
      anchor.click()
      URL.revokeObjectURL(url)
      onNotify(`已导出全书 · ${chapters.length} 章`)
    } catch (error) {
      onNotify(error.message || '全书导出失败')
    } finally {
      setExportingBook(false)
    }
  }

  const readMinutes = Math.max(1, Math.round(wordCount / 400))
  const saveBusy = draftStatus === 'saving'
  const matchedIdeas = ideas.filter((idea) => idea.projectId === project?.id || !idea.projectId)
  const projectForeshadows = foreshadows.filter((item) => item.projectId === project?.id)
  const characterIdeas = matchedIdeas.filter((idea) => /人物|角色|主角|配角/.test(`${idea.label}${idea.title}`))
  const termIdeas = matchedIdeas.filter((idea) => /词条|设定|世界|地点|规则/.test(`${idea.label}${idea.title}`))
  const anchorIdeas = matchedIdeas.filter((idea) => idea.pinned || /剧情|冲突|场景|线索|锚点/.test(`${idea.label}${idea.title}${(idea.tags || []).join('')}`)).slice(0, 4)
  const searchCount = searchQuery.trim() ? (draft.toLowerCase().match(new RegExp(searchQuery.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length : 0
  const splitBefore = draft.slice(0, splitPosition).trim()
  const splitAfter = draft.slice(splitPosition).trim()

  function openForeshadowEditor(target = null) {
    setForeshadowTarget(target)
    setForeshadowOpen(true)
  }

  return <>
    <div className={`page editor-page ${readingMode ? 'reading-mode' : ''} ${assistantOpen ? '' : 'assistant-hidden'}`}>
      <div className="editor-topline">
        <button className="back-button" onClick={onBack}><ArrowLeft size={17} />返回工作台</button>
        {lastAiRestore && String(lastAiRestore.chapterId) === String(displayChapter.id) && <button className="ai-restore-button" onClick={() => { commitDraftChange(lastAiRestore.content); onAiRestored?.(); onNotify('已恢复应用 AI 修改前的正文') }}><Undo2 size={14} />恢复 AI 修改前正文</button>}
        <button className="editor-status" onClick={() => draftStatus === 'error' && onSave()} title={draftStatus === 'error' ? '点击重试保存' : statusText}>
          <span className={draftStatus === 'saved' ? 'saved-dot' : 'unsaved-dot'} />{draftLoading ? '正在载入章节' : statusText}
        </button>
        <div className="editor-actions">
          <button className="icon-button" aria-label="导出本章" title="导出本章" onClick={exportChapter}><Download size={17} /></button>
          <button className="icon-button" aria-label="导出全书" title="导出全书" disabled={exportingBook || draftLoading} onClick={exportProject}>{exportingBook ? <LoaderCircle size={17} className="spin" /> : <BookOpen size={17} />}</button>
          <button className="dark-button save-button" disabled={draftLoading || saveBusy} onClick={() => onSave()}>{saveBusy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{saveBusy ? '保存中' : '保存'}</button>
        </div>
      </div>

      <div className="editor-feature-strip" aria-label="AI写作工具">
        {editorFeatureActions.map(({ key, label, tone, icon: Icon, skill, command, tab }) => (
          <button key={key} className={`editor-feature-button ${tone}`} onClick={() => tab ? setRailTab(tab) : openEditorSkill(skill, command)} title={tab ? `打开${tab}` : command}>
            <Icon size={14} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="editor-heading">
        <div><span className="section-overline">{project?.title} · 第 {displayChapter.id} 章</span><h1>{displayChapter.title}</h1></div>
        <div className="chapter-progress"><span>{chapters.length ? activeIndex + 1 : 0} / {chapters.length}</span><div><span style={{ width: `${chapters.length ? ((activeIndex + 1) / chapters.length) * 100 : 0}%` }} /></div><button type="button" className="mobile-chapter-button" onClick={() => setMobileRailOpen(true)}><List size={14} />章节</button></div>
      </div>

      <div className="editor-layout">
        {mobileRailOpen && <button type="button" className="mobile-rail-scrim" aria-label="关闭章节目录" onClick={() => setMobileRailOpen(false)} />}
        <aside className={`chapter-rail ${mobileRailOpen ? 'mobile-open' : ''}`}>
          <div className="rail-tabs" role="tablist" aria-label="作品资料">
            {[
              { label: '目录', icon: List },
              { label: '大纲', icon: BookMarked },
              { label: '人物', icon: UsersRound },
              { label: '词条', icon: Tags },
              { label: '记忆', icon: BrainCircuit },
              { label: '伏笔', icon: Pin },
            ].map(({ label, icon: Icon }) => <button key={label} role="tab" aria-selected={railTab === label} className={railTab === label ? 'active' : ''} onClick={() => setRailTab(label)}><Icon size={13} /><span>{label}</span></button>)}
          </div>
          <div className="rail-header"><strong>{railTab === '目录' ? `章节目录 · ${chapters.length}` : railTab === '伏笔' ? `伏笔 · ${projectForeshadows.length}` : railTab === '记忆' ? `作品记忆 · ${storyMemories.filter((item) => item.status !== 'archived').length}` : railTab}</strong><div className="rail-header-actions">{railTab === '目录' && <><button className="icon-button small" aria-label="打开章节大纲" title="打开章节大纲" onClick={() => setOutlineOpen(true)}><BookOpen size={15} /></button><button className={`icon-button small ${unfinishedOnly ? 'active' : ''}`} aria-label="只看未完成章节" title={unfinishedOnly ? '显示全部章节' : '只看未完成章节'} onClick={() => setUnfinishedOnly((value) => !value)}><CheckSquare2 size={15} /></button><button className="icon-button small" aria-label="切换章节排序" title={chapterOrder === 'asc' ? '当前正序，点击倒序' : '当前倒序，点击正序'} onClick={() => setChapterOrder((order) => order === 'asc' ? 'desc' : 'asc')}><ArrowUpDown size={15} /></button></>}<button className="icon-button small" aria-label={railTab === '目录' ? '新建章节' : railTab === '伏笔' ? '新增伏笔' : railTab === '记忆' ? '整理本章记忆' : '新增资料'} title={railTab === '目录' ? '新建章节' : railTab === '伏笔' ? '新增伏笔' : railTab === '记忆' ? '整理本章记忆' : '新增资料'} onClick={() => railTab === '目录' ? onNewChapter() : railTab === '伏笔' ? openForeshadowEditor() : railTab === '记忆' ? extractMemories() : setIdeaPickerOpen(true)}>{railTab === '记忆' && memoryLoading ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}</button><button type="button" className="icon-button small mobile-rail-close" aria-label="关闭章节目录" onClick={() => setMobileRailOpen(false)}><X size={16} /></button></div></div>
          {railTab === '目录' && <div className="chapter-list">
            {visibleChapters.map((chapter) => {
              const current = String(chapter.id) === String(displayChapter.id)
              return <div key={chapter.id} className={`chapter-item-wrap ${current ? 'current' : ''}`}>
                <button className={`chapter-item ${current ? 'current' : ''}`} onClick={() => selectEditorChapter(chapter)} disabled={draftLoading && !current}>
                  <span className="chapter-number">{String(chapter.id).padStart(2, '0')}</span>
                  <span className="chapter-name">{chapter.title}</span>
                  <span className="chapter-words">{chapter.words} 字 · {chapter.state === 'done' ? '已完成' : '草稿'}</span>
                </button>
                <button className="chapter-menu-btn" aria-label="章节操作" title="章节操作" onClick={(event) => { event.stopPropagation(); setMenuOpenId(menuOpenId === chapter.id ? null : chapter.id) }}><MoreHorizontal size={14} /></button>
                {menuOpenId === chapter.id && <div className="chapter-menu" role="menu"><button onClick={() => startRename(chapter)}>重命名</button><button onClick={() => { onUpdateChapterState?.(chapter, chapter.state === 'done' ? 'draft' : 'done'); setMenuOpenId(null) }}>{chapter.state === 'done' ? '恢复为草稿' : '标记为完成'}</button><button className="danger" onClick={() => { setDeleteTarget(chapter); setMenuOpenId(null) }}>删除</button></div>}
              </div>
            })}
          </div>}
          {railTab === '大纲' && <div className="rail-outline-list">{chapters.length ? chapters.map((chapter) => <button key={chapter.id} onClick={() => selectEditorChapter(chapter)}><span>{String(chapter.id).padStart(2, '0')}</span><strong>{chapter.title}</strong><small>{chapter.words} 字</small></button>) : <p className="rail-empty">还没有章节大纲。</p>}</div>}
          {railTab === '人物' && <div className="rail-entity-list">{characterIdeas.length ? characterIdeas.map((idea) => <button key={idea.id} onClick={() => insertMaterial(idea)}><span className="entity-dot coral" /><span><strong>{idea.title}</strong><small>{idea.body.slice(0, 42)}</small></span></button>) : <div className="rail-empty-block"><UsersRound size={22} /><p>还没有人物卡</p><button onClick={() => setIdeaPickerOpen(true)}>从素材库添加</button></div>}</div>}
          {railTab === '词条' && <div className="rail-entity-list">{termIdeas.length ? termIdeas.map((idea) => <button key={idea.id} onClick={() => insertMaterial(idea)}><span className="entity-dot teal" /><span><strong>{idea.title}</strong><small>{idea.body.slice(0, 42)}</small></span></button>) : <div className="rail-empty-block"><Tags size={22} /><p>还没有设定词条</p><button onClick={() => setIdeaPickerOpen(true)}>从素材库添加</button></div>}</div>}
          {railTab === '记忆' && <div className="rail-memory-list">{storyMemories.filter((item) => item.status !== 'archived').length ? storyMemories.filter((item) => item.status !== 'archived').map((memory) => <button key={memory.id} className="rail-memory-item" onClick={() => setMemoryEditing(memory)}><span className={`memory-type-dot ${memory.type}`} /><span><strong>{memory.title}</strong><small>{memory.characterName ? `${memory.characterName} · ` : ''}{memory.content.slice(0, 46)}</small></span><em>{memory.importance || 3}</em></button>) : <div className="rail-empty-block"><BrainCircuit size={22} /><p>还没有确认的作品记忆</p><button onClick={extractMemories} disabled={memoryLoading}>{memoryLoading ? '整理中…' : '整理本章记忆'}</button></div>}</div>}
          {railTab === '伏笔' && <div className="rail-foreshadow-list">{projectForeshadows.length ? projectForeshadows.map((item) => <button key={item.id} className="rail-foreshadow-item" onClick={() => openForeshadowEditor(item)}><span className={`foreshadow-status-dot ${item.status}`} /><span className="rail-foreshadow-copy"><strong>{item.title}</strong><small>{item.category || '未分类'} · {item.status === 'resolved' ? '已回收' : item.status === 'planted' ? '已埋入' : item.status === 'abandoned' ? '已放弃' : '计划中'}</small></span><span className="foreshadow-importance" title={`重要性 ${item.importance || 3}`}>{item.importance || 3}</span></button>) : <div className="rail-empty-block"><Pin size={22} /><p>还没有登记伏笔</p><button onClick={() => openForeshadowEditor()}>新增第一个伏笔</button></div>}</div>}
          {railTab === '目录' && <button className="outline-link" onClick={() => setOutlineOpen(true)}><List size={15} />打开完整大纲</button>}
        </aside>

        <section className="writing-canvas">
          <div className="writing-toolbar">
            <div className="toolbar-group">
              <button className="toolbar-button" aria-label="撤销" title="撤销" onClick={undoDraft} disabled={!historyRef.current.past.length}><Undo2 size={15} /></button>
              <button className="toolbar-button" aria-label="重做" title="重做" onClick={redoDraft} disabled={!historyRef.current.future.length}><Redo2 size={15} /></button>
              <button className="toolbar-button" aria-label="历史记录" title="历史记录" onClick={() => setHistoryOpen(true)}><History size={15} /></button>
            </div>
            <span className="toolbar-divider" />
            <div className="toolbar-group">
              <button className="toolbar-button active" aria-label="正文样式" title="正文样式" disabled><Type size={16} /></button>
              <button className="toolbar-button" aria-label="加粗" title="为选中文字添加 Markdown 加粗" onClick={() => applyFormat('**')}><strong>B</strong></button>
              <button className="toolbar-button" aria-label="斜体" title="为选中文字添加 Markdown 斜体" onClick={() => applyFormat('_')}><Italic size={16} /></button>
            </div>
            <span className="toolbar-divider" />
            <div className="toolbar-group">
              <button className="toolbar-button" aria-label="复制全文" title="复制全文" onClick={copyChapter}><Copy size={15} /></button>
              <button className="toolbar-button" aria-label="全选" title="全选 (Ctrl+A)" onClick={selectAllText}><CheckSquare2 size={15} /></button>
              <button className={`toolbar-button ${searchOpen ? 'active' : ''}`} aria-label="搜索正文" title="搜索正文" onClick={() => setSearchOpen((open) => !open)}><SearchCode size={15} /></button>
              <button className="toolbar-button" aria-label="快捷插入" title="快捷插入素材" onClick={() => setIdeaPickerOpen(true)}><Zap size={15} /></button>
            </div>
            <span className="toolbar-divider" />
            <div className="toolbar-group">
              <button className="toolbar-button" aria-label="高频词分析" title="高频词分析" onClick={() => frequentWords.length ? setFrequencyOpen(true) : onNotify('当前正文还没有可分析的重复词')}><Highlighter size={15} /></button>
              <button className="toolbar-button" aria-label="自动排版" title="自动排版" onClick={autoFormatChapter}><AlignLeft size={15} /></button>
              <button className="toolbar-button" aria-label="按光标拆章" title="按光标拆章（本地操作）" onClick={openSplitDialog}><Split size={15} /></button>
              <button className="toolbar-button" aria-label="朗读本章" title="朗读本章" onClick={readChapterAloud}><Volume2 size={15} /></button>
            </div>
            <span className="toolbar-spacer" />
            <div className="toolbar-group toolbar-group-end">
              <button className={`toolbar-button ${readingMode ? 'active' : ''}`} aria-label={readingMode ? '退出阅读模式' : '阅读模式'} title={readingMode ? '退出阅读模式' : '阅读模式'} onClick={() => setReadingMode((mode) => !mode)}>{readingMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
              <button className="toolbar-button danger-toolbar" aria-label="清空本章" title="清空本章" onClick={() => setClearOpen(true)}><Trash2 size={15} /></button>
            </div>
            <div className="skill-review-controls">
              <select className="skill-platform-select" aria-label="审稿平台" value={reviewPlatform} onChange={(event) => onPlatformChange(event.target.value)}><option>通用网文</option><option>番茄</option><option>起点</option><option>知乎盐言</option></select>
              <button className="skill-deslop-button" disabled={deslopLoading || draftLoading} onClick={onDeslop} title="对当前正文去 AI 味">{deslopLoading ? <LoaderCircle size={15} className="spin" /> : <Zap size={15} />}<span>{deslopLoading ? '去味中' : '去 AI 味'}</span></button>
              <button className="skill-review-button" disabled={reviewLoading || draftLoading} onClick={() => onReview(displayChapter.title)}>{reviewLoading ? <LoaderCircle size={15} className="spin" /> : <BrainCircuit size={15} />}<span>{reviewLoading ? '审稿中' : 'Skill 审稿'}</span></button>
            </div>
          </div>
          {searchOpen && <div className="editor-searchbar"><Search size={14} /><input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); jumpToSearch(event.shiftKey ? -1 : 1) } }} placeholder="搜索本章正文…" aria-label="搜索本章正文" /><span>{searchCount ? `${searchCount} 处` : searchQuery ? '未找到' : '输入关键词'}</span><button className="icon-button small" aria-label="上一个搜索结果" title="上一个" onClick={() => jumpToSearch(-1)}><ChevronLeft size={15} /></button><button className="icon-button small" aria-label="下一个搜索结果" title="下一个" onClick={() => jumpToSearch(1)}><ChevronRight size={15} /></button><button className="icon-button small" aria-label="关闭搜索" title="关闭搜索" onClick={() => { setSearchOpen(false); setSearchQuery('') }}><X size={14} /></button></div>}
          <div className="writing-body">
            {draftLoading && <div className="writing-loading"><LoaderCircle size={19} className="spin" /><span>正在载入章节正文</span></div>}
            <textarea ref={textareaRef} value={draft} onChange={(event) => handleDraftInput(event.target.value)} onKeyDown={handleEditorKeyDown} disabled={draftLoading} spellCheck="false" aria-label="章节正文" placeholder="开始写下这一章的正文…" />
            <div className="writing-footer"><span><FileText size={14} />{wordCount.toLocaleString()} 字</span><span><Clock3 size={14} />预计阅读 {readMinutes} 分钟</span><span className="footer-hint">Ctrl / ⌘ + S 保存 · Z 撤销</span></div>
          </div>
        </section>

        <aside className={`insight-rail ${assistantOpen ? '' : 'collapsed'}`}>
          {assistantOpen ? <>
            <div className="assistant-panel-heading"><div className="assistant-title"><Bot size={16} /><strong>{ASSISTANT_NAME}</strong><span>Chat</span></div><button className="icon-button small" aria-label={`收起${ASSISTANT_NAME}`} title={`收起${ASSISTANT_NAME}`} onClick={() => setAssistantOpen(false)}><PanelRight size={15} /></button></div>
            <div className="assistant-welcome"><strong>{ASSISTANT_NAME}已就位。</strong><p>今天想改剧情、磨人物，还是直接开写？</p></div>
            <div className="assistant-quick-actions">
              <button onClick={(event) => submitAssistant(event, '帮我分析这段文字的节奏和情绪。')}><span>01</span>帮我分析这段文字</button>
              <button onClick={(event) => submitAssistant(event, '如何让当前章节的剧情更精彩？')}><span>02</span>如何让剧情更精彩？</button>
              <button onClick={(event) => submitAssistant(event, '帮我给当前章节起 3 个章节名称。')}><span>03</span>给本章起 3 个名字</button>
              <button onClick={(event) => submitAssistant(event, '帮我总结当前章节，并列出下一章可推进的冲突。')}><span>04</span>总结当前章节</button>
            </div>
            {assistantMessages.length > 0 && <div className="assistant-message-list">{assistantMessages.map((message) => <div className="assistant-message" key={message.id}><MessageCircle size={13} /><span>{message.text}</span></div>)}</div>}
            <div className="assistant-context-card"><div><span>关联</span><strong>当前章节正文</strong></div><small>{wordCount.toLocaleString()} 字 · {displayChapter.title}</small></div>
            <form className="assistant-form" onSubmit={submitAssistant}><textarea value={assistantInput} onChange={(event) => setAssistantInput(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submitAssistant(event) }} rows={3} placeholder="输入问题或需求，Ctrl+Enter 发送" aria-label="输入问题或需求" /><div><span>支持 @关联内容</span><button type="submit" className="assistant-send" aria-label="发送" title="发送"><Send size={15} /></button></div></form>
            <div className="insight-card coral-note"><span>情绪曲线</span><strong>待分析</strong><p>写完本章后，可使用 Skill 审稿分析情绪节奏。</p></div>
            <div className="insight-card chapter-anchor-card"><span>本章锚点</span>{anchorIdeas.length ? <div className="anchor-list">{anchorIdeas.map((idea) => <button key={idea.id} onClick={() => insertMaterial(idea)}><span className={`entity-dot ${idea.color === 'teal' ? 'teal' : 'coral'}`} /><span><strong>{idea.title}</strong><small>{idea.label} · 点击插入</small></span></button>)}</div> : <p>还没有关联锚点，可从素材库插入剧情、冲突或线索卡。</p>}<button className="text-button" onClick={() => setIdeaPickerOpen(true)}>{anchorIdeas.length ? '插入更多素材' : '打开素材库'} <ArrowUpRight size={14} /></button></div>
            <div className="insight-card quote-card"><Info size={15} /><p>“让线索先抵达读者，再让人物意识到它。”</p></div>
          </> : <button className="assistant-reopen" aria-label={`展开${ASSISTANT_NAME}`} title={`展开${ASSISTANT_NAME}`} onClick={() => setAssistantOpen(true)}><Bot size={17} /><span>AI</span><ChevronLeft size={14} /></button>}
        </aside>
      </div>
    </div>

    {clearOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setClearOpen(false)}><div className="modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">章节操作</span><h2>清空本章正文？</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setClearOpen(false)}><X size={18} /></button></div><p className="confirm-text">正文会先进入撤销栈，确认后仍可点击撤销恢复。</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setClearOpen(false)}>取消</button><button type="button" className="dark-button danger-button" onClick={() => { commitDraftChange(''); setClearOpen(false); onNotify('本章正文已清空') }}>清空正文</button></div></div></div>}
    {renameTarget && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setRenameTarget(null)}><div className="modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">章节操作</span><h2>重命名章节</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setRenameTarget(null)}><X size={18} /></button></div><form onSubmit={confirmRename}><label>章节标题<input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={100} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setRenameTarget(null)}>取消</button><button type="submit" className="dark-button">保存</button></div></form></div></div>}
    {deleteTarget && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setDeleteTarget(null)}><div className="modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">删除章节</span><h2>确认删除</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setDeleteTarget(null)}><X size={18} /></button></div><p className="confirm-text">确定删除《{deleteTarget.title}》吗？此操作不可撤销。</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setDeleteTarget(null)}>取消</button><button type="button" className="dark-button danger-button" onClick={confirmDelete}>删除</button></div></div></div>}
    {outlineOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOutlineOpen(false)}><div className="modal outline-modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">{project?.title}</span><h2>章节大纲</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setOutlineOpen(false)}><X size={18} /></button></div>{chapters.length ? <ol className="outline-list">{chapters.map((chapter) => <li key={chapter.id}><span className="outline-num">{String(chapter.id).padStart(2, '0')}</span><button className="outline-title" onClick={() => { onSelectChapter?.(chapter); setOutlineOpen(false) }}>{chapter.title}</button><span className={`outline-state ${chapter.state === 'done' ? 'done' : ''}`}>{chapter.state === 'done' ? '已完成' : '草稿'}</span><span className="outline-words">{chapter.words} 字</span></li>)}</ol> : <div className="empty-state small"><p>还没有章节，先新建第一章吧。</p></div>}</div></div>}
    {historyOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setHistoryOpen(false)}><div className="modal history-modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">编辑器</span><h2>历史记录</h2></div><button className="icon-button" aria-label="关闭历史记录" onClick={() => setHistoryOpen(false)}><X size={18} /></button></div><p className="modal-subtitle">选择一个快照恢复到正文，当前内容会保留在重做栈中。</p><div className="history-list">{historyLoading ? <div className="history-empty"><LoaderCircle size={22} className="spin" /><p>正在读取历史快照</p></div> : historyRef.current.past.length ? historyRef.current.past.slice().reverse().map((snapshot, index) => { const version = historyRef.current.past.length - index; const preview = snapshot.replace(/\s+/g, ' ').trim(); return <button type="button" className="history-item" key={`${version}-${index}`} onClick={() => restoreHistory(snapshot)}><span className="history-item-version">版本 {version}</span><span className="history-item-copy"><strong>{formatNumber(snapshot.replace(/\s/g, '').length)} 字</strong><small>{preview || '（空正文）'}</small></span><ChevronRight size={16} /></button> }) : <div className="history-empty"><History size={22} /><p>还没有可恢复的编辑快照</p><small>继续输入一会儿，历史记录会自动生成。</small></div>}</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setHistoryOpen(false)}>关闭</button></div></div></div>}
    {frequencyOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setFrequencyOpen(false)}><div className="modal frequency-modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">正文分析</span><h2>高频词</h2></div><button className="icon-button" aria-label="关闭高频词" onClick={() => setFrequencyOpen(false)}><X size={18} /></button></div><p className="modal-subtitle">统计当前章节中重复出现的词语，点击词语可回到正文定位第一次出现的位置。</p><div className="frequency-cloud">{frequentWords.map(([word, count]) => <button type="button" className="frequency-chip" key={word} onClick={() => locateFrequentWord(word)}><strong>{word}</strong><small>{count} 次</small></button>)}</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setFrequencyOpen(false)}>关闭</button></div></div></div>}
    {splitOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !splitLoading && setSplitOpen(false)}><div className="modal split-modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">本地章节操作</span><h2>按光标拆章</h2></div><button className="icon-button" aria-label="关闭拆分章节" disabled={splitLoading} onClick={() => setSplitOpen(false)}><X size={18} /></button></div><p className="modal-subtitle">以当前光标位置为分界，在本地拆分正文并保存为新章节；此操作不调用 AI。</p><form onSubmit={confirmSplit}><label>新章节标题<input autoFocus value={splitTitle} onChange={(event) => setSplitTitle(event.target.value)} maxLength={100} placeholder="例如：潮声之后" /></label><div className="split-preview"><div><span>当前章节保留</span><strong>{formatNumber(splitBefore.length)} 字</strong><p>{splitBefore.slice(-90) || '拆分位置之前暂无正文'}</p></div><ChevronRight size={17} /><div><span>新章节内容</span><strong>{formatNumber(splitAfter.length)} 字</strong><p>{splitAfter.slice(0, 90) || '拆分位置之后暂无正文'}</p></div></div><div className="modal-actions"><button type="button" className="secondary-button" disabled={splitLoading} onClick={() => setSplitOpen(false)}>取消</button><button type="submit" className="dark-button" disabled={splitLoading || !splitTitle.trim()}>{splitLoading ? <LoaderCircle size={16} className="spin" /> : <Split size={16} />}{splitLoading ? '拆分中' : '确认拆分'}</button></div></form></div></div>}
    {memoryReviewOpen && <MemoryReviewModal candidates={memoryCandidates} loading={memoryLoading} onChange={updateMemoryCandidate} onClose={() => setMemoryReviewOpen(false)} onSave={saveMemoryCandidates} />}
    {memoryEditing && <MemoryEditModal memory={memoryEditing} onClose={() => setMemoryEditing(null)} onSave={async (updates) => { const saved = await onUpdateStoryMemory?.(memoryEditing, updates); if (saved) setMemoryEditing(null) }} onDelete={async () => { const deleted = await onDeleteStoryMemory?.(memoryEditing); if (deleted) setMemoryEditing(null) }} />}
    {foreshadowOpen && <ForeshadowModal project={project} chapters={chapters} target={foreshadowTarget} onClose={() => { setForeshadowOpen(false); setForeshadowTarget(null) }} onCreate={onCreateForeshadow} onUpdate={onUpdateForeshadow} onDelete={onDeleteForeshadow} />}
    {ideaPickerOpen && <MaterialPicker ideas={ideas} projectId={project?.id} onClose={() => setIdeaPickerOpen(false)} onInsert={insertMaterial} />}
  </>
}

const memoryTypeLabels = { character_state: '角色状态', event: '已发生事件', world_rule: '世界规则', chapter_summary: '章节摘要', canon_fact: '不可违背事实', voice_habit: '语言习惯' }

function MemoryReviewModal({ candidates, loading, onChange, onClose, onSave }) {
  return <div className="modal-backdrop memory-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !loading && onClose()}><div className="modal memory-review-modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">夜雨 · 作品记忆</span><h2>确认本章长期事实</h2><p className="modal-subtitle">以下只是候选项，勾选并修订后才会进入作品记忆。</p></div><button className="icon-button" disabled={loading} onClick={onClose}><X size={18} /></button></div><div className="memory-candidate-list">{candidates.map((candidate) => <article className={`memory-candidate ${candidate.selected ? 'selected' : ''}`} key={candidate.id}><label className="memory-candidate-toggle"><input type="checkbox" checked={candidate.selected} onChange={(event) => onChange(candidate.id, 'selected', event.target.checked)} /><span>{memoryTypeLabels[candidate.type] || candidate.type}</span><small>重要性 {candidate.importance || 3}</small></label><div className="form-row"><label>类型<select value={candidate.type} onChange={(event) => onChange(candidate.id, 'type', event.target.value)}>{Object.entries(memoryTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>标题<input value={candidate.title} maxLength={160} onChange={(event) => onChange(candidate.id, 'title', event.target.value)} /></label></div><label>内容<textarea rows={3} maxLength={4000} value={candidate.content} onChange={(event) => onChange(candidate.id, 'content', event.target.value)} /></label><div className="form-row"><label>角色<input value={candidate.character_name || ''} maxLength={80} onChange={(event) => onChange(candidate.id, 'character_name', event.target.value)} placeholder="可选" /></label><label>重要性<select value={candidate.importance || 3} onChange={(event) => onChange(candidate.id, 'importance', Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option value={value} key={value}>{value}</option>)}</select></label></div>{candidate.reason && <p className="memory-candidate-reason"><Info size={13} />{candidate.reason}</p>}</article>)}</div><div className="modal-actions"><button className="secondary-button" disabled={loading} onClick={onClose}>取消</button><button className="dark-button" disabled={loading || !candidates.some((item) => item.selected)} onClick={onSave}>{loading ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{loading ? '写入中' : `确认 ${candidates.filter((item) => item.selected).length} 条`}</button></div></div></div>
}

function MemoryEditModal({ memory, onClose, onSave, onDelete }) {
  const [form, setForm] = useState({ type: memory.type, title: memory.title, content: memory.content, characterName: memory.characterName || '', importance: memory.importance || 3, status: memory.status || 'active' })
  function update(field, value) { setForm((current) => ({ ...current, [field]: value })) }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal memory-edit-modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">作品记忆</span><h2>编辑长期事实</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div><div className="form-row"><label>类型<select value={form.type} onChange={(event) => update('type', event.target.value)}>{Object.entries(memoryTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>重要性<select value={form.importance} onChange={(event) => update('importance', Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option value={value} key={value}>{value}</option>)}</select></label></div><label>标题<input value={form.title} maxLength={160} onChange={(event) => update('title', event.target.value)} /></label><label>内容<textarea rows={5} value={form.content} maxLength={4000} onChange={(event) => update('content', event.target.value)} /></label><label>角色<input value={form.characterName} maxLength={80} onChange={(event) => update('characterName', event.target.value)} placeholder="可选" /></label><div className="modal-actions"><button className="danger-text-button" onClick={onDelete}><Trash2 size={15} />删除</button><button className="secondary-button" onClick={() => onSave({ status: form.status === 'archived' ? 'active' : 'archived' })}>{form.status === 'archived' ? '恢复' : '归档'}</button><button className="dark-button" onClick={() => onSave(form)}><Check size={15} />保存</button></div></div></div>
}

const foreshadowStatusLabels = { planned: '计划中', planted: '已埋入', resolved: '已回收', abandoned: '已放弃' }

function ForeshadowModal({ project, chapters, target, onClose, onCreate, onUpdate, onDelete }) {
  const [form, setForm] = useState(() => ({
    title: target?.title || '',
    content: target?.content || '',
    status: target?.status || 'planned',
    importance: String(target?.importance || 3),
    category: target?.category || '',
    plantChapterId: target?.plantChapterId ? String(target.plantChapterId) : '',
    targetChapterId: target?.targetChapterId ? String(target.targetChapterId) : '',
    resolvedChapterId: target?.resolvedChapterId ? String(target.resolvedChapterId) : '',
  }))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const editing = Boolean(target)

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value, ...(field === 'status' && value !== 'resolved' ? { resolvedChapterId: '' } : {}) }))
  }

  async function submit(event) {
    event.preventDefault()
    if (!form.title.trim() || !form.content.trim()) {
      setError('伏笔标题和内容不能为空')
      return
    }
    setError('')
    setLoading(true)
    const payload = {
      title: form.title.trim(), content: form.content.trim(), status: form.status,
      importance: Number(form.importance), category: form.category.trim(),
      plantChapterId: form.plantChapterId || null, targetChapterId: form.targetChapterId || null,
      resolvedChapterId: form.resolvedChapterId || null,
      projectId: project?.id,
    }
    const result = editing ? await onUpdate?.(target, payload) : await onCreate?.(payload)
    setLoading(false)
    if (result) onClose()
  }

  async function remove() {
    if (!target || loading) return
    setLoading(true)
    const result = await onDelete?.(target)
    setLoading(false)
    if (result) onClose()
  }

  return <div className="modal-backdrop foreshadow-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !loading && onClose()}><div className="modal foreshadow-modal" role="dialog" aria-modal="true" aria-labelledby="foreshadow-modal-title"><div className="modal-heading"><div><span className="section-overline">{project?.title || '作品'} · 叙事管理</span><h2 id="foreshadow-modal-title">{editing ? '编辑伏笔' : '登记伏笔'}</h2></div><button className="icon-button" aria-label="关闭伏笔编辑" title="关闭" disabled={loading} onClick={onClose}><X size={18} /></button></div><p className="modal-subtitle">记录线索如何埋下、准备在哪一章回收，{ASSISTANT_NAME}会自动把未回收伏笔加入章节上下文。</p><form onSubmit={submit}><label>伏笔标题<input autoFocus value={form.title} onChange={(event) => update('title', event.target.value)} maxLength={120} placeholder="例如：反锁的门" /></label><label>线索内容<textarea value={form.content} onChange={(event) => update('content', event.target.value)} maxLength={2000} rows={4} placeholder="描述读者能看到的线索，以及它最终指向什么。" /></label><div className="form-row"><label>状态<select value={form.status} onChange={(event) => update('status', event.target.value)}>{Object.entries(foreshadowStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>重要性<select value={form.importance} onChange={(event) => update('importance', event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} · {value >= 4 ? '关键线索' : value === 3 ? '普通线索' : '轻量线索'}</option>)}</select></label></div><label>分类<input value={form.category} onChange={(event) => update('category', event.target.value)} maxLength={40} placeholder="例如：人物身世、世界观、案件线索" /></label><div className="form-row"><label>埋入章节<select value={form.plantChapterId} onChange={(event) => update('plantChapterId', event.target.value)}><option value="">暂不指定</option>{chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.id} 章 · {chapter.title}</option>)}</select></label><label>计划回收章节<select value={form.targetChapterId} onChange={(event) => update('targetChapterId', event.target.value)}><option value="">暂不指定</option>{chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.id} 章 · {chapter.title}</option>)}</select></label></div><label>实际回收章节<select value={form.resolvedChapterId} onChange={(event) => update('resolvedChapterId', event.target.value)}><option value="">尚未回收</option>{chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.id} 章 · {chapter.title}</option>)}</select></label>{error && <div className="skill-runner-validation" role="alert">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={loading} onClick={onClose}>取消</button>{editing && <button type="button" className="danger-text-button" disabled={loading} onClick={remove}><Trash2 size={15} />删除</button>}<button type="submit" className="dark-button" disabled={loading}>{loading ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{loading ? '保存中' : editing ? '保存伏笔' : '加入作品'}</button></div></form></div></div>
}

function Works({ projects, onOpen, onNew, onEdit, onDelete, onSmartCreate, onImport }) {
  const [typeFilter, setTypeFilter] = useState('全部')
  const [statusFilter, setStatusFilter] = useState('全部')
  const [menuOpenId, setMenuOpenId] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const types = ['全部', '长篇', '短篇', '参考书']
  const statuses = ['全部', '进行中', '已完结']
  const typeCounts = { 全部: projects.length }
  for (const project of projects) typeCounts[project.type] = (typeCounts[project.type] || 0) + 1
  const statusCounts = { 全部: projects.length, 进行中: projects.filter((project) => project.status !== '已完结').length, 已完结: projects.filter((project) => project.status === '已完结').length }
  const filtered = projects.filter((project) => {
    const typeMatch = typeFilter === '全部' || project.type === typeFilter
    const statusMatch = statusFilter === '全部' || (statusFilter === '已完结' ? project.status === '已完结' : project.status !== '已完结')
    return typeMatch && statusMatch
  })
  async function confirmDelete() {
    if (!deleteTarget || deleteLoading) return
    setDeleteLoading(true)
    const deleted = await onDelete(deleteTarget)
    setDeleteLoading(false)
    if (deleted) setDeleteTarget(null)
  }
  return <>
  <div className="page inner-page">
    <div className="page-heading"><div><span className="section-overline">作品空间</span><h1>我的作品</h1><p>所有故事都在这里继续。</p></div><div className="works-heading-actions"><button className="secondary-button" onClick={onImport}><Download size={16} />导入本地文稿</button><button className="secondary-button smart-create-button" onClick={onSmartCreate}><Sparkles size={16} />和{ASSISTANT_NAME}构思</button><button className="primary-button" onClick={onNew}><BookPlus size={17} />新建作品</button></div></div>
    <div className="works-toolbar works-toolbar-expanded"><div className="filter-tabs">{types.map((type) => <button key={type} className={typeFilter === type ? 'selected' : ''} onClick={() => setTypeFilter(type)}>{type} <span>{typeCounts[type] || 0}</span></button>)}</div><div className="filter-tabs status-filter-tabs">{statuses.map((status) => <button key={status} className={statusFilter === status ? 'selected' : ''} onClick={() => setStatusFilter(status)}>{status} <span>{statusCounts[status] || 0}</span></button>)}</div></div>
    {filtered.length ? <div className="works-list">{filtered.map((project) => <div className="work-row-wrap" key={project.id}><button className="work-row" onClick={() => onOpen(project)}><div className={`row-cover ${project.cover}`}><span>{project.title.slice(0, 1)}</span></div><div className="row-main"><div className="row-title"><h3>{project.title}</h3><span className="muted-tag">{project.type}</span></div><p>{project.genre} · {project.status}</p><div className="row-progress"><span style={{ width: `${project.progress}%` }} /></div></div><div className="row-stat"><strong>{project.words}</strong><span>总字数</span></div><div className="row-stat"><strong>{project.progress}%</strong><span>完成度</span></div><div className="row-updated"><span>最近编辑</span><strong>{formatRelativeTime(project.updatedAt, project.updated)}</strong></div><ChevronRight size={18} className="row-arrow" /></button><button className="work-row-menu" aria-label="作品操作" title="作品操作" onClick={(event) => { event.stopPropagation(); setMenuOpenId(menuOpenId === project.id ? null : project.id) }}><MoreHorizontal size={16} /></button>{menuOpenId === project.id && <div className="chapter-menu work-menu" role="menu"><button onClick={() => { onEdit(project); setMenuOpenId(null) }}>编辑作品</button><button className="danger" onClick={() => { setDeleteTarget(project); setMenuOpenId(null) }}>删除作品</button></div>}</div>)}</div> : <div className="empty-state"><div className="empty-state-icon"><BookOpen size={28} /></div><h2>没有匹配的作品</h2><p>调整筛选条件，或新建一本作品开始创作。</p><button className="primary-button" onClick={onNew}><BookPlus size={17} />新建作品</button></div>}
  </div>
  {deleteTarget && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !deleteLoading && setDeleteTarget(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-project-title"><div className="modal-heading"><div><span className="section-overline">删除作品</span><h2 id="delete-project-title">确认永久删除</h2></div><button className="icon-button" aria-label="关闭" disabled={deleteLoading} onClick={() => setDeleteTarget(null)}><X size={18} /></button></div><p className="confirm-text">即将删除《{deleteTarget.title}》及其全部章节、正文、编辑历史和关联素材。此操作不可恢复。</p><div className="modal-actions"><button type="button" className="secondary-button" disabled={deleteLoading} onClick={() => setDeleteTarget(null)}>取消</button><button type="button" className="dark-button danger-button" disabled={deleteLoading} onClick={confirmDelete}>{deleteLoading ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}{deleteLoading ? '删除中' : '永久删除'}</button></div></div></div>}
  </>
}

function LibraryView({ ideas, onCreate, onEditIdea, onDeleteIdea, projects }) {
  const [query, setQuery] = useState('')
  const [labelFilter, setLabelFilter] = useState('全部')
  const [projectFilter, setProjectFilter] = useState('')
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const labels = ['全部', ...new Set(ideas.map((idea) => idea.label).filter(Boolean))]
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = ideas.filter((idea) => {
    const haystack = [idea.title, idea.body, idea.label, idea.folder, ...(idea.tags || [])].join(' ').toLowerCase()
    return (!normalizedQuery || haystack.includes(normalizedQuery))
      && (labelFilter === '全部' || idea.label === labelFilter)
      && (!projectFilter || idea.projectId === projectFilter)
      && (!pinnedOnly || idea.pinned)
  })

  return <>
    <div className="page inner-page">
      <div className="page-heading">
        <div><span className="section-overline">创作知识库</span><h1>素材与灵感</h1><p>集中管理人物、设定、剧情锚点与随手灵感。</p></div>
        <button className="primary-button" onClick={() => setCreateOpen(true)}><Plus size={17} />新增素材</button>
      </div>

      <div className="library-toolbar material-toolbar">
        <div className="library-search"><Search size={16} /><input type="text" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、正文、目录或标签…" aria-label="搜索素材" /></div>
        <select className="material-project-filter" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} aria-label="按作品筛选"><option value="">全部作品</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select>
        <button className={`material-pin-filter ${pinnedOnly ? 'selected' : ''}`} onClick={() => setPinnedOnly((value) => !value)}><Pin size={14} />只看置顶</button>
      </div>

      <div className="material-filter-row">
        <div className="filter-tabs">{labels.map((label) => <button key={label} className={labelFilter === label ? 'selected' : ''} onClick={() => setLabelFilter(label)}>{label}<span>{label === '全部' ? ideas.length : ideas.filter((idea) => idea.label === label).length}</span></button>)}</div>
        <span className="tiny-meta">{filtered.length} / {ideas.length} 条素材</span>
      </div>

      {filtered.length ? <div className="idea-grid material-grid">{filtered.map((idea) => {
        const project = projects.find((item) => item.id === idea.projectId)
        return <button className={`idea-card material-card ${idea.color} ${idea.pinned ? 'pinned' : ''}`} key={idea.id} onClick={() => setEditTarget(idea)}>
          <div className="idea-card-top"><span>{idea.label} · {idea.folder || '未分类'}</span>{idea.pinned ? <Pin size={15} /> : <MoreHorizontal size={16} />}</div>
          <h3>{idea.title}</h3>
          <p>{idea.body}</p>
          {(idea.tags || []).length > 0 && <div className="material-tags">{idea.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>}
          <div className="idea-card-foot"><span>{project?.title || '全局素材'} · {formatRelativeTime(idea.updatedAt || idea.createdAt, '刚刚')}</span><ArrowUpRight size={15} /></div>
        </button>
      })}</div> : <div className="empty-state"><div className="empty-state-icon"><Library size={28} /></div><h2>{ideas.length ? '没有匹配的素材' : '素材库还是空的'}</h2><p>{ideas.length ? '调整关键词或筛选条件再试试。' : '先记录一个人物、一条设定或一句突然出现的台词。'}</p>{!ideas.length && <button className="primary-button" onClick={() => setCreateOpen(true)}><Plus size={17} />新增第一条素材</button>}</div>}
    </div>

    {createOpen && <IdeaModal projects={projects} onClose={() => setCreateOpen(false)} onSubmit={(data) => { onCreate(data); setCreateOpen(false) }} />}
    {editTarget && <IdeaModal projects={projects} idea={editTarget} onClose={() => setEditTarget(null)} onSubmit={(data) => { onEditIdea(editTarget, data); setEditTarget(null) }} onDelete={() => { setDeleteTarget(editTarget); setEditTarget(null) }} />}
    {deleteTarget && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setDeleteTarget(null)}><div className="modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">删除素材</span><h2>确认删除</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setDeleteTarget(null)}><X size={18} /></button></div><p className="confirm-text">确定删除《{deleteTarget.title}》吗？</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setDeleteTarget(null)}>取消</button><button type="button" className="dark-button danger-button" onClick={() => { onDeleteIdea(deleteTarget); setDeleteTarget(null) }}>删除</button></div></div></div>}
  </>
}

function IdeaModal({ idea, projects, onClose, onSubmit, onDelete }) {
  const [label, setLabel] = useState(idea?.label || '灵感')
  const [title, setTitle] = useState(idea?.title || '')
  const [body, setBody] = useState(idea?.body || '')
  const [projectId, setProjectId] = useState(idea?.projectId || '')
  const [folder, setFolder] = useState(idea?.folder || '未分类')
  const [tags, setTags] = useState((idea?.tags || []).join('，'))
  const [pinned, setPinned] = useState(Boolean(idea?.pinned))
  const labels = ['灵感', '人物', '世界观', '场景', '冲突', '剧情', '台词', '设定']
  function submit(event) {
    event.preventDefault()
    if (!title.trim()) return
    onSubmit({ label, title: title.trim(), body: body.trim() || '记录下此刻的想法。', projectId: projectId || null, folder: folder.trim() || '未分类', tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean), pinned })
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal material-modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">{idea ? '编辑创作素材' : '收集创作素材'}</span><h2>{idea ? '编辑素材卡' : '新素材卡'}</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></div><form onSubmit={submit}><label>类型<div className="idea-label-row">{labels.map((item) => <button type="button" key={item} className={label === item ? 'selected' : ''} onClick={() => setLabel(item)}>{item}</button>)}</div></label><label>标题<input name="title" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="一句话概括这条素材" maxLength={160} /></label><label>内容<textarea name="body" value={body} onChange={(event) => setBody(event.target.value)} placeholder="人物小传、世界观规则、剧情片段或灵感正文…" rows={7} maxLength={10000} /></label><div className="form-row"><label>目录<input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="例如：核心人物" maxLength={40} /></label><label>关联作品<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">全局素材</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label></div><label>标签<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="逗号分隔，例如：女主，秘密，第一卷" /></label><label className="material-pin-toggle"><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /><span><Pin size={14} />置顶这条素材</span></label><div className="modal-actions">{idea && <button type="button" className="secondary-button danger-button" onClick={onDelete}>删除</button>}<button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="dark-button">{idea ? '保存' : '创建'}</button></div></form></div></div>
}

function MaterialPicker({ ideas, projectId, onClose, onInsert }) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const relevant = sortIdeas(ideas.filter((idea) => (!idea.projectId || idea.projectId === projectId) && (!normalizedQuery || [idea.title, idea.body, idea.label, idea.folder, ...(idea.tags || [])].join(' ').toLowerCase().includes(normalizedQuery))))
  return <div className="modal-backdrop material-picker-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="material-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="material-picker-title">
      <div className="modal-heading"><div><span className="section-overline">写作辅助</span><h2 id="material-picker-title">插入素材</h2><p className="material-picker-subtitle">显示当前作品与全局素材，点击后插入光标位置。</p></div><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></div>
      <div className="material-picker-search"><Search size={16} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索人物、设定、台词或标签…" /></div>
      <div className="material-picker-list">
        {relevant.length ? relevant.map((idea) => <button key={idea.id} className="material-picker-item" onClick={() => onInsert(idea)}>
          <span className={`material-picker-mark ${idea.color}`}>{idea.pinned ? <Pin size={14} /> : <Sparkles size={14} />}</span>
          <span className="material-picker-copy"><strong>{idea.title}</strong><small>{idea.label} · {idea.folder || '未分类'}</small><p>{idea.body}</p></span>
          <ArrowUpRight size={15} />
        </button>) : <div className="empty-state small"><Library size={20} /><p>{ideas.length ? '没有匹配的素材。' : '素材库为空，先去“素材与灵感”新增内容。'}</p></div>}
      </div>
    </div>
  </div>
}

function Deconstruct({ onNotify, onRunSkill }) {
  const [importOpen, setImportOpen] = useState(false)
  const [form, setForm] = useState({ title: '', length: '长篇', content: '' })
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [resultOpen, setResultOpen] = useState(false)
  async function runAnalyze(event) {
    event.preventDefault()
    if (!form.content.trim()) { onNotify('请粘贴参考书正文'); return }
    const skill = form.length === '短篇' ? 'story-short-analyze' : 'story-long-analyze'
    setLoading(true)
    setResult(null)
    onNotify(`正在拆解《${form.title || '未命名'}》，请稍候`)
    try {
      const response = await api.runStoryAgent({
        message: `拆解《${form.title || '未命名'}》`,
        skill,
        payload: { content: form.content, title: form.title },
      })
      setResult(response)
      setResultOpen(true)
      onNotify(`拆文完成 · ${response.status}`)
    } catch (error) {
      setResult({ status: 'failed', result: { message: error.message }, selected_skill: skill, route: 'error' })
      setResultOpen(true)
      onNotify(error.message)
    } finally {
      setLoading(false)
    }
  }
  return <div className="page inner-page"><div className="page-heading"><div><span className="section-overline">结构工作室</span><h1>拆文台</h1><p>把读过的故事，变成下一本书的养分。</p></div><button className="primary-button" onClick={() => setImportOpen(true)}><FolderOpen size={17} />导入参考书</button></div><div className="empty-state"><div className="empty-state-icon"><BookOpenCheck size={28} /></div><h2>拆解一本参考书</h2><p>粘贴一本你合法持有的小说正文，AI 会拆解黄金三章、人设架构、爽点设计与节奏控制。</p><button className="primary-button" onClick={() => setImportOpen(true)}><FolderOpen size={17} />导入参考书</button></div><div className="analysis-grid"><div className="analysis-card"><span className="analysis-number">01</span><FileText size={20} /><h3>故事概要</h3><p>全书主线、章节索引与关键转折</p></div><div className="analysis-card"><span className="analysis-number">02</span><Users size={20} /><h3>人物图谱</h3><p>角色关系、动机链与状态变化</p></div><div className="analysis-card"><span className="analysis-number">03</span><Clock3 size={20} /><h3>节奏报告</h3><p>情绪触发、信息递进与爽点密度</p></div></div>{importOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setImportOpen(false)}><div className="modal deconstruct-modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">导入参考书</span><h2>拆解一本小说</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setImportOpen(false)}><X size={18} /></button></div><form onSubmit={runAnalyze}><label>书名<input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="例如：剑道独尊" maxLength={80} /></label><label>篇幅<select value={form.length} onChange={(e) => setForm((f) => ({ ...f, length: e.target.value }))}><option>长篇</option><option>短篇</option></select></label><label>正文<textarea value={form.content} onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))} placeholder="粘贴小说正文（至少黄金三章）…" rows={8} /></label><div className="modal-note"><Info size={16} /><span>请确保你合法持有该作品的使用权。拆文仅用于学习与文学批评。</span></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setImportOpen(false)}>取消</button><button type="submit" className="dark-button" disabled={loading}>{loading ? <LoaderCircle size={16} className="spin" /> : <BookOpenCheck size={16} />}{loading ? '拆文中' : '开始拆文'}</button></div></form></div></div>}{resultOpen && result && <SkillRunnerModal skill={result.selected_skill} skills={[]} loading={false} result={result} onClose={() => setResultOpen(false)} onRun={() => {}} draft="" />}</div>
}

// 高级工具：只保留作者真正会单独打开的低频/专项能力
const toolkitSkillGroups = [
  {
    label: '题材趋势',
    skills: ['story-long-scan', 'story-short-scan'],
  },
  {
    label: '润色审稿',
    skills: ['story-deslop', 'story-review'],
  },
]

// 每个 skill 卡片的展示信息
const skillCardMeta = {
  'story-long-scan': { label: '长篇题材趋势', desc: '基于模型知识分析长篇热门题材与市场方向，不获取实时榜单', tone: 'coral', icon: 'Target' },
  'story-short-scan': { label: '短篇题材趋势', desc: '基于模型知识分析短篇选题与市场方向，不获取实时榜单', tone: 'coral', icon: 'Target' },
  'story-deslop': { label: '自然化润色', desc: '检查并改写套话与常见 AI 句式痕迹', tone: 'teal', icon: 'WandSparkles' },
  'story-review': { label: '章节诊断', desc: '结构化审查章节并输出评分与建议报告，不直接修改正文', tone: 'teal', icon: 'BrainCircuit' },
}

function Toolkit({ onNotify, skills, skillsLoading, onRefreshSkills, onRunSkill, onOpenSettings, onNavigate }) {
  const [guideOpen, setGuideOpen] = useState(false)
  const skillMap = useMemo(() => Object.fromEntries(skills.map((s) => [s.name, s])), [skills])
  const callable = callableSkill
  const listedSkills = toolkitSkillGroups.flatMap((group) => group.skills.map((name) => skillMap[name]).filter(Boolean))
  const readyCount = listedSkills.filter((s) => s.status === 'ready').length
  const needsModelCount = listedSkills.filter((s) => s.status === 'needs_model').length
  return <><div className="page inner-page"><div className="page-heading"><div><span className="section-overline">低频专项</span><h1>高级工具</h1><p>写作请走{ASSISTANT_NAME}与编辑器；这里只放题材趋势、自然化润色和章节诊断。</p></div><div className="page-heading-actions"><button className="text-button" onClick={onOpenSettings}><Settings2 size={15} />模型设置</button><button className="text-button" onClick={() => setGuideOpen(true)}><CircleHelp size={15} />使用指南</button></div></div>
  <div className="toolkit-redirect-card">
    <div><span className="section-overline">主路径</span><h2>想开书或继续写？</h2><p>建书方案用{ASSISTANT_NAME}，正文续写和润色在编辑器里更顺手。</p></div>
    <div className="toolkit-redirect-actions">
      <button className="primary-button" onClick={() => onNavigate('assistant')}><MessageCircle size={16} />{ASSISTANT_NAME}</button>
      <button className="secondary-button" onClick={() => onNavigate('works')}><BookOpen size={16} />我的作品</button>
      <button className="secondary-button" onClick={() => onNavigate('deconstruct')}><BookOpenCheck size={16} />拆文台</button>
    </div>
  </div>
  <div className="toolkit-status-bar"><span className={`skill-status ${readyCount ? 'ready' : ''}`}>{readyCount} 可调用</span><span className="skill-status needs_model">{needsModelCount} 需模型</span><span className="tiny-meta">未配置模型时部分功能不可用，点击「模型设置」配置 LLM API</span></div>
  {toolkitSkillGroups.map((group) => {
    const groupSkills = group.skills.map((name) => skillMap[name]).filter(Boolean)
    if (!groupSkills.length) return null
    return <section className="toolkit-group" key={group.label}><div className="toolkit-group-label">{group.label}</div><div className="skill-card-grid">{groupSkills.map((skill) => {
      const card = skillCardMeta[skill.name] || { label: skill.name, desc: skill.description || '', tone: 'blue', icon: 'Sparkles' }
      const Icon = card.icon === 'BrainCircuit' ? BrainCircuit : card.icon === 'PenLine' ? PenLine : card.icon === 'Target' ? Target : card.icon === 'WandSparkles' ? WandSparkles : card.icon === 'Settings2' ? Settings2 : Sparkles
      const canCall = callable(skill)
      return <button className={`skill-card ${card.tone} ${canCall ? '' : 'disabled'}`} key={skill.name} disabled={!canCall} onClick={() => canCall && onRunSkill(skill.name)}><div className="skill-card-top"><span className={`skill-card-icon ${card.tone}`}><Icon size={22} /></span><span className={`skill-status ${skill.status}`}>{skill.status === 'ready' ? '可调用' : skill.status === 'needs_model' ? '需模型' : skill.status === 'registered' ? '待适配' : '不可用'}</span></div><h3>{card.label}</h3><p>{card.desc}</p><div className="skill-card-foot"><span>{skill.name}</span>{skill.version && <span className="tiny-meta">v{skill.version}</span>}<ArrowUpRight size={16} /></div></button>
    })}</div></section>
  })}
  <div className="tool-footer"><Sparkles size={17} /><span>叙事工坊 0.1 · 本地工作区</span><button className="text-button" disabled={skillsLoading} onClick={() => onRefreshSkills()}>{skillsLoading ? <LoaderCircle size={14} className="spin" /> : null}{skillsLoading ? '刷新中' : '刷新状态'} {!skillsLoading && <ArrowUpRight size={14} />}</button></div></div>{guideOpen && <GuideModal onClose={() => setGuideOpen(false)} />}</>
}

function GuideModal({ onClose }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="modal guide-modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">使用指南</span><h2>叙事工坊怎么用</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></div><div className="guide-content"><h3>开始创作</h3><p>优先打开「{ASSISTANT_NAME}」，先描述想法，再确认篇幅、题材和设定，生成建书方案。也可以在「我的作品」手动新建。</p><h3>章节写作</h3><p>进入编辑器后，续写、自然化润色、章节诊断和素材插入都在当前章节上下文中完成，正文会自动保存。诊断类 Skill 输出报告，不会直接修改正文。</p><h3>素材库</h3><p>集中管理人物、设定、剧情锚点与灵感卡，可关联到具体作品。</p><h3>高级工具</h3><p>题材趋势分析、自然化润色和章节诊断放在这里；趋势分析基于模型知识，不获取实时榜单。拆文台用于分析你合法持有并主动提供的参考正文。</p><h3>设置</h3><p>在左下角「设置」中配置 OpenAI 兼容的 API Base URL、Key 和模型名，所有 AI 调用会使用此配置。</p></div><div className="modal-actions"><button type="button" className="dark-button" onClick={onClose}>知道了</button></div></div></div>
}

function ReviewReport({ report, onClose }) {
  const verdictLabels = { APPROVE: '可以发布', CONCERNS: '修改后发布', REJECT: '暂不发布' }
  const categoryLabels = { structure: '结构', character: '人物', prose: '文字', consistency: '一致性', platform: '平台', factual: '事实', format: '格式', causal: '因果', rule_boundary: '规则边界' }
  const counts = report.severity_counts || {}
  return <div className="modal-backdrop review-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-report-title"><header className="review-report-header"><div><span className="section-overline">{report.skill} · v{report.skill_version}</span><h2 id="review-report-title">章节审稿报告</h2></div><button className="icon-button" aria-label="关闭审稿报告" title="关闭" onClick={onClose}><X size={19} /></button></header><div className="review-verdict"><div className={`verdict-mark ${report.verdict.toLowerCase()}`}><span>{report.score}</span><small>评分</small></div><div><span className="review-verdict-label">{verdictLabels[report.verdict] || report.verdict}</span><p>{report.summary}</p></div><div className="severity-summary">{['S1', 'S2', 'S3', 'S4'].map((severity) => <span key={severity} className={`severity-pill ${severity.toLowerCase()}`}>{severity} {counts[severity] || 0}</span>)}</div></div><dl className="review-metadata"><div><dt>请求模式</dt><dd>{report['Requested Mode']}</dd></div><div><dt>执行模式</dt><dd>{report['Effective Mode']}</dd></div><div><dt>平台规则</dt><dd>{report.Rubric}</dd></div><div><dt>规则来源</dt><dd>{report['Rubric Source']}</dd></div></dl><section className="review-findings"><div className="review-section-heading"><h3>问题清单</h3><span>{report.findings?.length || 0} 项</span></div>{report.findings?.length ? report.findings.map((finding, index) => <article className="review-finding" key={`${finding.location}-${index}`}><div className="finding-topline"><span className={`severity-pill ${finding.severity.toLowerCase()}`}>{finding.severity}</span><span>{categoryLabels[finding.category] || finding.category}</span><span>{finding.location}</span></div><blockquote>{finding.evidence}</blockquote><strong>{finding.issue}</strong><p><span>修改方向</span>{finding.fix}</p></article>) : <div className="review-empty"><Check size={18} /><span>确定性检查未发现必须修改的问题</span></div>}</section></div></div>
}

function SearchModal({ projects, chapters, ideas, onClose, onOpenProject, onSelectChapter, onNavigate }) {
  const [query, setQuery] = useState('')
  const inputRef = useRef(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  const q = query.trim().toLowerCase()
  const projectResults = q ? projects.filter((p) => (p.title + p.genre + p.type + p.status).toLowerCase().includes(q)) : []
  const chapterResults = q ? chapters.filter((c) => String(c.title).toLowerCase().includes(q)) : []
  const ideaResults = q ? ideas.filter((i) => (i.title + i.body + i.label).toLowerCase().includes(q)) : []
  const hasResults = projectResults.length || chapterResults.length || ideaResults.length
  return <div className="modal-backdrop search-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="search-dialog" role="dialog" aria-modal="true">
    <div className="search-input-wrap"><Search size={18} /><input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索作品、章节或灵感…" aria-label="搜索" /><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></div>
    <div className="search-results">
      {!q && <div className="search-hint">输入关键词搜索作品、章节和灵感</div>}
      {q && !hasResults && <div className="search-hint">没有匹配「{query}」的结果</div>}
      {projectResults.length > 0 && <div className="search-group"><span className="search-group-label">作品</span>{projectResults.map((p) => <button key={p.id} className="search-result-item" onClick={() => { onOpenProject(p); onClose() }}><BookOpen size={15} /><span className="search-result-title">{p.title}</span><span className="search-result-meta">{p.type} · {p.genre}</span></button>)}</div>}
      {chapterResults.length > 0 && <div className="search-group"><span className="search-group-label">当前作品章节</span>{chapterResults.map((c) => <button key={c.id} className="search-result-item" onClick={() => { void onSelectChapter?.(c); onNavigate('editor'); onClose() }}><FileText size={15} /><span className="search-result-title">{c.title}</span><span className="search-result-meta">第 {c.id} 章 · {c.words} 字</span></button>)}</div>}
      {ideaResults.length > 0 && <div className="search-group"><span className="search-group-label">灵感</span>{ideaResults.map((i) => <button key={i.id} className="search-result-item" onClick={() => { onNavigate('library'); onClose() }}><Sparkles size={15} /><span className="search-result-title">{i.title}</span><span className="search-result-meta">{i.label}</span></button>)}</div>}
    </div>
  </div></div>
}

function ImportProjectModal({ loading, onClose, onImport }) {
  const [title, setTitle] = useState('')
  const [type, setType] = useState('长篇')
  const [genre, setGenre] = useState('未分类')
  const [content, setContent] = useState('')
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')
  const chapters = useMemo(() => parseNovelText(content), [content])
  const totalWords = useMemo(() => chapters.reduce((total, chapter) => total + chapter.content.replace(/\s/g, '').length, 0), [chapters])

  async function chooseFile(event) {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 20 * 1024 * 1024) {
      setError('文件不能超过 20 MB')
      return
    }
    try {
      const text = await file.text()
      setContent(text)
      setFileName(file.name)
      setTitle((current) => current || file.name.replace(/\.[^.]+$/, '').slice(0, 80))
      setError('')
    } catch {
      setError('文件读取失败，请换一个 TXT 文件重试')
    }
  }

  function submit(event) {
    event.preventDefault()
    if (!title.trim()) {
      setError('请填写作品名')
      return
    }
    if (!chapters.length) {
      setError('请选择 TXT 文件或粘贴正文')
      return
    }
    if (chapters.length > 500) {
      setError('单次最多导入 500 个章节')
      return
    }
    if (chapters.some((chapter) => chapter.content.length > 500000)) {
      setError('存在超过 500,000 字符的单章，请先拆分后再导入')
      return
    }
    setError('')
    onImport({ title: title.trim(), type, genre: genre.trim() || '未分类', chapters })
  }

  return <div className="modal-backdrop import-project-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !loading && onClose()}><div className="modal import-project-modal" role="dialog" aria-modal="true" aria-labelledby="import-project-title"><div className="modal-heading"><div><span className="section-overline">本地 TXT</span><h2 id="import-project-title">导入本地文稿</h2><p className="modal-subtitle">浏览器会在本地读取 TXT，并按“第X章、序章、番外、Chapter X”等标题规则拆分章节；此流程不调用 AI 或 story-import Skill。</p></div><button className="icon-button" aria-label="关闭导入" disabled={loading} onClick={onClose}><X size={18} /></button></div><form onSubmit={submit}><label className="import-file-picker"><input type="file" accept=".txt,text/plain" disabled={loading} onChange={chooseFile} /><span><FolderOpen size={18} /><strong>{fileName || '选择 TXT 文件'}</strong><small>也可以在下方直接粘贴全文</small></span></label><div className="form-row"><label>作品名<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} placeholder="作品名称" /></label><label>篇幅<select value={type} onChange={(event) => setType(event.target.value)}><option>长篇</option><option>短篇</option><option>参考书</option></select></label></div><label>题材<input value={genre} onChange={(event) => setGenre(event.target.value)} maxLength={30} placeholder="例如：东方玄幻" /></label><label>全文<textarea value={content} onChange={(event) => { setContent(event.target.value); setFileName(''); setError('') }} rows={8} maxLength={10000000} placeholder="粘贴小说全文，章节标题单独占一行…" /></label>{content && <div className="import-detection"><div><BookOpen size={16} /><span>识别到 <strong>{chapters.length}</strong> 章</span></div><div><FileText size={16} /><span>约 <strong>{formatNumber(totalWords)}</strong> 字</span></div></div>}{chapters.length > 0 && <div className="import-preview">{chapters.slice(0, 6).map((chapter, index) => <span key={`${chapter.title}-${index}`}><b>{String(index + 1).padStart(2, '0')}</b>{chapter.title}<small>{formatNumber(chapter.content.replace(/\s/g, '').length)} 字</small></span>)}{chapters.length > 6 && <em>还有 {chapters.length - 6} 章…</em>}</div>}{error && <div className="skill-runner-validation" role="alert">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={loading} onClick={onClose}>取消</button><button type="submit" className="dark-button" disabled={loading || !content.trim()}>{loading ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}{loading ? '导入中' : '开始导入'}</button></div></form></div></div>
}

function SmartCreateModal({ proposal, loading, onClose, onCreate }) {
  const [form, setForm] = useState(proposal)
  const [error, setError] = useState('')

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  function updateChapter(index, field, value) {
    setForm((current) => ({ ...current, chapters: current.chapters.map((chapter, chapterIndex) => chapterIndex === index ? { ...chapter, [field]: value } : chapter) }))
  }

  function removeChapter(index) {
    setForm((current) => ({ ...current, chapters: current.chapters.filter((_, chapterIndex) => chapterIndex !== index) }))
  }

  function submit(event) {
    event.preventDefault()
    const normalized = {
      ...form,
      title: form.title.trim(),
      genre: form.genre.trim(),
      style: String(form.style || '').trim(),
      tone: form.tone.trim(),
      chapters: form.chapters.map((chapter) => ({ title: chapter.title.trim(), content: chapter.content.trim() })).filter((chapter) => chapter.title && chapter.content),
    }
    if (!normalized.title || !normalized.genre || !normalized.tone || !normalized.chapters.length) {
      setError('请补齐作品名、题材、故事主线和至少一个章节大纲')
      return
    }
    setError('')
    onCreate(normalized)
  }

  return <div className="modal-backdrop smart-create-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !loading && onClose()}><div className="modal smart-create-modal" role="dialog" aria-modal="true" aria-labelledby="smart-create-title"><div className="modal-heading"><div><span className="section-overline">AI 方案校验</span><h2 id="smart-create-title">创建智能作品</h2><p className="modal-subtitle">确认书名、主线和章节大纲后，将一次性生成可编辑的作品。</p></div><button className="icon-button" aria-label="关闭智能创建" disabled={loading} onClick={onClose}><X size={18} /></button></div><form onSubmit={submit}><div className="form-row"><label>作品名<input autoFocus value={form.title} maxLength={80} onChange={(event) => update('title', event.target.value)} /></label><label>篇幅<select value={form.type} onChange={(event) => update('type', event.target.value)}><option>长篇</option><option>短篇</option></select></label></div><div className="form-row"><label>题材<input value={form.genre} maxLength={30} onChange={(event) => update('genre', event.target.value)} /></label><label>流派 / 核心爽点<input value={form.style || ''} maxLength={80} onChange={(event) => update('style', event.target.value)} placeholder="例如：克苏鲁悬疑" /></label></div><label>故事主线<textarea value={form.tone} rows={3} maxLength={2000} onChange={(event) => update('tone', event.target.value)} /></label><div className="smart-outline-heading"><span>初始章节</span><button type="button" className="secondary-button" disabled={loading || form.chapters.length >= 100} onClick={() => setForm((current) => ({ ...current, chapters: [...current.chapters, { title: `第 ${current.chapters.length + 1} 章`, content: '' }] }))}><Plus size={14} />添加章节</button></div><div className="smart-outline-list">{form.chapters.map((chapter, index) => <div className="smart-outline-item" key={index}><span className="smart-outline-index">{String(index + 1).padStart(2, '0')}</span><div><input aria-label={`第 ${index + 1} 章标题`} value={chapter.title} maxLength={100} onChange={(event) => updateChapter(index, 'title', event.target.value)} /><textarea aria-label={`第 ${index + 1} 章大纲`} value={chapter.content} rows={2} maxLength={5000} onChange={(event) => updateChapter(index, 'content', event.target.value)} /></div><button type="button" className="icon-button" aria-label={`删除第 ${index + 1} 章`} title="删除章节" disabled={loading || form.chapters.length <= 1} onClick={() => removeChapter(index)}><Trash2 size={15} /></button></div>)}</div>{error && <div className="skill-runner-validation" role="alert">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={loading} onClick={onClose}>返回修改方案</button><button type="submit" className="dark-button" disabled={loading}>{loading ? <LoaderCircle size={16} className="spin" /> : <BookPlus size={16} />}{loading ? '创建中' : '创建并开始写作'}</button></div></form></div></div>
}

function NewProjectModal({ onClose, onCreate }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-project-title"><div className="modal-heading"><div><span className="section-overline">开始一个新故事</span><h2 id="new-project-title">新建作品</h2></div><button className="icon-button" aria-label="关闭" title="关闭" onClick={onClose}><X size={18} /></button></div><form onSubmit={onCreate}><label>作品名<input name="title" autoFocus placeholder="例如：潮汐之上" /></label><div className="form-row"><label>篇幅<select name="type" defaultValue="长篇"><option>长篇</option><option>短篇</option><option>参考书</option></select></label><label>题材<select name="genre" defaultValue="现代言情"><option>现代言情</option><option>古代言情</option><option>东方玄幻</option><option>悬疑推理</option><option>都市现实</option></select></label></div><label>流派 / 核心爽点<input name="style" maxLength={80} placeholder="例如：重生复仇、甜宠拉扯" /></label><div className="modal-note"><Sparkles size={16} /><span>创建后，你可以先写一句话故事核，其他设定随时补充。</span></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="dark-button"><Plus size={16} />创建作品</button></div></form></div></div>
}

function EditProjectModal({ project, onClose, onSave }) {
  const [form, setForm] = useState({ title: project.title, type: project.type, genre: project.genre, style: project.style || '', status: project.status, tone: project.tone })
  function submit(event) {
    event.preventDefault()
    onSave(form)
  }
  function update(field, value) { setForm((f) => ({ ...f, [field]: value })) }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">编辑作品</span><h2>作品设置</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></div><form onSubmit={submit}><label>作品名<input value={form.title} onChange={(e) => update('title', e.target.value)} maxLength={80} /></label><div className="form-row"><label>篇幅<select value={form.type} onChange={(e) => update('type', e.target.value)}><option>长篇</option><option>短篇</option><option>参考书</option></select></label><label>题材<select value={form.genre} onChange={(e) => update('genre', e.target.value)}><option>现代言情</option><option>古代言情</option><option>东方玄幻</option><option>悬疑推理</option><option>都市现实</option></select></label></div><label>流派 / 核心爽点<input value={form.style} onChange={(e) => update('style', e.target.value)} maxLength={80} placeholder="例如：逆袭打脸、克苏鲁悬疑" /></label><label>状态<select value={form.status} onChange={(e) => update('status', e.target.value)}><option>构思中</option><option>连载中</option><option>已完结</option><option>已拆文</option></select></label><label>创作基调<input value={form.tone} onChange={(e) => update('tone', e.target.value)} maxLength={160} placeholder="一句话描述整体气质" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="dark-button">保存</button></div></form></div></div>
}

function SkillRunnerModal({ skill, skills, loading, result, onClose, onRun, draft, initialMessage = '', context = null, canApplyToDraft = false, onApplyOutput, smartCreateMode = false, onUseSmartResult }) {
  const meta = skillMeta[skill] || { label: skill, command: '' }
  const skillInfo = skills.find((item) => item.name === skill)
  const needsContent = contentSkills.has(skill)
  const hasDraft = Boolean(draft.trim())
  const defaultUseDraft = needsContent && hasDraft && Boolean(context?.chapterId)
  const [message, setMessage] = useState(initialMessage || meta.command || '')
  const [useDraft, setUseDraft] = useState(defaultUseDraft)
  const [customContent, setCustomContent] = useState('')
  const [rewriteMode, setRewriteMode] = useState('similar')
  const [validationError, setValidationError] = useState('')

  useEffect(() => {
    setMessage(initialMessage || meta.command || '')
    setUseDraft(defaultUseDraft)
    setCustomContent('')
    setRewriteMode('similar')
    setValidationError('')
  }, [initialMessage, skill, defaultUseDraft, meta.command])

  const contextPayload = context ? {
    project_id: context.projectId || '',
    chapter_id: context.chapterId || '',
    project_type: context.projectType || '',
    genre: context.genre || '',
    style: context.style || '',
    premise: context.premise || '',
    preferred_writing_skill: context.preferredWritingSkill || '',
    chapter_title: context.chapterTitle || '',
    selected_text: context.selectedText || '',
    source_text: context.sourceText || draft,
    selection_start: context.selectionStart,
    selection_end: context.selectionEnd,
  } : {}
  const payload = needsContent ? { ...contextPayload, content: useDraft ? draft : customContent } : context ? { ...contextPayload, content: draft } : contextPayload
  if (context?.selectedText) payload.rewrite_mode = rewriteMode
  if (canApplyToDraft && skill !== 'story-review') payload.reviewable_edit = true

  function handleRun(event) {
    event.preventDefault()
    if (!message.trim()) return
    if (needsContent && !String(payload.content || '').trim()) {
      setValidationError('请使用当前正文，或粘贴需要处理的内容。')
      return
    }
    setValidationError('')
    onRun(skill, message, payload)
  }

  return <div className="modal-backdrop skill-runner-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="skill-runner-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-runner-title">
      <header className="skill-runner-header">
        <div>
          <span className="section-overline">{meta.label} · {skillInfo?.executor || 'skill'}</span>
          <h2 id="skill-runner-title">{meta.label}</h2>
          <p className="skill-runner-desc">{skillInfo?.description || ''}</p>
        </div>
        <button className="icon-button" aria-label="关闭" title="关闭" onClick={onClose}><X size={19} /></button>
      </header>

      <form className="skill-runner-form" onSubmit={handleRun}>
        <label className="skill-runner-field">
          <span>指令</span>
          <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="输入你的指令…" rows={2} />
        </label>
        {needsContent && (
          <div className="skill-runner-content-toggle">
            <button type="button" className={useDraft ? 'active' : ''} disabled={!hasDraft} onClick={() => setUseDraft(true)}>{hasDraft ? '使用当前正文' : '当前正文为空'}</button>
            <button type="button" className={!useDraft ? 'active' : ''} onClick={() => setUseDraft(false)}>粘贴正文</button>
            {!useDraft && <textarea value={customContent} onChange={(event) => setCustomContent(event.target.value)} placeholder="粘贴需要处理的正文…" rows={4} className="skill-runner-content-input" />}
          </div>
        )}
        {context?.selectedText && <div className="skill-runner-rewrite-modes" aria-label="局部重写长度"><span>重写方式</span>{[['similar', '相近长度'], ['expand', '扩写细节'], ['condense', '精简内容']].map(([value, label]) => <button type="button" key={value} className={rewriteMode === value ? 'active' : ''} onClick={() => setRewriteMode(value)}>{label}</button>)}</div>}
        {context?.selectedText && <div className="skill-runner-selection"><Highlighter size={14} /><span>已关联选中内容 · {formatNumber(context.selectedText.length)} 字</span></div>}
        {validationError && <div className="skill-runner-validation" role="alert">{validationError}</div>}
        <div className="skill-runner-actions">
          <button type="submit" className="dark-button" disabled={loading || !message.trim()}>
            {loading ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}
            <span>{loading ? '执行中' : '执行 Skill'}</span>
          </button>
        </div>
      </form>

      {result && <SkillResultPanel result={result} originalText={context?.selectedText || ''} canApplyToDraft={canApplyToDraft} hasSelection={Boolean(context?.selectedText)} onApplyOutput={onApplyOutput} smartCreateMode={smartCreateMode} onUseSmartResult={onUseSmartResult} />}
    </div>
  </div>
}

function SkillResultPanel({ result, originalText = '', canApplyToDraft = false, hasSelection = false, onApplyOutput, smartCreateMode = false, onUseSmartResult }) {
  const r = result.result || {}
  const statusLabel = { completed: '完成', needs_model: '需模型', needs_input: '需输入', needs_adapter: '需适配', failed: '失败' }[result.status] || result.status
  const isCompleted = result.status === 'completed'
  const proposal = r.edit_proposal || null
  const outputText = typeof (proposal?.revised_text ?? r.output) === 'string' ? (proposal?.revised_text ?? r.output) : r.output ? JSON.stringify(r.output, null, 2) : ''
  const [copied, setCopied] = useState(false)
  const [hunks, setHunks] = useState(() => buildEditHunks(originalText, outputText, proposal?.blocks || []))

  useEffect(() => {
    setHunks(buildEditHunks(originalText, outputText, proposal?.blocks || []))
  }, [originalText, outputText, proposal])

  const changedHunks = hunks.filter((hunk) => hunk.type !== 'equal')
  const reviewedText = changedHunks.length ? composeAcceptedText(hunks) : outputText
  function setAllHunks(accepted) { setHunks((current) => current.map((hunk) => hunk.type === 'equal' ? hunk : { ...hunk, accepted })) }
  function toggleHunk(id, accepted) { setHunks((current) => current.map((hunk) => hunk.id === id ? { ...hunk, accepted } : hunk)) }

  async function copyOutput() {
    if (!outputText) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(outputText)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = outputText
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      textarea.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return <section className="skill-result-panel">
    <div className="skill-result-header">
      <span className={`skill-result-status ${result.status}`}>{statusLabel}</span>
      <span className="skill-result-skill">{result.selected_skill}</span>
      <span className="skill-result-route">{result.route}</span>
    </div>

    {result.status === 'needs_model' && (
      <div className="skill-result-notice"><Info size={15} /><p>{r.message || '执行该 Skill 需要配置 OPENAI_API_KEY。'}</p></div>
    )}
    {result.status === 'needs_input' && (
      <div className="skill-result-notice"><Info size={15} /><p>{r.message || '请补充所需输入。'}</p></div>
    )}
    {result.status === 'needs_adapter' && (
      <div className="skill-result-notice"><Info size={15} /><p>{r.message || '该 Skill 已注册，但当前应用还没有可执行它的适配器。'}</p></div>
    )}
    {result.status === 'failed' && (
      <div className="skill-result-notice skill-result-error"><Info size={15} /><p>{r.message || '执行失败。'}</p></div>
    )}

    {r.references_loaded && r.references_loaded.length > 0 && (
      <div className="skill-result-refs">
        <span className="skill-result-refs-label">已加载引用{r.references_truncated ? '（部分截断）' : ''}</span>
        <div className="skill-result-refs-list">{r.references_loaded.map((ref) => <span key={ref} className="skill-result-ref-chip">{ref}</span>)}</div>
      </div>
    )}

    {r.checks && r.checks.length > 0 && (
      <div className="skill-result-checks">
        <span className="skill-result-checks-label">确定性检查 · {r.checks.length} 项</span>
        <div className="skill-result-checks-list">{r.checks.slice(0, 8).map((check, index) => <div key={index} className="skill-result-check"><span className={`severity-pill ${check.severity.toLowerCase()}`}>{check.severity}</span><span>{check.issue}</span></div>)}</div>
      </div>
    )}

    {outputText && (
      <div className="skill-result-output">
        <div className="skill-result-output-heading"><span className="skill-result-output-label">{proposal ? '可审阅修改建议' : isCompleted ? '输出' : '执行详情'}</span>{isCompleted && <div className="skill-result-output-actions"><button type="button" onClick={copyOutput}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制结果'}</button>{proposal && changedHunks.length > 0 && <><button type="button" onClick={() => setAllHunks(true)}>全部接受</button><button type="button" onClick={() => setAllHunks(false)}>全部拒绝</button></>}{smartCreateMode && onUseSmartResult && <button type="button" className="smart-result-button" onClick={() => onUseSmartResult(result)}><BookPlus size={14} />使用方案创建</button>}{canApplyToDraft && onApplyOutput && <><button type="button" onClick={() => onApplyOutput(reviewedText, 'insert', { taskId: result.taskId, summary: proposal?.summary || '' })}><PenLine size={14} />{hasSelection ? '应用已接受修改' : '插入正文'}</button><button type="button" className="replace-output" onClick={() => onApplyOutput(reviewedText, 'replace', { taskId: result.taskId, summary: proposal?.summary || '' })}><Wand2 size={14} />替换全文</button></>}</div>}</div>
        {proposal && proposal.summary && <p className="edit-proposal-summary"><Info size={14} />{proposal.summary}。以下内容尚未修改正文。</p>}
        {proposal && changedHunks.length > 0 ? <div className="edit-hunk-list">{changedHunks.map((hunk, index) => <article className={`edit-hunk ${hunk.accepted ? 'accepted' : 'rejected'}`} key={hunk.id}><header><strong>修改 {index + 1}</strong><span>{hunk.type === 'insert' ? '新增' : hunk.type === 'delete' ? '删除' : '替换'}</span><div><button className={hunk.accepted ? 'active' : ''} onClick={() => toggleHunk(hunk.id, true)}><Check size={13} />接受</button><button className={!hunk.accepted ? 'active' : ''} onClick={() => toggleHunk(hunk.id, false)}><X size={13} />拒绝</button></div></header>{hunk.original && <div className="edit-hunk-copy original"><span>原文</span><pre>{hunk.original}</pre></div>}{hunk.replacement && <div className="edit-hunk-copy replacement"><span>建议</span><pre>{hunk.replacement}</pre></div>}<p><Info size={13} />{hunk.reason}</p></article>)}</div> : originalText ? <div className="skill-result-comparison"><div><span>原文选区</span><pre>{originalText}</pre></div><div><span>AI 新内容</span><pre>{outputText}</pre></div></div> : <pre className="skill-result-output-text">{outputText}</pre>}
      </div>
    )}

    {r.findings && r.findings.length > 0 && (
      <div className="skill-result-findings">
        <span className="skill-result-findings-label">问题清单 · {r.findings.length} 项</span>
        {r.findings.slice(0, 10).map((finding, index) => <div key={index} className="skill-result-finding"><span className={`severity-pill ${finding.severity.toLowerCase()}`}>{finding.severity}</span><strong>{finding.issue}</strong><p>{finding.fix}</p></div>)}
      </div>
    )}
  </section>
}

function SettingsModal({ onClose, onNotify }) {
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [modelList, setModelList] = useState([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const [form, setForm] = useState({ provider: 'openai', apiBaseUrl: '', apiKey: '', model: '', temperature: 0.7, maxTokens: 4096, contextWindow: 16384 })

  useEffect(() => {
    let mounted = true
    api.getSettings()
      .then((response) => {
        if (!mounted) return
        const s = response.settings || {}
        setSettings(s)
        setForm({
          provider: s.provider === 'anthropic' ? 'anthropic' : 'openai',
          apiBaseUrl: s.apiBaseUrl || '',
          apiKey: '',
          model: s.model || '',
          temperature: s.temperature ?? 0.7,
          maxTokens: s.maxTokens ?? 4096,
          contextWindow: s.contextWindow ?? 16384,
        })
      })
      .catch(() => { if (mounted) onNotify('读取设置失败') })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [])

  async function handleSave(event) {
    event.preventDefault()
    setSaving(true)
    try {
      const response = await api.updateSettings(form)
      setSettings(response.settings)
      setForm((current) => ({ ...current, apiKey: '' }))
      onNotify('设置已保存')
    } catch (error) {
      onNotify(error.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleFetchModels() {
    setFetchingModels(true)
    try {
      const response = await api.getModels()
      setModelList(response.models || [])
      if (!(response.models || []).length) onNotify('未获取到模型列表，请检查 API 配置')
    } catch (error) {
      onNotify(error.message || '获取模型列表失败')
    } finally {
      setFetchingModels(false)
    }
  }

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  const apiKeyPlaceholder = settings?.apiKeyMask ? `已配置 ${settings.apiKeyMask}，留空不修改` : '输入 API Key'

  return <div className="modal-backdrop settings-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="settings-header">
        <div>
          <span className="section-overline">模型配置</span>
          <h2 id="settings-title">设置</h2>
          <p className="settings-subtitle">配置你的 LLM API，所有 Skill 调用将使用此配置。API Key 加密存储。</p>
        </div>
        <button className="icon-button" aria-label="关闭" title="关闭" onClick={onClose}><X size={19} /></button>
      </header>

      {loading ? (
        <div className="settings-loading"><LoaderCircle size={20} className="spin" /><span>正在读取设置</span></div>
      ) : (
        <form className="settings-form" onSubmit={handleSave}>
          <label className="settings-field">
            <span>模型服务商</span>
            <select value={form.provider} onChange={(e) => updateField('provider', e.target.value)}>
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic（Claude）</option>
            </select>
            <small>选择 OpenAI 兼容或 Anthropic 格式；两者均可填自定义 Base URL 走代理</small>
          </label>

          <label className="settings-field">
            <span>API Base URL</span>
            <input type="url" value={form.apiBaseUrl} onChange={(e) => updateField('apiBaseUrl', e.target.value)} placeholder={form.provider === 'anthropic' ? 'https://api.anthropic.com/v1（留空用官方）' : 'https://api.openai.com/v1'} />
            <small>{form.provider === 'anthropic' ? 'Anthropic 兼容地址，留空使用官方 API' : 'OpenAI 兼容 API 地址，留空使用服务端默认'}</small>
          </label>

          <label className="settings-field">
            <span>API Key</span>
            <input type="password" value={form.apiKey} onChange={(e) => updateField('apiKey', e.target.value)} placeholder={apiKeyPlaceholder} autoComplete="off" />
            <small>{settings?.apiKeyMask ? `当前已配置 ${settings.apiKeyMask}，留空则不修改` : '加密存储在服务端'}</small>
          </label>

          <div className="settings-model-row">
            <label className="settings-field settings-model-field">
              <span>模型名</span>
              <input type="text" value={form.model} onChange={(e) => updateField('model', e.target.value)} placeholder={form.provider === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'gpt-4o-mini'} list="model-list" />
              <small>输入或从下拉选择</small>
            </label>
            <button type="button" className="settings-fetch-models" disabled={fetchingModels} onClick={handleFetchModels}>
              {fetchingModels ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}
              <span>{fetchingModels ? '获取中' : '获取模型列表'}</span>
            </button>
          </div>
          {modelList.length > 0 && <datalist id="model-list">{modelList.map((m) => <option key={m} value={m} />)}</datalist>}

          <label className="settings-field">
            <span>Temperature · {Number(form.temperature).toFixed(1)}</span>
            <input type="range" min="0" max="2" step="0.1" value={form.temperature} onChange={(e) => updateField('temperature', Number(e.target.value))} className="settings-slider" />
            <small>0 精确确定性，2 高随机性</small>
          </label>

          <div className="settings-number-row">
            <label className="settings-field">
              <span>Max Tokens（最大输出）</span>
              <input type="number" min="256" max="128000" step="256" value={form.maxTokens} onChange={(e) => updateField('maxTokens', Number(e.target.value))} />
            </label>
            <label className="settings-field">
              <span>上下文窗口（Tokens）</span>
              <input type="number" min="4096" max="1000000" step="1024" value={form.contextWindow} onChange={(e) => updateField('contextWindow', Number(e.target.value))} />
            </label>
          </div>

          <div className="settings-actions">
            <button type="button" className="secondary-button" onClick={onClose}>取消</button>
            <button type="submit" className="dark-button" disabled={saving}>
              {saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
              <span>{saving ? '保存中' : '保存设置'}</span>
            </button>
          </div>
        </form>
      )}
    </div>
  </div>
}

export default App
