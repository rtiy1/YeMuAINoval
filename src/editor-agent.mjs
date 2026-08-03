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

function nonEmptyText(...values) {
  const value = values.find((item) => typeof item === 'string' && item.trim())
  return value?.trim() || ''
}

function reportOutputField(output, key) {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'im').exec(String(output || ''))
  return match?.[1]?.trim() || ''
}

export function normalizeAgentSeverity(value, fallback = 'S3') {
  const normalized = String(value || '').trim().toUpperCase()
  if (/^S[1-4]$/.test(normalized)) return normalized
  if (normalized === 'BLOCKING' || normalized === 'ERROR' || normalized === 'CRITICAL') return 'S2'
  if (normalized === 'ADVISORY' || normalized === 'WARNING' || normalized === 'WARN') return 'S4'
  return fallback
}

export function normalizeAgentChecks(value) {
  if (!Array.isArray(value)) return []
  return value.map((check) => {
    if (typeof check === 'string') return { severity: '', issue: check.trim() }
    if (!check || typeof check !== 'object') return null
    const issue = nonEmptyText(check.issue, check.message, check.text)
    if (!issue) return null
    return {
      severity: check.severity ? normalizeAgentSeverity(check.severity) : '',
      issue,
    }
  }).filter(Boolean)
}

export function normalizeAgentFindings(value) {
  if (!Array.isArray(value)) return []
  return value.map((finding) => {
    if (typeof finding === 'string') {
      return { severity: 'S3', category: 'general', location: '', evidence: '', issue: finding.trim(), fix: '' }
    }
    if (!finding || typeof finding !== 'object') return null
    const issue = nonEmptyText(finding.issue, finding.title, finding.message)
    if (!issue) return null
    return {
      severity: normalizeAgentSeverity(finding.severity),
      category: nonEmptyText(finding.category) || 'general',
      location: nonEmptyText(finding.location),
      evidence: nonEmptyText(finding.evidence),
      issue,
      fix: nonEmptyText(finding.fix, finding.recommendation),
    }
  }).filter(Boolean)
}

export function normalizeReviewReport(response, defaults = {}) {
  const outer = response?.result && typeof response.result === 'object'
    ? response
    : { status: response?.status || 'completed', selected_skill: response?.selected_skill, result: response || {} }
  const result = outer.result || {}
  const output = nonEmptyText(result.output)
  const findings = normalizeAgentFindings(result.findings)
  const checks = normalizeAgentChecks(result.checks)
  const severityCounts = { S1: 0, S2: 0, S3: 0, S4: 0 }
  for (const finding of findings) severityCounts[finding.severity] += 1
  if (!findings.length && result.severity_counts && typeof result.severity_counts === 'object') {
    for (const severity of Object.keys(severityCounts)) {
      const count = Number(result.severity_counts[severity])
      if (Number.isFinite(count) && count >= 0) severityCounts[severity] = Math.floor(count)
    }
  }
  const rawScore = Number(result.score)
  const score = Number.isFinite(rawScore) ? Math.min(100, Math.max(0, rawScore)) : null
  const reportedVerdict = nonEmptyText(result.verdict, reportOutputField(output, 'VERDICT')).toUpperCase()
  const verdict = ['APPROVE', 'CONCERNS', 'REJECT'].includes(reportedVerdict)
    ? reportedVerdict
    : findings.some((finding) => finding.severity === 'S1')
      ? 'REJECT'
      : findings.length
        ? 'CONCERNS'
        : 'APPROVE'
  const summary = nonEmptyText(
    result.summary,
    result.message,
    verdict === 'APPROVE' ? '本轮审查未发现阻塞发布的问题。' : `本轮审查发现 ${findings.length} 项需要关注的问题。`,
  )

  return {
    status: outer.status || result.status || 'completed',
    skill: nonEmptyText(result.selected_skill, outer.selected_skill, defaults.skill) || 'story-review',
    skillVersion: nonEmptyText(result.skill_version, result.skillVersion),
    verdict,
    score,
    summary,
    findings,
    checks,
    severityCounts,
    requestedMode: nonEmptyText(
      result.requested_mode,
      result.requestedMode,
      result['Requested Mode'],
      reportOutputField(output, 'Requested Mode'),
      defaults.requestedMode,
    ) || 'full',
    effectiveMode: nonEmptyText(
      result.effective_mode,
      result.effectiveMode,
      result['Effective Mode'],
      reportOutputField(output, 'Effective Mode'),
    ) || 'solo',
    fallback: nonEmptyText(result.fallback, result.Fallback, reportOutputField(output, 'Fallback')) || 'none',
    rubric: nonEmptyText(result.rubric, result.Rubric, reportOutputField(output, 'Rubric'), defaults.rubric) || 'generic web-fiction',
    rubricSource: nonEmptyText(
      result.rubric_source,
      result.rubricSource,
      result['Rubric Source'],
      reportOutputField(output, 'Rubric Source'),
    ) || 'embedded fallback',
    output,
    referencesLoaded: Array.isArray(result.references_loaded) ? result.references_loaded.filter((item) => typeof item === 'string') : [],
    referencesTruncated: result.references_truncated === true,
  }
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

function repairUnescapedJsonQuotes(value) {
  const source = String(value || '')
  let repaired = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (!inString) {
      repaired += character
      if (character === '"') inString = true
      continue
    }
    if (escaped) {
      repaired += character
      escaped = false
      continue
    }
    if (character === '\\') {
      repaired += character
      escaped = true
      continue
    }
    if (character !== '"') {
      repaired += character
      continue
    }
    let nextIndex = index + 1
    while (nextIndex < source.length && /\s/.test(source[nextIndex])) nextIndex += 1
    const next = source[nextIndex] || ''
    if (!next || [':', ',', '}', ']'].includes(next)) {
      repaired += character
      inString = false
    } else {
      repaired += '\\"'
    }
  }
  return repaired
}

