export const NOVEL_COMMANDS = [
  ['/help', '查看小说 Agent 命令'],
  ['/status', '查看模型、作品和章节状态'],
  ['/projects', '列出作品'],
  ['/use <序号|名称|ID>', '切换作品'],
  ['/chapters', '列出当前作品章节'],
  ['/chapter <序号|名称|ID>', '切换章节'],
  ['/draft', '预览当前章节正文'],
  ['/write [要求]', '续写或重写当前章节'],
  ['/review [要求]', '审查当前章节'],
  ['/polish [要求]', '对当前章节去 AI 味'],
  ['/analyze [要求]', '分析当前作品结构'],
  ['/scan [要求]', '扫描当前作品问题'],
  ['/search <关键词>', '联网查写作资料'],
  ['/skill <名称> <要求>', '直接调用一个 Story Skill'],
  ['/apply', '确认应用最近一次正文建议'],
  ['/undo', '恢复当前章节最近一份历史正文'],
  ['/history', '查看最近对话'],
  ['/new', '清空创作助手会话'],
  ['/confirm', '确认当前建书方案'],
  ['/skills', '列出可用 Story Skills'],
  ['/tasks', '列出最近的 Agent 任务'],
  ['/task [ID]', '查看并恢复跟踪最近任务'],
  ['/cancel [ID]', '取消正在运行或最近的任务'],
  ['/retry [ID]', '重试失败或已取消的任务'],
  ['/quit', '退出'],
]

export function parseSlashCommand(input) {
  const text = String(input || '').trim()
  if (!text.startsWith('/')) return null
  const firstSpace = text.search(/\s/)
  if (firstSpace === -1) return { name: text.slice(1).toLowerCase(), argument: '' }
  return {
    name: text.slice(1, firstSpace).toLowerCase(),
    argument: text.slice(firstSpace).trim(),
  }
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

export function skillForProject(project, family) {
  const length = project?.type === '短篇' ? 'short' : 'long'
  return `story-${length}-${family}`
}
