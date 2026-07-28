const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled'])

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeAgentThreads(db) {
  if (!Array.isArray(db.agentThreads)) db.agentThreads = []
  db.agentThreads = db.agentThreads
    .filter((thread) => thread && typeof thread === 'object' && thread.id && thread.userId && thread.projectId)
    .map((thread) => ({
      ...thread,
      chapterId: thread.chapterId == null ? null : String(thread.chapterId),
      status: thread.status === 'archived' ? 'archived' : 'active',
      contextSummary: text(thread.contextSummary),
      compactedTurnIds: Array.isArray(thread.compactedTurnIds) ? [...new Set(thread.compactedTurnIds.filter(Boolean).map(String))].slice(-40) : [],
      compactedTurnCount: Math.max(0, Number(thread.compactedTurnCount) || 0),
      contextSummaryUpdatedAt: thread.contextSummaryUpdatedAt || null,
      turns: Array.isArray(thread.turns)
        ? thread.turns.filter((turn) => turn && turn.id && turn.taskId && typeof turn.message === 'string').slice(-40)
        : [],
      createdAt: thread.createdAt || null,
      updatedAt: thread.updatedAt || thread.createdAt || null,
    }))
  const turnIdsByTask = new Map(
    db.agentThreads.flatMap((thread) => thread.turns.map((turn) => [turn.taskId, turn.id])),
  )
  for (const task of db.writingTasks || []) {
    if (!task.turnId && turnIdsByTask.has(task.id)) task.turnId = turnIdsByTask.get(task.id)
  }
  return db.agentThreads
}

export function taskResultText(task) {
  const result = task?.result?.result || {}
  const proposal = result.edit_proposal
  if (result.question && typeof result.question === 'object') {
    const questions = Array.isArray(result.question.questions) ? result.question.questions : [result.question]
    const lines = questions.slice(0, 3).flatMap((item, questionIndex) => {
      const question = text(item?.question)
      const options = Array.isArray(item?.options)
        ? item.options.slice(0, 6).map((option, index) => {
          const label = text(option?.label || option?.value)
          const value = text(option?.value || label)
          return label ? `${String.fromCharCode(65 + index)}：${label}${value && value !== label ? `（${value}）` : ''}` : ''
        }).filter(Boolean)
        : []
      return question ? [`问题 ${questionIndex + 1}：${question}`, ...options] : []
    })
    if (lines.length) return lines.join('\n')
  }
  for (const value of [proposal?.summary, result.output, result.summary, result.message]) {
    if (text(value)) return text(value)
  }
  if (result.verdict || result.findings?.length) {
    const lines = [result.verdict ? `审稿结论：${result.verdict}${result.score != null ? ` · ${result.score} 分` : ''}` : '章节审查完成。']
    for (const finding of (result.findings || []).slice(0, 8)) {
      lines.push(`- ${finding.issue || finding.title || finding.message}${finding.fix ? `：${finding.fix}` : ''}`)
    }
    return lines.join('\n')
  }
  return TERMINAL_TASK_STATUSES.has(task?.status) ? task?.error || task?.statusMessage || '' : ''
}

export function threadConversation(thread, tasks) {
  const taskMap = new Map((tasks || []).map((task) => [task.id, task]))
  const compactedTurnIds = new Set(thread?.compactedTurnIds || [])
  const messages = []
  const completedTurns = (thread?.turns || [])
    .filter((turn) => taskMap.get(turn.taskId)?.status === 'completed' && !compactedTurnIds.has(turn.id))
    .slice(-12)
  for (const turn of completedTurns) {
    const task = taskMap.get(turn.taskId)
    messages.push({ role: 'user', text: turn.message.slice(0, 6000) })
    const response = taskResultText(task)
    if (response) messages.push({ role: 'assistant', text: response.slice(0, 12000) })
  }
  return messages.slice(-24)
}

export function threadCompactionPlan(thread, tasks, { contextWindow = 100000, maxTokens = 4096 } = {}) {
  const taskMap = new Map((tasks || []).map((task) => [task.id, task]))
  const compactedTurnIds = new Set(thread?.compactedTurnIds || [])
  const completedTurns = (thread?.turns || [])
    .filter((turn) => taskMap.get(turn.taskId)?.status === 'completed' && !compactedTurnIds.has(turn.id))
  if (completedTurns.length <= 8) return null

  const messages = []
  for (const turn of completedTurns) {
    const task = taskMap.get(turn.taskId)
    messages.push({ role: 'user', text: turn.message.slice(0, 6000) })
    const response = taskResultText(task)
    if (response) messages.push({ role: 'assistant', text: response.slice(0, 12000) })
  }
  const safeWindow = Math.max(500, Number(contextWindow) || 100000)
  const reservedOutput = Math.min(Math.max(0, Number(maxTokens) || 4096), safeWindow * 0.4)
  const transcriptBudget = Math.max(500, Math.floor((safeWindow - reservedOutput) * 0.3))
  const estimatedTokens = Math.ceil((text(thread?.contextSummary).length + JSON.stringify(messages).length) / 2.2)
  if (estimatedTokens < transcriptBudget) return null

  const turnsToCompact = completedTurns.slice(0, -6)
  if (turnsToCompact.length < 2) return null
  const turnIds = turnsToCompact.map((turn) => turn.id)
  const messagesToCompact = []
  for (const turn of turnsToCompact) {
    const task = taskMap.get(turn.taskId)
    messagesToCompact.push({ role: 'user', text: turn.message.slice(0, 6000) })
    const response = taskResultText(task)
    if (response) messagesToCompact.push({ role: 'assistant', text: response.slice(0, 12000) })
  }
  return {
    turnIds,
    messages: messagesToCompact,
    estimatedTokens,
    transcriptBudget,
  }
}

