import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpDown,
  ArrowUpRight,
  AlignLeft,
  BarChart3,
  BookOpen,
  BookMarked,
  BookOpenCheck,
  BookPlus,
  Bot,
  BrainCircuit,
  Check,
  CheckSquare2,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Copy,
  Clock3,
  Code2,
  Command,
  Download,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Flame,
  Globe,
  Highlighter,
  History,
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
  Paperclip,
  Package,
  PenLine,
  Pin,
  Plus,
  Redo2,
  Search,
  SearchCode,
  Send,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Split,
  Store,
  Target,
  Tags,
  Trophy,
  Trash2,
  Type,
  Undo2,
  UserRound,
  UploadCloud,
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
import { NOVEL_COMMANDS, parseSlashCommand, resolveSelection } from '../terminal/commands.mjs'
import {
  agentEventDuration,
  agentResponseText,
  agentTurnEvents,
  agentThreadMessages,
  compactAgentEvents,
  formatAgentDuration,
  isEditorAgentEdit,
  normalizeStructuredAgentQuestion,
  parseAgentChoicePrompt,
  resolveEditorAgentCommand,
  waitForAgentPoll,
} from './editor-agent.mjs'
import AgentMarkdown from './agent-markdown.jsx'

const ASSISTANT_NAME = '夜雨'
const SIDEBAR_COLLAPSED_KEY = 'story-studio-sidebar-collapsed'
const SOURCE_REPOSITORY_URL = import.meta.env.VITE_SOURCE_REPOSITORY_URL || 'https://github.com/rtiy1/YeMuAINoval'
const callableSkill = (skill) => skill?.status === 'ready' || skill?.status === 'needs_model'
const PROJECT_GENRE_GROUPS = [
  {
    label: '幻想与冒险',
    options: ['东方玄幻', '西方奇幻', '武侠仙侠', '玄幻言情', '科幻末世', '无限流', '规则怪谈', '游戏竞技', '轻小说'],
  },
  {
    label: '都市与现实',
    options: ['都市现实', '都市生活', '都市高武', '都市修真', '都市脑洞', '职场商战', '战神赘婿', '年代'],
  },
  {
    label: '情感与关系',
    options: ['现代言情', '古代言情', '豪门总裁', '青春甜宠', '职场婚恋', '宫斗宅斗', '种田经商', '快穿', '双男主'],
  },
  {
    label: '悬疑与历史',
    options: ['悬疑推理', '悬疑灵异', '女频悬疑', '历史架空', '历史脑洞', '民国言情', '抗战谍战', '群像'],
  },
]
const PROJECT_GENRES = PROJECT_GENRE_GROUPS.flatMap((group) => group.options)

const primaryNavItems = [
  { id: 'editor', label: '工作台', icon: PenLine },
  { id: 'works', label: '我的作品', icon: BookOpen },
  { id: 'library', label: '素材库', icon: Library },
  { id: 'skill-market', label: '技能市场', icon: Store },
  { id: 'stats', label: '写作统计', icon: BarChart3 },
  { id: 'profile', label: '个人中心', icon: UserRound },
]

const navItems = primaryNavItems

const editorAgentCommands = NOVEL_COMMANDS
  .map(([usage, description]) => {
    const name = usage.match(/^\/([a-z]+)/)?.[1] || ''
    return { name, usage, description, insertText: `/${name} `, kind: 'command' }
  })

const agentReasoningOptions = [
  { value: '', label: '自动', description: '由模型根据当前任务自行决定', badge: '推荐' },
  { value: 'minimal', label: '最低', description: '几乎不推理，优先获得最快响应' },
  { value: 'low', label: '低', description: '适合改写、摘要等轻量任务' },
  { value: 'medium', label: '中', description: '平衡响应速度与创作质量' },
  { value: 'high', label: '高', description: '适合结构、人物与复杂修改' },
  { value: 'xhigh', label: '极高', description: '更深入地推演长篇上下文' },
  { value: 'max', label: 'MAX', description: '使用模型支持的最高推理强度', badge: '最深' },
]

const agentModeOptions = [
  { value: 'build', label: 'Build', description: '创作、续写并生成可审阅修改', badge: '默认' },
  { value: 'review', label: 'Review', description: '只审查问题，不直接改写正文' },
  { value: 'plan', label: 'Plan', description: '只读分析、收敛决策并输出可执行计划' },
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

function compactTokenCount(value) {
  const number = Math.max(0, Number(value || 0))
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}M`
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`
  return number.toLocaleString('zh-CN')
}

function agentRunTokenUsage(run) {
  const result = run?.response?.result || {}
  const usage = run?.usage || result.usage || run?.response?.usage || {}
  const output = String(result.edit_proposal?.revised_text || result.output || result.summary || result.message || run?.text || '')
  const source = String(run?.source?.selectedText || run?.source?.sourceText || '')
  const hasUsage = Number(usage.input_tokens) || Number(usage.output_tokens) || Number(usage.cached_input_tokens)
  const inputTokens = Math.max(0, Number(usage.input_tokens || (source ? Math.ceil(source.length / 2.2) : 0)))
  const outputTokens = Math.max(0, Number(usage.output_tokens || (output ? Math.ceil(output.length / 2.2) : 0)))
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: Math.max(0, Number(usage.cached_input_tokens || 0)),
    reasoningTokens: Math.max(0, Number(usage.reasoning_output_tokens || 0)),
    estimated: usage.estimated === true || !hasUsage,
  }
}

