const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled'])

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function answerValues(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value.answers : value
  const values = Array.isArray(raw) ? raw : [raw]
  return [...new Set(values.map((item) => text(String(item ?? '')).slice(0, 1000)).filter(Boolean))].slice(0, 6)
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0
}

function normalizedUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = {
    input_tokens: positiveInteger(value.input_tokens),
    cached_input_tokens: positiveInteger(value.cached_input_tokens),
    output_tokens: positiveInteger(value.output_tokens),
    reasoning_output_tokens: positiveInteger(value.reasoning_output_tokens),
    total_tokens: positiveInteger(value.total_tokens),
    estimated: value.estimated === true,
  }
  if (!usage.total_tokens) usage.total_tokens = usage.input_tokens + usage.output_tokens
  return usage
}

export function accumulateTaskUsage(task, response, timestamp = new Date().toISOString()) {
  if (!task || !response || typeof response !== 'object') return task?.usage || null
  const attemptUsage = normalizedUsage(response?.result?.usage || response?.usage)
  if (!attemptUsage) return task.usage || null
  const interactionAttempt = Math.max(1, positiveInteger(task.interactionAttempt) || 1)
  const history = Array.isArray(task.usageHistory) ? task.usageHistory : []
  const runId = text(response.run_id)
  if (runId && history.some((item) => item?.runId === runId)) {
    if (response.result && typeof response.result === 'object' && !Array.isArray(response.result) && task.usage) {
      response.result.usage = { ...task.usage }
    }
    return task.usage || null
  }
  const previous = normalizedUsage(task.usage) || normalizedUsage({})
  const usage = {
    input_tokens: previous.input_tokens + attemptUsage.input_tokens,
    cached_input_tokens: previous.cached_input_tokens + attemptUsage.cached_input_tokens,
    output_tokens: previous.output_tokens + attemptUsage.output_tokens,
    reasoning_output_tokens: previous.reasoning_output_tokens + attemptUsage.reasoning_output_tokens,
    total_tokens: previous.total_tokens + attemptUsage.total_tokens,
    estimated: previous.estimated || attemptUsage.estimated,
  }
  task.usage = usage
  task.usageHistory = [...history, {
    runId: runId || null,
    interactionAttempt,
    status: text(response.status) || 'completed',
    usage: attemptUsage,
    createdAt: timestamp,
  }].slice(-20)
  if (response.result && typeof response.result === 'object' && !Array.isArray(response.result)) {
    response.result.usage = { ...usage }
  }
  return usage
}

function publicQuestion(question, index) {
  const options = Array.isArray(question?.options)
    ? question.options.slice(0, 6).map((option) => ({
      label: text(option?.label || option?.value).slice(0, 100),
      value: text(option?.value || option?.label).slice(0, 200),
      description: text(option?.description).slice(0, 300),
    })).filter((option) => option.label)
    : []
  return {
    id: text(question?.id) || `question_${index + 1}`,
    header: text(question?.header).slice(0, 80),
    question: text(question?.question).slice(0, 1000),
    options,
    isOther: question?.isOther !== false,
  }
}

export function taskInputHistory(task) {
  const history = task?.input?.payload?.request_user_input_history
  if (!Array.isArray(history)) return []
  return history.slice(-6).map((entry, historyIndex) => {
    const rawQuestions = Array.isArray(entry?.questions) ? entry.questions : []
    const questions = rawQuestions.slice(0, 3).map(publicQuestion).filter((item) => item.question)
    const rawAnswers = entry?.response?.answers
    const answers = {}
    if (rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)) {
      for (const question of questions) {
        const values = answerValues(rawAnswers[question.id])
        if (values.length) answers[question.id] = { answers: values }
      }
    }
    const fallbackQuestionText = questions.map((item, index) => `${item.header || `问题 ${index + 1}`}：${item.question}`).join('\n')
    const fallbackAnswerText = questions.flatMap((item) => {
      const values = answerValues(answers[item.id])
      return values.length ? [`${item.header || item.question}：${values.join('、')}`] : []
    }).join('\n')
    return {
      requestId: text(entry?.requestId) || `${task?.id || 'task'}:request-user-input:${historyIndex + 1}`,
      interactionAttempt: Math.max(1, positiveInteger(entry?.interactionAttempt) || historyIndex + 1),
      questions,
      response: {
        answers,
        questionText: text(entry?.response?.questionText).slice(0, 4000) || fallbackQuestionText,
        answerText: text(entry?.response?.answerText).slice(0, 6000) || fallbackAnswerText,
      },
      requestedAt: entry?.requestedAt || null,
      resolvedAt: entry?.resolvedAt || null,
    }
  })
}

