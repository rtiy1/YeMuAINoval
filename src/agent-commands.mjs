const command = (name, usage, description, options = {}) => ({
  name,
  usage,
  description,
  aliases: options.aliases || [],
  group: options.group || 'tui',
})

export const EDITOR_AGENT_COMMANDS = [
  command('help', '/help', '查看当前 Web 工作区支持的命令'),
  command('write', '/write [要求]', '续写或重写当前章节', { group: 'writing' }),
  command('continue', '/continue [要求]', '从当前章节结尾继续写', { group: 'writing', aliases: ['续写'] }),
  command('rewrite', '/rewrite [要求]', '按要求重写当前章节', { group: 'writing', aliases: ['重写'] }),
  command('outline', '/outline [要求]', '整理或补全当前作品大纲', { group: 'writing', aliases: ['大纲'] }),
  command('expand', '/expand [要求]', '扩写当前选区或章节', { group: 'writing', aliases: ['扩写'] }),
  command('shorten', '/shorten [要求]', '精简当前选区或章节', { group: 'writing', aliases: ['精简'] }),
  command('review', '/review [要求]', '审查当前章节', { group: 'writing' }),
  command('polish', '/polish [要求]', '润色当前章节并降低 AI 味', { group: 'writing' }),
  command('analyze', '/analyze [要求]', '分析当前作品结构', { group: 'writing' }),
  command('scan', '/scan [要求]', '扫描当前作品问题', { group: 'writing' }),
  command('search', '/search <关键词>', '联网查写作资料', { group: 'writing' }),
  command('settings', '/settings', '打开模型与上下文设置'),
  command('status', '/status', '查看模型、作品和章节状态'),
  command('context', '/context', '查看当前上下文、阈值与压缩摘要'),
  command('compact', '/compact [soft|remote] [重点]', '立即压缩较早对话；参数语义对齐 TUI'),
  command('plan', '/plan [要求]', '以 Plan 模式分析并给出执行方案'),
  command('model', '/model [名称]', '查看或切换当前模型'),
  command('models', '/models', '列出当前连接提供的模型'),
  command('tools', '/tools', '列出 Web 工作区可用工具'),
  command('memory', '/memory', '打开并统计当前作品记忆'),
  command('new', '/new', '新建 Agent 会话', { aliases: ['clear'] }),
  command('rename', '/rename <标题>', '重命名当前会话'),
  command('retry', '/retry [ID]', '重试指定任务或最近失败任务'),
  command('queue', '/queue <追加指令>', '向正在运行的轮次追加指令'),
  command('quit', '/quit', '关闭夜雨面板', { aliases: ['q'] }),
  command('projects', '/projects', '列出作品', { group: 'story' }),
  command('use', '/use <序号|名称|ID>', '切换作品', { group: 'story' }),
  command('chapters', '/chapters', '列出当前作品章节', { group: 'story' }),
  command('chapter', '/chapter <序号|名称|ID>', '切换章节', { group: 'story' }),
  command('draft', '/draft', '预览当前章节正文', { group: 'story' }),
  command('skill', '/skill <名称> <要求>', '直接调用一个 Story Skill', { group: 'story' }),
  command('apply', '/apply', '应用最近一次正文建议', { group: 'story' }),
  command('undo', '/undo', '恢复最近一份历史正文', { group: 'story' }),
  command('history', '/history', '查看最近对话', { group: 'story' }),
  command('confirm', '/confirm', '确认当前建书方案', { group: 'story' }),
  command('skills', '/skills', '列出可用 Story Skills', { group: 'story' }),
  command('tasks', '/tasks', '列出最近的 Agent 任务', { group: 'story' }),
  command('task', '/task [ID]', '查看最近任务', { group: 'story' }),
  command('cancel', '/cancel [ID]', '取消正在运行或最近的任务', { group: 'story' }),
]

const COMMAND_ALIASES = new Map(EDITOR_AGENT_COMMANDS.flatMap((item) => (
  item.aliases.map((alias) => [alias, item.name])
)))

export function parseSlashCommand(input) {
  const text = String(input || '').trim()
  if (!text.startsWith('/')) return null
  const body = text.slice(1)
  const separator = body.search(/[\s:]/)
  const rawName = (separator === -1 ? body : body.slice(0, separator)).toLowerCase()
  const name = COMMAND_ALIASES.get(rawName) || rawName
  return {
    name,
    argument: separator === -1 ? '' : body.slice(separator + 1).trim(),
  }
}

export function parseCompactCommandArgs(input) {
  const text = String(input || '').trim()
  if (!text) return { mode: '', instructions: '' }
  const [first, ...rest] = text.split(/\s+/)
  const mode = first.toLowerCase()
  if (!['soft', 'remote', 'snapcompact'].includes(mode)) return { mode: '', instructions: text }
  const instructions = rest.join(' ').trim()
  if (mode === 'snapcompact' && instructions) {
    throw new Error('/compact snapcompact 不接受压缩重点参数')
  }
  return { mode, instructions }
}

export function resolveSelection(items, selector, label = '项目') {
  const value = String(selector || '').trim()
  if (!value) throw new Error(`请提供${label}序号、名称或 ID`)
  if (/^\d+$/.test(value)) {
    const byIndex = items[Number(value) - 1]
    if (byIndex) return byIndex
  }
  const exact = items.find((item) => String(item.id) === value || item.title === value || item.name === value)
  if (exact) return exact
  const matches = items.filter((item) => String(item.title || item.name || '').includes(value))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new Error(`匹配到多个${label}，请使用序号或 ID`)
  throw new Error(`没有找到${label}：${value}`)
}