function AgentEventIcon({ event }) {
  if (event.status === 'running') return <LoaderCircle size={13} className="spin" />
  if (['failed', 'cancelled', 'interrupted'].includes(event.status)) return <X size={13} />
  if (event.type === 'subagent') return <UsersRound size={13} />
  if (event.type === 'context') return <SearchCode size={13} />
  if (event.type === 'skill') return <Code2 size={13} />
  if (event.type === 'result') return <FileText size={13} />
  return <Check size={13} />
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
  const [passwordResetToken, setPasswordResetToken] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('reset_token') || ''
    } catch {
      return ''
    }
  })
  const [authMode, setAuthMode] = useState(() => passwordResetToken ? 'reset' : 'login')
  const [authError, setAuthError] = useState('')
  const [activeSection, setActiveSection] = useState('editor')
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
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
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
  const draftRef = useRef('')
  const savedDraftRef = useRef('')
  const activeDraftKeyRef = useRef('')
  const saveQueueRef = useRef(Promise.resolve())
  const skillSubmissionRef = useRef(null)
  const profileMenuRef = useRef(null)

  useEffect(() => {
    if (passwordResetToken) {
      setUser(null)
      setAuthLoading(false)
      return undefined
    }
    let mounted = true
    api.restoreSession()
      .then((session) => { if (mounted) setUser(session?.user || null) })
      .catch(() => { if (mounted) setUser(null) })
      .finally(() => { if (mounted) setAuthLoading(false) })
    return () => { mounted = false }
  }, [passwordResetToken])

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
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed))
    } catch {
      // 浏览器禁用本地存储时仍可在当前会话使用折叠状态。
    }
  }, [sidebarCollapsed])

  useEffect(() => {
    if (!profileMenuOpen) return undefined
    function closeProfileMenu(event) {
      if (!profileMenuRef.current?.contains(event.target)) setProfileMenuOpen(false)
    }
    function closeProfileMenuOnEscape(event) {
      if (event.key === 'Escape') setProfileMenuOpen(false)
    }
    document.addEventListener('mousedown', closeProfileMenu)
    document.addEventListener('keydown', closeProfileMenuOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeProfileMenu)
      document.removeEventListener('keydown', closeProfileMenuOnEscape)
    }
  }, [profileMenuOpen])

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
      const response = await api.createSmartProject(proposal)
      setProjects((current) => [response.project, ...current.map((project) => ({ ...project, isActive: false }))])
      setActiveProject(response.project)
      setChapters(response.chapters || [])
      setActiveChapterId(response.chapters?.[0]?.id ?? null)
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
      return response.chapter
    } catch (error) {
      setToast(error.message)
      return null
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
      const response = await api.confirmStoryMemories(currentProject.id, candidates.map((candidate) => ({ ...candidate, characterName: candidate.characterName ?? candidate.character_name ?? '', replacesMemoryId: candidate.replacesMemoryId ?? candidate.replaces_memory_id ?? null, sourceChapterId: candidate.sourceChapterId ?? activeChapterId })))
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
      let task = created.task
      for (let attempt = 0; attempt < 240 && ['queued', 'running'].includes(task.status); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 700))
        const response = await api.getAiTask(task.id)
        task = response.task
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
      if (authMode === 'forgot') return await api.requestPasswordReset(credentials.email)
      if (authMode === 'reset') {
        const response = await api.resetPassword(passwordResetToken, credentials.password)
        setPasswordResetToken('')
        const url = new URL(window.location.href)
        url.searchParams.delete('reset_token')
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
        setAuthMode('login')
        return response
      }
      const response = authMode === 'register' ? await api.register(credentials) : await api.login(credentials)
      setUser(response.user)
      setActiveSection('editor')
      return response
    } catch (error) {
      setAuthError(error.message)
      return null
    }
  }

  function changeAuthMode(mode) {
    setAuthMode(mode)
    setAuthError('')
    if (mode !== 'reset' && passwordResetToken) {
      setPasswordResetToken('')
      const url = new URL(window.location.href)
      url.searchParams.delete('reset_token')
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
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
    setActiveSection('editor')
    setAuthMode('login')
  }

  if (authLoading) {
    return <div className="auth-loading"><div className="brand-mark"><span>叙</span></div><LoaderCircle size={20} className="spin" /><span>正在恢复创作空间</span></div>
  }

  if (!user) {
    return <AuthScreen mode={authMode} error={authError} onModeChange={changeAuthMode} onSubmit={submitAuth} />
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

        <div className="sidebar-section-label">创作空间</div>
        <nav className="primary-nav" aria-label="主导航">
          {primaryNavItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${activeSection === id ? 'active' : ''}`} aria-label={label} title={sidebarCollapsed ? label : undefined} onClick={() => selectSection(id)}>
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {id === 'library' && <span className="nav-count">{ideas.length}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-section-label recent-label">我的书架 · {projects.length}</div>
        <div className="recent-projects project-shelf">
          {projects.map((project) => (
            <button key={project.id} className={`recent-project ${String(currentProject?.id) === String(project.id) ? 'active' : ''}`} onClick={() => openProject(project)}>
              <span className={`mini-cover ${project.cover}`} aria-hidden="true">{project.title.slice(0, 1)}</span>
              <span className="recent-project-name">{project.title}</span>
              {String(currentProject?.id) === String(project.id) && <span className="active-dot" />}
            </button>
          ))}
          {!projects.length && <p className="project-shelf-empty">新建作品后会显示在这里</p>}
        </div>

        <div className="sidebar-bottom">
          <button className="nav-item" aria-label="设置" title={sidebarCollapsed ? '设置' : undefined} onClick={() => setSettingsOpen(true)}><Settings2 size={17} strokeWidth={1.8} /><span>设置</span></button>
          <button className="nav-item" aria-label="退出登录" title={sidebarCollapsed ? '退出登录' : undefined} onClick={logout}><LogOut size={17} strokeWidth={1.8} /><span>退出登录</span></button>
          <div className="profile-chip" ref={profileMenuRef}>
            <div className="avatar">{user.name.slice(0, 1)}</div>
            <div className="profile-copy"><strong>{user.name}</strong><span>{user.email}</span></div>
            <button type="button" className={`profile-more-button ${profileMenuOpen ? 'active' : ''}`} aria-label="打开账户菜单" aria-expanded={profileMenuOpen} onClick={() => setProfileMenuOpen((open) => !open)}><MoreHorizontal size={16} /></button>
            {profileMenuOpen && <div className="profile-menu" role="menu">
              <div className="profile-menu-heading"><div className="avatar small">{user.name.slice(0, 1)}</div><span><strong>{user.name}</strong><small>{user.email}</small></span></div>
              <button type="button" role="menuitem" onClick={() => { setProfileMenuOpen(false); selectSection('profile') }}><UserRound size={14} /><span>个人中心</span></button>
              <button type="button" role="menuitem" onClick={() => { setProfileMenuOpen(false); setSettingsOpen(true) }}><Settings2 size={14} /><span>设置</span></button>
              <span className="profile-menu-divider" />
              <button type="button" role="menuitem" className="danger" onClick={() => { setProfileMenuOpen(false); logout() }}><LogOut size={14} /><span>退出登录</span></button>
            </div>}
          </div>
        </div>
      </aside>

      <main className="main-shell">
        {activeSection !== 'editor' && <header className="topbar">
          <button className="mobile-menu-button icon-button" aria-label="打开菜单" onClick={() => setShowMobileMenu((open) => !open)} title="打开菜单"><Menu size={20} /></button>
          <div className="breadcrumbs">
            <span>{navItems.find((item) => item.id === activeSection)?.label || '叙事工坊'}</span>
          </div>
          <div className="topbar-actions">
            <button className="search-button" onClick={() => setSearchOpen(true)}><Search size={17} /><span>搜索</span><kbd>⌘ K</kbd></button>
            <button className="primary-button top-new-button" onClick={() => setShowNew(true)}><Plus size={17} />新建作品</button>
          </div>
        </header>}

        <div className="content-wrap">
          {activeSection === 'editor' && currentProject && <Editor project={currentProject} projects={projects} skills={skillCatalog} chapters={chapters} activeChapter={activeChapter} ideas={ideas} foreshadows={foreshadows} storyMemories={storyMemories.filter((memory) => memory.projectId === currentProject.id)} onUpdateStoryMemory={updateStoryMemory} onDeleteStoryMemory={deleteStoryMemory} onConfirmStoryMemories={confirmStoryMemories} onCreateForeshadow={createForeshadow} onUpdateForeshadow={updateForeshadow} onDeleteForeshadow={deleteForeshadow} draft={draft} onDraftChange={updateDraft} draftStatus={draftStatus} draftLoading={draftLoading} wordCount={wordCount} historySnapshots={historySnapshots} historyLoading={historyLoading} onCreateHistory={createHistorySnapshot} lastAiRestore={lastAiRestore} onAiApplied={(snapshot) => setLastAiRestore(snapshot)} onAiRestored={() => setLastAiRestore(null)} onNotify={notify} onSave={saveDraft} onReview={reviewChapter} reviewLoading={reviewLoading} reviewPlatform={reviewPlatform} onPlatformChange={setReviewPlatform} onDeslop={deslopChapter} deslopLoading={deslopLoading} onNewChapter={createChapter} onSplitChapter={splitChapter} onSelectChapter={selectChapter} onRenameChapter={renameChapter} onUpdateChapterState={updateChapterState} onDeleteChapter={deleteChapter} onOpenProject={openProject} onOpenSkill={openSkillRunner} onOpenSettings={() => setSettingsOpen(true)} applyRequest={editorApplyRequest} onApplyRequestHandled={() => setEditorApplyRequest(null)} />}
          {activeSection === 'editor' && !currentProject && <div className="page inner-page workspace-empty"><div className="empty-state"><div className="empty-state-icon"><BookOpen size={28} /></div><h2>还没有作品</h2><p>新建或导入作品后，工作台会直接显示正文和助手。</p><div className="empty-state-actions"><button className="primary-button" onClick={() => setShowNew(true)}><BookPlus size={17} />新建作品</button><button className="secondary-button" onClick={() => setImportProjectOpen(true)}><Download size={16} />导入文稿</button></div></div></div>}
          {activeSection === 'works' && <Works projects={projects} onOpen={openProject} onNew={() => setShowNew(true)} onEdit={(p) => setEditProjectTarget(p)} onDelete={deleteProject} onImport={() => setImportProjectOpen(true)} />}
          {activeSection === 'library' && <LibraryView ideas={ideas} onCreate={createIdea} onEditIdea={editIdea} onDeleteIdea={deleteIdea} projects={projects} />}
          {activeSection === 'skill-market' && <SkillMarket user={user} onNotify={notify} onSkillsChanged={refreshSkills} />}
          {activeSection === 'stats' && <WritingStats stats={dashboard} projects={projects} />}
          {activeSection === 'profile' && <ProfileCenter user={user} stats={dashboard} projects={projects} onNavigate={selectSection} onOpenSettings={() => setSettingsOpen(true)} onOpenProject={openProject} />}
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
      {toast && <div className={`toast ${toastKind(toast)}`} role="status" aria-live="polite">{toastKind(toast) === 'loading' ? <LoaderCircle size={16} className="spin" /> : toastKind(toast) === 'error' ? <Info size={16} /> : <Check size={16} />}{toast}</div>}
    </div>
  )
}

function composerTriggerAt(value, cursor) {
  const text = String(value || '')
  const position = Number.isFinite(cursor) ? cursor : text.length
  const before = text.slice(0, position)
  const lineStart = before.lastIndexOf('\n') + 1
  const line = before.slice(lineStart)
  if (/^\/[^\s]*$/.test(line)) {
    return { type: 'command', query: line.slice(1).toLowerCase(), start: lineStart, end: position }
  }
  const mention = before.match(/(?:^|\s)@([^\s@]*)$/)
  if (mention) {
    const start = before.lastIndexOf('@')
    return { type: 'file', query: mention[1].toLowerCase(), start, end: position }
  }
  return null
}

function writingLevel(words) {
  const value = Number(words || 0)
  if (!value) return 0
  if (value < 500) return 1
  if (value < 1500) return 2
  if (value < 3000) return 3
  return 4
}

function WritingCalendar({ days = [] }) {
  const calendarDays = days.length ? days : Array.from({ length: 365 }, (_, index) => {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - (364 - index))
    return { date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, words: 0 }
  })
  const firstDate = new Date(`${calendarDays[0].date}T00:00:00`)
  const leadingDays = (firstDate.getDay() + 6) % 7
  const calendarCells = [...Array.from({ length: leadingDays }, () => null), ...calendarDays]
  const months = []
  for (const day of calendarDays) {
    const key = day.date.slice(0, 7)
    if (months.at(-1)?.key !== key) months.push({ key, label: `${Number(key.slice(5, 7))}月` })
  }

  return <div className="writing-calendar">
    <div className="calendar-months">{months.map((month) => <span key={month.key}>{month.label}</span>)}</div>
    <div className="calendar-body">
      <div className="calendar-weekdays" aria-hidden="true"><span>一</span><span /><span>三</span><span /><span>五</span><span /><span>日</span></div>
      <div className="calendar-grid" role="img" aria-label="过去一年每日写作字数日历">
        {calendarCells.map((day, index) => day
          ? <span key={day.date} className={`calendar-cell level-${writingLevel(day.words)}`} title={`${day.date} · ${formatNumber(day.words)} 字`} aria-label={`${day.date}，写作 ${formatNumber(day.words)} 字`} />
          : <span key={`blank-${index}`} className="calendar-cell blank" aria-hidden="true" />)}
      </div>
    </div>
    <div className="calendar-legend"><span>少</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`calendar-cell level-${level}`} />)}<span>多</span></div>
  </div>
}

function WritingStats({ stats, projects }) {
  const rankedProjects = [...projects].sort((left, right) => Number(String(right.words || '0').replaceAll(',', '')) - Number(String(left.words || '0').replaceAll(',', ''))).slice(0, 5)
  const metricCards = [
    { label: '累计字数', value: formatNumber(stats?.totalWords), suffix: '字', icon: FileText, tone: 'coral' },
    { label: '本月写作', value: formatNumber(stats?.monthWords), suffix: '字', icon: CalendarDays, tone: 'teal' },
    { label: '今日新增', value: formatNumber(stats?.todayWords), suffix: '字', icon: PenLine, tone: 'purple' },
    { label: '作品数量', value: formatNumber(stats?.projectCount), suffix: '部', icon: BookOpen, tone: 'yellow' },
    { label: '章节总数', value: formatNumber(stats?.chapterCount), suffix: '章', icon: List, tone: 'blue' },
    { label: '写作日均', value: formatNumber(stats?.averageWordsPerWritingDay), suffix: '字', icon: BarChart3, tone: 'green' },
  ]

  return <div className="page inner-page analytics-page">
    <div className="page-heading analytics-heading">
      <div><span className="section-overline">WRITING INSIGHTS</span><h1>写作统计</h1><p>每一次保存都算数。这里记录你的创作节奏，而不只是最终字数。</p></div>
      <div className="analytics-period"><CalendarDays size={16} /><span>过去 365 天</span></div>
    </div>

    <section className="writing-calendar-card">
      <div className="calendar-summary">
        <div className="writing-days-total"><small>累计写作</small><div><strong>{formatNumber(stats?.totalWritingDays)}</strong><span>天</span></div><p>{stats?.firstWritingDate ? `从 ${stats.firstWritingDate.replaceAll('-', '.')} 开始记录` : '从今天开始留下第一格'}</p></div>
        <div className="streak-summary">
          <div><span className="streak-icon current"><Flame size={18} /></span><p><small>当前连续</small><strong>{formatNumber(stats?.currentStreak)} 天</strong></p></div>
          <div><span className="streak-icon best"><Trophy size={18} /></span><p><small>最长连续</small><strong>{formatNumber(stats?.longestStreak)} 天</strong></p></div>
        </div>
      </div>
      <WritingCalendar days={stats?.calendar || []} />
    </section>

    <section className="analytics-metrics" aria-label="写作指标">
      {metricCards.map(({ label, value, suffix, icon: Icon, tone }) => <article className="analytics-metric-card" key={label}>
        <span className={`metric-icon ${tone}`}><Icon size={17} /></span>
        <small>{label}</small>
        <div><strong>{value}</strong><span>{suffix}</span></div>
      </article>)}
    </section>

    <div className="analytics-detail-grid">
      <WritingPulse stats={stats} />
      <section className="project-ranking">
        <div className="section-heading compact"><div><span className="section-overline">作品贡献</span><h2>字数分布</h2></div><span className="tiny-meta">{projects.length} 部作品</span></div>
        <div className="ranking-list">
          {rankedProjects.length ? rankedProjects.map((project, index) => {
            const words = Number(String(project.words || '0').replaceAll(',', ''))
            const share = stats?.totalWords ? Math.round((words / stats.totalWords) * 100) : 0
            return <div className="ranking-item" key={project.id}>
              <span className="ranking-index">{String(index + 1).padStart(2, '0')}</span>
              <span className={`mini-cover ${project.cover}`}>{project.title.slice(0, 1)}</span>
              <div><strong>{project.title}</strong><span><i style={{ width: `${share}%` }} /></span></div>
              <p><strong>{formatNumber(words)}</strong><small>字</small></p>
            </div>
          }) : <div className="ranking-empty"><BookOpen size={21} /><p>创建第一部作品后，这里会显示字数贡献。</p></div>}
        </div>
      </section>
    </div>
  </div>
}

function ProfileCenter({ user, stats, projects, onNavigate, onOpenSettings, onOpenProject }) {
  const joinedAt = user?.createdAt ? new Date(user.createdAt) : null
  const joinedDays = joinedAt && !Number.isNaN(joinedAt.getTime()) ? Math.max(1, Math.floor((Date.now() - joinedAt.getTime()) / 86_400_000) + 1) : 1
  const recentProjects = [...projects].sort((left, right) => new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0)).slice(0, 3)
  const milestones = [
    { label: '第一部作品', description: '建立属于自己的故事世界', earned: Number(stats?.projectCount || 0) >= 1, icon: BookPlus },
    { label: '万字作者', description: '累计完成 10,000 字', earned: Number(stats?.totalWords || 0) >= 10000, icon: PenLine },
    { label: '七日执笔', description: '累计写作达到 7 天', earned: Number(stats?.totalWritingDays || 0) >= 7, icon: Flame },
    { label: '完成一本', description: '至少有一部作品已完结', earned: Number(stats?.completedProjects || 0) >= 1, icon: Trophy },
  ]

  return <div className="page inner-page profile-page">
    <section className="profile-hero">
      <div className="profile-avatar-large">{user?.name?.slice(0, 1) || '作'}</div>
      <div className="profile-hero-copy"><span className="section-overline">AUTHOR PROFILE</span><h1>{user?.name || '创作者'}</h1><p>{user?.email}</p><div><span><Clock3 size={13} />加入创作空间第 {formatNumber(joinedDays)} 天</span><span><PenLine size={13} />累计写作 {formatNumber(stats?.totalWritingDays)} 天</span></div></div>
      <button className="secondary-button profile-settings-button" onClick={onOpenSettings}><Settings2 size={16} />模型与 API 设置</button>
    </section>

    <section className="profile-overview-grid">
      <article><small>累计创作</small><div><strong>{formatNumber(stats?.totalWords)}</strong><span>字</span></div><p>所有作品正文总和</p></article>
      <article><small>作品空间</small><div><strong>{formatNumber(stats?.projectCount)}</strong><span>部</span></div><p>{formatNumber(stats?.chapterCount)} 个章节</p></article>
      <article><small>连续写作</small><div><strong>{formatNumber(stats?.currentStreak)}</strong><span>天</span></div><p>历史最佳 {formatNumber(stats?.longestStreak)} 天</p></article>
      <article><small>本月进度</small><div><strong>{formatNumber(stats?.monthWords)}</strong><span>字</span></div><p>今天新增 {formatNumber(stats?.todayWords)} 字</p></article>
    </section>

    <div className="profile-content-grid">
      <section className="profile-panel">
        <div className="section-heading compact"><div><span className="section-overline">创作成就</span><h2>里程碑</h2></div><span className="tiny-meta">{milestones.filter((item) => item.earned).length} / {milestones.length} 已获得</span></div>
        <div className="milestone-grid">
          {milestones.map(({ label, description, earned, icon: Icon }) => <div className={`milestone-card ${earned ? 'earned' : ''}`} key={label}><span><Icon size={18} /></span><div><strong>{label}</strong><small>{description}</small></div>{earned && <Check size={14} />}</div>)}
        </div>
      </section>

      <section className="profile-panel account-panel">
        <div className="section-heading compact"><div><span className="section-overline">账号信息</span><h2>个人资料</h2></div></div>
        <dl><div><dt>创作者名称</dt><dd>{user?.name || '—'}</dd></div><div><dt>登录邮箱</dt><dd>{user?.email || '—'}</dd></div><div><dt>加入时间</dt><dd>{joinedAt && !Number.isNaN(joinedAt.getTime()) ? joinedAt.toLocaleDateString('zh-CN') : '—'}</dd></div></dl>
        <button className="text-button" onClick={() => onNavigate('stats')}><BarChart3 size={15} />查看完整写作统计<ChevronRight size={15} /></button>
      </section>
    </div>

    <section className="profile-panel profile-recent-projects">
      <div className="section-heading compact"><div><span className="section-overline">最近创作</span><h2>继续你的故事</h2></div><button className="text-button" onClick={() => onNavigate('works')}>管理全部作品 <ArrowUpRight size={15} /></button></div>
      <div className="profile-project-list">
        {recentProjects.length ? recentProjects.map((project) => <button key={project.id} onClick={() => onOpenProject(project)}><span className={`row-cover ${project.cover}`}>{project.title.slice(0, 1)}</span><span><strong>{project.title}</strong><small>{project.genre} · {project.chapters || 0} 章 · {project.words || 0} 字</small></span><em>{project.progress || 0}%</em><ChevronRight size={16} /></button>) : <div className="ranking-empty"><BookOpen size={21} /><p>还没有作品，去工作台开始第一本书。</p></div>}
      </div>
    </section>
  </div>
}

function AuthScreen({ mode, error, onModeChange, onSubmit }) {
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState('')
  const [notice, setNotice] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [sendingVerificationCode, setSendingVerificationCode] = useState(false)
  const [verificationCooldown, setVerificationCooldown] = useState(0)
  const [quoteIndex, setQuoteIndex] = useState(0)
  const emailInputRef = useRef(null)
  const isRegister = mode === 'register'
  const isLogin = mode === 'login'
  const isForgot = mode === 'forgot'
  const isReset = mode === 'reset'
  const quote = authQuotes[quoteIndex]
  const heading = isRegister
    ? { overline: '创建创作空间', title: '写下第一行。', description: '建立账号后，作品会隔离保存在你的空间中。' }
    : isForgot
      ? { overline: '找回创作空间', title: '重拾你的故事。', description: '输入注册邮箱，我们会发送一封密码重置邮件。' }
      : isReset
        ? { overline: '设置新密码', title: '重新打开故事。', description: '新密码设置成功后，其他设备上的旧登录会话会全部失效。' }
        : { overline: '欢迎回来', title: '继续你的故事。', description: '登录后回到上次停笔的位置。' }

  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    if (reduceMotion) return undefined
    const timer = window.setInterval(() => setQuoteIndex((current) => (current + 1) % authQuotes.length), 6200)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (verificationCooldown <= 0) return undefined
    const timer = window.setTimeout(() => setVerificationCooldown((seconds) => Math.max(0, seconds - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [verificationCooldown])

  function changeMode(nextMode) {
    setLocalError('')
    setNotice('')
    setShowPassword(false)
    setShowConfirmPassword(false)
    setVerificationCooldown(0)
    onModeChange(nextMode)
  }

  async function requestVerificationCode() {
    const emailInput = emailInputRef.current
    const email = emailInput?.value.trim() || ''
    setLocalError('')
    setNotice('')
    if (!email || !emailInput?.checkValidity()) {
      setLocalError('请先输入正确的邮箱地址')
      emailInput?.focus()
      return
    }
    setSendingVerificationCode(true)
    try {
      const response = await api.requestRegistrationCode(email)
      setNotice(response.message)
      setVerificationCooldown(Number(response.retryAfterSeconds) || 60)
    } catch (requestError) {
      setLocalError(requestError.message)
    } finally {
      setSendingVerificationCode(false)
    }
  }

  async function submit(event) {
    event.preventDefault()
    setLocalError('')
    setNotice('')
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') || '')
    if ((isRegister || isReset) && password !== String(form.get('confirmPassword') || '')) {
      setLocalError('两次输入的密码不一致')
      return
    }
    setSubmitting(true)
    const response = await onSubmit({
      name: String(form.get('name') || ''),
      email: String(form.get('email') || ''),
      password,
      verificationCode: String(form.get('verificationCode') || ''),
    })
    if (response?.message) setNotice(response.message)
    setSubmitting(false)
  }

  const submitLabel = submitting
    ? '请稍候'
    : isRegister
      ? '创建账号'
      : isForgot
        ? '发送重置邮件'
        : isReset
          ? '保存新密码'
          : '进入工作台'

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
            <button type="button" className={isLogin ? 'active' : ''} onClick={() => changeMode('login')}>登录</button>
            <button type="button" className={isRegister ? 'active' : ''} onClick={() => changeMode('register')}>注册</button>
          </div>
          <div className="auth-heading">
            <span className="section-overline">{heading.overline}</span>
            <h1>{heading.title}</h1>
            <p>{heading.description}</p>
          </div>
          <form className="auth-form" onSubmit={submit}>
            {isRegister && <label><span>昵称</span><div className="auth-input"><UserRound size={16} /><input name="name" autoComplete="name" placeholder="你的创作者昵称" required maxLength="40" /></div></label>}
            {!isReset && <label><span>邮箱</span><div className="auth-input"><Mail size={16} /><input ref={isRegister ? emailInputRef : null} name="email" type="email" autoComplete="email" placeholder="name@example.com" required maxLength="160" /></div></label>}
            {isRegister && (
              <label>
                <span>邮箱验证码</span>
                <div className="auth-input auth-verification-input">
                  <ShieldCheck size={16} />
                  <input name="verificationCode" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" placeholder="6 位验证码" required maxLength="6" />
                  <button className="auth-code-button" type="button" disabled={sendingVerificationCode || verificationCooldown > 0} onClick={requestVerificationCode}>
                    {sendingVerificationCode ? '发送中' : verificationCooldown > 0 ? `${verificationCooldown}s` : '获取验证码'}
                  </button>
                </div>
              </label>
            )}
            {!isForgot && (
              <label>
                <span className="auth-label-row"><span>{isReset ? '新密码' : '密码'}</span>{isLogin && <button type="button" onClick={() => changeMode('forgot')}>忘记密码？</button>}</span>
                <div className="auth-input">
                  <LockKeyhole size={16} />
                  <input name="password" type={showPassword ? 'text' : 'password'} autoComplete={isLogin ? 'current-password' : 'new-password'} placeholder="至少 8 个字符" required minLength="8" maxLength="128" />
                  <button className="auth-password-toggle" type="button" aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword} onClick={() => setShowPassword((visible) => !visible)}>
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>
            )}
            {(isRegister || isReset) && (
              <label>
                <span>确认密码</span>
                <div className="auth-input">
                  <LockKeyhole size={16} />
                  <input name="confirmPassword" type={showConfirmPassword ? 'text' : 'password'} autoComplete="new-password" placeholder="再次输入密码" required minLength="8" maxLength="128" />
                  <button className="auth-password-toggle" type="button" aria-label={showConfirmPassword ? '隐藏确认密码' : '显示确认密码'} aria-pressed={showConfirmPassword} onClick={() => setShowConfirmPassword((visible) => !visible)}>
                    {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>
            )}
            {(localError || error) && <div className="auth-error" role="alert">{localError || error}</div>}
            {notice && <div className="auth-notice" role="status">{notice}</div>}
            <button className="auth-submit" disabled={submitting} type="submit">{submitting ? <LoaderCircle size={17} className="spin" /> : <ArrowUpRight size={17} />}{submitLabel}</button>
            {(isForgot || isReset) && <button className="auth-back-button" type="button" onClick={() => changeMode('login')}><ArrowLeft size={14} />返回登录</button>}
          </form>
          <p className="auth-security"><LockKeyhole size={13} />{isForgot || isReset ? '重置链接仅可使用一次，并会在短时间后过期。' : '密码经过加盐哈希处理，登录会话可随时退出。'}</p>
          <p className="auth-source"><a href={SOURCE_REPOSITORY_URL} target="_blank" rel="noreferrer"><Code2 size={12} />源代码 · AGPL-3.0</a></p>
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
          {active ? <><button className="secondary-button" onClick={() => onNavigate('editor')}><PenLine size={16} />进入工作台</button><button className="primary-button" onClick={() => onOpen(active)}><PenLine size={17} />继续写作</button></> : <><button className="secondary-button" onClick={onNew}><BookPlus size={16} />手动新建</button><button className="primary-button" onClick={() => onNavigate('editor')}><PenLine size={17} />进入工作台</button></>}
        </div>
      </section>

      {!active ? (
        <section className="empty-state hero-empty">
          <div className="empty-state-icon"><BookOpen size={28} /></div>
          <h2>开始你的第一本书</h2>
          <p>告诉{ASSISTANT_NAME}你想写什么，它会选择合适的 Skill 并只追问真正影响下一步的信息。</p>
          <div className="empty-state-actions"><button className="primary-button" onClick={() => onNavigate('editor')}><PenLine size={17} />进入工作台</button><button className="secondary-button" onClick={onNew}><BookPlus size={16} />手动新建</button></div>
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
  const [customQuestionId, setCustomQuestionId] = useState('')
  const [customAnswer, setCustomAnswer] = useState('')
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

  function submitCustomQuestion(event, questionId) {
    event?.preventDefault()
    const value = customAnswer.trim()
    if (!value || loading) return
    setCustomQuestionId('')
    setCustomAnswer('')
    send(value)
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
                  {question.options?.length > 0 && <div>{[
                    ...question.options,
                    ...(question.options.some((option) => /^(其他|自定义|other)$/i.test(option.label || '')) ? [] : [{ label: '其他', value: '__custom__', description: '自定义输入' }]),
                  ].map((option) => <button type="button" key={option.value} onClick={() => option.value === '__custom__' ? setCustomQuestionId(question.id) : send(option.value)}><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</button>)}</div>}
                  {customQuestionId === question.id && <form className="assistant-plan-custom" onSubmit={(event) => submitCustomQuestion(event, question.id)}><input autoFocus value={customAnswer} maxLength={1000} onChange={(event) => setCustomAnswer(event.target.value)} placeholder="输入你的自定义答案…" aria-label="自定义答案" /><button type="submit" disabled={!customAnswer.trim()}>继续</button></form>}
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
                <label title="自动选择或强制指定 Skill"><Wand2 size={13} /><select value={selectedSkill} onChange={(event) => setSelectedSkill(event.target.value)}><option value="">自动选择 Skill</option>{availableSkills.map((item) => <option key={item.name} value={item.name}>{item.displayName || skillMeta[item.name]?.label || item.name}</option>)}</select></label>
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

function AgentChoicePrompt({ prompt, disabled, onChoose }) {
  const questions = Array.isArray(prompt.questions) && prompt.questions.length
    ? prompt.questions
    : [{ id: 'question_1', header: '', question: prompt.question, options: prompt.options, isOther: true }]
  const [questionIndex, setQuestionIndex] = useState(0)
  const [answers, setAnswers] = useState({})
  const [selected, setSelected] = useState('')
  const [customValue, setCustomValue] = useState('')
  const currentQuestion = questions[Math.min(questionIndex, questions.length - 1)]
  const modelOptions = (Array.isArray(currentQuestion.options) ? currentQuestion.options : []).map((option) => ({
    ...option,
    isOther: /^(其他|自定义|other)$/i.test(String(option.label || '').trim()),
  }))
  const allowOther = currentQuestion.isOther !== false || modelOptions.some((option) => option.isOther)
  const hasOther = modelOptions.some((option) => option.isOther)
  const options = hasOther || !allowOther
    ? modelOptions
    : [...modelOptions, { key: 'OTHER', label: '其他', description: '自定义输入你的想法', reply: '', isOther: true }]

  function completeAnswer(value) {
    const nextAnswers = { ...answers, [currentQuestion.id]: value }
    if (questionIndex < questions.length - 1) {
      setAnswers(nextAnswers)
      setQuestionIndex((current) => current + 1)
      setSelected('')
      setCustomValue('')
      return
    }
    const reply = questions.map((question) => `${question.header || question.question}：${nextAnswers[question.id] || ''}`).join('\n')
    onChoose({ answers: nextAnswers, text: reply })
  }

  function choose(option) {
    if (disabled) return
    setSelected(option.key)
    if (option.isOther) {
      setCustomValue('')
      return
    }
  }

  function submitSelected() {
    const option = options.find((item) => item.key === selected)
    if (disabled || !option || option.isOther) return
    completeAnswer(option.reply)
  }

  function submitCustom(event) {
    event?.preventDefault()
    const value = customValue.trim()
    if (disabled || !options.find((option) => option.key === selected)?.isOther || !value) return
    completeAnswer(`其他：${value}`)
  }

  return <div className="agent-choice-response">
    {prompt.intro && <p className="agent-choice-intro">{prompt.intro}</p>}
    <section className="agent-choice-card" aria-label="请选择一个方向">
      <header><span>{currentQuestion.header || '需要你确认'}</span><small>{questions.length > 1 ? `${questionIndex + 1} / ${questions.length} · 选择后继续` : '选择一项继续'}</small></header>
      <p>{currentQuestion.question}</p>
      <div className="agent-choice-options">
        {options.map((option) => <button
          type="button"
          key={option.key}
          className={selected === option.key ? 'selected' : ''}
          disabled={disabled}
          onClick={() => choose(option)}
        >
          <strong>{option.key}</strong>
          <span className="agent-choice-copy"><span>{option.label}</span>{option.description && <small>{option.description}</small>}</span>
          {selected === option.key ? <Check size={13} /> : <ChevronRight size={13} />}
        </button>)}
      </div>
      {selected && options.find((option) => option.key === selected)?.isOther && <form className="agent-choice-custom" onSubmit={submitCustom}>
        <input
          autoFocus
          value={customValue}
          maxLength={1000}
          onChange={(event) => setCustomValue(event.target.value)}
          placeholder="输入你的自定义答案…"
          aria-label="自定义答案"
        />
        <button type="submit" disabled={!customValue.trim()}>继续</button>
      </form>}
      {selected && !options.find((option) => option.key === selected)?.isOther && <button type="button" className="agent-choice-confirm" disabled={disabled} onClick={submitSelected}>继续</button>}
      {prompt.hint && <small className="agent-choice-hint">{prompt.hint}</small>}
    </section>
  </div>
}

function EditorAgentTurn({ run, elapsedMs = 0, onApply, onChoose, choiceDisabled = false }) {
  const result = run.response?.result || {}
  const proposal = result.edit_proposal || null
  const outputText = typeof (proposal?.revised_text ?? result.output) === 'string'
    ? String(proposal?.revised_text ?? result.output).trim()
    : ''
  const originalText = run.source?.selectedText || run.source?.sourceText || result.original || ''
  const showDiff = run.editRequested && outputText && originalText
  const [hunks, setHunks] = useState(() => showDiff ? buildEditHunks(originalText, outputText, proposal?.blocks || []) : [])
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setHunks(showDiff ? buildEditHunks(originalText, outputText, proposal?.blocks || []) : [])
  }, [originalText, outputText, proposal, showDiff])

  const changedHunks = hunks.filter((hunk) => hunk.type !== 'equal')
  const acceptedText = changedHunks.length ? composeAcceptedText(hunks) : outputText
  const addedCharacters = changedHunks.reduce((sum, hunk) => sum + (hunk.accepted ? hunk.replacement.length : 0), 0)
  const removedCharacters = changedHunks.reduce((sum, hunk) => sum + (hunk.accepted ? hunk.original.length : 0), 0)
  const references = Array.isArray(result.references_loaded) ? result.references_loaded : []
  const checks = Array.isArray(result.checks) ? result.checks : []
  const findings = Array.isArray(result.findings) ? result.findings : []
  const events = compactAgentEvents(run.events)
  const plan = Array.isArray(run.plan) ? run.plan : []
  const reasoningHistory = Array.isArray(run.reasoningHistory) ? run.reasoningHistory.filter((item) => String(item?.summary || '').trim()) : []
  const inputHistory = Array.isArray(run.inputHistory) ? run.inputHistory : []
  const interactionTrace = [
    ...reasoningHistory.map((entry, index) => ({
      kind: 'reasoning',
      entry,
      ordinal: index + 1,
      interactionAttempt: Math.max(1, Number(entry?.interactionAttempt) || index + 1),
    })),
    ...inputHistory.map((entry, index) => ({
      kind: 'input',
      entry,
      ordinal: index + 1,
      interactionAttempt: Math.max(1, Number(entry?.interactionAttempt) || index + 1),
    })),
  ].sort((left, right) => left.interactionAttempt - right.interactionAttempt
    || (left.kind === right.kind ? left.ordinal - right.ordinal : left.kind === 'reasoning' ? -1 : 1))
  const attachedFiles = Array.isArray(run.source?.attachedFiles) ? run.source.attachedFiles : []
  const chapterCount = run.source?.chapterId == null ? 0 : 1
  const contextCount = 1 + attachedFiles.length + (run.source?.selectedText ? 1 : 0)
  const explorationParts = [
    chapterCount ? `${chapterCount} 个章节` : '',
    attachedFiles.length ? `${attachedFiles.length} 个附件` : '',
    references.length ? `${references.length} 份 Skill 参考` : '',
    `${contextCount} 条上下文`,
  ].filter(Boolean)
  const traceSummary = String(proposal?.summary || result.summary || '').trim()
  const isPlanMode = run.mode === 'plan' || run.source?.mode === 'plan'
  const effectiveStatus = result.status === 'needs_input' ? 'needs_input' : run.status
  const hasInputRequest = effectiveStatus === 'needs_input' && result.question
  const choicePrompt = normalizeStructuredAgentQuestion(result.question) || (hasInputRequest ? parseAgentChoicePrompt(run.text) : null)
  const statusLabel = {
    completed: '已完成', needs_model: '需要配置模型', needs_input: '需要补充输入',
    waiting_input: '等待你的回答', needs_adapter: '能力待接入', failed: '运行失败', cancelled: '已停止',
  }[effectiveStatus] || '运行中'

  function toggleHunk(id, accepted) {
    setHunks((current) => current.map((hunk) => hunk.id === id ? { ...hunk, accepted } : hunk))
  }

  async function copyResult() {
    const text = outputText || run.text
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard permissions vary in embedded browsers; copying is optional.
    }
  }

  return <article className={`agent-turn ${run.status}`}>
    <details className="agent-exploration">
      <summary className="agent-trace-row">
        <Search size={14} />
        <strong>已读取</strong>
        <span>{explorationParts.join(' · ')}</span>
        <ChevronRight size={13} className="agent-trace-chevron" />
      </summary>
      <div className="agent-exploration-body">
        <div className="agent-trace-detail">
          <FileText size={13} />
          <span>{run.source?.chapterTitle || '当前章节'}</span>
          <small>{originalText.replace(/\s/g, '').length.toLocaleString()} 字</small>
        </div>
        {attachedFiles.map((file) => <div className="agent-trace-detail" key={`${run.id}:${file.name}`}>
          <Paperclip size={13} />
          <span>{file.name}</span>
          <small>{file.kind || '外部文件'}</small>
        </div>)}
        {references.length > 0 && <div className="agent-trace-detail">
          <SearchCode size={13} />
          <span>Skill 参考</span>
          <small>{references.length} 份</small>
        </div>}
      </div>
    </details>

    {traceSummary && <div className="agent-trace-row agent-summary-row">
      <List size={14} />
      <strong>章节摘要</strong>
      <span>{traceSummary}</span>
      <Info size={12} />
    </div>}

    <details className="agent-reasoning" open={run.status === 'running' || ['needs_input', 'waiting_input'].includes(effectiveStatus)}>
      <summary>{run.status === 'running' ? <LoaderCircle size={14} className="spin" /> : <BrainCircuit size={14} />}<strong>执行过程</strong><span>{run.status === 'running' ? formatAgentDuration(elapsedMs) : formatAgentDuration(run.durationMs)} · {statusLabel}</span><ChevronRight size={13} className="agent-trace-chevron" /></summary>
      <div className="agent-reasoning-body">
        {plan.length > 0 && <div className="agent-plan" aria-label="执行计划">
          <div className="agent-plan-heading"><List size={13} /><strong>执行计划</strong><span>{plan.filter((item) => item.status === 'completed').length}/{plan.length}</span></div>
          <ol>{plan.map((item, index) => <li className={item.status} key={`${item.step}-${index}`}>
            {item.status === 'completed' ? <Check size={11} /> : item.status === 'inProgress' ? <LoaderCircle size={11} className="spin" /> : <span className="agent-plan-dot" />}
            <span>{item.step}</span>
          </li>)}</ol>
        </div>}
        <div className="agent-tool-stack">
          {(events.length ? events : [{ id: `${run.id}:local`, type: 'lifecycle', label: run.statusMessage || '正在创建任务', status: 'running' }]).map((event) => <div className={`agent-tool-row ${event.status === 'completed' ? 'done' : event.status}`} key={event.id}>
            <AgentEventIcon event={event} />
            <span>{event.label}</span>
            {event.count > 1 ? <small>{event.count} 轮</small> : agentEventDuration(event) && <small>{agentEventDuration(event)}</small>}
          </div>)}
        </div>
        {events.filter((event) => event.type === 'subagent' && event.meta?.reportSummary).map((event) => <div className="agent-reasoning-summary" key={`${event.id}:report`}>
          <UsersRound size={12} />
          <div>
            <strong>{event.label}</strong>
            <AgentMarkdown value={event.meta.reportSummary} />
          </div>
        </div>)}
        {interactionTrace.map(({ kind, entry, ordinal }) => kind === 'input'
          ? <div className="agent-reasoning-summary" key={entry.requestId || `${run.id}:input:${ordinal}`}>
            <CheckSquare2 size={12} />
            <div>
              <strong>已确认的补充信息 {inputHistory.length > 1 ? `${ordinal}/${inputHistory.length}` : ''}</strong>
              <AgentMarkdown value={`问题：${entry.response?.questionText || '补充信息'}\n\n回答：${entry.response?.answerText || '已回答'}`} />
            </div>
          </div>
          : <div className="agent-reasoning-summary" key={entry.id || `${run.id}:reasoning-history:${ordinal}`}>
            <BrainCircuit size={12} />
            <div>
              <strong>模型推理摘要 {reasoningHistory.length > 1 || run.reasoningSummary ? `${ordinal}/${reasoningHistory.length + (run.reasoningSummary ? 1 : 0)}` : ''}</strong>
              <AgentMarkdown value={entry.summary} />
            </div>
          </div>)}
        {run.reasoningSummary && <div className="agent-reasoning-summary"><BrainCircuit size={12} /><div><strong>模型推理摘要 {reasoningHistory.length ? `${reasoningHistory.length + 1}/${reasoningHistory.length + 1}` : ''}</strong><AgentMarkdown value={run.reasoningSummary} streaming={run.status === 'running'} /></div></div>}
        {checks.length > 0 && <div className="agent-tool-row done"><CheckSquare2 size={13} /><span>完成 {checks.length} 项确定性检查</span></div>}
        {run.response?.route && <code>{run.response.route}</code>}
      </div>
    </details>

    {(run.status !== 'running' || run.text || hasInputRequest) && <div className={`agent-answer ${run.status === 'running' ? 'streaming' : ''} ${['failed', 'cancelled', 'needs_model', 'needs_adapter'].includes(run.status) ? 'notice' : ''}`} aria-live="polite">
      <div className="agent-answer-heading"><Bot size={15} /><strong>{isPlanMode ? '计划' : ASSISTANT_NAME}</strong><button type="button" onClick={copyResult} title="复制结果" aria-label="复制结果">{copied ? <Check size={13} /> : <Copy size={13} />}</button></div>
      {run.status === 'running'
        ? <AgentMarkdown value={run.text} streaming />
        : choicePrompt
        ? <AgentChoicePrompt prompt={choicePrompt} disabled={choiceDisabled} onChoose={onChoose} />
        : <AgentMarkdown value={run.text} />}
    </div>}

    {findings.length > 0 && <div className="agent-finding-list">{findings.slice(0, 6).map((finding, index) => <div key={`${finding.issue || index}-${index}`}><span>{finding.severity || `${index + 1}`}</span><p><strong>{finding.issue || finding.title}</strong>{finding.fix && <small>{finding.fix}</small>}</p></div>)}</div>}

    {showDiff && changedHunks.length > 0 && <details className="agent-write-stage" open>
      <summary className="agent-trace-row">
        <PenLine size={14} />
        <strong>写入章节</strong>
        <span>{run.source?.selectedText ? '当前选区' : run.source?.chapterTitle}</span>
        <ChevronRight size={13} className="agent-trace-chevron" />
      </summary>
      <section className="agent-diff">
        <header><div><FileText size={14} /><strong>{run.source?.selectedText ? '当前选区' : run.source?.chapterTitle}</strong></div><span className="diff-add">+{addedCharacters}</span><span className="diff-remove">-{removedCharacters}</span></header>
        <div className="agent-diff-list">{changedHunks.map((hunk, index) => <article className={`agent-diff-hunk ${hunk.accepted ? '' : 'rejected'}`} key={hunk.id}>
          <div className="agent-diff-hunk-heading"><span>修改 {index + 1}</span><small>{hunk.reason}</small><div><button type="button" className={hunk.accepted ? 'active' : ''} title="接受修改" onClick={() => toggleHunk(hunk.id, true)}><Check size={12} /></button><button type="button" className={!hunk.accepted ? 'active reject' : ''} title="拒绝修改" onClick={() => toggleHunk(hunk.id, false)}><X size={12} /></button></div></div>
          {hunk.original && <pre className="diff-line removed"><span>-</span>{hunk.original}</pre>}
          {hunk.replacement && <pre className="diff-line added"><span>+</span>{hunk.replacement}</pre>}
        </article>)}</div>
        <footer><span>{changedHunks.filter((hunk) => hunk.accepted).length} / {changedHunks.length} 项已接受</span><button type="button" disabled={run.applied || !changedHunks.some((hunk) => hunk.accepted)} onClick={() => onApply(run, acceptedText)}>{run.applied ? <Check size={13} /> : <PenLine size={13} />}{run.applied ? '已应用' : '应用到正文'}</button></footer>
      </section>
    </details>}
  </article>
}

function AgentComposerMenu({ title, description, options, value, loading, onSelect }) {
  function moveFocus(event) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = [...event.currentTarget.querySelectorAll('[role="option"]:not(:disabled)')]
    if (!buttons.length) return
    const currentIndex = buttons.indexOf(document.activeElement)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + buttons.length) % buttons.length
          : (currentIndex - 1 + buttons.length) % buttons.length
    buttons[nextIndex]?.focus()
  }

  return <div className="agent-control-popover" role="listbox" aria-label={title} onKeyDown={moveFocus}>
    <div className="agent-control-popover-heading">
      <div><strong>{title}</strong><small>{description}</small></div>
      {loading && <LoaderCircle size={14} className="spin" />}
    </div>
    <div className="agent-control-option-list">
      {options.map((option, index) => {
        const selected = option.value === value
        return <button
          type="button"
          role="option"
          aria-selected={selected}
          autoFocus={selected || (!value && index === 0)}
          className={`agent-control-option ${selected ? 'selected' : ''}`}
          key={option.value || 'default'}
          onClick={() => onSelect(option.value)}
        >
          <span className="agent-control-option-mark">{selected && <Check size={12} />}</span>
          <span className="agent-control-option-copy"><strong>{option.label}</strong><small>{option.description}</small></span>
          {option.badge && <em>{option.badge}</em>}
        </button>
      })}
      {!loading && options.length <= 1 && <div className="agent-control-empty"><Bot size={15} /><span>暂未读取到其他模型，请先在设置中测试连接。</span></div>}
    </div>
  </div>
}

function Editor({ project, projects = [], skills = [], chapters, activeChapter, ideas, foreshadows = [], storyMemories = [], onUpdateStoryMemory, onDeleteStoryMemory, onConfirmStoryMemories, onCreateForeshadow, onUpdateForeshadow, onDeleteForeshadow, draft, onDraftChange, draftStatus, draftLoading, wordCount, historySnapshots = [], historyLoading = false, onCreateHistory, lastAiRestore = null, onAiApplied, onAiRestored, onNotify, onSave, onReview, reviewLoading, reviewPlatform, onPlatformChange, onDeslop, deslopLoading, onNewChapter, onSplitChapter, onSelectChapter, onRenameChapter, onUpdateChapterState, onDeleteChapter, onOpenProject, onOpenSkill, onOpenSettings, applyRequest, onApplyRequestHandled }) {
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
  const [assistantOpen, setAssistantOpen] = useState(() => (
    typeof window === 'undefined' || !window.matchMedia('(max-width: 760px)').matches
  ))
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
  const [assistantThread, setAssistantThread] = useState(null)
  const [assistantLoading, setAssistantLoading] = useState(false)
  const [assistantRunning, setAssistantRunning] = useState(false)
  const [assistantElapsedMs, setAssistantElapsedMs] = useState(0)
  const [assistantAttachments, setAssistantAttachments] = useState([])
  const [assistantSuggestion, setAssistantSuggestion] = useState(null)
  const [assistantSuggestionIndex, setAssistantSuggestionIndex] = useState(0)
  const [assistantAttachmentLoading, setAssistantAttachmentLoading] = useState(false)
  const [openChapterIds, setOpenChapterIds] = useState([])
  const [styleMenuOpen, setStyleMenuOpen] = useState(false)
  const [editorFontSize, setEditorFontSize] = useState(16)
  const [editorLineHeight, setEditorLineHeight] = useState(2.05)
  const [editorBold, setEditorBold] = useState(false)
  const [editorItalic, setEditorItalic] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [agentModel, setAgentModel] = useState('')
  const [agentModels, setAgentModels] = useState([])
  const [agentModelsLoading, setAgentModelsLoading] = useState(false)
  const [agentReasoningEffort, setAgentReasoningEffort] = useState('')
  const [agentContextWindow, setAgentContextWindow] = useState(100000)
  const [agentSettingSaving, setAgentSettingSaving] = useState(false)
  const [agentWebSearch, setAgentWebSearch] = useState(false)
  const [agentMultiAgent, setAgentMultiAgent] = useState(false)
  const [agentMode, setAgentMode] = useState('build')
  const [agentPickerOpen, setAgentPickerOpen] = useState(null)
  const [, setHistoryVersion] = useState(0)
  const historyRef = useRef({ past: [], future: [] })
  const historyTimerRef = useRef(null)
  const historyPendingRef = useRef(null)
  const textareaRef = useRef(null)
  const assistantAbortRef = useRef(null)
  const assistantTaskIdRef = useRef(null)
  const assistantTurnIdRef = useRef(null)
  const assistantStreamRef = useRef(null)
  const assistantInputRef = useRef(null)
  const assistantFileInputRef = useRef(null)
  const agentControlsRef = useRef(null)
  const displayChapter = activeChapter || chapters.at(-1) || { id: 1, title: '第一章', words: '0' }
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
    let mounted = true
    const applyAgentSettings = (settings) => {
      if (!mounted) return
      setAgentModel(settings?.model || '')
      setAgentReasoningEffort(settings?.reasoningEffort || '')
      setAgentContextWindow(Math.max(100, Number(settings?.contextWindow) || 100000))
    }
    api.getSettings()
      .then(({ settings }) => applyAgentSettings(settings))
      .catch(() => {})
    const handleSettingsUpdate = (event) => applyAgentSettings(event.detail)
    window.addEventListener('story:model-settings-updated', handleSettingsUpdate)
    return () => {
      mounted = false
      window.removeEventListener('story:model-settings-updated', handleSettingsUpdate)
    }
  }, [])

  useEffect(() => {
    setOpenChapterIds(displayChapter?.id == null ? [] : [String(displayChapter.id)])
  }, [project.id])

  useEffect(() => {
    if (displayChapter?.id == null) return
    const id = String(displayChapter.id)
    setOpenChapterIds((current) => current.includes(id) ? current : [...current, id].slice(-5))
  }, [displayChapter.id])

  useEffect(() => {
    if (!agentPickerOpen) return undefined
    function closeOnOutsideClick(event) {
      if (!agentControlsRef.current?.contains(event.target)) setAgentPickerOpen(null)
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') setAgentPickerOpen(null)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [agentPickerOpen])

  async function loadAgentModels() {
    if (agentModelsLoading || agentModels.length) return
    setAgentModelsLoading(true)
    try {
      const response = await api.getModels()
      setAgentModels(response.models || [])
    } catch (error) {
      onNotify?.(error.message || '模型列表获取失败，请检查连接设置')
    } finally {
      setAgentModelsLoading(false)
    }
  }

  async function updateAgentSetting(field, value) {
    const previous = field === 'model' ? agentModel : agentReasoningEffort
    if (field === 'model') setAgentModel(value)
    else setAgentReasoningEffort(value)
    setAgentSettingSaving(true)
    try {
      const response = await api.updateSettings({ [field]: value })
      window.dispatchEvent(new CustomEvent('story:model-settings-updated', { detail: response.settings }))
    } catch (error) {
      if (field === 'model') setAgentModel(previous)
      else setAgentReasoningEffort(previous)
      onNotify?.(error.message || '模型设置保存失败')
    } finally {
      setAgentSettingSaving(false)
    }
  }

  function toggleAgentPicker(picker) {
    setAssistantSuggestion(null)
    setAgentPickerOpen((current) => current === picker ? null : picker)
    if (picker === 'model' && agentPickerOpen !== 'model') loadAgentModels()
  }

  function refreshAssistantSuggestion(value, cursor) {
    const trigger = composerTriggerAt(value, cursor)
    setAssistantSuggestion(trigger)
    setAssistantSuggestionIndex(0)
    if (trigger) setAgentPickerOpen(null)
  }

  function replaceAssistantTrigger(replacement) {
    if (!assistantSuggestion) return
    const next = `${assistantInput.slice(0, assistantSuggestion.start)}${replacement}${assistantInput.slice(assistantSuggestion.end)}`
    const cursor = assistantSuggestion.start + replacement.length
    setAssistantInput(next)
    setAssistantSuggestion(null)
    requestAnimationFrame(() => {
      assistantInputRef.current?.focus()
      assistantInputRef.current?.setSelectionRange(cursor, cursor)
    })
  }

  function selectAssistantCommand(command) {
    replaceAssistantTrigger(command.insertText)
  }

  async function selectAssistantFile(file) {
    if (assistantAttachmentLoading) return
    const existing = assistantAttachments.find((item) => item.key === file.key)
    if (existing) {
      replaceAssistantTrigger(`@${existing.name} `)
      return
    }
    setAssistantAttachmentLoading(true)
    try {
      let content = file.content || ''
      if (file.chapterId != null && String(file.chapterId) !== String(displayChapter.id)) {
        const response = await api.getChapterDraft(project.id, file.chapterId)
        content = response.content || ''
      } else if (file.chapterId != null) {
        content = draft
      }
      const attachment = { ...file, content: String(content).slice(0, 60000) }
      setAssistantAttachments((current) => [...current, attachment].slice(-6))
      replaceAssistantTrigger(`@${file.name} `)
    } catch (error) {
      onNotify(error.message || '文件内容读取失败')
    } finally {
      setAssistantAttachmentLoading(false)
    }
  }

  function openExternalFilePicker() {
    assistantFileInputRef.current?.click()
  }

  async function handleExternalFiles(event) {
    const files = [...(event.target.files || [])]
    event.target.value = ''
    if (!files.length) return
    const remaining = Math.max(0, 6 - assistantAttachments.length)
    if (!remaining) {
      onNotify('一次最多添加 6 个上下文文件')
      return
    }
    setAssistantAttachmentLoading(true)
    try {
      const accepted = files.slice(0, remaining)
      const attachments = await Promise.all(accepted.map(async (file, index) => {
        if (file.size > 2 * 1024 * 1024) throw new Error(`文件 ${file.name} 超过 2 MB`)
        const content = await file.text()
        return {
          key: `external:${Date.now()}:${index}:${file.name}`,
          name: file.name,
          kind: '外部文件',
          description: `${Math.max(1, Math.round(file.size / 1024))} KB`,
          content: content.slice(0, 60000),
        }
      }))
      setAssistantAttachments((current) => [...current, ...attachments].slice(-6))
      const mentions = `${attachments.map((file) => `@${file.name}`).join(' ')} `
      if (assistantSuggestion?.type === 'file') replaceAssistantTrigger(mentions)
      else setAssistantInput((current) => `${current}${current && !/\s$/.test(current) ? ' ' : ''}${mentions}`)
      onNotify(`已添加 ${attachments.length} 个外部文件`)
    } catch (error) {
      onNotify(error.message || '外部文件读取失败')
    } finally {
      setAssistantAttachmentLoading(false)
    }
  }

  function removeAssistantAttachment(key) {
    const target = assistantAttachments.find((item) => item.key === key)
    setAssistantAttachments((current) => current.filter((item) => item.key !== key))
    if (target) {
      setAssistantInput((current) => current.replace(new RegExp(`@${target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'g'), ''))
    }
  }

  function handleAssistantInputChange(event) {
    const value = event.target.value
    setAssistantInput(value)
    refreshAssistantSuggestion(value, event.target.selectionStart)
  }

  function handleAssistantComposerKeyDown(event) {
    const options = assistantSuggestion?.type === 'command'
      ? filteredAgentCommands
      : [{ key: 'external:file-picker', external: true }, ...filteredAgentFiles]
    if (assistantSuggestion && options.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setAssistantSuggestionIndex((current) => {
          const direction = event.key === 'ArrowDown' ? 1 : -1
          return (current + direction + options.length) % options.length
        })
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !(event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        const option = options[assistantSuggestionIndex] || options[0]
        if (assistantSuggestion.type === 'command') selectAssistantCommand(option)
        else if (option.external) openExternalFilePicker()
        else void selectAssistantFile(option)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setAssistantSuggestion(null)
        return
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submitAssistant(event)
  }

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
    setAssistantThread(null)
    setAssistantLoading(true)
    setAssistantRunning(false)
    setAssistantElapsedMs(0)
    assistantAbortRef.current?.abort()
    assistantAbortRef.current = null
    assistantTaskIdRef.current = null
    assistantTurnIdRef.current = null
  }, [displayChapter.id])

  useEffect(() => {
    const controller = new AbortController()
    assistantAbortRef.current?.abort()
    assistantAbortRef.current = controller
    setAssistantLoading(true)
    setAssistantMessages([])
    setAssistantThread(null)
    setAssistantRunning(false)
    setAssistantElapsedMs(0)
    assistantTaskIdRef.current = null
    assistantTurnIdRef.current = null
    api.getAgentThread(project.id, displayChapter.id)
      .then(async ({ thread }) => {
        if (controller.signal.aborted) return
        setAssistantThread(thread || null)
        const restored = agentThreadMessages(thread)
        setAssistantMessages(restored)
        const running = [...restored].reverse().find((item) => item.role === 'agent' && ['queued', 'running'].includes(item.status))
        if (!running?.taskId) return
        setAssistantRunning(true)
        assistantTaskIdRef.current = running.taskId
        assistantTurnIdRef.current = running.turnId
        const startedAt = performance.now() - Math.max(0, Number(running.durationMs) || 0)
        await monitorAssistantTurn(thread.id, running.turnId, running.taskId, running.id, controller, startedAt)
        if (assistantAbortRef.current === controller) {
          assistantTaskIdRef.current = null
          assistantTurnIdRef.current = null
          setAssistantElapsedMs(performance.now() - startedAt)
          setAssistantRunning(false)
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) onNotify(error.message || 'Agent 会话恢复失败')
      })
      .finally(() => {
        if (assistantAbortRef.current === controller) setAssistantLoading(false)
      })
    return () => controller.abort()
  }, [displayChapter.id, project.id])

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
    assistantAbortRef.current?.abort()
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [])

  useEffect(() => {
    const stream = assistantStreamRef.current
    if (!stream) return
    stream.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' })
  }, [assistantMessages.length, assistantRunning])

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
    setOpenChapterIds((current) => {
      const id = String(chapter.id)
      return current.includes(id) ? current : [...current, id].slice(-5)
    })
    await onSelectChapter?.(chapter)
  }

  async function closeEditorTab(event, chapter) {
    event.stopPropagation()
    const id = String(chapter.id)
    const closingIndex = editorTabs.findIndex((item) => String(item.id) === id)
    const remaining = editorTabs.filter((item) => String(item.id) !== id)
    setOpenChapterIds((current) => current.filter((item) => String(item) !== id))
    if (String(displayChapter.id) === id && remaining.length) {
      const nextChapter = remaining[Math.min(Math.max(0, closingIndex), remaining.length - 1)]
      await onSelectChapter?.(nextChapter)
    }
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

  function toggleEditorBold() {
    setEditorBold((current) => {
      const next = !current
      onNotify(next ? '已开启正文加粗显示，不会修改正文内容' : '已关闭正文加粗显示')
      return next
    })
  }

  function toggleEditorItalic() {
    setEditorItalic((current) => {
      const next = !current
      onNotify(next ? '已开启正文斜体显示，不会修改正文内容' : '已关闭正文斜体显示')
      return next
    })
  }

  function cleanInlineMarkdownMarkers() {
    const cleaned = draft
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/_([^_\n]+)_/g, '$1')
    if (cleaned === draft) {
      onNotify('正文中没有可清理的格式标记')
      return
    }
    commitDraftChange(cleaned)
    onNotify('已清理正文中的 Markdown 格式标记，可用撤销恢复')
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
      return
    }
    if (key === 'b') {
      event.preventDefault()
      toggleEditorBold()
      return
    }
    if (key === 'i') {
      event.preventDefault()
      toggleEditorItalic()
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
    if (!draft) {
      onNotify('本章还没有正文')
      return
    }
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
    if (speaking) {
      window.speechSynthesis.cancel()
      setSpeaking(false)
      onNotify('已停止朗读')
      return
    }
    if (!draft.trim()) {
      onNotify('本章还没有正文')
      return
    }
    if (!('speechSynthesis' in window)) {
      onNotify('当前浏览器不支持朗读')
      return
    }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(draft)
    utterance.lang = 'zh-CN'
    utterance.rate = 0.95
    utterance.onend = () => setSpeaking(false)
    utterance.onerror = () => {
      setSpeaking(false)
      onNotify('朗读中断，请检查系统语音服务')
    }
    window.speechSynthesis.speak(utterance)
    setSpeaking(true)
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

  async function extractMemories(targetChapter = displayChapter, { automatic = false } = {}) {
    const chapter = targetChapter?.id == null ? displayChapter : targetChapter
    const isCurrentChapter = String(chapter.id) === String(displayChapter.id)
    if (!project?.id || !chapter?.id || (isCurrentChapter && !draft.trim()) || memoryLoading) {
      if (isCurrentChapter && !draft.trim()) onNotify('先写一点正文，再整理本章记忆')
      return
    }
    setMemoryLoading(true)
    try {
      const response = await api.extractChapterMemories(project.id, chapter.id)
      if (response.status !== 'completed') {
        onNotify(response.message || (automatic ? '章节已完成，但自动整理记忆未完成' : '作品记忆整理未完成'))
        return
      }
      const candidates = (response.candidates || []).map((candidate, index) => ({
        ...candidate,
        id: `candidate-${chapter.id}-${index}`,
        sourceChapterId: chapter.id,
        selected: true,
      }))
      if (!candidates.length) {
        onNotify(automatic ? '章节已完成，本章没有需要新增的长期记忆' : '本章没有整理出新的长期记忆')
        return
      }
      setMemoryCandidates(candidates)
      setMemoryReviewOpen(true)
      if (automatic) onNotify(`章节已完成 · 已整理 ${candidates.length} 条待确认记忆`)
    } catch (error) {
      onNotify(error.message || (automatic ? '章节已完成，但自动整理记忆失败' : '作品记忆整理失败'))
    } finally {
      setMemoryLoading(false)
    }
  }

  async function toggleChapterCompletion(chapter) {
    const nextState = chapter.state === 'done' ? 'draft' : 'done'
    setMenuOpenId(null)
    if (nextState === 'done' && String(chapter.id) === String(displayChapter.id) && draftStatus !== 'saved') {
      try {
        await onSave?.({ silent: true })
      } catch {
        onNotify('正文保存失败，暂未标记完成')
        return
      }
    }
    const updated = await onUpdateChapterState?.(chapter, nextState)
    if (updated && nextState === 'done') {
      onNotify('章节已完成，正在整理长期记忆…')
      await extractMemories(updated, { automatic: true })
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

  function appendLocalCommandResult(commandText, resultText) {
    const id = `local-${Date.now()}`
    setAssistantMessages((current) => [...current.slice(-18),
      { id: `${id}-user`, role: 'user', text: commandText },
      {
        id,
        role: 'agent',
        status: 'completed',
        text: resultText,
        durationMs: 0,
        statusMessage: '已在本地执行命令',
        events: [{ id: `${id}:command`, type: 'lifecycle', label: '已在本地执行命令', status: 'completed' }],
      },
    ])
    setAssistantInput('')
    setAssistantAttachments([])
    setAssistantSuggestion(null)
  }

  async function runLocalAssistantCommand(message) {
    const command = parseSlashCommand(message)
    if (!command || !['help', 'status', 'projects', 'use', 'chapters', 'chapter', 'draft', 'history', 'new', 'undo', 'apply', 'skills', 'tasks', 'task', 'cancel', 'retry', 'confirm', 'quit'].includes(command.name)) return false
    if (command.name === 'quit') {
      setAssistantOpen(false)
      setAssistantInput('')
      setAssistantSuggestion(null)
      return true
    }
    if (command.name === 'new') {
      await clearAssistant()
      setAssistantInput('')
      setAssistantAttachments([])
      setAssistantSuggestion(null)
      return true
    }
    if (command.name === 'undo') {
      undoDraft()
      appendLocalCommandResult(message, '已执行正文撤销。')
      return true
    }
    if (command.name === 'apply') {
      const run = [...assistantMessages].reverse().find((item) => {
        const result = item.response?.result || {}
        return item.role === 'agent' && !item.applied && (result.edit_proposal?.revised_text || result.output)
      })
      if (!run) throw new Error('当前没有可应用的正文建议')
      const result = run.response?.result || {}
      await applyAssistantRevision(run, result.edit_proposal?.revised_text || result.output)
      setAssistantInput('')
      setAssistantAttachments([])
      setAssistantSuggestion(null)
      return true
    }
    if (command.name === 'chapter') {
      const target = resolveSelection(chapters, command.argument, '章节')
      await selectEditorChapter(target)
      appendLocalCommandResult(message, `已切换到《${target.title}》。`)
      return true
    }
    if (command.name === 'use') {
      const target = resolveSelection(projects, command.argument, '作品')
      await onOpenProject?.(target)
      appendLocalCommandResult(message, `已切换到《${target.title}》。`)
      return true
    }
    if (command.name === 'help') {
      appendLocalCommandResult(message, editorAgentCommands.map((item) => `${item.usage}　${item.description}`).join('\n'))
      return true
    }
    if (command.name === 'status') {
      const effort = agentReasoningOptions.find((item) => item.value === agentReasoningEffort)?.label || '自动'
      appendLocalCommandResult(message, `作品：${project.title}\n章节：${displayChapter.title}\n正文：${wordCount.toLocaleString()} 字\n模型：${agentModel || '默认模型'}\n思考强度：${effort}`)
      return true
    }
    if (command.name === 'chapters') {
      appendLocalCommandResult(message, chapters.map((chapter, index) => `${String(index + 1).padStart(2, '0')}　${String(chapter.id) === String(displayChapter.id) ? '● ' : ''}${chapter.title}　${chapter.words || 0} 字`).join('\n') || '当前作品还没有章节。')
      return true
    }
    if (command.name === 'projects') {
      appendLocalCommandResult(message, projects.map((item, index) => `${String(index + 1).padStart(2, '0')}　${String(item.id) === String(project.id) ? '● ' : ''}${item.title}　${item.type} · ${item.genre}`).join('\n') || '当前还没有作品。')
      return true
    }
    if (command.name === 'skills') {
      const storySkills = skills.filter((skill) => skill.name?.startsWith('story') || skill.source === 'market')
      appendLocalCommandResult(message, storySkills.length ? storySkills.map((skill) => `${skill.status === 'ready' ? '●' : '○'} ${skill.displayName || skill.name}　${skill.description || skill.status}`).join('\n') : '当前没有可用的 Story Skills。')
      return true
    }
    if (command.name === 'tasks') {
      const response = await api.getAiTasks(project.id)
      const tasks = response.tasks || []
      appendLocalCommandResult(message, tasks.length ? tasks.slice(0, 20).map((task) => `${task.id}　${task.status}　${task.skill || 'story'}\n${task.message || ''}`).join('\n\n') : '当前作品还没有 Agent 任务。')
      return true
    }
    if (command.name === 'task') {
      if (!command.argument) throw new Error('请提供任务 ID')
      const response = await api.getAiTask(command.argument)
      const task = response.task
      appendLocalCommandResult(message, `任务：${task.id}\n状态：${task.status}\nSkill：${task.skill || 'story'}\n指令：${task.message || ''}\n${task.error || task.statusMessage || ''}`)
      return true
    }
    if (command.name === 'cancel') {
      const taskId = command.argument || assistantTaskIdRef.current
      if (!taskId) throw new Error('没有可取消的任务，请提供任务 ID')
      const response = await api.cancelAiTask(taskId)
      appendLocalCommandResult(message, `任务 ${response.task.id} 当前状态：${response.task.status}`)
      return true
    }
    if (command.name === 'retry') {
      if (!command.argument) throw new Error('请提供任务 ID')
      const response = await api.retryAiTask(command.argument)
      appendLocalCommandResult(message, `任务已重新排队：${response.task.id}`)
      return true
    }
    if (command.name === 'confirm') {
      const response = await api.getWritingAssistantSession()
      if (!response.session?.proposal) throw new Error('当前没有待确认的建书方案')
      const created = await api.confirmWritingAssistant(response.session.id, response.session.proposal)
      await onOpenProject?.(created.project)
      appendLocalCommandResult(message, `《${created.project.title}》已创建并打开。`)
      return true
    }
    if (command.name === 'draft') {
      appendLocalCommandResult(message, draft ? `${draft.slice(0, 2400)}${draft.length > 2400 ? `\n\n…（共 ${draft.length} 字符）` : ''}` : '当前章节还没有正文。')
      return true
    }
    if (command.name === 'history') {
      const history = assistantMessages.filter((item) => item.role === 'user').slice(-8)
      appendLocalCommandResult(message, history.length ? history.map((item, index) => `${index + 1}. ${item.text}`).join('\n') : '当前还没有对话历史。')
      return true
    }
    return false
  }

  async function submitAssistantAnswer(run, response) {
    const threadId = assistantThread?.id
    const turnId = run?.turnId
    const answer = String(response?.text || response || '').trim()
    const answers = response?.answers && typeof response.answers === 'object' ? response.answers : { answer }
    if (!threadId || !turnId || !answer || assistantRunning || assistantLoading) return
    const startedAt = performance.now()
    const requestId = run.id
    const controller = new AbortController()
    assistantAbortRef.current = controller
    assistantTaskIdRef.current = run.taskId || null
    assistantTurnIdRef.current = turnId
    setAssistantRunning(true)
    setAssistantElapsedMs(0)
    setAssistantMessages((current) => current.flatMap((item) => item.id === requestId
      ? [{
        id: `${requestId}-answer-${Date.now()}`,
        role: 'user',
        text: answer,
      }, {
        ...item,
        status: 'running',
        response: null,
        text: '',
        reasoningHistory: item.reasoningSummary
          ? [...(item.reasoningHistory || []), {
            id: `${turnId}:reasoning:${Math.max(1, Number(item.reasoningHistory?.length || 0) + 1)}`,
            summary: item.reasoningSummary,
          }]
          : item.reasoningHistory || [],
        reasoningSummary: '',
        durationMs: 0,
      }]
      : [item]))
    const timer = window.setInterval(() => setAssistantElapsedMs(performance.now() - startedAt), 100)
    try {
      const resumed = await api.answerAgentTurn(threadId, turnId, answers, { signal: controller.signal })
      const task = resumed.task
      assistantTaskIdRef.current = task.id
      await monitorAssistantTurn(threadId, turnId, task.id, requestId, controller, startedAt)
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setAssistantMessages((current) => current.map((item) => item.id === requestId ? { ...item, status: 'failed', text: error.message || 'Agent 回答提交失败。' } : item))
      }
    } finally {
      window.clearInterval(timer)
      if (assistantAbortRef.current === controller) {
        assistantAbortRef.current = null
        assistantTaskIdRef.current = null
        assistantTurnIdRef.current = null
        setAssistantRunning(false)
      }
    }
  }

  async function submitAssistantSteer(message) {
    const threadId = assistantThread?.id
    const turnId = assistantTurnIdRef.current
    if (!threadId || !turnId) {
      onNotify('当前运行还没有可追加指令的轮次')
      return
    }
    const clientId = `steer-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const optimistic = {
      id: clientId,
      role: 'user',
      text: message,
      turnId,
      steer: true,
      steerStatus: 'pending',
    }
    setAssistantMessages((current) => [...current, optimistic])
    setAssistantInput('')
    setAssistantSuggestion(null)
    try {
      const response = await api.steerAgentTurn(threadId, turnId, {
        message,
        expectedTurnId: turnId,
        idempotencyKey: clientId,
      })
      if (response?.input?.id) {
        setAssistantMessages((current) => {
          const hasServerMessage = current.some((item) => item.id === response.input.id)
          if (hasServerMessage) {
            return current
              .filter((item) => item.id !== clientId)
              .map((item) => item.id === response.input.id
                ? { ...item, steerStatus: response.input.status }
                : item)
          }
          return current.map((item) => item.id === clientId ? {
              ...item,
              id: response.input.id,
              steerStatus: response.input.status,
            } : item)
        })
      }
    } catch (error) {
      setAssistantMessages((current) => current.filter((item) => item.id !== clientId))
      setAssistantInput((current) => current || message)
      onNotify(error.message || '追加指令提交失败')
    }
  }

  async function submitAssistant(event, quickMessage = '') {
    event?.preventDefault()
    const message = String(quickMessage || assistantInput).trim()
    if (!message || assistantLoading || draftLoading) return
    if (assistantRunning) {
      await submitAssistantSteer(message)
      return
    }
    try {
      if (await runLocalAssistantCommand(message)) return
    } catch (error) {
      onNotify(error.message || '命令执行失败')
      return
    }
    const command = resolveEditorAgentCommand(message, project)
    const explicitCommand = message.startsWith('/')
    const modeSkill = !explicitCommand && agentMode === 'review'
      ? 'story-review'
      : !explicitCommand && agentMode === 'plan'
        ? `story-${project?.type === '短篇' ? 'short' : 'long'}-analyze`
        : command.skill
    const effectiveSkill = agentWebSearch ? 'story-search' : modeSkill
    const textarea = textareaRef.current
    const selectionStart = textarea?.selectionStart ?? draft.length
    const selectionEnd = textarea?.selectionEnd ?? selectionStart
    const selectedText = draft.slice(selectionStart, selectionEnd)
    const editRequested = isEditorAgentEdit(command.message, effectiveSkill)
    const requestId = `agent-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const startedAt = performance.now()
    const attachedFiles = assistantAttachments.map(({ key, name, kind, content }) => ({ key, name, kind, content }))
    const source = {
      chapterId: displayChapter.id,
      chapterTitle: displayChapter.title,
      mode: agentMode,
      sourceText: draft,
      selectionStart,
      selectionEnd,
      selectedText,
      attachedFiles: attachedFiles.map(({ name, kind }) => ({ name, kind })),
    }
    const userMessage = { id: `${requestId}-user`, role: 'user', text: message }
    const runMessage = { id: requestId, role: 'agent', status: 'running', text: '', source, mode: agentMode, editRequested, requestedSkill: effectiveSkill }
    setAssistantMessages((current) => [...current.slice(-18), userMessage, runMessage])
    setAssistantInput('')
    setAssistantAttachments([])
    setAssistantSuggestion(null)
    setAssistantRunning(true)
    setAssistantElapsedMs(0)
    const controller = new AbortController()
    let createdTaskId = null
    let createdTurnId = null
    assistantAbortRef.current = controller
    const timer = window.setInterval(() => setAssistantElapsedMs(performance.now() - startedAt), 100)
    try {
      const thread = assistantThread || (await api.createAgentThread(project.id, displayChapter.id)).thread
      if (controller.signal.aborted) return
      setAssistantThread(thread)
      const created = await api.createAgentTurn(thread.id, {
        message: command.message,
        skill: effectiveSkill,
        payload: {
          project_id: project.id,
          chapter_id: displayChapter.id,
          project_type: project.type,
          genre: project.genre,
          style: project.style || '',
          premise: project.tone || '',
          preferred_writing_skill: project.type === '短篇' ? 'story-short-write' : 'story-long-write',
          chapter_title: displayChapter.title,
          content: selectedText || draft,
          source_text: draft,
          selected_text: selectedText,
          attached_files: attachedFiles,
          collaboration_mode: agentMode,
          multi_agent: agentMultiAgent,
          selection_start: selectionStart,
          selection_end: selectionEnd,
          reviewable_edit: editRequested,
        },
        idempotencyKey: requestId,
      }, { signal: controller.signal })
      let task = created.task
      const turn = created.turn
      createdTaskId = task.id
      createdTurnId = turn.id
      assistantTaskIdRef.current = task.id
      assistantTurnIdRef.current = turn.id
      setAssistantMessages((current) => current.map((item) => item.id === requestId ? {
        ...item,
        turnId: turn.id,
        taskId: task.id,
        items: turn.items || [],
        events: agentTurnEvents(turn),
        plan: turn.plan || [],
        progress: task.progress || 0,
      } : item))
      await monitorAssistantTurn(thread.id, turn.id, task.id, requestId, controller, startedAt)
    } catch (error) {
      const durationMs = performance.now() - startedAt
      const cancelled = error?.name === 'AbortError'
      if (!cancelled) {
        setAssistantMessages((current) => current.map((item) => item.id === requestId ? {
          ...item,
          status: 'failed',
          text: error.message || 'Agent 执行失败。',
          durationMs,
        } : item))
      }
    } finally {
      window.clearInterval(timer)
      if (assistantAbortRef.current === controller) {
        assistantAbortRef.current = null
        if (assistantTaskIdRef.current && assistantTaskIdRef.current === createdTaskId) assistantTaskIdRef.current = null
        if (assistantTurnIdRef.current === createdTurnId) assistantTurnIdRef.current = null
        setAssistantElapsedMs(performance.now() - startedAt)
        setAssistantRunning(false)
      }
    }
  }

  function applyStreamedTask(task, requestId, startedAt, turn = null) {
    const terminal = ['completed', 'failed', 'cancelled'].includes(task.status)
    const response = task.result
    setAssistantMessages((current) => current.map((item) => item.role === 'agent' && (item.id === requestId || item.taskId === task.id) ? {
      ...item,
      taskId: task.id,
      turnId: turn?.id || item.turnId,
      status: terminal
        ? task.status === 'completed' ? response?.status || 'completed' : task.status
        : task.status,
      response: response === null && ['queued', 'running'].includes(task.status) ? null : response || item.response,
      text: terminal
        ? task.status === 'completed' ? agentResponseText(response) : task.error || task.statusMessage || '任务未完成。'
        : typeof task.partialOutput === 'string' && task.partialOutput.length >= String(item.text || '').length
          ? task.partialOutput
          : item.text,
      items: turn?.items || item.items || [],
      events: turn ? agentTurnEvents(turn) : task.events || item.events || [],
      plan: turn?.plan || item.plan || [],
      progress: task.progress || 0,
      statusMessage: task.statusMessage || '',
      reasoningSummary: typeof task.reasoningSummary === 'string' ? task.reasoningSummary : item.reasoningSummary || '',
      reasoningHistory: Array.isArray(task.reasoningHistory) ? task.reasoningHistory : item.reasoningHistory || [],
      inputHistory: Array.isArray(task.inputHistory) ? task.inputHistory : item.inputHistory || [],
      usage: task.usage || item.usage || null,
      durationMs: performance.now() - startedAt,
    } : item))
    return terminal
  }

  async function monitorAssistantTurn(threadId, turnId, taskId, requestId, controller, startedAt) {
    let latestTurn = null
    try {
      await api.streamAgentTurn(threadId, turnId, {
        signal: controller.signal,
        onEvent: (event, payload) => {
          if (['item/agentMessage/delta', 'item/plan/delta'].includes(event) && payload?.turnId === turnId && typeof payload.delta === 'string') {
            setAssistantMessages((current) => current.map((item) => item.role === 'agent' && (item.id === requestId || item.turnId === turnId) ? {
              ...item,
              text: `${item.text || ''}${payload.delta}`,
              statusMessage: '正在生成回复',
            } : item))
            return
          }
          if (event === 'item/reasoning/summaryTextDelta' && payload?.turnId === turnId && typeof payload.delta === 'string') {
            setAssistantMessages((current) => current.map((item) => item.role === 'agent' && (item.id === requestId || item.turnId === turnId) ? {
              ...item,
              reasoningSummary: `${item.reasoningSummary || ''}${payload.delta}`,
            } : item))
            return
          }
          if (event === 'turn/plan/updated' && payload?.turnId === turnId) {
            setAssistantMessages((current) => current.map((item) => item.role === 'agent' && (item.id === requestId || item.turnId === turnId) ? {
              ...item,
              plan: Array.isArray(payload.plan) ? payload.plan : item.plan || [],
            } : item))
            return
          }
          if (event === 'turn/steer/accepted' && payload?.turnId === turnId && payload?.input?.text) {
            setAssistantMessages((current) => {
              const existing = current.some((item) => item.id === payload.input.id
                || (item.steer === true && item.turnId === turnId && item.text === payload.input.text))
              if (existing) {
                return current.map((item) => item.id === payload.input.id
                  || (item.steer === true && item.turnId === turnId && item.text === payload.input.text)
                  ? { ...item, steerStatus: payload.input.status }
                  : item)
              }
              return [...current, {
                id: payload.input.id,
                role: 'user',
                text: payload.input.text,
                turnId,
                steer: true,
                steerStatus: payload.input.status,
              }]
            })
            return
          }
          if (event === 'turn/steered' && payload?.turnId === turnId) {
            setAssistantMessages((current) => current.map((item) => item.role === 'agent'
              && (item.id === requestId || item.turnId === turnId) ? {
                ...item,
                status: 'running',
                text: '',
                response: null,
                reasoningSummary: '',
                statusMessage: '已应用追加指令，正在重新规划',
              } : item))
            return
          }
          if (!event.startsWith('turn/') || !payload?.turn) return
          latestTurn = payload.turn
          if (event === 'turn/started' && ['queued', 'running'].includes(latestTurn.task?.status)) {
            setAssistantMessages((current) => current.map((item) => item.role === 'agent'
              && (item.id === requestId || item.turnId === turnId) ? {
                ...item,
                text: '',
                reasoningSummary: '',
              } : item))
          }
          if (latestTurn.task) applyStreamedTask(latestTurn.task, requestId, startedAt, latestTurn)
          if (latestTurn.task?.status === 'waiting_input') controller.abort()
        },
      })
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') throw error
      while (!latestTurn || latestTurn.status === 'inProgress') {
        await waitForAgentPoll(700, controller.signal)
        latestTurn = (await api.getAgentTurn(threadId, turnId, { signal: controller.signal })).turn
        if (latestTurn.task && applyStreamedTask(latestTurn.task, requestId, startedAt, latestTurn)) break
      }
    }
    return latestTurn
  }

  function stopAssistant() {
    const taskId = assistantTaskIdRef.current
    const turnId = assistantTurnIdRef.current
    const threadId = assistantThread?.id
    if (threadId && turnId) void api.interruptAgentTurn(threadId, turnId).catch(() => undefined)
    else if (taskId) void api.cancelAiTask(taskId).catch(() => undefined)
    assistantAbortRef.current?.abort()
    setAssistantMessages((current) => current.map((item) => item.role === 'agent' && item.taskId === taskId ? {
      ...item,
      status: 'cancelled',
      text: '已停止本次运行。',
    } : item))
    setAssistantRunning(false)
  }

  async function clearAssistant() {
    const taskId = assistantTaskIdRef.current
    const activeTurnId = assistantTurnIdRef.current
    if (assistantThread?.id && activeTurnId) void api.interruptAgentTurn(assistantThread.id, activeTurnId).catch(() => undefined)
    else if (taskId) void api.cancelAiTask(taskId).catch(() => undefined)
    assistantAbortRef.current?.abort()
    assistantAbortRef.current = null
    assistantTaskIdRef.current = null
    assistantTurnIdRef.current = null
    setAssistantMessages([])
    const threadId = assistantThread?.id
    setAssistantThread(null)
    setAssistantRunning(false)
    setAssistantElapsedMs(0)
    setAssistantInput('')
    if (threadId) {
      try {
        await api.archiveAgentThread(threadId)
        onNotify('已新建 Agent 会话')
      } catch (error) {
        onNotify(error.message || 'Agent 会话归档失败')
      }
    }
  }

  async function applyAssistantRevision(run, reviewedText) {
    const content = String(reviewedText || '').trim()
    if (!content || run.applied) return
    const source = run.source || {}
    if (String(source.chapterId ?? '') !== String(displayChapter.id)) {
      onNotify('这份修改属于其他章节，无法应用到当前正文')
      return
    }
    const hasSelection = Number(source.selectionEnd) > Number(source.selectionStart) && Boolean(source.selectedText)
    const sourceMatches = hasSelection
      ? draft.slice(source.selectionStart, source.selectionEnd) === source.selectedText
      : draft === source.sourceText
    if (!sourceMatches) {
      onNotify('正文已发生变化，这份 Agent 修改已过期')
      return
    }
    try {
      await onCreateHistory?.(draft, { awaitSave: true })
    } catch {
      onNotify('应用前快照保存失败，已取消修改')
      return
    }
    const before = draft
    const next = hasSelection
      ? `${draft.slice(0, source.selectionStart)}${content}${draft.slice(source.selectionEnd)}`
      : content
    commitDraftChange(next)
    onAiApplied?.({ chapterId: displayChapter.id, content: before, runId: run.response?.run_id || run.id })
    setAssistantMessages((current) => current.map((item) => item.id === run.id ? { ...item, applied: true } : item))
    onNotify(hasSelection ? '已应用选中的 Agent 修改，可一键恢复' : '已应用 Agent 修改，可一键恢复')
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
  const availableAgentModels = [...new Set([...(agentModel ? [agentModel] : []), ...agentModels])]
  const agentModelOptions = [
    { value: '', label: '默认模型', description: '使用连接设置中的默认模型', badge: '默认' },
    ...availableAgentModels.map((model) => ({ value: model, label: model, description: '通过当前 API 连接提供' })),
  ]
  const agentSessionUsage = assistantMessages
    .filter((message) => message.role === 'agent')
    .reduce((total, run) => {
      const usage = agentRunTokenUsage(run)
      total.inputTokens += usage.inputTokens
      total.outputTokens += usage.outputTokens
      total.cachedInputTokens += usage.cachedInputTokens
      total.reasoningTokens += usage.reasoningTokens
      total.estimated ||= usage.estimated
      return total
    }, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, estimated: false })
  const latestAgentRun = [...assistantMessages].reverse().find((message) => message.role === 'agent')
  const latestAgentUsage = latestAgentRun ? agentRunTokenUsage(latestAgentRun) : null
  const agentContextUsed = Math.max(0, latestAgentUsage
    ? latestAgentUsage.inputTokens + latestAgentUsage.outputTokens
    : Math.ceil(String(draft || '').length / 2.2))
  const agentContextPercent = Math.min(100, Math.round((agentContextUsed / Math.max(100, agentContextWindow)) * 100))
  const agentContextLabel = `上下文已使用 ${agentContextPercent}% · ${compactTokenCount(agentContextUsed)} / ${compactTokenCount(agentContextWindow)} Tokens`
  const agentFileOptions = [
    {
      key: `project:${project.id}`,
      name: `${project.title}.story.md`,
      kind: '作品设定',
      description: `${project.type} · ${project.genre} · 作品设定`,
      content: `# ${project.title}\n\n篇幅：${project.type}\n题材：${project.genre}\n流派：${project.style || '未设置'}\n创作基调：${project.tone || '未设置'}`,
    },
    ...chapters.map((chapter) => ({
      key: `chapter:${chapter.id}`,
      name: `${String(chapter.id).padStart(2, '0')}-${chapter.title}.md`,
      kind: '章节正文',
      description: `${String(chapter.id) === String(displayChapter.id) ? '当前章节 · ' : ''}${chapter.words || 0} 字`,
      chapterId: chapter.id,
    })),
  ]
  const suggestionQuery = assistantSuggestion?.query || ''
  const agentSkillCommands = skills
    .filter((skill) => skill.name?.startsWith('story') || skill.source === 'market')
    .map((skill) => ({
      name: `skill:${skill.name}`,
      usage: skill.name,
      description: skill.source === 'market' ? `社区 Skill · ${skill.displayName || skill.name}` : skill.description || '运行这个 Story Skill',
      insertText: `/skill ${skill.name} `,
      kind: 'skill',
      status: skill.status,
    }))
  const filteredAgentCommands = [...editorAgentCommands, ...agentSkillCommands]
    .filter((command) => !suggestionQuery || command.name.includes(suggestionQuery) || command.description.includes(suggestionQuery))
    .slice(0, 40)
  const filteredAgentFiles = agentFileOptions
    .filter((file) => !suggestionQuery || `${file.name} ${file.kind} ${file.description}`.toLowerCase().includes(suggestionQuery))
    .slice(0, 40)
  const anchorIdeas = matchedIdeas.filter((idea) => idea.pinned || /剧情|冲突|场景|线索|锚点/.test(`${idea.label}${idea.title}${(idea.tags || []).join('')}`)).slice(0, 4)
  const searchCount = searchQuery.trim() ? (draft.toLowerCase().match(new RegExp(searchQuery.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length : 0
  const splitBefore = draft.slice(0, splitPosition).trim()
  const splitAfter = draft.slice(splitPosition).trim()
  const editorTabs = openChapterIds.map((id) => chapters.find((chapter) => String(chapter.id) === String(id))).filter(Boolean)

  function openForeshadowEditor(target = null) {
    setForeshadowTarget(target)
    setForeshadowOpen(true)
  }

  return <>
    <div className={`page editor-page ${readingMode ? 'reading-mode' : ''} ${assistantOpen ? '' : 'assistant-hidden'}`}>
      <div className="editor-document-tabs" aria-label="已打开章节">
        {editorTabs.map((chapter) => {
          const current = String(chapter.id) === String(displayChapter.id)
          return <div className={`editor-document-tab ${current ? 'active' : ''}`} key={chapter.id}>
            <button type="button" className="editor-document-tab-main" onClick={() => selectEditorChapter(chapter)} disabled={draftLoading && !current}>
              <FileText size={13} />
              <span>{chapter.title}</span>
            </button>
            <button type="button" className="editor-tab-close" aria-label={`关闭 ${chapter.title}`} title="关闭标签" onClick={(event) => closeEditorTab(event, chapter)}><X size={12} /></button>
          </div>
        })}
        <button type="button" className="editor-new-tab" aria-label="新建章节" title="新建章节" onClick={onNewChapter}><Plus size={16} /></button>
      </div>

      <div className="editor-topline">
        <button type="button" className="mobile-chapter-button icon-button" aria-label="打开章节目录" title="打开章节目录" onClick={() => setMobileRailOpen(true)}><PanelLeft size={17} /></button>
        <div className="editor-document-context"><span>{project?.title}</span><ChevronRight size={13} /><strong>{displayChapter.title}</strong></div>
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
                {menuOpenId === chapter.id && <div className="chapter-menu" role="menu"><button onClick={() => startRename(chapter)}>重命名</button><button onClick={() => void toggleChapterCompletion(chapter)}>{chapter.state === 'done' ? '恢复为草稿' : '标记为完成'}</button><button className="danger" onClick={() => { setDeleteTarget(chapter); setMenuOpenId(null) }}>删除</button></div>}
              </div>
            })}
          </div>}
          {railTab === '大纲' && <div className="rail-outline-list">{chapters.length ? chapters.map((chapter) => <button key={chapter.id} onClick={() => selectEditorChapter(chapter)}><span>{String(chapter.id).padStart(2, '0')}</span><strong>{chapter.title}</strong><small>{chapter.words} 字</small></button>) : <p className="rail-empty">还没有章节大纲。</p>}</div>}
          {railTab === '人物' && <div className="rail-entity-list">{characterIdeas.length ? characterIdeas.map((idea) => <button key={idea.id} onClick={() => insertMaterial(idea)}><span className="entity-dot coral" /><span><strong>{idea.title}</strong><small>{idea.body.slice(0, 42)}</small></span></button>) : <div className="rail-empty-block"><UsersRound size={22} /><p>还没有人物卡</p><button onClick={() => setIdeaPickerOpen(true)}>从素材库添加</button></div>}</div>}
          {railTab === '词条' && <div className="rail-entity-list">{termIdeas.length ? termIdeas.map((idea) => <button key={idea.id} onClick={() => insertMaterial(idea)}><span className="entity-dot teal" /><span><strong>{idea.title}</strong><small>{idea.body.slice(0, 42)}</small></span></button>) : <div className="rail-empty-block"><Tags size={22} /><p>还没有设定词条</p><button onClick={() => setIdeaPickerOpen(true)}>从素材库添加</button></div>}</div>}
          {railTab === '记忆' && <div className="rail-memory-list">{storyMemories.filter((item) => item.status !== 'archived').length ? storyMemories.filter((item) => item.status !== 'archived').map((memory) => <button key={memory.id} className="rail-memory-item" onClick={() => setMemoryEditing(memory)}><span className={`memory-type-dot ${memory.type}`} /><span><strong>{memory.title}</strong><small>{memory.characterName ? `${memory.characterName} · ` : ''}{memory.content.slice(0, 46)}</small></span><em>{memory.importance || 3}</em></button>) : <div className="rail-empty-block"><BrainCircuit size={22} /><p>还没有确认的作品记忆</p><button onClick={() => void extractMemories()} disabled={memoryLoading}>{memoryLoading ? '整理中…' : '整理本章记忆'}</button></div>}</div>}
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
              <div className="editor-style-anchor">
                <button className={`toolbar-button ${styleMenuOpen || editorFontSize !== 16 || editorLineHeight !== 2.05 ? 'active' : ''}`} aria-label="正文样式" aria-expanded={styleMenuOpen} title="调整正文字号与行距" onClick={() => setStyleMenuOpen((open) => !open)}><Type size={16} /></button>
                {styleMenuOpen && <div className="editor-style-menu" role="dialog" aria-label="正文样式设置">
                  <div className="editor-style-menu-heading"><strong>正文样式</strong><button type="button" aria-label="关闭正文样式" onClick={() => setStyleMenuOpen(false)}><X size={13} /></button></div>
                  <p className="editor-style-note">仅调整编辑区显示，不写入正文。</p>
                  <span>字号</span>
                  <div className="editor-style-options">{[{ value: 15, label: '小' }, { value: 16, label: '标准' }, { value: 18, label: '大' }].map((option) => <button type="button" key={option.value} className={editorFontSize === option.value ? 'active' : ''} onClick={() => { setEditorFontSize(option.value); onNotify(`正文字号已切换为${option.label}`) }}>{option.label}</button>)}</div>
                  <span>行距</span>
                  <div className="editor-style-options">{[{ value: 1.8, label: '紧凑' }, { value: 2.05, label: '舒适' }, { value: 2.35, label: '宽松' }].map((option) => <button type="button" key={option.value} className={editorLineHeight === option.value ? 'active' : ''} onClick={() => { setEditorLineHeight(option.value); onNotify(`正文行距已切换为${option.label}`) }}>{option.label}</button>)}</div>
                  {/\*\*[^*\n]+\*\*|_[^_\n]+_/.test(draft) && <button type="button" className="editor-clean-markers" onClick={cleanInlineMarkdownMarkers}><Wand2 size={13} />清理正文中的 ** / _ 标记</button>}
                </div>}
              </div>
              <button className={`toolbar-button ${editorBold ? 'active' : ''}`} aria-pressed={editorBold} aria-label="加粗显示" title="整篇加粗显示，不修改正文（Ctrl+B）" onClick={toggleEditorBold}><strong>B</strong></button>
              <button className={`toolbar-button ${editorItalic ? 'active' : ''}`} aria-pressed={editorItalic} aria-label="斜体显示" title="整篇斜体显示，不修改正文（Ctrl+I）" onClick={toggleEditorItalic}><Italic size={16} /></button>
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
              <button className={`toolbar-button ${speaking ? 'active speaking' : ''}`} aria-label={speaking ? '停止朗读' : '朗读本章'} title={speaking ? '停止朗读' : '朗读本章'} onClick={readChapterAloud}><Volume2 size={15} /></button>
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
            <header className="manuscript-heading">
              <span>{project?.title} · 第 {displayChapter.id} 章</span>
              <h1>{displayChapter.title}</h1>
            </header>
            <textarea ref={textareaRef} value={draft} onChange={(event) => handleDraftInput(event.target.value)} onKeyDown={handleEditorKeyDown} disabled={draftLoading} spellCheck="false" aria-label="章节正文" placeholder="开始写下这一章的正文…" style={{ fontSize: `${editorFontSize}px`, lineHeight: editorLineHeight, fontWeight: editorBold ? 700 : 400, fontStyle: editorItalic ? 'italic' : 'normal' }} />
            <div className="writing-footer"><span><FileText size={14} />{wordCount.toLocaleString()} 字</span><span><Clock3 size={14} />预计阅读 {readMinutes} 分钟</span><span className="footer-hint">Ctrl / ⌘ + S 保存 · Z 撤销</span></div>
          </div>
        </section>

        <aside className={`insight-rail agent-rail ${assistantOpen ? '' : 'collapsed'}`}>
          {assistantOpen ? <>
            <div className="assistant-panel-heading agent-panel-heading">
              <div className="assistant-title"><Bot size={16} /><strong>{ASSISTANT_NAME}</strong><span>AGENT</span></div>
              <div><button className="icon-button small" disabled={assistantLoading} aria-label="新建会话" title="新建会话" onClick={clearAssistant}><Plus size={15} /></button><button className="icon-button small" aria-label={`收起${ASSISTANT_NAME}`} title={`收起${ASSISTANT_NAME}`} onClick={() => setAssistantOpen(false)}><PanelRight size={15} /></button></div>
            </div>
            <div className="agent-session-strip">
              <div className="agent-token-usage" title={agentSessionUsage.estimated ? '部分模型未返回 usage，缺失部分为估算值' : '模型返回的 Token 用量'}>
                <span>Tokens{agentSessionUsage.estimated && agentSessionUsage.inputTokens ? ' ≈' : ''}</span>
                <span>↑ {compactTokenCount(agentSessionUsage.inputTokens)}</span>
                <span>↓ {compactTokenCount(agentSessionUsage.outputTokens)}</span>
                <span>◇ {compactTokenCount(agentSessionUsage.cachedInputTokens)}</span>
                {agentSessionUsage.reasoningTokens > 0 && <span>◈ {compactTokenCount(agentSessionUsage.reasoningTokens)}</span>}
              </div>
              <button type="button" className={`agent-context-progress ${assistantRunning ? 'running' : ''}`} title={agentContextLabel} aria-label={agentContextLabel} onClick={onOpenSettings}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="agent-context-track" cx="12" cy="12" r="9" pathLength="100" />
                  <circle className="agent-context-value" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${agentContextPercent} 100`} />
                </svg>
              </button>
            </div>
            {assistantThread?.compactedTurnCount > 0 && <div className="agent-compaction-note" title={assistantThread.contextSummary || '较早对话已压缩为滚动摘要，并会继续参与后续写作'}>
              <BrainCircuit size={12} />
              <span>已压缩 {assistantThread.compactedTurnCount} 轮上下文 · 摘要持续参与写作</span>
            </div>}
            <div className="agent-conversation" ref={assistantStreamRef}>
              {assistantLoading && <div className="agent-empty"><LoaderCircle size={20} className="spin" /><strong>正在恢复会话</strong><p>读取本章的 Agent Turn 与任务状态。</p></div>}
              {!assistantLoading && assistantMessages.length === 0 && <div className="agent-empty">
                <div className="agent-empty-mark"><Bot size={20} /></div>
                <strong>和 {ASSISTANT_NAME} 一起写</strong>
                <p>Agent 会读取当前作品、章节正文和选区，执行任务后再由你决定是否应用修改。</p>
                <div className="agent-starters">
                  <button onClick={(event) => submitAssistant(event, '/write 加强冲突，结尾留下新的悬念')}><PenLine size={13} />续写本章</button>
                  <button onClick={(event) => submitAssistant(event, '/review 重点检查人物动机和节奏')}><BrainCircuit size={13} />审查章节</button>
                  <button onClick={(event) => submitAssistant(event, '/polish 保留作者语气，降低模板感')}><Wand2 size={13} />自然化润色</button>
                </div>
              </div>}
              {assistantMessages.map((message, index) => message.role === 'user'
                ? <div className="agent-user-turn" key={message.id}><p>{message.text}</p></div>
                : <EditorAgentTurn
                  key={message.id}
                  run={message}
                  elapsedMs={message.status === 'running' ? assistantElapsedMs : message.durationMs}
                  onApply={applyAssistantRevision}
                  onChoose={(reply) => submitAssistantAnswer(message, reply)}
                  choiceDisabled={assistantRunning || assistantLoading || index !== assistantMessages.length - 1}
                />)}
            </div>
            <div className="agent-composer-wrap">
              <div className="agent-context-line"><span><FileText size={12} />{displayChapter.title}</span><small>{wordCount.toLocaleString()} 字{textareaRef.current?.selectionEnd > textareaRef.current?.selectionStart ? ' · 已关联选区' : ''}</small></div>
              <form className="assistant-form agent-composer" onSubmit={submitAssistant}>
                <input ref={assistantFileInputRef} className="agent-file-input" type="file" multiple accept=".txt,.md,.markdown,.json,.csv,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.java,.go,.rs,text/*,application/json" onChange={handleExternalFiles} />
                {assistantAttachments.length > 0 && <div className="agent-attachment-list" aria-label="已添加的上下文文件">{assistantAttachments.map((file) => <span className="agent-attachment-chip" key={file.key}><FileText size={11} /><span>{file.name}</span><button type="button" aria-label={`移除 ${file.name}`} onClick={() => removeAssistantAttachment(file.key)}><X size={10} /></button></span>)}</div>}
                <textarea
                  ref={assistantInputRef}
                  value={assistantInput}
                  disabled={assistantLoading}
                  onChange={handleAssistantInputChange}
                  onClick={(event) => refreshAssistantSuggestion(event.currentTarget.value, event.currentTarget.selectionStart)}
                  onKeyDown={handleAssistantComposerKeyDown}
                  rows={3}
                  placeholder={assistantRunning ? '追加指令到当前轮次…' : '让 Agent 续写、审查或修改… 输入 @ 添加文件，/ 使用命令'}
                  aria-label="输入问题或需求"
                  aria-autocomplete="list"
                  aria-expanded={Boolean(assistantSuggestion)}
                />
                {assistantSuggestion && <div className="agent-composer-suggestions" role="listbox" aria-label={assistantSuggestion.type === 'command' ? '命令建议' : '文件建议'}>
                  <div className="agent-suggestion-list">
                    {assistantSuggestion.type === 'command' ? <>
                      {filteredAgentCommands.some((item) => item.kind === 'command') && <div className="agent-suggestion-section-label">命令</div>}
                      {filteredAgentCommands.filter((item) => item.kind === 'command').map((command) => {
                        const index = filteredAgentCommands.indexOf(command)
                        return <button type="button" role="option" aria-selected={index === assistantSuggestionIndex} className={index === assistantSuggestionIndex ? 'active' : ''} key={command.name} onMouseEnter={() => setAssistantSuggestionIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => selectAssistantCommand(command)}><Command size={13} /><strong>{command.usage}</strong><small>{command.description}</small></button>
                      })}
                      {filteredAgentCommands.some((item) => item.kind === 'skill') && <div className="agent-suggestion-section-label">Skills</div>}
                      {filteredAgentCommands.filter((item) => item.kind === 'skill').map((command) => {
                        const index = filteredAgentCommands.indexOf(command)
                        return <button type="button" role="option" aria-selected={index === assistantSuggestionIndex} className={index === assistantSuggestionIndex ? 'active' : ''} key={command.name} onMouseEnter={() => setAssistantSuggestionIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => selectAssistantCommand(command)}><Sparkles size={13} /><strong>{command.usage}</strong><small>{command.description}</small><em>{command.status === 'ready' ? '可用' : command.status === 'needs_model' ? '需模型' : command.status || '已安装'}</em></button>
                      })}
                    </> : <>
                      <div className="agent-suggestion-section-label">添加</div>
                      <button type="button" role="option" aria-selected={assistantSuggestionIndex === 0} className={`agent-external-file-option ${assistantSuggestionIndex === 0 ? 'active' : ''}`} onMouseEnter={() => setAssistantSuggestionIndex(0)} onMouseDown={(event) => event.preventDefault()} onClick={openExternalFilePicker}><Paperclip size={13} /><strong>文件</strong><small>从电脑选择文本文件</small></button>
                      <div className="agent-suggestion-section-label">当前作品</div>
                      {filteredAgentFiles.map((file, fileIndex) => {
                        const index = fileIndex + 1
                        return <button type="button" role="option" aria-selected={index === assistantSuggestionIndex} className={index === assistantSuggestionIndex ? 'active' : ''} key={file.key} onMouseEnter={() => setAssistantSuggestionIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => void selectAssistantFile(file)}><FileText size={13} /><strong>{file.name}</strong><small>{file.kind} · {file.description}</small>{assistantAttachments.some((item) => item.key === file.key) && <Check size={12} />}</button>
                      })}
                    </>}
                    {((assistantSuggestion.type === 'command' && !filteredAgentCommands.length) || (assistantSuggestion.type === 'file' && !filteredAgentFiles.length)) && <div className="agent-suggestion-empty">没有匹配项</div>}
                    {assistantAttachmentLoading && <div className="agent-suggestion-loading"><LoaderCircle size={13} className="spin" />正在读取文件</div>}
                  </div>
                  <div className="agent-suggestion-footer"><span><kbd>↑</kbd><kbd>↓</kbd>选择</span><span><kbd>↵</kbd>确认</span><span><kbd>Esc</kbd>关闭</span></div>
                </div>}
                <div className="agent-composer-footer">
                  <div className="agent-composer-controls" ref={agentControlsRef}>
                    <button type="button" className={`agent-mode-trigger ${agentPickerOpen === 'mode' ? 'open' : ''}`} aria-haspopup="listbox" aria-expanded={agentPickerOpen === 'mode'} onClick={() => toggleAgentPicker('mode')} title="选择执行模式"><UserRound size={13} /><span>{agentModeOptions.find((option) => option.value === agentMode)?.label || 'Build'}</span></button>
                    <button type="button" className={`agent-tool-button ${agentWebSearch ? 'active' : ''}`} aria-pressed={agentWebSearch} onClick={() => setAgentWebSearch((active) => !active)} title={agentWebSearch ? '关闭联网搜索' : '开启联网搜索'}><Globe size={13} /><span>联网</span></button>
                    <button type="button" className={`agent-tool-button ${agentMultiAgent ? 'active' : ''}`} aria-pressed={agentMultiAgent} onClick={() => setAgentMultiAgent((active) => !active)} title={agentMultiAgent ? '关闭双子代理协作' : '开启双子代理协作（会额外使用 token）'}><UsersRound size={13} /><span>协作</span></button>
                    <button type="button" className={`agent-control-trigger model ${agentPickerOpen === 'model' ? 'open' : ''}`} aria-haspopup="listbox" aria-expanded={agentPickerOpen === 'model'} disabled={agentSettingSaving} onClick={() => toggleAgentPicker('model')} title="选择模型">
                      <Bot size={13} />
                      <span>{agentModel || (agentModelsLoading ? '读取中…' : '默认模型')}</span>
                      <ChevronDown size={11} />
                    </button>
                    <button type="button" className={`agent-control-trigger reasoning ${agentPickerOpen === 'reasoning' ? 'open' : ''}`} aria-haspopup="listbox" aria-expanded={agentPickerOpen === 'reasoning'} disabled={agentSettingSaving} onClick={() => toggleAgentPicker('reasoning')} title="选择思考强度">
                      <BrainCircuit size={13} />
                      <span>{agentReasoningOptions.find((option) => option.value === agentReasoningEffort)?.label || '自动'}</span>
                      <ChevronDown size={11} />
                    </button>
                    {agentPickerOpen === 'model' && <AgentComposerMenu
                      title="选择模型"
                      description="模型来自当前 API 连接"
                      options={agentModelOptions}
                      value={agentModel}
                      loading={agentModelsLoading}
                      onSelect={(value) => { setAgentPickerOpen(null); updateAgentSetting('model', value) }}
                    />}
                    {agentPickerOpen === 'reasoning' && <AgentComposerMenu
                      title="思考强度"
                      description="强度越高，通常耗时和 token 越多"
                      options={agentReasoningOptions}
                      value={agentReasoningEffort}
                      loading={false}
                      onSelect={(value) => { setAgentPickerOpen(null); updateAgentSetting('reasoningEffort', value) }}
                    />}
                    {agentPickerOpen === 'mode' && <AgentComposerMenu
                      title="执行模式"
                      description="决定普通消息的默认处理方式"
                      options={agentModeOptions}
                      value={agentMode}
                      loading={false}
                      onSelect={(value) => { setAgentMode(value); setAgentPickerOpen(null) }}
                    />}
                    <button type="button" className="agent-tool-button icon-only" onClick={onOpenSettings} title="打开模型设置" aria-label="打开模型设置"><Settings2 size={14} /></button>
                  </div>
                  <div className="agent-composer-actions">
                    {assistantRunning && <button type="submit" className="assistant-send steer" disabled={!assistantInput.trim()} aria-label="追加指令" title="追加到当前轮次"><Send size={15} /></button>}
                    {assistantRunning ? <button type="button" className="assistant-send stop" onClick={stopAssistant} aria-label="停止" title="停止"><X size={15} /></button> : <button type="submit" className="assistant-send" disabled={assistantLoading || !assistantInput.trim()} aria-label="发送" title="发送"><Send size={15} /></button>}
                  </div>
                </div>
              </form>
            </div>
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

function Works({ projects, onOpen, onNew, onEdit, onDelete, onImport }) {
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
    <div className="page-heading"><div><span className="section-overline">作品空间</span><h1>我的作品</h1><p>所有故事都在这里继续。</p></div><div className="works-heading-actions"><button className="secondary-button" onClick={onImport}><Download size={16} />导入本地文稿</button><button className="primary-button" onClick={onNew}><BookPlus size={17} />新建作品</button></div></div>
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

function formatFileSize(value) {
  const bytes = Math.max(0, Number(value) || 0)
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '')
    reader.onerror = () => reject(new Error('读取 Skill 文件失败'))
    reader.readAsDataURL(file)
  })
}

function SkillMarket({ user, onNotify, onSkillsChanged }) {
  const [items, setItems] = useState([])
  const [categories, setCategories] = useState(['写作', '审稿', '人物', '世界观', '效率', '其他'])
  const [reviewConfig, setReviewConfig] = useState({ mode: 'optional', configured: false, provider: 'static' })
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [mineOnly, setMineOnly] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [installingId, setInstallingId] = useState(null)
  const [reviewingId, setReviewingId] = useState(null)

  async function loadMarket() {
    setLoading(true)
    try {
      const response = await api.getSkillMarket()
      setItems(response.items || [])
      if (response.categories?.length) setCategories(response.categories)
      if (response.review) setReviewConfig(response.review)
    } catch (error) {
      onNotify(error.message || '技能市场读取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadMarket() }, [])

  const normalizedQuery = query.trim().toLowerCase()
  const filtered = items.filter((item) => {
    const haystack = [item.name, item.description, item.category, item.author?.name, ...(item.tags || [])].join(' ').toLowerCase()
    return (!normalizedQuery || haystack.includes(normalizedQuery))
      && (!category || item.category === category)
      && (!mineOnly || item.isOwner)
  })

  async function installSkill(item) {
    setInstallingId(item.id)
    try {
      const response = await api.installMarketSkill(item.id)
      setItems((current) => current.map((entry) => entry.id === item.id ? response.item : entry))
      await onSkillsChanged?.({ notifyResult: false })
      onNotify(`已导入 ${item.name}，现在可以在 Skill 选择器中使用`)
    } catch (error) {
      onNotify(error.message || 'Skill 导入失败')
    } finally {
      setInstallingId(null)
    }
  }

  async function uninstallSkill(item) {
    setInstallingId(item.id)
    try {
      await api.uninstallMarketSkill(item.id)
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, installed: false, installCount: Math.max(0, Number(entry.installCount || 0) - 1) } : entry))
      await onSkillsChanged?.({ notifyResult: false })
      onNotify(`已从能力目录移除 ${item.name}`)
    } catch (error) {
      onNotify(error.message || 'Skill 移除失败')
    } finally {
      setInstallingId(null)
    }
  }

  async function reviewAgain(item) {
    setReviewingId(item.id)
    try {
      const response = await api.reviewMarketSkill(item.id)
      setItems((current) => current.map((entry) => entry.id === item.id ? response.item : entry))
      onNotify(`安全审查通过，${item.name} 已上架`)
    } catch (error) {
      onNotify(error.message || 'Skill 审查未通过')
      await loadMarket()
    } finally {
      setReviewingId(null)
    }
  }

  async function deleteSkill() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.deleteMarketSkill(deleteTarget.id)
      setItems((current) => current.filter((item) => item.id !== deleteTarget.id))
      onNotify(`已下架 ${deleteTarget.name}`)
      setDeleteTarget(null)
    } catch (error) {
      onNotify(error.message || 'Skill 下架失败')
    } finally {
      setDeleting(false)
    }
  }

  const listedItems = items.filter((item) => item.isListed)
  const totalInstalls = listedItems.reduce((sum, item) => sum + Number(item.installCount || 0), 0)
  const creatorCount = new Set(listedItems.map((item) => item.author?.id).filter(Boolean)).size

  return <>
    <div className="page inner-page skill-market-page">
      <div className="page-heading">
        <div><span className="section-overline">COMMUNITY SKILLS</span><h1>技能市场</h1><p>发现其他作者分享的创作工作流，也可以发布自己的 Skill。</p></div>
        <button className="primary-button" onClick={() => setUploadOpen(true)}><UploadCloud size={17} />上传 Skill</button>
      </div>

      <section className="skill-market-overview">
        <div><Store size={21} /><span><strong>{listedItems.length}</strong><small>已上架技能</small></span></div>
        <div><UsersRound size={21} /><span><strong>{creatorCount}</strong><small>社区作者</small></span></div>
        <div><Download size={21} /><span><strong>{formatNumber(totalInstalls)}</strong><small>累计导入</small></span></div>
        <p className={reviewConfig.configured ? 'review-ready' : 'review-basic'}>
          {reviewConfig.configured ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}
          {reviewConfig.configured
            ? '发布前先做归档检查与专用模型严格安全审查；高风险内容不会进入市场。'
            : '当前仅启用基础文件审查；生产部署应配置专用审查模型后再开放上传。'}
        </p>
      </section>

      <div className="skill-market-toolbar">
        <div className="library-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能、作者或标签…" aria-label="搜索技能市场" /></div>
        <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="按技能分类筛选"><option value="">全部分类</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select>
        <button className={mineOnly ? 'selected' : ''} onClick={() => setMineOnly((value) => !value)}><UserRound size={14} />只看我的</button>
      </div>

      {loading ? <div className="skill-market-loading"><LoaderCircle size={22} className="spin" /><span>正在读取社区 Skill</span></div>
        : filtered.length ? <div className="skill-market-grid">{filtered.map((item) => <article className={`market-skill-card ${item.isListed ? '' : 'pending'}`} key={item.id}>
          <div className="market-skill-top">
            <span className="market-skill-icon"><Package size={20} /></span>
            <span className="market-category">{item.category}</span>
            <span className={`market-review-badge ${item.isListed ? 'verified' : 'pending'}`}>
              {item.isListed ? <ShieldCheck size={10} /> : <ShieldAlert size={10} />}
              {item.isListed ? '审查通过' : '待模型审查'}
            </span>
            {item.isOwner && <span className="market-owner">我的</span>}
          </div>
          <h2>{item.name}</h2>
          <p>{item.description}</p>
          <div className="market-skill-tags">{(item.tags || []).map((tag) => <span key={tag}>#{tag}</span>)}</div>
          <dl>
            <div><dt>作者</dt><dd>{item.author?.name || '匿名作者'}</dd></div>
            <div><dt>版本</dt><dd>v{item.version}</dd></div>
            <div><dt>文件</dt><dd>{formatFileSize(item.fileSize)}</dd></div>
          </dl>
          <footer>
            <span><Download size={13} />{formatNumber(item.installCount)} 次导入</span>
            {item.isOwner && <button type="button" className="market-delete" onClick={() => setDeleteTarget(item)}>下架</button>}
            {!item.isListed && item.isOwner && <button type="button" className="market-download" disabled={reviewingId === item.id} onClick={() => reviewAgain(item)}>{reviewingId === item.id ? <LoaderCircle size={14} className="spin" /> : <ShieldCheck size={14} />}{reviewingId === item.id ? '审查中' : '重新审查'}</button>}
            {item.isListed && item.installed && <button type="button" className="market-installed" disabled={installingId === item.id} onClick={() => uninstallSkill(item)}>{installingId === item.id ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{installingId === item.id ? '处理中' : '已导入 · 移除'}</button>}
            {item.isListed && !item.installed && <button type="button" className="market-download" disabled={installingId === item.id} onClick={() => installSkill(item)}>{installingId === item.id ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{installingId === item.id ? '导入中' : '导入使用'}</button>}
          </footer>
        </article>)}</div>
          : <div className="empty-state skill-market-empty"><Package size={27} /><h2>{items.length ? '没有匹配的 Skill' : '技能市场还没有内容'}</h2><p>{items.length ? '调整搜索词或筛选条件再试试。' : '成为第一个分享创作 Skill 的作者。'}</p><button className="primary-button" onClick={() => setUploadOpen(true)}><UploadCloud size={16} />上传第一个 Skill</button></div>}
    </div>

    {uploadOpen && <SkillUploadModal categories={categories} reviewConfig={reviewConfig} user={user} onClose={() => setUploadOpen(false)} onUploaded={(item) => { setItems((current) => [item, ...current]); setUploadOpen(false); onNotify(item.isListed ? `安全审查通过，已上架 ${item.name}` : `${item.name} 已保存，等待专用模型审查后上架`) }} />}
    {deleteTarget && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !deleting && setDeleteTarget(null)}><div className="modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">下架技能</span><h2>下架《{deleteTarget.name}》？</h2></div><button className="icon-button" disabled={deleting} aria-label="关闭" onClick={() => setDeleteTarget(null)}><X size={18} /></button></div><p className="confirm-text">下架后其他用户将无法继续下载，已下载到本地的文件不会被删除。</p><div className="modal-actions"><button className="secondary-button" disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button><button className="dark-button danger-button" disabled={deleting} onClick={deleteSkill}>{deleting ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}{deleting ? '下架中' : '确认下架'}</button></div></div></div>}
  </>
}

function SkillUploadModal({ categories, reviewConfig, user, onClose, onUploaded }) {
  const [form, setForm] = useState({ name: '', description: '', version: '1.0.0', category: '写作', tags: '' })
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  async function submit(event) {
    event.preventDefault()
    setError('')
    if (!file) {
      setError('请选择一个 .md、.markdown 或 .zip Skill 文件')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('Skill 文件不能超过 2 MB')
      return
    }
    setUploading(true)
    try {
      const contentBase64 = await readFileAsBase64(file)
      const response = await api.uploadMarketSkill({
        ...form,
        tags: form.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
        fileName: file.name,
        contentBase64,
      })
      onUploaded(response.item)
    } catch (uploadError) {
      setError(uploadError.message || 'Skill 上传失败')
    } finally {
      setUploading(false)
    }
  }

  return <div className="modal-backdrop skill-upload-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !uploading && onClose()}>
    <div className="modal skill-upload-modal" role="dialog" aria-modal="true" aria-labelledby="skill-upload-title">
      <div className="modal-heading"><div><span className="section-overline">发布到社区</span><h2 id="skill-upload-title">上传 Skill</h2><p className="skill-upload-author">发布者：{user?.name}</p></div><button className="icon-button" disabled={uploading} aria-label="关闭" onClick={onClose}><X size={18} /></button></div>
      <form onSubmit={submit}>
        <div className="form-row"><label>Skill 名称<input autoFocus value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} maxLength={80} placeholder="例如：长篇伏笔检查" required /></label><label>版本号<input value={form.version} onChange={(event) => setForm((current) => ({ ...current, version: event.target.value }))} maxLength={32} placeholder="1.0.0" required /></label></div>
        <label>简介<textarea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} maxLength={500} rows={4} placeholder="说明这个 Skill 能解决什么问题、适合什么场景…" required /></label>
        <div className="form-row"><label>分类<select value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label><label>标签<input value={form.tags} onChange={(event) => setForm((current) => ({ ...current, tags: event.target.value }))} placeholder="长篇，伏笔，连续性" /></label></div>
        <label className={`skill-file-picker ${file ? 'selected' : ''}`}>
          <input type="file" accept=".md,.markdown,.zip,text/markdown,application/zip" onChange={(event) => { setFile(event.target.files?.[0] || null); setError('') }} />
          <UploadCloud size={24} />
          <span><strong>{file ? file.name : '选择 Skill 文件'}</strong><small>{file ? `${formatFileSize(file.size)} · 点击可更换` : '支持 Markdown 或 ZIP，最大 2 MB'}</small></span>
        </label>
        <div className="skill-upload-safety">
          {reviewConfig.configured ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}
          <span>{reviewConfig.configured
            ? '提交后将先进行归档规则扫描和专用模型严格安全审查。内容不会自动执行，只有审查通过才会发布。'
            : '当前开发环境未配置专用审查模型，将只进行基础归档与秘密信息检查；生产环境会安全地阻止未审查发布。'}</span>
        </div>
        {error && <p className="skill-upload-error">{error}</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" disabled={uploading} onClick={onClose}>取消</button><button type="submit" className="dark-button" disabled={uploading}>{uploading ? <LoaderCircle size={15} className="spin" /> : <UploadCloud size={15} />}{uploading ? '上传中' : '发布 Skill'}</button></div>
      </form>
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
      <button className="primary-button" onClick={() => onNavigate('editor')}><PenLine size={16} />工作台</button>
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
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-project-title"><div className="modal-heading"><div><span className="section-overline">开始一个新故事</span><h2 id="new-project-title">新建作品</h2></div><button className="icon-button" aria-label="关闭" title="关闭" onClick={onClose}><X size={18} /></button></div><form onSubmit={onCreate}><label>作品名<input name="title" autoFocus placeholder="例如：潮汐之上" /></label><div className="form-row"><label>篇幅<select name="type" defaultValue="长篇"><option>长篇</option><option>短篇</option><option>参考书</option></select></label><label>题材<select name="genre" defaultValue="现代言情"><ProjectGenreOptions /></select></label></div><label>流派 / 核心爽点<input name="style" maxLength={80} placeholder="例如：重生复仇、甜宠拉扯" /></label><div className="modal-note"><Sparkles size={16} /><span>创建后，你可以先写一句话故事核，其他设定随时补充。</span></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="dark-button"><Plus size={16} />创建作品</button></div></form></div></div>
}

function ProjectGenreOptions({ value = '' }) {
  return <>
    {value && !PROJECT_GENRES.includes(value) && <option value={value}>{value}</option>}
    {PROJECT_GENRE_GROUPS.map((group) => <optgroup label={group.label} key={group.label}>
      {group.options.map((genre) => <option value={genre} key={genre}>{genre}</option>)}
    </optgroup>)}
  </>
}

function EditProjectModal({ project, onClose, onSave }) {
  const [form, setForm] = useState({ title: project.title, type: project.type, genre: project.genre, style: project.style || '', status: project.status, tone: project.tone })
  function submit(event) {
    event.preventDefault()
    onSave(form)
  }
  function update(field, value) { setForm((f) => ({ ...f, [field]: value })) }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="section-overline">编辑作品</span><h2>作品设置</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></div><form onSubmit={submit}><label>作品名<input value={form.title} onChange={(e) => update('title', e.target.value)} maxLength={80} /></label><div className="form-row"><label>篇幅<select value={form.type} onChange={(e) => update('type', e.target.value)}><option>长篇</option><option>短篇</option><option>参考书</option></select></label><label>题材<select value={form.genre} onChange={(e) => update('genre', e.target.value)}><ProjectGenreOptions value={form.genre} /></select></label></div><label>流派 / 核心爽点<input value={form.style} onChange={(e) => update('style', e.target.value)} maxLength={80} placeholder="例如：逆袭打脸、克苏鲁悬疑" /></label><label>状态<select value={form.status} onChange={(e) => update('status', e.target.value)}><option>构思中</option><option>连载中</option><option>已完结</option><option>已拆文</option></select></label><label>创作基调<input value={form.tone} onChange={(e) => update('tone', e.target.value)} maxLength={160} placeholder="一句话描述整体气质" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="dark-button">保存</button></div></form></div></div>
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
  const [activePane, setActivePane] = useState('connection')
  const [connectionStatus, setConnectionStatus] = useState('idle')
  const [form, setForm] = useState({ provider: 'openai', apiBaseUrl: '', apiKey: '', model: '', reasoningEffort: '', temperature: 0.7, maxTokens: 4096, contextWindow: 100000 })

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
          reasoningEffort: s.reasoningEffort || '',
          temperature: s.temperature ?? 0.7,
          maxTokens: s.maxTokens ?? 4096,
          contextWindow: s.contextWindow ?? 100000,
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
      window.dispatchEvent(new CustomEvent('story:model-settings-updated', { detail: response.settings }))
      onNotify('设置已保存')
    } catch (error) {
      onNotify(error.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleFetchModels() {
    setFetchingModels(true)
    setConnectionStatus('testing')
    try {
      const response = await api.getModels({
        provider: form.provider,
        apiBaseUrl: form.apiBaseUrl,
        apiKey: form.apiKey,
      })
      setModelList(response.models || [])
      setConnectionStatus('connected')
      if (!(response.models || []).length) onNotify('连接成功，但接口没有返回可用模型')
    } catch (error) {
      setConnectionStatus('error')
      onNotify(error.message || '获取模型列表失败')
    } finally {
      setFetchingModels(false)
    }
  }

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
    if (['provider', 'apiBaseUrl', 'apiKey'].includes(field)) setConnectionStatus('idle')
  }

  const apiKeyPlaceholder = settings?.apiKeyMask ? `已配置 ${settings.apiKeyMask}，留空不修改` : '输入 API Key'
  const connectionCopy = {
    idle: settings?.apiKeyMask ? '已保存凭据' : '等待配置',
    testing: '正在连接',
    connected: `连接正常${modelList.length ? ` · ${modelList.length} 个模型` : ''}`,
    error: '连接失败',
  }[connectionStatus]

  return <div className="modal-backdrop settings-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="settings-header">
        <div className="settings-title-group">
          <div className="settings-title-icon"><Settings2 size={18} /></div>
          <div>
            <h2 id="settings-title">模型与连接</h2>
            <p className="settings-subtitle">管理 Agent 使用的模型服务和生成参数。</p>
          </div>
        </div>
        <button className="icon-button" aria-label="关闭" title="关闭" onClick={onClose}><X size={19} /></button>
      </header>

      {loading ? (
        <div className="settings-loading"><LoaderCircle size={20} className="spin" /><span>正在读取设置</span></div>
      ) : (
        <form className="settings-form" onSubmit={handleSave}>
          <div className="settings-layout">
            <nav className="settings-nav" aria-label="设置分类">
              <button type="button" className={activePane === 'connection' ? 'active' : ''} onClick={() => setActivePane('connection')}><Globe size={16} /><span><strong>连接与模型</strong><small>服务商、地址和密钥</small></span></button>
              <button type="button" className={activePane === 'generation' ? 'active' : ''} onClick={() => setActivePane('generation')}><BrainCircuit size={16} /><span><strong>生成参数</strong><small>思考强度与上下文</small></span></button>
              <div className={`settings-connection-state ${connectionStatus}`}>
                <span />
                <div><strong>{connectionCopy}</strong><small>API Key 仅加密保存在服务端</small></div>
              </div>
            </nav>

            <div className="settings-pane">
              {activePane === 'connection' ? <>
                <section className="settings-section">
                  <div className="settings-section-heading"><div><h3>模型服务</h3><p>兼容官方端点，也支持自定义代理地址。</p></div></div>
                  <div className="settings-provider-picker">
                    <button type="button" className={form.provider === 'openai' ? 'active' : ''} onClick={() => updateField('provider', 'openai')}><Bot size={17} /><span><strong>OpenAI 兼容</strong><small>OpenAI、代理及兼容服务</small></span><Check size={15} /></button>
                    <button type="button" className={form.provider === 'anthropic' ? 'active' : ''} onClick={() => updateField('provider', 'anthropic')}><Sparkles size={17} /><span><strong>Anthropic</strong><small>Claude 官方或兼容服务</small></span><Check size={15} /></button>
                  </div>
                </section>

                <section className="settings-section settings-connection-fields">
                  <label className="settings-field">
                    <span>API Base URL</span>
                    <input type="url" value={form.apiBaseUrl} onChange={(e) => updateField('apiBaseUrl', e.target.value)} placeholder={form.provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'} />
                    <small>留空时使用官方默认地址；代理地址请包含版本路径。</small>
                  </label>

                  <label className="settings-field">
                    <span>API Key</span>
                    <input type="password" value={form.apiKey} onChange={(e) => updateField('apiKey', e.target.value)} placeholder={apiKeyPlaceholder} autoComplete="new-password" />
                    <small>{settings?.apiKeyMask ? `当前为 ${settings.apiKeyMask}，留空保持不变。` : '保存后会加密存储，不会回传明文。'}</small>
                  </label>

                  <div className="settings-model-row">
                    <label className="settings-field settings-model-field">
                      <span>模型</span>
                      <input type="text" value={form.model} onChange={(e) => updateField('model', e.target.value)} placeholder={form.provider === 'anthropic' ? '输入 Claude 模型名' : '输入 OpenAI 兼容模型名'} list="model-list" />
                      <small>可手动填写，也可测试连接后从服务端列表选择。</small>
                    </label>
                    <button type="button" className={`settings-fetch-models ${connectionStatus === 'connected' ? 'success' : ''}`} disabled={fetchingModels} onClick={handleFetchModels}>
                      {fetchingModels ? <LoaderCircle size={15} className="spin" /> : connectionStatus === 'connected' ? <Check size={15} /> : <Zap size={15} />}
                      <span>{fetchingModels ? '连接中' : connectionStatus === 'connected' ? '重新测试' : '测试连接'}</span>
                    </button>
                  </div>
                  {modelList.length > 0 && <datalist id="model-list">{modelList.map((model) => <option key={model} value={model} />)}</datalist>}
                </section>
              </> : <>
                <section className="settings-section">
                  <div className="settings-section-heading"><div><h3>推理与输出</h3><p>模型不支持某项参数时，服务端会自动忽略。</p></div></div>
                  <label className="settings-field">
                    <span>思考强度</span>
                    <div className="settings-select-wrap"><BrainCircuit size={16} /><select value={form.reasoningEffort} onChange={(e) => updateField('reasoningEffort', e.target.value)}>
                      <option value="">自动（使用模型默认值）</option>
                      <option value="minimal">最低 · 最快响应</option>
                      <option value="low">低 · 简单编辑</option>
                      <option value="medium">中 · 日常创作</option>
                      <option value="high">高 · 复杂推演</option>
                      <option value="xhigh">极高 · 最深度思考</option>
                      <option value="max">MAX · 模型支持的最高强度</option>
                    </select><ChevronDown size={14} /></div>
                    <small>强度越高通常耗时越长、使用的 token 越多。</small>
                  </label>

                  <label className="settings-field">
                    <span>采样温度 <strong>{Number(form.temperature).toFixed(1)}</strong></span>
                    <input type="range" min="0" max="2" step="0.1" value={form.temperature} onChange={(e) => updateField('temperature', Number(e.target.value))} className="settings-slider" />
                    <div className="settings-range-labels"><span>稳定</span><span>灵活</span><span>发散</span></div>
                    <small>推理模型启用思考强度时会自动忽略温度，避免 API 参数冲突。</small>
                  </label>
                </section>

                <section className="settings-section">
                  <div className="settings-section-heading"><div><h3>Token 预算</h3><p>支持输入任意精确整数，不再受 1024 步进限制。</p></div></div>
                  <div className="settings-number-row">
                    <label className="settings-field">
                      <span>最大输出 Tokens</span>
                      <input type="number" min="1" max="128000" step="1" value={form.maxTokens} onChange={(e) => updateField('maxTokens', Number(e.target.value))} />
                      <small>单次回复的最大输出预算。</small>
                    </label>
                    <label className="settings-field">
                      <span>上下文窗口 Tokens</span>
                      <input type="number" min="100" max="1000000" step="1" value={form.contextWindow} onChange={(e) => updateField('contextWindow', Number(e.target.value))} />
                      <small>可直接填写 100000 等整值。</small>
                    </label>
                  </div>
                </section>
              </>}
            </div>
          </div>

          <div className="settings-actions">
            <div className="settings-save-note"><LockKeyhole size={14} /><span>更改会应用到所有 Story Skills</span></div>
            <button type="button" className="secondary-button" onClick={onClose}>取消</button>
            <button type="submit" className="dark-button" disabled={saving}>
              {saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
              <span>{saving ? '保存中' : '保存并应用'}</span>
            </button>
          </div>
        </form>
      )}
    </div>
  </div>
}

export default App
