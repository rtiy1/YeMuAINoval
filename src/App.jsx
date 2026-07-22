import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  BookOpenCheck,
  BookPlus,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Download,
  FileText,
  FolderOpen,
  Gem,
  Grid2X2,
  Image,
  Info,
  Italic,
  LayoutDashboard,
  Library,
  List,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Mail,
  Menu,
  MoreHorizontal,
  PenLine,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Target,
  Type,
  UserRound,
  Users,
  WandSparkles,
  X,
} from 'lucide-react'
import { api } from './api'

const initialProjects = [
  {
    id: 'tide',
    title: '潮汐之上',
    type: '长篇',
    genre: '现代言情',
    status: '连载中',
    progress: 42,
    words: '18,342',
    updated: '12 分钟前',
    chapters: 8,
    tone: '克制、清醒、带一点潮湿的浪漫',
    cover: 'cover-tide',
    isActive: true,
  },
  {
    id: 'sword',
    title: '剑道独尊',
    type: '参考书',
    genre: '东方玄幻',
    status: '已拆文',
    progress: 100,
    words: '23 章',
    updated: '昨天',
    chapters: 23,
    tone: '升级、冒险、持续的胜利预期',
    cover: 'cover-sword',
    isActive: false,
  },
  {
    id: 'chang-an',
    title: '长安旧梦',
    type: '短篇',
    genre: '古代言情',
    status: '构思中',
    progress: 16,
    words: '2,406',
    updated: '3 天前',
    chapters: 2,
    tone: '旧城、旧人、来不及说完的话',
    cover: 'cover-changan',
    isActive: false,
  },
]

const fallbackChapters = [
  { id: 1, title: '雨落在海城', words: '2,184', state: 'done' },
  { id: 2, title: '她没有回头', words: '2,601', state: 'done' },
  { id: 3, title: '一封未寄出的信', words: '2,045', state: 'done' },
  { id: 4, title: '潮汐的方向', words: '3,108', state: 'done' },
  { id: 5, title: '凌晨四点的灯', words: '1,986', state: 'done' },
  { id: 6, title: '不合时宜的重逢', words: '2,716', state: 'done' },
  { id: 7, title: '她说，先到这里', words: '1,856', state: 'done' },
  { id: 8, title: '风从旧码头来', words: '1,846', state: 'current' },
  { id: 9, title: '还没有命名', words: '—', state: 'draft' },
]

const navItems = [
  { id: 'overview', label: '总览', icon: LayoutDashboard },
  { id: 'works', label: '我的作品', icon: BookOpen },
  { id: 'library', label: '灵感库', icon: Library },
  { id: 'deconstruct', label: '拆文台', icon: BookOpenCheck },
  { id: 'toolkit', label: '工具箱', icon: Grid2X2 },
]

const workflow = [
  { icon: Target, index: '01', title: '扫榜选题', text: '看见正在发生的热度', tone: 'coral' },
  { icon: BookOpenCheck, index: '02', title: '拆文学习', text: '把好故事拆成可复用的结构', tone: 'teal' },
  { icon: PenLine, index: '03', title: '落笔创作', text: '从大纲到正文，保持每章推进', tone: 'yellow' },
  { icon: WandSparkles, index: '04', title: '去味审查', text: '让文字更像你，而不是模型', tone: 'purple' },
]