export function taskSource(task) {
  const payload = task?.input?.payload || {}
  return {
    chapterId: task?.chapterId ?? payload.chapter_id ?? payload.chapterId ?? null,
    chapterTitle: text(payload.chapter_title || payload.chapterTitle),
    mode: text(payload.collaboration_mode) || 'build',
    sourceText: typeof payload.source_text === 'string' ? payload.source_text : typeof payload.sourceText === 'string' ? payload.sourceText : typeof payload.content === 'string' ? payload.content : '',
    selectedText: typeof payload.selected_text === 'string' ? payload.selected_text : typeof payload.selectedText === 'string' ? payload.selectedText : '',
    selectionStart: Number(payload.selection_start ?? payload.selectionStart) || 0,
    selectionEnd: Number(payload.selection_end ?? payload.selectionEnd) || 0,
    attachedFiles: Array.isArray(payload.attached_files)
      ? payload.attached_files.slice(0, 12).map((item) => ({ name: text(item?.name), kind: text(item?.kind) })).filter((item) => item.name)
      : [],
  }
}

function itemStatus(status) {
  if (status === 'running' || status === 'queued') return 'inProgress'
  if (status === 'waiting_input') return 'inProgress'
  if (status === 'cancelled' || status === 'interrupted') return 'interrupted'
  if (status === 'failed') return 'failed'
  return 'completed'
}

export function turnStatus(task) {
  return itemStatus(task?.status)
}

export function agentTurnPlan(task) {
  if (!Array.isArray(task?.plan)) return []
  return task.plan
    .slice(0, 12)
    .map((item) => ({
      step: text(item?.step),
      status: ['pending', 'inProgress', 'completed'].includes(item?.status) ? item.status : 'pending',
    }))
    .filter((item) => item.step)
}

export function agentTurnItems(turn, task) {
  const items = [{
    id: `${turn.id}:user`,
    type: 'userMessage',
    status: 'completed',
    content: [{ type: 'inputText', text: turn.message }],
    createdAt: turn.createdAt || task?.createdAt || null,
    completedAt: turn.createdAt || task?.createdAt || null,
  }]
  for (const event of task?.events || []) {
    if (event.type === 'result') continue
    items.push({
      id: event.id,
      type: event.type === 'skill' ? 'dynamicToolCall' : 'reasoning',
      status: itemStatus(event.status),
      summary: event.label,
      ...(event.type === 'skill' ? {
        tool: task.skill || 'story',
        arguments: { message: task.message },
      } : {}),
      meta: event.meta || {},
      createdAt: event.startedAt || task.createdAt || null,
      completedAt: event.completedAt || null,
    })
  }
  const inputRequest = task?.result?.status === 'needs_input' ? task.result?.result?.question : null
  if (inputRequest && typeof inputRequest === 'object') {
    items.push({
      id: `${turn.id}:request-user-input`,
      type: 'requestUserInput',
      status: 'inProgress',
      questions: Array.isArray(inputRequest.questions) ? inputRequest.questions : [inputRequest],
    })
  }
  if (TERMINAL_TASK_STATUSES.has(task?.status)) {
    const planMode = task?.input?.payload?.collaboration_mode === 'plan'
    items.push({
      id: `${turn.id}:agent`,
      type: planMode ? 'plan' : 'agentMessage',
      status: itemStatus(task.status),
      content: [{ type: 'outputText', text: taskResultText(task) || task.statusMessage || '' }],
      createdAt: task.updatedAt || null,
      completedAt: task.updatedAt || null,
    })
  }
  return items
}

export function agentTurnPublic(thread, turn, task, taskPublic) {
  return {
    id: turn.id,
    threadId: thread.id,
    taskId: turn.taskId,
    status: turnStatus(task),
    plan: agentTurnPlan(task),
    items: agentTurnItems(turn, task),
    message: turn.message,
    editRequested: turn.editRequested === true,
    source: task ? taskSource(task) : null,
    error: task?.error || null,
    createdAt: turn.createdAt || task?.createdAt || null,
    updatedAt: task?.updatedAt || turn.createdAt || null,
    completedAt: TERMINAL_TASK_STATUSES.has(task?.status) ? task.updatedAt || null : null,
    task: task ? taskPublic(task) : null,
  }
}

export function agentThreadPublic(thread, tasks, taskPublic) {
  const taskMap = new Map((tasks || []).map((task) => [task.id, task]))
  const turns = (thread.turns || []).map((turn) => agentTurnPublic(thread, turn, taskMap.get(turn.taskId), taskPublic))
  return {
    id: thread.id,
    projectId: thread.projectId,
    chapterId: thread.chapterId,
    status: thread.status,
    contextSummary: thread.contextSummary || '',
    compactedTurnCount: Math.max(0, Number(thread.compactedTurnCount) || 0),
    contextSummaryUpdatedAt: thread.contextSummaryUpdatedAt || null,
    turns,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  }
}
