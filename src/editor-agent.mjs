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

function cleanAgentChoiceText(value) {
  return String(value || '')
    .trim()
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*---+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function firstChoiceQuestion(value) {
  const question = cleanAgentChoiceText(value)
  const marks = [question.indexOf('？'), question.indexOf('?')].filter((index) => index >= 0)
  return marks.length ? question.slice(0, Math.min(...marks) + 1).trim() : question
}

function markdownTableCells(line, preserveDelimiter = false) {
  const value = String(line || '').trim()
  if (!value.includes('|')) return null
  const cells = value.split('|')
  if (cells[0].trim() === '') cells.shift()
  if (cells.at(-1)?.trim() === '') cells.pop()
  return cells.map((cell) => preserveDelimiter ? cell.trim() : cleanAgentChoiceText(cell))
}

function parseMarkdownTableChoices(lines) {
  for (let delimiterIndex = 1; delimiterIndex < lines.length; delimiterIndex += 1) {
    const delimiterCells = markdownTableCells(lines[delimiterIndex], true)
    if (!delimiterCells?.length || !delimiterCells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue
    const headerCells = markdownTableCells(lines[delimiterIndex - 1])
    if (!headerCells || headerCells.length < 2 || headerCells.length > 7) continue

    let questionIndex = -1
    for (let index = delimiterIndex - 2; index >= Math.max(0, delimiterIndex - 10); index -= 1) {
      const copy = cleanAgentChoiceText(lines[index])
      if (/[？?]/.test(copy) || /请选择|更想要|哪一种|哪种|还是/.test(copy)) {
        questionIndex = index
        break
      }
    }
    const nearbyCopy = cleanAgentChoiceText(lines.slice(Math.max(0, delimiterIndex - 10), delimiterIndex - 1).join('\n'))
    const hasChoiceCue = questionIndex >= 0 || /选择|方向|哪种|还是|更想|确认/.test(nearbyCopy)
    if (!hasChoiceCue) continue

    const hasRowLabelColumn = headerCells[0] === ''
    const optionLabels = (hasRowLabelColumn ? headerCells.slice(1) : headerCells).filter(Boolean)
    if (optionLabels.length < 2 || optionLabels.length > 6) continue

    const detailRows = []
    let tableEndIndex = delimiterIndex
    for (let index = delimiterIndex + 1; index < lines.length; index += 1) {
      const cells = markdownTableCells(lines[index])
      if (!cells || cells.length < optionLabels.length) break
      detailRows.push(cells)
      tableEndIndex = index
    }
    const options = optionLabels.map((label, optionIndex) => {
      const details = detailRows.slice(0, 4).map((cells) => {
        const rowLabel = hasRowLabelColumn ? cells[0] : ''
        const value = cells[optionIndex + (hasRowLabelColumn ? 1 : 0)]
        return value ? `${rowLabel ? `${rowLabel}：` : ''}${value}` : ''
      }).filter(Boolean)
      const key = String.fromCharCode(65 + optionIndex)
      return {
        key,
        label,
        description: details.join(' · '),
        reply: `${key}：${label}`,
      }
    })
    const questionStart = questionIndex >= 0 ? questionIndex : delimiterIndex - 2
    return {
      intro: cleanAgentChoiceText(lines.slice(0, questionStart).join('\n')),
      question: firstChoiceQuestion(lines[questionStart]) || '请选择一个方向继续',
      hint: cleanAgentChoiceText(lines.slice(tableEndIndex + 1).join('\n')),
      options,
    }
  }
  return null
}

export function parseAgentChoicePrompt(value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n')
  const optionPattern = /^\s*(?:[-*+]\s*)?(?:\*\*)?([A-H])(?:\*\*)?\s*(?:[.、:：]|[—–-]{1,2})\s*(.+?)\s*$/i
  const matches = lines
    .map((line, index) => {
      const match = line.match(optionPattern)
      return match ? { index, key: match[1].toUpperCase(), label: cleanAgentChoiceText(match[2]) } : null
    })
    .filter(Boolean)

  if (matches.length < 2 || new Set(matches.map((item) => item.key)).size !== matches.length) {
    return parseMarkdownTableChoices(lines)
  }

  const firstOptionIndex = matches[0].index
  const lastOptionIndex = matches.at(-1).index
  let headingIndex = -1
  for (let index = firstOptionIndex - 1; index >= 0; index -= 1) {
    if (/障碍问题|需要你选择|请选择|请确认|选择一个|确认一项/.test(lines[index])) {
      headingIndex = index
      break
    }
  }

  const questionStart = headingIndex >= 0 ? headingIndex + 1 : Math.max(0, firstOptionIndex - 1)
  const introEnd = headingIndex >= 0 ? headingIndex : questionStart
  const intro = cleanAgentChoiceText(lines.slice(0, introEnd).join('\n'))
  const question = firstChoiceQuestion(lines.slice(questionStart, firstOptionIndex).join('\n')) || '请选择一个方向继续'
  const hint = cleanAgentChoiceText(lines.slice(lastOptionIndex + 1).join('\n'))

  return {
    intro,
    question,
    hint,
    options: matches.map(({ key, label }) => ({ key, label, description: '', reply: `${key}：${label}` })),
  }
}

export function normalizeStructuredAgentQuestion(value) {
  const rawQuestions = Array.isArray(value?.questions) ? value.questions : [value]
  const questions = rawQuestions.slice(0, 3).map((item, questionIndex) => {
    const question = firstChoiceQuestion(item?.question)
    if (!question || !Array.isArray(item?.options)) return null
    const options = item.options.slice(0, 6).map((option, index) => {
      const key = cleanAgentChoiceText(option?.key) || String.fromCharCode(65 + index)
      const label = cleanAgentChoiceText(option?.label || option?.value)
      const replyValue = cleanAgentChoiceText(option?.value || label)
      return { key, label, description: cleanAgentChoiceText(option?.description), reply: replyValue }
    }).filter((option) => option.label)
    if (options.length < 2) return null
    return {
      id: cleanAgentChoiceText(item?.id) || `question_${questionIndex + 1}`,
      header: cleanAgentChoiceText(item?.header),
      question,
      isOther: item?.isOther !== false,
      options,
    }
  }).filter(Boolean)
  if (!questions.length) return null
  return { intro: '', question: questions[0].question, hint: '', options: questions[0].options, questions }
}

function compactEventKey(event) {
  const label = String(event?.label || '')
  if (/任务.*排队|正在创建任务/.test(label)) return 'queue'
  if (/读取.*(?:作品|章节|上下文)|构建写作上下文/.test(label)) return 'context'
  if (event?.type === 'skill' || /\bSkill\b/i.test(label)) return `skill:${event?.meta?.selectedSkill || label.replace(/^(?:执行|完成)\s+|\s+Skill.*$/gi, '')}`
  if (/收到用户回答|确认补充信息/.test(label)) return 'input'
  return `${event?.type || 'lifecycle'}:${label}`
}

export function compactAgentEvents(value) {
  const events = Array.isArray(value) ? value.filter(Boolean) : []
  if (events.length < 2) return events
  const compacted = []
  const indexByKey = new Map()
  for (const event of events) {
    const key = compactEventKey(event)
    if (key === 'queue') continue
    const existingIndex = indexByKey.get(key)
    if (existingIndex == null) {
      indexByKey.set(key, compacted.length)
      compacted.push({ ...event, count: 1 })
      continue
    }
    const previous = compacted[existingIndex]
    compacted[existingIndex] = {
      ...previous,
      ...event,
      id: previous.id,
      label: key === 'input' ? '已确认补充信息' : event.label,
      count: previous.count + 1,
      startedAt: event.startedAt || previous.startedAt,
      completedAt: event.completedAt || previous.completedAt,
      meta: { ...(previous.meta || {}), ...(event.meta || {}) },
    }
  }
  return compacted.length ? compacted : events.slice(-1)
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
    search: { skill: 'story-search', message: argument || '搜索与当前作品相关的写作资料。' },
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
    .filter((item) => item.type !== 'userMessage'
      && item.type !== 'agentMessage'
      && item.type !== 'plan'
      && item.meta?.modelReasoning !== true)
    .map((item) => ({
      id: item.id,
      type: item.type === 'dynamicToolCall'
        ? 'skill'
        : item.type === 'collabAgentToolCall'
          ? 'subagent'
          : 'lifecycle',
      label: item.type === 'requestUserInput' ? '等待你的回答' : item.summary || item.tool || 'Agent 正在处理',
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
    for (const steer of task?.steeringHistory || []) {
      if (!steer?.text || steer.status === 'cancelled') continue
      messages.push({
        id: steer.id,
        role: 'user',
        text: steer.text,
        turnId: turn.id,
        steer: true,
        steerStatus: steer.status,
      })
    }
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
    for (const [historyIndex, exchange] of (task.inputHistory || []).entries()) {
      const answerText = String(exchange?.response?.answerText || '').trim()
      if (!answerText) continue
      messages.push({
        id: `${turn.id}-answer-${exchange.requestId || historyIndex + 1}`,
        role: 'user',
        text: answerText,
        turnId: turn.id,
        requestId: exchange.requestId || null,
      })
    }
    const completed = task.status === 'completed'
    messages.push({
      id: turn.id,
      role: 'agent',
      turnId: turn.id,
      taskId: task.id,
      status: completed ? task.result?.status || 'completed' : task.status,
      text: completed
        ? agentResponseText(task.result)
        : ['queued', 'running'].includes(task.status)
          ? task.partialOutput || ''
          : task.error || task.statusMessage || '',
      response: task.result || null,
      source: turn.source || {},
      editRequested: turn.editRequested === true,
      requestedSkill: task.skill || null,
      plan: Array.isArray(turn.plan) ? turn.plan : [],
      items: turn.items || [],
      events: agentTurnEvents(turn),
      progress: task.progress || 0,
      reasoningSummary: task.reasoningSummary || '',
      reasoningHistory: Array.isArray(task.reasoningHistory) ? task.reasoningHistory : [],
      inputHistory: Array.isArray(task.inputHistory) ? task.inputHistory : [],
      usage: task.usage || null,
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