function App() {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [authMode, setAuthMode] = useState('login')
  const [authError, setAuthError] = useState('')
  const [activeSection, setActiveSection] = useState('overview')
  const [projects, setProjects] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('story-projects')) || initialProjects
    } catch {
      return initialProjects
    }
  })
  const [activeProject, setActiveProject] = useState(projects[0])
  const [chapters, setChapters] = useState(fallbackChapters)
  const [ideas, setIdeas] = useState([])
  const [showNew, setShowNew] = useState(false)
  const [showMobileMenu, setShowMobileMenu] = useState(false)
  const [toast, setToast] = useState('')
  const [skillCatalog, setSkillCatalog] = useState([])
  const [reviewReport, setReviewReport] = useState(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewPlatform, setReviewPlatform] = useState('通用网文')
  const [draft, setDraft] = useState(
    () => localStorage.getItem('story-draft') || '凌晨四点，海城的雨还没有停。\n\n沈知遥站在旧码头的屋檐下，看着潮水一点一点漫过那条生锈的缆绳。她已经等了二十七分钟，手机屏幕亮了又暗，最后只剩下电量不足的红色提醒。\n\n远处有船鸣。\n\n她低头看了一眼那封信，信封边角被雨水洇开，露出里面半行熟悉的字迹。')

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
    localStorage.setItem('story-projects', JSON.stringify(projects))
  }, [projects])

  useEffect(() => {
    localStorage.setItem('story-draft', draft)
  }, [draft])

  useEffect(() => {
    if (!user) return undefined
    let mounted = true
    Promise.all([api.getProjects(), api.getIdeas()])
      .then(([projectResponse, ideaResponse]) => {
        if (!mounted) return
        const nextProjects = projectResponse.projects || []
        setProjects(nextProjects)
        setActiveProject((current) => nextProjects.find((project) => project.id === current?.id) || nextProjects.find((project) => project.isActive) || nextProjects[0])
        if (ideaResponse.ideas) setIdeas(ideaResponse.ideas)
      })
      .catch(() => {
        if (mounted) setToast('账号数据读取失败，请检查后端服务')
      })
    return () => { mounted = false }
  }, [user])

  useEffect(() => {
    if (!user) return undefined
    let mounted = true
    api.getSkills()
      .then((response) => { if (mounted) setSkillCatalog(response.skills || []) })
      .catch(() => { if (mounted) setSkillCatalog([]) })
    return () => { mounted = false }
  }, [user])

  useEffect(() => {
    if (!user || !activeProject?.id) return undefined
    let mounted = true
    Promise.all([api.getChapters(activeProject.id), api.getDraft(activeProject.id)])
      .then(([chapterResponse, draftResponse]) => {
        if (!mounted) return
        setChapters(chapterResponse.chapters || [])
        setDraft(draftResponse.content || '')
      })
      .catch(() => {
        if (mounted) setToast('作品数据读取失败，请检查后端服务')
      })
    return () => { mounted = false }
  }, [activeProject?.id, user])

  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(''), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  const currentProject = projects.find((project) => project.id === activeProject?.id) || projects[0]
  const wordCount = useMemo(() => draft.replace(/\s/g, '').length, [draft])

  function openProject(project) {
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
      const response = await api.createProject({ title, type: String(form.get('type') || '长篇'), genre: String(form.get('genre') || '现代言情') })
      const project = response.project
      setProjects((current) => [project, ...current.map((item) => ({ ...item, isActive: false }))])
      setActiveProject(project)
      setShowNew(false)
      setActiveSection('editor')
      setToast('作品已创建，开始写下第一章吧')
    } catch (error) {
      setToast(error.message)
    }
  }

  async function saveDraft() {
    if (!currentProject?.id) return
    try {
      const response = await api.saveDraft(currentProject.id, draft)
      if (response.project) {
        setProjects((current) => current.map((project) => project.id === response.project.id ? response.project : project))
        setActiveProject(response.project)
      }
      setToast('正文已保存到后端')
    } catch (error) {
      setToast(error.message)
      throw error
    }
  }

  async function createChapter() {
    if (!currentProject?.id) return
    try {
      const response = await api.createChapter(currentProject.id, `第 ${chapters.length + 1} 章`)
      setChapters((current) => [...current, response.chapter])
      setToast('新章节已加入目录')
    } catch (error) {
      setToast(error.message)
    }
  }

  async function createIdea() {
    try {
      const response = await api.createIdea({ label: '灵感', title: '未命名灵感', body: '记录下此刻的想法。', projectId: currentProject?.id })
      setIdeas((current) => [response.idea, ...current])
      setToast('新灵感卡已创建')
    } catch (error) {
      setToast(error.message)
    }
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

  function selectSection(id) {
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
    await api.logout()
    setUser(null)
    setProjects(initialProjects)
    setIdeas([])
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
    <div className="app-shell">
      <aside className={`sidebar ${showMobileMenu ? 'is-open' : ''}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><span>叙</span></div>
          <div>
            <div className="brand-name">叙事工坊</div>
            <div className="brand-subtitle">STORY STUDIO</div>
          </div>
        </div>

        <div className="sidebar-section-label">工作台</div>
        <nav className="primary-nav" aria-label="主导航">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${activeSection === id ? 'active' : ''}`} onClick={() => selectSection(id)}>
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {id === 'library' && <span className="nav-count">12</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-section-label recent-label">最近打开</div>
        <div className="recent-projects">
          {projects.slice(0, 3).map((project) => (
            <button key={project.id} className="recent-project" onClick={() => openProject(project)}>
              <span className={`mini-cover ${project.cover}`} aria-hidden="true">{project.cover === 'cover-sword' ? '剑' : project.cover === 'cover-tide' ? '潮' : '长'}</span>
              <span className="recent-project-name">{project.title}</span>
              {project.isActive && <span className="active-dot" />}
            </button>
          ))}
        </div>

        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => notify('设置中心即将开放')}><Settings2 size={17} strokeWidth={1.8} /><span>设置</span></button>
          <button className="nav-item" onClick={logout}><LogOut size={17} strokeWidth={1.8} /><span>退出登录</span></button>
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
            <button className="search-button" onClick={() => notify('搜索作品、章节或灵感')}><Search size={17} /><span>搜索</span><kbd>⌘ K</kbd></button>
            <button className="icon-button" aria-label="帮助" onClick={() => notify('需要帮助？从左侧工具箱开始')} title="帮助"><CircleHelp size={18} /></button>
            <button className="primary-button top-new-button" onClick={() => setShowNew(true)}><Plus size={17} />新建作品</button>
          </div>
        </header>

        <div className="content-wrap">
          {activeSection === 'overview' && <Overview projects={projects} onOpen={openProject} onNew={() => setShowNew(true)} onNavigate={selectSection} />}
          {activeSection === 'editor' && <Editor project={currentProject} chapters={chapters} draft={draft} setDraft={setDraft} wordCount={wordCount} onBack={() => selectSection('overview')} onNotify={(message) => message === '新章节已加入目录' ? createChapter() : notify(message)} onSave={saveDraft} onReview={reviewChapter} reviewLoading={reviewLoading} reviewPlatform={reviewPlatform} onPlatformChange={setReviewPlatform} />}
          {activeSection === 'works' && <Works projects={projects} onOpen={openProject} onNew={() => setShowNew(true)} />}
          {activeSection === 'library' && <LibraryView ideas={ideas} onNotify={notify} onCreate={createIdea} />}
          {activeSection === 'deconstruct' && <Deconstruct onNotify={notify} />}
          {activeSection === 'toolkit' && <Toolkit onNotify={notify} skills={skillCatalog} />}
        </div>
      </main>

      <div className="mobile-nav">
        {navItems.slice(0, 4).map(({ id, label, icon: Icon }) => (
          <button key={id} className={activeSection === id ? 'active' : ''} onClick={() => selectSection(id)}><Icon size={18} /><span>{label}</span></button>
        ))}
      </div>

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} onCreate={createProject} />}
      {reviewOpen && reviewReport && <ReviewReport report={reviewReport} onClose={() => setReviewOpen(false)} />}
      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </div>
  )
}