export function parseAgentChoiceResponse(value) {
  const source = String(value || '')
  const match = /<choice_request>\s*([\s\S]*?)\s*<\/choice_request>/i.exec(source)
  if (!match) return null
  let raw
  try {
    raw = JSON.parse(match[1])
  } catch {
    try {
      raw = JSON.parse(repairUnescapedJsonQuotes(match[1]))
    } catch {
      return null
    }
  }
  const prompt = normalizeStructuredAgentQuestion(raw)
  if (!prompt) return null
  const questions = prompt.questions.map((question) => ({
    id: question.id,
    header: question.header || '需要确认',
    question: question.question,
    isOther: question.isOther !== false,
    options: question.options.filter((option) => !option.isOther).map((option) => ({
      key: option.key,
      label: option.label,
      value: option.reply || option.label,
      description: option.description || '',
    })),
  }))
  const request = {
    protocol: 'request_user_input',
    requestId: cleanAgentChoiceText(raw?.requestId || raw?.request_id) || null,
    question: questions[0].question,
    options: questions[0].options,
    questions,
  }
  return {
    prompt,
    request,
    reasoning: cleanAgentChoiceText(source.slice(0, match.index)),
  }
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
    if (!delimiterCells?.length || !delimiterCells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue
    const headerCells = markdownTableCells(lines[delimiterIndex - 1])
    if (!headerCells || headerCells.length < 2 || headerCells.length > 7) continue

    const tableRows = []
    let tableEndIndex = delimiterIndex
    for (let index = delimiterIndex + 1; index < lines.length; index += 1) {
      const cells = markdownTableCells(lines[index])
      if (!cells || cells.length < headerCells.length) break
      tableRows.push(cells)
      tableEndIndex = index
    }

    let precedingQuestionIndex = -1
    for (let index = delimiterIndex - 2; index >= Math.max(0, delimiterIndex - 10); index -= 1) {
      const copy = cleanAgentChoiceText(lines[index])
      if (/[？?]/.test(copy) || /请选择|更想要|哪一种|哪种|还是|选一个/.test(copy)) {
        precedingQuestionIndex = index
        break
      }
    }
    let followingQuestionIndex = -1
    for (let index = tableEndIndex + 1; index <= Math.min(lines.length - 1, tableEndIndex + 6); index += 1) {
      const copy = cleanAgentChoiceText(lines[index])
      if (/[？?]/.test(copy) || /请选择|你选哪个|选一个/.test(copy)) {
        followingQuestionIndex = index
        break
      }
    }
    const nearbyCopy = cleanAgentChoiceText(lines.slice(Math.max(0, delimiterIndex - 10), delimiterIndex - 1).join('\n'))
    const hasChoiceCue = precedingQuestionIndex >= 0
      || followingQuestionIndex >= 0
      || /选择|选一个|选项|方向|哪种|还是|更想|确认|下一步/.test(nearbyCopy)
    if (!hasChoiceCue) continue

    const rowChoiceHeader = /^(?:选项|选择|方案|方向|option)$/i.test(headerCells[0])
    const rowChoices = rowChoiceHeader
      ? tableRows.map((cells) => {
        const match = /^([A-H])(?:[.、:：])?\s*(.*?)$/i.exec(cells[0])
        return match
          ? { key: match[1].toUpperCase(), inlineLabel: cleanAgentChoiceText(match[2]), cells }
          : null
      }).filter(Boolean)
      : []
    if (
      rowChoices.length >= 2
      && rowChoices.length <= 6
      && rowChoices.length === tableRows.length
      && new Set(rowChoices.map((choice) => choice.key)).size === rowChoices.length
    ) {
      const preferredLabelIndex = headerCells.findIndex((header, index) => (
        index > 0 && /做什么|内容|方案|方向|操作|下一步/.test(header)
      ))
      const labelIndex = preferredLabelIndex > 0 ? preferredLabelIndex : 1
      const options = rowChoices.map(({ key, inlineLabel, cells }) => {
        const label = inlineLabel || cells[labelIndex]
        const description = cells.map((cell, cellIndex) => (
          cellIndex > 0 && (inlineLabel || cellIndex !== labelIndex) && cell
            ? `${headerCells[cellIndex] ? `${headerCells[cellIndex]}：` : ''}${cell}`
            : ''
        )).filter(Boolean).join(' · ')
        return { key, label, description, reply: `${key}：${label}` }
      }).filter((option) => option.label)
      if (options.length < 2) continue
      const questionIndex = followingQuestionIndex >= 0 ? followingQuestionIndex : precedingQuestionIndex
      const introEndIndex = precedingQuestionIndex >= 0 ? precedingQuestionIndex : delimiterIndex - 1
      return {
        intro: cleanAgentChoiceText(lines.slice(0, introEndIndex).join('\n')),
        question: firstChoiceQuestion(questionIndex >= 0 ? lines[questionIndex] : '') || '请选择一个方向继续',
        hint: followingQuestionIndex >= 0
          ? cleanAgentChoiceText(lines.slice(followingQuestionIndex + 1).join('\n'))
          : cleanAgentChoiceText(lines.slice(tableEndIndex + 1).join('\n')),
        options,
      }
    }

    // Column-oriented choice tables must reserve the first column for row
    // labels (for example `| | 方案 A | 方案 B |`). Without that explicit
    // shape, ordinary status tables such as `环节 | 状态 | 说明` were being
    // mistaken for three selectable answers whenever nearby copy mentioned a
    // choice.
    const hasRowLabelColumn = headerCells[0] === ''
    if (!hasRowLabelColumn) continue
    const optionLabels = (hasRowLabelColumn ? headerCells.slice(1) : headerCells).filter(Boolean)
    if (optionLabels.length < 2 || optionLabels.length > 6) continue

    const options = optionLabels.map((label, optionIndex) => {
      const details = tableRows.slice(0, 4).map((cells) => {
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
    const questionIndex = followingQuestionIndex >= 0 ? followingQuestionIndex : precedingQuestionIndex
    const questionStart = questionIndex >= 0 ? questionIndex : delimiterIndex - 2
    return {
      intro: cleanAgentChoiceText(lines.slice(0, precedingQuestionIndex >= 0 ? precedingQuestionIndex : delimiterIndex - 1).join('\n')),
      question: firstChoiceQuestion(lines[questionStart]) || '请选择一个方向继续',
      hint: followingQuestionIndex >= 0
        ? cleanAgentChoiceText(lines.slice(followingQuestionIndex + 1).join('\n'))
        : cleanAgentChoiceText(lines.slice(tableEndIndex + 1).join('\n')),
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

export function agentItemText(item) {
  if (!Array.isArray(item?.content)) return ''
  return item.content
    .filter((part) => ['inputText', 'outputText'].includes(part?.type) && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim()
}

export function agentReasoningText(item) {
  if (!Array.isArray(item?.summary)) return ''
  return item.summary
    .filter((part) => part?.type === 'summary_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim()
}

export function buildAgentTurnView(run) {
  const items = Array.isArray(run?.items) ? run.items.filter(Boolean) : []
  const result = run?.response?.result && typeof run.response.result === 'object'
    ? run.response.result
    : {}
  const proposal = result.edit_proposal && typeof result.edit_proposal === 'object'
    ? result.edit_proposal
    : null
  const activityItems = items.filter((item) => [
    'lifecycle',
    'dynamicToolCall',
    'collabAgentToolCall',
  ].includes(item.type))
  const reasoningItems = items.filter((item) => item.type === 'reasoning' && agentReasoningText(item))
  const inputItems = items.filter((item) => item.type === 'requestUserInput')
  const activeInputItem = [...inputItems].reverse().find((item) => item.status === 'inProgress') || null
  const completedInputItems = inputItems.filter((item) => item.status !== 'inProgress')
  const answerItem = [...items].reverse().find((item) => ['agentMessage', 'plan'].includes(item.type)) || null
  const itemAnswerText = agentItemText(answerItem)
  const legacyChoice = parseAgentChoiceResponse(run?.text)
  const resultChoice = normalizeStructuredAgentQuestion(result.question)
  const itemChoice = activeInputItem
    ? normalizeStructuredAgentQuestion({ questions: activeInputItem.questions })
    : null
  const choicePrompt = itemChoice
    || resultChoice
    || legacyChoice?.prompt
    || (result.status === 'needs_input' ? parseAgentChoicePrompt(run?.text) : null)
  const effectiveStatus = activeInputItem || result.status === 'needs_input' || choicePrompt
    ? 'needs_input'
    : run?.status || 'completed'
  const resultOutput = nonEmptyText(proposal?.revised_text, result.output)
  const isStreaming = ['queued', 'running'].includes(run?.status)
  const answerText = isStreaming
    ? nonEmptyText(run?.text, itemAnswerText)
    : nonEmptyText(itemAnswerText, run?.text, resultOutput, agentResponseText(run?.response))
  const suggestedChoice = !choicePrompt && run?.status === 'completed'
    ? parseAgentChoicePrompt(answerText)
    : null
  const suggestedChoicePrompt = suggestedChoice
    ? { ...suggestedChoice, intro: '' }
    : null
  const legacyActivityItems = items.length
    ? []
    : compactAgentEvents(run?.events).map((event) => ({
      id: event.id,
      type: event.type === 'skill'
        ? 'dynamicToolCall'
        : event.type === 'subagent'
          ? 'collabAgentToolCall'
          : 'lifecycle',
      status: event.status === 'running' ? 'inProgress' : event.status,
      summary: event.label,
      meta: event.meta || {},
      createdAt: event.startedAt || null,
      completedAt: event.completedAt || null,
      legacy: true,
    }))

  return {
    items,
    usesItemProtocol: items.length > 0,
    activityItems: activityItems.length ? activityItems : legacyActivityItems,
    reasoningItems,
    completedInputItems,
    activeInputItem,
    answerItem,
    answerText,
    outputText: resultOutput,
    originalText: nonEmptyText(run?.source?.selectedText, run?.source?.sourceText, result.original),
    choicePrompt,
    suggestedChoicePrompt,
    effectiveStatus,
    isPlan: answerItem?.type === 'plan' || run?.mode === 'plan' || run?.source?.mode === 'plan',
    proposal,
    checks: normalizeAgentChecks(result.checks),
    findings: normalizeAgentFindings(result.findings),
    references: Array.isArray(result.references_loaded)
      ? result.references_loaded.filter((reference) => typeof reference === 'string' && reference.trim())
      : [],
  }
}

export function applyAgentItemStreamEvent(items, event, payload) {
  const current = Array.isArray(items) ? items.filter(Boolean) : []
  if (['item/started', 'item/completed'].includes(event) && payload?.item?.id) {
    const streamedItem = payload.item
    const normalizedItem = ['agentMessage', 'plan'].includes(streamedItem.type) && !Array.isArray(streamedItem.content)
      ? {
        ...streamedItem,
        content: [{ type: 'outputText', text: typeof streamedItem.text === 'string' ? streamedItem.text : '' }],
      }
      : streamedItem
    const existingIndex = current.findIndex((item) => item.id === normalizedItem.id)
    if (existingIndex < 0) return [...current, normalizedItem]
    return current.map((item, index) => index === existingIndex ? { ...item, ...normalizedItem } : item)
  }
  if (['item/agentMessage/delta', 'item/plan/delta'].includes(event) && payload?.itemId && typeof payload.delta === 'string') {
    const type = event === 'item/plan/delta' ? 'plan' : 'agentMessage'
    const existingIndex = current.findIndex((item) => item.id === payload.itemId)
    const existing = existingIndex >= 0 ? current[existingIndex] : null
    const nextItem = {
      ...(existing || { id: payload.itemId, type, status: 'inProgress' }),
      content: [{
        type: 'outputText',
        text: `${agentItemText(existing)}${payload.delta}`,
      }],
    }
    if (existingIndex < 0) return [...current, nextItem]
    return current.map((item, index) => index === existingIndex ? nextItem : item)
  }
  if (event === 'item/reasoning/summaryTextDelta' && payload?.itemId && typeof payload.delta === 'string') {
    const existingIndex = current.findIndex((item) => item.id === payload.itemId)
    const existing = existingIndex >= 0 ? current[existingIndex] : null
    const nextItem = {
      ...(existing || {
        id: payload.itemId,
        type: 'reasoning',
        status: 'inProgress',
        meta: { modelReasoning: true },
      }),
      summary: [{
        type: 'summary_text',
        text: `${agentReasoningText(existing)}${payload.delta}`,
      }],
    }
    if (existingIndex < 0) return [...current, nextItem]
    return current.map((item, index) => index === existingIndex ? nextItem : item)
  }
  return current
}

export function reconcileAgentTurnItems(currentItems, nextItems) {
  const next = Array.isArray(nextItems) ? nextItems.filter(Boolean) : []
  if (!next.length) return Array.isArray(currentItems) ? currentItems.filter(Boolean) : []
  const current = Array.isArray(currentItems) ? currentItems.filter(Boolean) : []
  const currentById = new Map(current.map((item) => [item.id, item]))
  const reconciled = next.map((item) => {
    const existing = currentById.get(item.id)
    if (!existing) return item
    if (item.type === 'reasoning' && agentReasoningText(existing).length > agentReasoningText(item).length) {
      return { ...item, summary: existing.summary }
    }
    if (['agentMessage', 'plan'].includes(item.type) && agentItemText(existing).length > agentItemText(item).length) {
      return { ...item, content: existing.content }
    }
    return item
  })
  const nextIds = new Set(next.map((item) => item.id))
  const transient = current
    .filter((item) => ['agentMessage', 'plan'].includes(item?.type)
      && item.status === 'inProgress'
      && !nextIds.has(item.id))
  return [...reconciled, ...transient]
}

export function resolveEditorAgentCommand(rawMessage, project) {
  const message = String(rawMessage || '').trim()
  if (!message.startsWith('/')) return { message, skill: 'story' }
  const body = message.slice(1)
  const separator = body.search(/[\s:]/)
  const command = (separator === -1 ? body : body.slice(0, separator)).toLowerCase()
  const argument = separator === -1 ? '' : body.slice(separator + 1).trim()
  const rest = argument ? argument.split(/\s+/) : []
  const length = project?.type === '短篇' ? 'short' : 'long'
  const commands = {
    review: { skill: 'story-review', message: argument || '审查当前章节，重点检查人物动机、节奏和章末钩子。' },
    polish: { skill: 'story-deslop', message: argument || '润色当前章节，降低模板腔和 AI 味，不改变剧情事实。' },
    write: { skill: `story-${length}-write`, message: argument || '结合当前章节与作品设定续写，保持人物和叙事风格一致。' },
    continue: { skill: `story-${length}-write`, message: argument ? `从当前章节结尾继续写：${argument}` : '从当前章节结尾继续写一章，保持人物状态、剧情连续性和叙事风格一致。' },
    rewrite: { skill: `story-${length}-write`, message: argument ? `重写当前章节：${argument}` : '重写当前章节，保留关键剧情事实，改善节奏、冲突和可读性。' },
    outline: { skill: `story-${length}-write`, message: argument ? `整理或补全当前作品大纲：${argument}` : '根据作品工作区整理并补全后续大纲；先读取已有大纲和设定，Build 模式下写回对应作品文件。' },
    expand: { skill: `story-${length}-write`, message: argument ? `扩写当前选区或章节：${argument}` : '扩写当前选区；没有选区时扩写当前章节，补足场景、动作、感官与人物反应，不注水。' },
    shorten: { skill: `story-${length}-write`, message: argument ? `精简当前选区或章节：${argument}` : '精简当前选区；没有选区时精简当前章节，删除重复说明和拖沓段落，保留必要信息与情绪。' },
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

export function agentTaskDurationMs(task) {
  const executionEvents = (Array.isArray(task?.events) ? task.events : [])
    .filter((event) => ['context', 'skill'].includes(event?.type) && event.startedAt)
  const activeDuration = executionEvents.reduce((total, event) => {
    const startedAt = new Date(event.startedAt).getTime()
    const completedAt = new Date(event.completedAt || task.updatedAt || event.startedAt).getTime()
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return total
    return total + Math.max(0, completedAt - startedAt)
  }, 0)
  if (activeDuration > 0 || executionEvents.length) return activeDuration
  if (!task?.createdAt || !task?.updatedAt) return 0
  return Math.max(0, new Date(task.updatedAt).getTime() - new Date(task.createdAt).getTime())
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
      artifactPreview: task.artifactPreview || null,
      artifactApplication: task.artifactApplication || null,
      durationMs: agentTaskDurationMs(task),
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
