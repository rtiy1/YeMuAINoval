export function formatAgentDuration(milliseconds) {
  const seconds = Math.max(0, Number(milliseconds || 0)) / 1000
  if (seconds < 10) return `${seconds.toFixed(1)} 秒`
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`
}

export function agentEventDuration(event) {
  const startedAt = new Date(event?.startedAt || 0).getTime()
  const completedAt = new Date(event?.completedAt || 0).getTime()
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) return ''
  return formatAgentDuration(completedAt - startedAt)
}

export function agentResponseText(response) {
  const result = response?.result || {}
  const proposal = result.edit_proposal
  if (proposal?.summary) return proposal.summary
  for (const value of [result.output, result.summary, result.message]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  if (result.verdict || result.findings?.length) {
    const lines = [result.verdict ? `审稿结论：${result.verdict}${result.score != null ? ` · ${result.score} 分` : ''}` : '章节审查完成。']
    for (const finding of (result.findings || []).slice(0, 8)) {
      lines.push(`- ${finding.issue || finding.title || finding.message}${finding.fix ? `：${finding.fix}` : ''}`)
    }
    return lines.join('\n')
  }
  return response?.status === 'completed' ? '任务已完成。' : 'Agent 没有返回可显示的文本。'
}

export function resolveEditorAgentCommand(rawMessage, project) {
  const message = String(rawMessage || '').trim()
  if (!message.startsWith('/')) return { message, skill: 'story' }
  const [command, ...rest] = message.slice(1).split(/\s+/)
  const argument = rest.join(' ').trim()
  const length = project?.type === '短篇' ? 'short' : 'long'
  const commands = {
    review: { skill: 'story-review', message: argument || '审查当前章节，重点检查人物动机、节奏和章末钩子。' },
    polish: { skill: 'story-deslop', message: argument || '润色当前章节，降低模板腔和 AI 味，不改变剧情事实。' },
    write: { skill: `story-${length}-write`, message: argument || '结合当前章节与作品设定续写，保持人物和叙事风格一致。' },
    analyze: { skill: `story-${length}-analyze`, message: argument || '分析当前章节的结构、人物动机和节奏。' },
    scan: { skill: `story-${length}-scan`, message: argument || '扫描当前作品的问题并给出可执行建议。' },
  }
  if (command === 'skill' && rest.length > 0) {
    return { skill: rest[0], message: rest.slice(1).join(' ').trim() || `执行 ${rest[0]}` }
  }
  return commands[command] || { skill: 'story', message }
}

export function isEditorAgentEdit(message, skill) {
  if (skill === 'story-review' || /-(?:analyze|scan)$/.test(skill || '')) return false
  return skill === 'story-deslop'
    || /-write$/.test(skill || '')
    || /修改|改写|重写|润色|续写|补写|扩写|精简|删掉|替换|自然化|去\s*AI\s*味/i.test(message)
}

export function agentTurnEvents(turn) {
  return (turn?.items || [])
    .filter((item) => item.type !== 'userMessage' && item.type !== 'agentMessage')
    .map((item) => ({
      id: item.id,
      type: item.type === 'dynamicToolCall' ? 'skill' : 'lifecycle',
      label: item.summary || item.tool || 'Agent 正在处理',
      status: item.status === 'inProgress' ? 'running' : item.status === 'interrupted' ? 'cancelled' : item.status,
      meta: item.meta || {},
      startedAt: item.createdAt || null,
      completedAt: item.completedAt || null,
    }))
}

export function agentThreadMessages(thread) {
  const messages = []
  for (const turn of thread?.turns || []) {
    const task = turn.task
    messages.push({
      id: `${turn.id}-user`,
      role: 'user',
      text: turn.message,
      turnId: turn.id,
    })
    if (!task) {
      messages.push({
        id: turn.id,
        role: 'agent',
        turnId: turn.id,
        taskId: turn.taskId,
        status: 'failed',
        text: '这条历史任务已经不可用。',
        source: turn.source || {},
        editRequested: turn.editRequested === true,
        items: turn.items || [],
        events: agentTurnEvents(turn),
      })
      continue
    }
    const completed = task.status === 'completed'
    messages.push({
      id: turn.id,
      role: 'agent',
      turnId: turn.id,
      taskId: task.id,
      status: completed ? task.result?.status || 'completed' : task.status,
      text: completed ? agentResponseText(task.result) : task.error || task.statusMessage || '',
      response: task.result || null,
      source: turn.source || {},
      editRequested: turn.editRequested === true,
      requestedSkill: task.skill || null,
      plan: Array.isArray(turn.plan) ? turn.plan : [],
      items: turn.items || [],
      events: agentTurnEvents(turn),
      progress: task.progress || 0,
      durationMs: task.createdAt && task.updatedAt
        ? Math.max(0, new Date(task.updatedAt).getTime() - new Date(task.createdAt).getTime())
        : 0,
    })
  }
  return messages
}

export function waitForAgentPoll(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    function abort() {
      globalThis.clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