export function reasoningItemId(task, turnId = null, interactionAttempt = null) {
  const attempt = Math.max(1, positiveInteger(interactionAttempt ?? task?.interactionAttempt) || 1)
  return `${turnId || task?.turnId || task?.id || 'task'}:reasoning:${attempt}`
}

export function taskReasoningHistory(task) {
  if (!Array.isArray(task?.reasoningHistory)) return []
  return task.reasoningHistory.slice(-12).map((item, index) => {
    const summary = String(item?.summary || '').trim()
    if (!summary) return null
    const interactionAttempt = Math.max(1, positiveInteger(item?.interactionAttempt) || index + 1)
    return {
      id: text(item?.id) || reasoningItemId(task, task?.turnId, interactionAttempt),
      interactionAttempt,
      summary,
      createdAt: item?.createdAt || null,
      completedAt: item?.completedAt || null,
    }
  }).filter(Boolean)
}

export function taskSteeringHistory(task) {
  if (!Array.isArray(task?.steeringHistory)) return []
  return task.steeringHistory.slice(-8).map((item, index) => {
    const steerText = text(item?.text).slice(0, 4000)
    if (!steerText) return null
    return {
      id: text(item?.id) || `${task?.id || 'task'}:steer:${index + 1}`,
      text: steerText,
      revision: Math.max(1, positiveInteger(item?.revision) || index + 1),
      status: ['pending', 'applied', 'cancelled'].includes(item?.status) ? item.status : 'applied',
      createdAt: item?.createdAt || null,
      appliedAt: item?.appliedAt || null,
    }
  }).filter(Boolean)
}

export function taskSubagents(task) {
  if (!Array.isArray(task?.subagents)) return []
  return task.subagents.slice(0, 2).map((item, index) => {
    const role = text(item?.role).slice(0, 80)
    if (!role) return null
    return {
      id: text(item?.id) || `${task?.id || 'task'}:subagent:${index + 1}`,
      path: text(item?.path).slice(0, 160) || `/root/${role}`,
      role,
      ordinal: positiveInteger(item?.ordinal) || index,
      status: ['running', 'completed', 'failed', 'interrupted', 'needs_model'].includes(item?.status)
        ? item.status
        : 'running',
      summary: text(item?.summary).slice(0, 6000),
      usage: normalizedUsage(item?.usage),
      error: text(item?.error).slice(0, 500) || null,
      startedAt: item?.startedAt || null,
      completedAt: item?.completedAt || null,
    }
  }).filter(Boolean).sort((left, right) => left.ordinal - right.ordinal)
}

export function archiveTaskReasoning(task, { turnId = null, completedAt = new Date().toISOString() } = {}) {
  const summary = String(task?.reasoningSummary || '').trim()
  if (!task || !summary) return null
  const interactionAttempt = Math.max(1, positiveInteger(task.interactionAttempt) || 1)
  const id = reasoningItemId(task, turnId, interactionAttempt)
  const history = taskReasoningHistory(task)
  const existing = history.find((item) => item.id === id)
  if (existing) return existing
  const item = {
    id,
    interactionAttempt,
    summary,
    createdAt: task.reasoningStartedAt || task.updatedAt || task.createdAt || null,
    completedAt,
  }
  task.reasoningHistory = [...history, item].slice(-12)
  return item
}