function AuthScreen({ mode, error, onModeChange, onSubmit }) {
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState('')
  const isRegister = mode === 'register'

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
        <div className="auth-quote">
          <span className="section-overline">今日摘句 · 潮汐之上</span>
          <blockquote>“她终于明白，潮水从来不是为了带走什么。它只是一次次回来，提醒岸边的人，时间仍在往前。”</blockquote>
          <div className="auth-quote-meta"><span>第 8 章</span><span>风从旧码头来</span></div>
        </div>
        <div className="auth-progress-art" aria-hidden="true">
          <span /><span /><span /><span className="active" /><span /><span /><span />
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

function Overview({ projects, onOpen, onNew, onNavigate }) {
  const active = projects.find((project) => project.isActive) || projects[0]
  return (
    <div className="page overview-page">
      <section className="welcome-row">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" />2026 年 7 月 22 日 · 星期三</div>
          <h1>晚上好，继续写下去。</h1>
          <p className="welcome-copy">今天的故事，想从哪一幕开始？</p>
        </div>
        <button className="primary-button" onClick={onNew}><BookPlus size={17} />新建作品</button>
      </section>

      <section className="focus-section">
        <div className="section-heading"><div><span className="section-overline">正在进行</span><h2>继续你的故事</h2></div><button className="text-button" onClick={() => onNavigate('works')}>查看全部 <ArrowUpRight size={15} /></button></div>
        <div className="focus-project">
          <div className={`large-cover ${active.cover}`}><span>{active.cover === 'cover-tide' ? <>潮汐<br />之上</> : active.title}</span><i>STORY<br />NO. 01</i></div>
          <div className="focus-copy">
            <div className="tag-row"><span className="status-tag"><span className="status-pulse" />{active.status}</span><span className="muted-tag">{active.type} · {active.genre}</span></div>
            <h3>{active.title}</h3>
            <p>{active.tone}</p>
            <div className="progress-line"><span style={{ width: `${active.progress}%` }} /></div>
            <div className="focus-metrics"><span><strong>{active.progress}%</strong> 完成度</span><span><strong>{active.words}</strong> 字</span><span>更新于 {active.updated}</span></div>
            <button className="dark-button" onClick={() => onOpen(active)}>继续写作 <ArrowUpRight size={16} /></button>
          </div>
          <div className="focus-side-note"><span className="note-label">下一章提示</span><p>让她终于看到那盏没有熄灭的灯。</p><button className="icon-button small" aria-label="打开章节提示" onClick={() => onOpen(active)} title="打开章节提示"><ChevronRight size={16} /></button></div>
        </div>
      </section>

      <section className="dashboard-grid">
        <div className="workflow-panel">
          <div className="section-heading compact"><div><span className="section-overline">创作路径</span><h2>从灵感到成稿</h2></div><span className="tiny-meta">4 个阶段</span></div>
          <div className="workflow-list">
            {workflow.map(({ icon: Icon, index, title, text, tone }) => <button className="workflow-item" key={title} onClick={() => onNavigate(title === '落笔创作' ? 'editor' : title === '拆文学习' ? 'deconstruct' : title === '扫榜选题' ? 'library' : 'toolkit')}><span className={`workflow-icon ${tone}`}><Icon size={18} /></span><span className="workflow-index">{index}</span><span className="workflow-copy"><strong>{title}</strong><small>{text}</small></span><ArrowUpRight size={16} className="workflow-arrow" /></button>)}
          </div>
        </div>
        <WritingPulse />
      </section>

      <section className="recent-section">
        <div className="section-heading compact"><div><span className="section-overline">作品空间</span><h2>最近的作品</h2></div><button className="text-button" onClick={() => onNavigate('works')}>管理作品 <ArrowUpRight size={15} /></button></div>
        <div className="project-grid">{projects.map((project) => <ProjectCard key={project.id} project={project} onOpen={onOpen} />)}</div>
      </section>
    </div>
  )
}

function WritingPulse() {
  const bars = [22, 42, 30, 58, 41, 64, 52, 77, 55, 70, 48, 86, 66, 78]
  return <div className="pulse-panel"><div className="section-heading compact"><div><span className="section-overline">本周写作</span><h2>保持住这个节奏</h2></div><button className="icon-button small" aria-label="写作统计详情" title="写作统计详情"><MoreHorizontal size={17} /></button></div><div className="pulse-number"><strong>8,462</strong><span>字</span><em><ArrowUpRight size={13} />18%</em></div><div className="bar-chart" aria-label="本周写作字数图表">{bars.map((height, index) => <span key={index} style={{ height: `${height}%` }} className={index === 11 ? 'today' : ''} />)}</div><div className="chart-labels"><span>周一</span><span>今天</span><span>周日</span></div></div>
}

function ProjectCard({ project, onOpen }) {
  return <button className="project-card" onClick={() => onOpen(project)}><div className={`card-cover ${project.cover}`}><span>{project.cover === 'cover-tide' ? '潮' : project.cover === 'cover-sword' ? '剑' : '长'}</span></div><div className="card-content"><div className="card-topline"><span>{project.type}</span><MoreHorizontal size={15} /></div><h3>{project.title}</h3><p>{project.genre}</p><div className="card-footer"><span>{project.words} {project.words === '23 章' ? '' : '字'}</span><span>{project.progress}%</span></div><div className="mini-progress"><span style={{ width: `${project.progress}%` }} /></div></div></button>
}

function Editor({ project, chapters, draft, setDraft, wordCount, onBack, onNotify, onSave, onReview, reviewLoading, reviewPlatform, onPlatformChange }) {
  const [saved, setSaved] = useState(true)
  const activeChapter = chapters.find((chapter) => chapter.state === 'current') || chapters.at(-1) || { id: 1, title: '第一章' }
  function updateDraft(event) {
    setDraft(event.target.value)
    setSaved(false)
  }
  async function saveDraft() {
    try {
      await onSave()
      setSaved(true)
    } catch {
      setSaved(false)
    }
  }
  return <div className="page editor-page"><div className="editor-topline"><button className="back-button" onClick={onBack}><ArrowLeft size={17} />返回工作台</button><div className="editor-status"><span className={saved ? 'saved-dot' : 'unsaved-dot'} />{saved ? '已保存' : '有未保存更改'}</div><div className="editor-actions"><button className="icon-button" aria-label="导出章节" title="导出章节" onClick={() => onNotify('导出功能将在接入后端后开放')}><Download size={17} /></button><button className="icon-button" aria-label="章节设置" title="章节设置" onClick={() => onNotify('章节设置已打开')}><Settings2 size={17} /></button><button className="dark-button save-button" onClick={saveDraft}><Check size={16} />保存</button></div></div><div className="editor-heading"><div><span className="section-overline">{project?.title} · 第 {activeChapter.id} 章</span><h1>{activeChapter.title}</h1></div><div className="chapter-progress"><span>{activeChapter.id} / {chapters.length || 1}</span><div><span style={{ width: `${Math.min(100, (Number(activeChapter.id) / Math.max(chapters.length, 1)) * 100)}%` }} /></div></div></div><div className="editor-layout"><aside className="chapter-rail"><div className="rail-header"><strong>章节</strong><button className="icon-button small" aria-label="新建章节" title="新建章节" onClick={() => onNotify('新章节已加入目录')}><Plus size={16} /></button></div><div className="chapter-list">{chapters.map((chapter) => <button key={chapter.id} className={`chapter-item ${chapter.state === 'current' ? 'current' : ''}`} onClick={() => onNotify(`已切换到第 ${chapter.id} 章`)}><span className="chapter-number">{String(chapter.id).padStart(2, '0')}</span><span className="chapter-name">{chapter.title}</span><span className="chapter-words">{chapter.words}</span></button>)}</div><button className="outline-link" onClick={() => onNotify('大纲视图即将开放')}><List size={15} />查看大纲</button></aside><section className="writing-canvas"><div className="writing-toolbar"><div className="toolbar-group"><button className="toolbar-button active" aria-label="正文样式" title="正文样式"><Type size={16} /></button><button className="toolbar-button" aria-label="加粗" title="加粗"><strong>B</strong></button><button className="toolbar-button" aria-label="斜体" title="斜体"><Italic size={16} /></button></div><span className="toolbar-divider" /><div className="toolbar-group"><button className="toolbar-button" aria-label="插入灵感" title="插入灵感" onClick={() => onNotify('灵感卡已加入当前章节')}><Sparkles size={16} /></button></div><span className="toolbar-spacer" /><div className="skill-review-controls"><select className="skill-platform-select" aria-label="审稿平台" value={reviewPlatform} onChange={(event) => onPlatformChange(event.target.value)}><option>通用网文</option><option>番茄</option><option>起点</option><option>知乎盐言</option></select><button className="skill-review-button" disabled={reviewLoading} onClick={() => onReview(activeChapter.title)}>{reviewLoading ? <LoaderCircle size={15} className="spin" /> : <BrainCircuit size={15} />}<span>{reviewLoading ? '审稿中' : 'Skill 审稿'}</span></button></div></div><div className="writing-body"><textarea value={draft} onChange={updateDraft} spellCheck="false" aria-label="章节正文" /><div className="writing-footer"><span><FileText size={14} />{wordCount.toLocaleString()} 字</span><span><Clock3 size={14} />预计阅读 6 分钟</span><span className="footer-hint">⌘ + S 保存</span></div></div></section><aside className="insight-rail"><div className="insight-heading"><Sparkles size={16} /><strong>章节提示</strong></div><div className="insight-card coral-note"><span>情绪曲线</span><strong>压抑 → 松动</strong><p>她以为自己还在等一个答案，其实已经准备好离开。</p></div><div className="insight-card"><span>本章锚点</span><ul><li>旧码头的灯</li><li>没有寄出的信</li><li>周予安的船</li></ul><button className="text-button" onClick={() => onNotify('锚点已展开')}>展开全部 <ArrowUpRight size={14} /></button></div><div className="insight-card quote-card"><Info size={15} /><p>“让线索先抵达读者，再让人物意识到它。”</p></div></aside></div></div>
}

function Works({ projects, onOpen, onNew }) {
  return <div className="page inner-page"><div className="page-heading"><div><span className="section-overline">作品空间</span><h1>我的作品</h1><p>所有故事都在这里继续。</p></div><button className="primary-button" onClick={onNew}><BookPlus size={17} />新建作品</button></div><div className="works-toolbar"><div className="filter-tabs"><button className="selected">全部 <span>{projects.length}</span></button><button>长篇 <span>1</span></button><button>短篇 <span>1</span></button><button>参考书 <span>1</span></button></div><button className="filter-button"><Search size={16} />筛选</button></div><div className="works-list">{projects.map((project) => <button className="work-row" key={project.id} onClick={() => onOpen(project)}><div className={`row-cover ${project.cover}`}><span>{project.cover === 'cover-tide' ? '潮' : project.cover === 'cover-sword' ? '剑' : '长'}</span></div><div className="row-main"><div className="row-title"><h3>{project.title}</h3><span className="muted-tag">{project.type}</span></div><p>{project.genre} · {project.status}</p><div className="row-progress"><span style={{ width: `${project.progress}%` }} /></div></div><div className="row-stat"><strong>{project.words}</strong><span>{project.words === '23 章' ? '章节' : '总字数'}</span></div><div className="row-stat"><strong>{project.progress}%</strong><span>完成度</span></div><div className="row-updated"><span>最近编辑</span><strong>{project.updated}</strong></div><ChevronRight size={18} className="row-arrow" /></button>)}</div></div>
}

function LibraryView({ ideas, onNotify: notify, onCreate }) {
  const fallbackIdeas = [{ id: 'fallback-1', label: '人物', title: '一个不再相信承诺的人', body: '她把所有重要的东西都写在纸上，因为纸不会临时改口。', color: 'coral' }, { id: 'fallback-2', label: '场景', title: '凌晨四点的旧码头', body: '潮水、未接来电，以及一盏不该亮着的灯。', color: 'teal' }, { id: 'fallback-3', label: '冲突', title: '他带着她以为已经丢掉的东西回来', body: '不是为了复合，是为了让她知道当年发生了什么。', color: 'yellow' }, { id: 'fallback-4', label: '一句话', title: '“我不是原谅你，我只是终于不需要你了。”', body: '适合作为章节末尾的情绪落点。', color: 'purple' }]
  ideas = ideas.length ? ideas : fallbackIdeas
  const onNotify = (message) => message === '新灵感卡已创建' ? onCreate() : notify(message)
  return <div className="page inner-page"><div className="page-heading"><div><span className="section-overline">灵感收集</span><h1>灵感库</h1><p>还没长成故事的句子，也值得被好好放着。</p></div><button className="primary-button" onClick={() => onNotify('新灵感卡已创建')}><Plus size={17} />记录灵感</button></div><div className="library-toolbar"><div className="library-search"><Search size={16} /><span>搜索灵感</span></div><span className="tiny-meta">12 条灵感 · 最近更新</span></div><div className="idea-grid">{ideas.map((idea) => <button className={`idea-card ${idea.color}`} key={idea.title} onClick={() => onNotify('已打开灵感卡')}><div className="idea-card-top"><span>{idea.label}</span><MoreHorizontal size={16} /></div><h3>{idea.title}</h3><p>{idea.body}</p><div className="idea-card-foot"><span>潮汐之上</span><ArrowUpRight size={15} /></div></button>)}</div></div>
}

function Deconstruct({ onNotify }) {
  return <div className="page inner-page"><div className="page-heading"><div><span className="section-overline">结构工作室</span><h1>拆文台</h1><p>把读过的故事，变成下一本书的养分。</p></div><button className="primary-button" onClick={() => onNotify('导入书籍功能即将开放')}><FolderOpen size={17} />导入参考书</button></div><div className="deconstruct-banner"><div className="banner-icon"><BookOpenCheck size={22} /></div><div><span className="section-overline">正在分析</span><h2>剑道独尊</h2><p>23 章 · 东方玄幻 · 最近更新于昨天</p></div><div className="banner-progress"><strong>100%</strong><span>拆文完成</span><div><span /></div></div><button className="dark-button" onClick={() => onNotify('正在打开拆文报告')}>打开报告 <ArrowUpRight size={16} /></button></div><div className="analysis-grid"><button className="analysis-card" onClick={() => onNotify('概要已打开')}><span className="analysis-number">01</span><FileText size={20} /><h3>故事概要</h3><p>全书主线、章节索引与关键转折</p><ArrowUpRight size={16} /></button><button className="analysis-card" onClick={() => onNotify('人物图谱已打开')}><span className="analysis-number">02</span><Users size={20} /><h3>人物图谱</h3><p>角色关系、动机链与状态变化</p><ArrowUpRight size={16} /></button><button className="analysis-card" onClick={() => onNotify('节奏报告已打开')}><span className="analysis-number">03</span><Clock3 size={20} /><h3>节奏报告</h3><p>情绪触发、信息递进与爽点密度</p><ArrowUpRight size={16} /></button></div><div className="empty-analysis"><Gem size={19} /><span>还有 2 本参考书等待拆解</span><button className="text-button" onClick={() => onNotify('参考书列表已打开')}>查看列表 <ArrowUpRight size={14} /></button></div></div>
}

function Toolkit({ onNotify, skills }) {
  const tools = [{ icon: Target, title: '扫榜选题', body: '追踪热门题材与平台趋势', tone: 'coral' }, { icon: WandSparkles, title: '去 AI 味', body: '检查确定性套话与句式痕迹', tone: 'teal' }, { icon: Image, title: '生成封面', body: '为你的故事找到第一眼的气质', tone: 'yellow' }, { icon: Users, title: '角色卡', body: '整理人物动机、关系与语言习惯', tone: 'purple' }, { icon: Settings2, title: '写作偏好', body: '调整字体、章节格式与工作流', tone: 'blue' }, { icon: CircleHelp, title: '使用指南', body: '了解叙事工坊的完整用法', tone: 'pink' }]
  return <div className="page inner-page"><div className="page-heading"><div><span className="section-overline">辅助工具</span><h1>工具箱</h1><p>写作之外的事，也交给一个顺手的工作台。</p></div></div><div className="tool-grid">{tools.map(({ icon: Icon, title, body, tone }) => <button className="tool-card" key={title} onClick={() => onNotify(`${title}即将打开`)}><span className={`tool-icon ${tone}`}><Icon size={20} /></span><h3>{title}</h3><p>{body}</p><ArrowUpRight size={16} className="tool-arrow" /></button>)}</div><section className="skill-catalog"><div className="section-heading"><div><span className="section-overline">Story Agent</span><h2>Skill 能力目录</h2></div><span className="tiny-meta">{skills.filter((skill) => skill.status === 'ready').length} 可直接调用 · {skills.filter((skill) => skill.status === 'needs_model').length} 需模型</span></div><div className="skill-capability-list">{skills.map((skill) => <div className="skill-capability-row" key={skill.name}><div><strong>{skill.name}</strong><span>{skill.version ? `v${skill.version}` : '未标版本'}</span></div><p>{skill.description || '已发现 Skill manifest'}</p><span className={`skill-status ${skill.status}`}>{skill.status === 'ready' ? '可调用' : skill.status === 'needs_model' ? '需模型' : skill.status === 'registered' ? '待适配' : '不可用'}</span></div>)}</div></section><div className="tool-footer"><Sparkles size={17} /><span>叙事工坊 0.1 · 本地工作区</span><button className="text-button" onClick={() => onNotify('能力目录已刷新')}>刷新状态 <ArrowUpRight size={14} /></button></div></div>
}

function ReviewReport({ report, onClose }) {
  const verdictLabels = { APPROVE: '可以发布', CONCERNS: '修改后发布', REJECT: '暂不发布' }
  const categoryLabels = { structure: '结构', character: '人物', prose: '文字', consistency: '一致性', platform: '平台', factual: '事实', format: '格式', causal: '因果', rule_boundary: '规则边界' }
  const counts = report.severity_counts || {}
  return <div className="modal-backdrop review-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-report-title"><header className="review-report-header"><div><span className="section-overline">{report.skill} · v{report.skill_version}</span><h2 id="review-report-title">章节审稿报告</h2></div><button className="icon-button" aria-label="关闭审稿报告" title="关闭" onClick={onClose}><X size={19} /></button></header><div className="review-verdict"><div className={`verdict-mark ${report.verdict.toLowerCase()}`}><span>{report.score}</span><small>评分</small></div><div><span className="review-verdict-label">{verdictLabels[report.verdict] || report.verdict}</span><p>{report.summary}</p></div><div className="severity-summary">{['S1', 'S2', 'S3', 'S4'].map((severity) => <span key={severity} className={`severity-pill ${severity.toLowerCase()}`}>{severity} {counts[severity] || 0}</span>)}</div></div><dl className="review-metadata"><div><dt>请求模式</dt><dd>{report['Requested Mode']}</dd></div><div><dt>执行模式</dt><dd>{report['Effective Mode']}</dd></div><div><dt>平台规则</dt><dd>{report.Rubric}</dd></div><div><dt>规则来源</dt><dd>{report['Rubric Source']}</dd></div></dl><section className="review-findings"><div className="review-section-heading"><h3>问题清单</h3><span>{report.findings?.length || 0} 项</span></div>{report.findings?.length ? report.findings.map((finding, index) => <article className="review-finding" key={`${finding.location}-${index}`}><div className="finding-topline"><span className={`severity-pill ${finding.severity.toLowerCase()}`}>{finding.severity}</span><span>{categoryLabels[finding.category] || finding.category}</span><span>{finding.location}</span></div><blockquote>{finding.evidence}</blockquote><strong>{finding.issue}</strong><p><span>修改方向</span>{finding.fix}</p></article>) : <div className="review-empty"><Check size={18} /><span>确定性检查未发现必须修改的问题</span></div>}</section></div></div>
}

function NewProjectModal({ onClose, onCreate }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-project-title"><div className="modal-heading"><div><span className="section-overline">开始一个新故事</span><h2 id="new-project-title">新建作品</h2></div><button className="icon-button" aria-label="关闭" title="关闭" onClick={onClose}><X size={18} /></button></div><form onSubmit={onCreate}><label>作品名<input name="title" autoFocus placeholder="例如：潮汐之上" /></label><div className="form-row"><label>篇幅<select name="type" defaultValue="长篇"><option>长篇</option><option>短篇</option></select></label><label>题材<select name="genre" defaultValue="现代言情"><option>现代言情</option><option>古代言情</option><option>东方玄幻</option><option>悬疑推理</option><option>都市现实</option></select></label></div><div className="modal-note"><Sparkles size={16} /><span>创建后，你可以先写一句话故事核，其他设定随时补充。</span></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="dark-button"><Plus size={16} />创建作品</button></div></form></div></div>
}

export default App