export function normalizeAgentInputAnswers(inputRequest, submittedAnswers) {
  const questions = Array.isArray(inputRequest?.questions) ? inputRequest.questions : [inputRequest]
  const answers = submittedAnswers && typeof submittedAnswers === 'object' && !Array.isArray(submittedAnswers)
    ? submittedAnswers
    : {}
  const normalized = {}
  const questionLines = []
  const answerLines = []
  for (const [index, question] of questions.slice(0, 3).entries()) {
    const id = text(question?.id) || `question_${index + 1}`
    const prompt = text(question?.question)
    if (!prompt) continue
    const values = answerValues(answers[id])
    if (!values.length) {
      throw Object.assign(new Error(`请回答“${text(question?.header) || prompt}”`), { status: 400 })
    }
    normalized[id] = { answers: values }
    questionLines.push(`${text(question?.header) || `问题 ${index + 1}`}：${prompt}`)
    answerLines.push(`${text(question?.header) || prompt}：${values.join('、')}`)
  }
  if (!Object.keys(normalized).length) {
    throw Object.assign(new Error('当前问题格式无效，请重新发起任务'), { status: 409 })
  }
  return {
    answers: normalized,
    questionText: questionLines.join('\n'),
    answerText: answerLines.join('\n'),
  }
}

export function normalizeAgentThreads(db) {
  if (!Array.isArray(db.agentThreads)) db.agentThreads = []
  db.agentThreads = db.agentThreads
    .filter((thread) => thread && typeof thread === 'object' && thread.id && thread.userId && thread.projectId)
    .map((thread) => ({
      ...thread,
      chapterId: thread.chapterId == null ? null : String(thread.chapterId),
      title: text(thread.title).slice(0, 120),
      isFavorited: thread.isFavorited === true,
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
    task.interactionAttempt = Math.max(1, positiveInteger(task.interactionAttempt) || 1)
    task.reasoningHistory = taskReasoningHistory(task)
    const rawSteeringHistory = Array.isArray(task.steeringHistory) ? task.steeringHistory : []
    task.steeringHistory = taskSteeringHistory(task).map((item) => {
      const raw = rawSteeringHistory.find((candidate) => candidate?.id === item.id)
      return {
        ...item,
        idempotencyKey: text(raw?.idempotencyKey).slice(0, 160) || null,
      }
    })
    task.steerRevision = positiveInteger(task.steerRevision)
    task.appliedSteerRevision = positiveInteger(task.appliedSteerRevision)
    task.executionGeneration = Math.max(1, positiveInteger(task.executionGeneration) || 1)
    task.activeExecutionId = text(task.activeExecutionId) || null
    task.steerRequested = task.steerRequested === true
    task.subagents = taskSubagents(task)
    task.usageHistory = Array.isArray(task.usageHistory) ? task.usageHistory.slice(-20) : []
    task.usage = normalizedUsage(task.usage)
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

function turnConversationMessages(turn, task, { includeResult = true } = {}) {
  const messages = [{ role: 'user', text: String(turn?.message || '').slice(0, 6000) }]
  for (const steer of taskSteeringHistory(task)) {
    if (steer.status !== 'cancelled') messages.push({ role: 'user', text: steer.text.slice(0, 4000) })
  }
  for (const exchange of taskInputHistory(task)) {
    const questionText = text(exchange.response?.questionText)
    const answerText = text(exchange.response?.answerText)
    if (questionText) messages.push({ role: 'assistant', text: questionText.slice(0, 6000) })
    if (answerText) messages.push({ role: 'user', text: answerText.slice(0, 6000) })
  }
  if (includeResult) {
    const response = taskResultText(task)
    if (response) messages.push({ role: 'assistant', text: response.slice(0, 12000) })
  }
  return messages
}

export function threadConversation(thread, tasks) {
  const taskMap = new Map((tasks || []).map((task) => [task.id, task]))
  const compactedTurnIds = new Set(thread?.compactedTurnIds || [])
  const completedTurns = (thread?.turns || [])
    .filter((turn) => taskMap.get(turn.taskId)?.status === 'completed' && !compactedTurnIds.has(turn.id))
    .slice(-12)
  const batches = completedTurns.map((turn) => {
    const task = taskMap.get(turn.taskId)
    return turnConversationMessages(turn, task)
  })
  const selected = []
  let messageCount = 0
  for (let index = batches.length - 1; index >= 0; index -= 1) {
    const batch = batches[index]
    if (selected.length && messageCount + batch.length > 24) break
    selected.unshift(batch)
    messageCount += batch.length
  }
  return selected.flat()
}

const DEFAULT_COMPACTION_RESERVE_TOKENS = 16384

export const DEFAULT_THREAD_COMPACTION_SETTINGS = Object.freeze({
  enabled: true,
  strategy: 'context-full',
  thresholdPercent: -1,
  thresholdTokens: -1,
  reserveTokens: null,
  keepRecentTokens: 20000,
})

function finiteNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function normalizeThreadCompactionSettings(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    enabled: input.enabled !== false,
    strategy: input.strategy === 'off' ? 'off' : 'context-full',
    thresholdPercent: finiteNumber(input.thresholdPercent, -1),
    thresholdTokens: finiteNumber(input.thresholdTokens, -1),
    reserveTokens: input.reserveTokens == null ? null : Math.max(0, finiteNumber(input.reserveTokens, 0)),
    keepRecentTokens: Math.max(1, finiteNumber(input.keepRecentTokens, DEFAULT_THREAD_COMPACTION_SETTINGS.keepRecentTokens)),
  }
}

export function resolveThreadCompactionThreshold(contextWindow, value) {
  const settings = normalizeThreadCompactionSettings(value)
  const safeWindow = Math.max(2, finiteNumber(contextWindow, 100000))
  if (settings.thresholdTokens > 0) {
    return Math.min(safeWindow - 1, Math.max(1, Math.floor(settings.thresholdTokens)))
  }
  if (settings.thresholdPercent > 0) {
    const percent = Math.min(99, Math.max(1, settings.thresholdPercent))
    return Math.floor(safeWindow * (percent / 100))
  }
  const proportionalReserve = Math.max(1, Math.floor(safeWindow * 0.15))
  const configuredReserve = settings.reserveTokens == null
    ? Math.max(proportionalReserve, DEFAULT_COMPACTION_RESERVE_TOKENS)
    : Math.max(proportionalReserve, settings.reserveTokens)
  const defaultReserveIsImpossible = settings.reserveTokens == null
    && configuredReserve >= safeWindow - proportionalReserve
  const reserve = defaultReserveIsImpossible || configuredReserve >= safeWindow
    ? proportionalReserve
    : configuredReserve
  return Math.max(0, Math.min(safeWindow - 1, safeWindow - reserve))
}

function estimateConversationTokens(messages) {
  return Math.max(1, Math.ceil(JSON.stringify(messages || []).length / 2.2))
}

export function threadCompactionPlan(thread, tasks, {
  contextWindow = 100000,
  compaction = DEFAULT_THREAD_COMPACTION_SETTINGS,
  force = false,
} = {}) {
  const settings = normalizeThreadCompactionSettings(compaction)
  if (!force && (!settings.enabled || settings.strategy === 'off')) return null
  const taskMap = new Map((tasks || []).map((task) => [task.id, task]))
  const compactedTurnIds = new Set(thread?.compactedTurnIds || [])
  const completedTurns = (thread?.turns || [])
    .filter((turn) => taskMap.get(turn.taskId)?.status === 'completed' && !compactedTurnIds.has(turn.id))
  if (completedTurns.length < 2) return null

  const turnBatches = completedTurns.map((turn) => {
    const task = taskMap.get(turn.taskId)
    const messages = turnConversationMessages(turn, task)
    return { turn, messages, tokens: estimateConversationTokens(messages) }
  })
  const messages = turnBatches.flatMap((batch) => batch.messages)
  const safeWindow = Math.max(2, finiteNumber(contextWindow, 100000))
  const thresholdTokens = resolveThreadCompactionThreshold(safeWindow, settings)
  const summaryTokens = text(thread?.contextSummary) ? Math.ceil(text(thread.contextSummary).length / 2.2) : 0
  const estimatedTokens = summaryTokens + estimateConversationTokens(messages)
  if (!force && estimatedTokens <= thresholdTokens) return null

  let keepStart = turnBatches.length
  let keptTokens = 0
  while (keepStart > 0 && (keptTokens < settings.keepRecentTokens || keepStart === turnBatches.length)) {
    keepStart -= 1
    keptTokens += turnBatches[keepStart].tokens
  }
  if (keepStart === 0 && turnBatches.length > 1 && (force || estimatedTokens > thresholdTokens)) keepStart = 1
  const batchesToCompact = turnBatches.slice(0, keepStart)
  if (!batchesToCompact.length) return null
  const turnsToCompact = batchesToCompact.map((batch) => batch.turn)
  const turnIds = turnsToCompact.map((turn) => turn.id)
  const messagesToCompact = batchesToCompact.flatMap((batch) => batch.messages)
  return {
    turnIds,
    messages: messagesToCompact,
    estimatedTokens,
    thresholdTokens,
    keepRecentTokens: settings.keepRecentTokens,
    keptTurnCount: completedTurns.length - turnsToCompact.length,
    forced: force,
  }
}

export function taskSource(task) {
  const payload = task?.input?.payload || {}
  return {
    chapterId: task?.chapterId ?? payload.chapter_id ?? payload.chapterId ?? null,
    chapterTitle: text(payload.chapter_title || payload.chapterTitle),
    mode: text(payload.collaboration_mode) || 'build',
    multiAgent: payload.multi_agent === true,
    sourceText: typeof payload.source_text === 'string' ? payload.source_text : typeof payload.sourceText === 'string' ? payload.sourceText : typeof payload.content === 'string' ? payload.content : '',
    selectedText: typeof payload.selected_text === 'string' ? payload.selected_text : typeof payload.selectedText === 'string' ? payload.selectedText : '',
    selectionStart: Number(payload.selection_start ?? payload.selectionStart) || 0,
    selectionEnd: Number(payload.selection_end ?? payload.selectionEnd) || 0,
    attachedFiles: Array.isArray(payload.attached_files)
      ? payload.attached_files.slice(0, 12).map((item) => ({
        name: text(item?.name),
        kind: text(item?.kind),
        ...(item?.reference && typeof item.reference === 'object'
          ? { reference: { type: text(item.reference.type), id: text(item.reference.id) } }
          : {}),
      })).filter((item) => item.name)
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
  for (const steer of taskSteeringHistory(task)) {
    items.push({
      id: steer.id,
      type: 'userMessage',
      status: steer.status === 'cancelled' ? 'interrupted' : 'completed',
      content: [{ type: 'inputText', text: steer.text }],
      meta: { steer: true, revision: steer.revision, steerStatus: steer.status },
      createdAt: steer.createdAt,
      completedAt: steer.appliedAt || steer.createdAt,
    })
  }
  const subagentLabels = {
    continuity_guard: '连续性子代理',
    scene_planner: '场景规划子代理',
    prose_critic: '文本审阅子代理',
  }
  for (const subagent of taskSubagents(task)) {
    items.push({
      id: `${turn.id}:subagent:${subagent.id}`,
      type: 'collabAgentToolCall',
      status: itemStatus(subagent.status),
      summary: `${subagentLabels[subagent.role] || subagent.role}${subagent.status === 'failed' ? '已降级' : subagent.status === 'running' ? '正在审阅' : '已返回报告'}`,
      receiver: subagent.path,
      meta: {
        role: subagent.role,
        path: subagent.path,
        reportSummary: subagent.summary,
        error: subagent.error,
        usage: subagent.usage,
      },
      createdAt: subagent.startedAt,
      completedAt: subagent.completedAt,
    })
  }
  const segmentedReasoningAttempts = new Set(
    (task?.events || [])
      .filter((event) => event?.type === 'reasoning' && event?.meta?.reasoningSegment === true)
      .map((event) => Math.max(1, positiveInteger(event?.meta?.interactionAttempt) || 1)),
  )
  for (const event of task?.events || []) {
    if (event.type === 'result') continue
    if (event.type === 'tool' && event.meta?.toolName === 'request_user_input') continue
    if (event.type === 'reasoning') {
      items.push({
        id: event.id,
        type: 'reasoning',
        status: itemStatus(event.status),
        summary: [{ type: 'summary_text', text: String(event.meta?.summary || '') }],
        meta: event.meta || {},
        createdAt: event.startedAt || task.createdAt || null,
        completedAt: event.completedAt || null,
      })
      continue
    }
    const dynamicTool = event.type === 'tool'
    items.push({
      id: event.id,
      type: dynamicTool ? 'dynamicToolCall' : 'lifecycle',
      status: itemStatus(event.status),
      summary: event.label,
      ...(dynamicTool ? {
        tool: event.type === 'tool' ? event.meta?.toolName : task.skill || 'story',
        arguments: event.type === 'tool' ? event.meta?.arguments || {} : { message: task.message },
      } : {}),
      meta: event.meta || {},
      createdAt: event.startedAt || task.createdAt || null,
      completedAt: event.completedAt || null,
    })
  }
  for (const reasoning of taskReasoningHistory(task)) {
    if (segmentedReasoningAttempts.has(reasoning.interactionAttempt)) continue
    items.push({
      id: reasoning.id,
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: reasoning.summary }],
      meta: { modelReasoning: true, interactionAttempt: reasoning.interactionAttempt },
      createdAt: reasoning.createdAt,
      completedAt: reasoning.completedAt,
    })
  }
  for (const exchange of taskInputHistory(task)) {
    items.push({
      id: exchange.requestId,
      type: 'requestUserInput',
      status: 'completed',
      requestId: exchange.requestId,
      questions: exchange.questions,
      response: exchange.response.answers,
      meta: { interactionAttempt: exchange.interactionAttempt },
      createdAt: exchange.requestedAt,
      completedAt: exchange.resolvedAt,
    })
    if (exchange.response.answerText) {
      items.push({
        id: `${exchange.requestId}:answer`,
        type: 'userMessage',
        status: 'completed',
        content: [{ type: 'inputText', text: exchange.response.answerText }],
        meta: { requestId: exchange.requestId, interactionAttempt: exchange.interactionAttempt },
        createdAt: exchange.resolvedAt,
        completedAt: exchange.resolvedAt,
      })
    }
  }
  const reasoningSummary = String(task?.reasoningSummary || '').trim()
  const interactionAttempt = Math.max(1, positiveInteger(task?.interactionAttempt) || 1)
  if (reasoningSummary && !segmentedReasoningAttempts.has(interactionAttempt)) {
    items.push({
      id: reasoningItemId(task, turn.id, interactionAttempt),
      type: 'reasoning',
      status: task?.status === 'waiting_input' ? 'completed' : itemStatus(task?.status),
      summary: [{ type: 'summary_text', text: reasoningSummary }],
      meta: { modelReasoning: true, interactionAttempt },
      createdAt: task?.reasoningStartedAt || task?.updatedAt || task?.createdAt || null,
      completedAt: ['queued', 'running'].includes(task?.status) ? null : task?.reasoningCompletedAt || task?.updatedAt || null,
    })
  }
  const pendingInputRequest = task?.pendingInputRequest && typeof task.pendingInputRequest === 'object'
    ? task.pendingInputRequest
    : null
  const inputRequest = task?.result?.status === 'needs_input'
    ? task.result?.result?.question
    : pendingInputRequest
  if (inputRequest && typeof inputRequest === 'object') {
    const requestId = text(inputRequest.requestId) || `${turn.id}:request-user-input`
    items.push({
      id: requestId,
      type: 'requestUserInput',
      status: 'inProgress',
      requestId,
      questions: Array.isArray(inputRequest.questions) ? inputRequest.questions : [inputRequest],
      meta: { interactionAttempt: Math.max(1, positiveInteger(task?.interactionAttempt) || 1) },
      createdAt: task?.inputRequestStartedAt || pendingInputRequest?.requestedAt || task?.updatedAt || null,
    })
  }
  if (TERMINAL_TASK_STATUSES.has(task?.status)) {
    const planMode = task?.input?.payload?.collaboration_mode === 'plan'
    const interactionAttempt = Math.max(1, positiveInteger(task?.interactionAttempt) || 1)
    items.push({
      id: `${turn.id}:agent:${interactionAttempt}`,
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
  const taskMap = new Map((tasks || [])
    .filter((task) => !thread?.userId || task?.userId === thread.userId)
    .map((task) => [task.id, task]))
  const turns = (thread.turns || []).map((turn) => agentTurnPublic(thread, turn, taskMap.get(turn.taskId), taskPublic))
  const fallbackTitle = text(thread.turns?.[0]?.message).replace(/\s+/g, ' ').slice(0, 60)
  const latestMessage = text(thread.turns?.at(-1)?.message).replace(/\s+/g, ' ').slice(0, 160)
  return {
    id: thread.id,
    projectId: thread.projectId,
    chapterId: thread.chapterId,
    title: text(thread.title) || fallbackTitle || '新会话',
    isFavorited: thread.isFavorited === true,
    latestMessage,
    turnCount: turns.length,
    status: thread.status,
    contextSummary: thread.contextSummary || '',
    compactedTurnCount: Math.max(0, Number(thread.compactedTurnCount) || 0),
    contextSummaryUpdatedAt: thread.contextSummaryUpdatedAt || null,
    turns,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  }
}
