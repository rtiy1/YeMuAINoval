import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BrainCircuit,
  Check,
  CheckSquare2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Code2,
  FileText,
  LoaderCircle,
  List,
  PenLine,
  SearchCode,
  UsersRound,
  X,
} from 'lucide-react'
import {
  agentEventDuration,
  formatAgentDuration,
} from './editor-agent.mjs'
import AgentMarkdown from './agent-markdown.jsx'

function AgentEventIcon({ event }) {
  if (event.status === 'running') return <LoaderCircle size={13} className="spin" />
  if (['failed', 'cancelled', 'interrupted'].includes(event.status)) return <X size={13} />
  if (event.type === 'subagent') return <UsersRound size={13} />
  if (event.type === 'context') return <SearchCode size={13} />
  if (event.type === 'skill') return <Code2 size={13} />
  if (event.type === 'result') return <FileText size={13} />
  return <Check size={13} />
}

function choiceOptions(question) {
  const modelOptions = (Array.isArray(question?.options) ? question.options : []).map((option) => ({
    ...option,
    isOther: /^(其他|自定义|other)$/i.test(String(option.label || '').trim()),
  }))
  const allowOther = question?.isOther !== false || modelOptions.some((option) => option.isOther)
  if (modelOptions.some((option) => option.isOther) || !allowOther) return modelOptions
  return [...modelOptions, {
    key: 'OTHER',
    label: '其他',
    description: '自定义输入你的想法',
    reply: '',
    isOther: true,
  }]
}

export function AgentChoicePrompt({ prompt, disabled, onChoose, desktop = false }) {
  const promptKey = JSON.stringify(prompt)
  const questions = useMemo(() => (
    Array.isArray(prompt.questions) && prompt.questions.length
      ? prompt.questions
      : [{ id: 'question_1', header: '', question: prompt.question, options: prompt.options, isOther: true }]
  ), [prompt])
  const [questionIndex, setQuestionIndex] = useState(0)
  const [answers, setAnswers] = useState({})
  const [selections, setSelections] = useState({})
  const [customAnswers, setCustomAnswers] = useState({})
  const [selected, setSelected] = useState('')
  const [customValue, setCustomValue] = useState('')
  const optionRefs = useRef([])
  const customInputRef = useRef(null)
  const currentQuestion = questions[Math.min(questionIndex, questions.length - 1)]
  const options = choiceOptions(currentQuestion)
  const selectedOption = options.find((option) => option.key === selected)

  useEffect(() => {
    setQuestionIndex(0)
    setAnswers({})
    setSelections({})
    setCustomAnswers({})
    setSelected('')
    setCustomValue('')
  }, [promptKey])

  useEffect(() => {
    optionRefs.current = optionRefs.current.slice(0, options.length)
    if (disabled || !desktop) return undefined
    const frame = window.requestAnimationFrame(() => {
      const selectedIndex = options.findIndex((option) => option.key === selected)
      optionRefs.current[Math.max(0, selectedIndex)]?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [disabled, questionIndex])

  function completeAnswer(value, selection = selected) {
    const questionId = currentQuestion.id
    const nextAnswers = { ...answers, [questionId]: value }
    const nextSelections = { ...selections, [questionId]: selection }
    const nextCustomAnswers = selectedOption?.isOther
      ? { ...customAnswers, [questionId]: customValue.trim() }
      : customAnswers
    if (questionIndex < questions.length - 1) {
      const nextQuestion = questions[questionIndex + 1]
      setAnswers(nextAnswers)
      setSelections(nextSelections)
      setCustomAnswers(nextCustomAnswers)
      setQuestionIndex((current) => current + 1)
      setSelected(nextSelections[nextQuestion.id] || '')
      setCustomValue(nextCustomAnswers[nextQuestion.id] || '')
      return
    }
    const reply = questions
      .map((question) => `${question.header || question.question}：${nextAnswers[question.id] || ''}`)
      .join('\n')
    onChoose({ answers: nextAnswers, text: reply })
  }

  function choose(option, { focusCustom = false } = {}) {
    if (disabled) return
    setSelected(option.key)
    if (option.isOther) {
      setCustomValue(customAnswers[currentQuestion.id] || '')
      if (focusCustom) window.requestAnimationFrame(() => customInputRef.current?.focus())
    }
  }

  function submitSelected() {
    if (disabled || !selectedOption || selectedOption.isOther) return
    completeAnswer(selectedOption.reply)
  }

  function submitCustom(event) {
    event?.preventDefault()
    const value = customValue.trim()
    if (disabled || !selectedOption?.isOther || !value) return
    completeAnswer(`其他：${value}`)
  }

  function goBack() {
    if (disabled || questionIndex <= 0) return
    const previousIndex = questionIndex - 1
    const previousQuestion = questions[previousIndex]
    setQuestionIndex(previousIndex)
    setSelected(selections[previousQuestion.id] || '')
    setCustomValue(customAnswers[previousQuestion.id] || '')
  }

  function moveSelection(direction) {
    if (!options.length) return
    const focusedIndex = optionRefs.current.indexOf(document.activeElement)
    const selectedIndex = options.findIndex((option) => option.key === selected)
    const origin = focusedIndex >= 0 ? focusedIndex : selectedIndex >= 0 ? selectedIndex : 0
    const nextIndex = direction === 'first'
      ? 0
      : direction === 'last'
        ? options.length - 1
        : (origin + direction + options.length) % options.length
    choose(options[nextIndex])
    optionRefs.current[nextIndex]?.focus()
  }

  function handleKeyDown(event) {
    if (disabled || event.isComposing) return
    const editable = ['INPUT', 'TEXTAREA'].includes(event.target.tagName)
    if (editable) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setSelected('')
        setCustomValue('')
        optionRefs.current[0]?.focus()
      }
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      moveSelection(1)
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      moveSelection(-1)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      moveSelection(event.key === 'Home' ? 'first' : 'last')
      return
    }
    if (event.key === 'Enter' && selectedOption) {
      event.preventDefault()
      if (selectedOption.isOther) customInputRef.current?.focus()
      else submitSelected()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setSelected('')
      return
    }
    if (event.key === 'Backspace' && questionIndex > 0 && !selected) {
      event.preventDefault()
      goBack()
      return
    }
    const numericIndex = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1
    const keyIndex = options.findIndex((option) => String(option.key || '').toLowerCase() === event.key.toLowerCase())
    const shortcutIndex = numericIndex >= 0 ? numericIndex : keyIndex
    if (shortcutIndex >= 0 && shortcutIndex < options.length) {
      event.preventDefault()
      choose(options[shortcutIndex], { focusCustom: options[shortcutIndex].isOther })
      optionRefs.current[shortcutIndex]?.focus()
    }
  }

  return <div className="agent-choice-response">
    {prompt.intro && <p className="agent-choice-intro">{prompt.intro}</p>}
    <section
      className={`agent-choice-card ${desktop ? 'desktop-enhanced' : ''}`}
      aria-label="Agent 正在等待你的选择"
      aria-describedby={`agent-choice-question-${currentQuestion.id}`}
      onKeyDown={desktop ? handleKeyDown : undefined}
    >
      <header>
        <span>{currentQuestion.header || '需要你确认'}</span>
        <small>{questions.length > 1 ? `${questionIndex + 1} / ${questions.length}` : '选择一项继续'}</small>
      </header>
      <p id={`agent-choice-question-${currentQuestion.id}`}>{currentQuestion.question}</p>
      <div className="agent-choice-options" role="radiogroup" aria-label={currentQuestion.question}>
        {options.map((option, index) => <button
          type="button"
          role="radio"
          aria-checked={selected === option.key}
          ref={(element) => { optionRefs.current[index] = element }}
          key={option.key}
          className={selected === option.key ? 'selected' : ''}
          disabled={disabled}
          tabIndex={selected === option.key || (!selected && index === 0) ? 0 : -1}
          onClick={() => choose(option, { focusCustom: desktop && option.isOther })}
          onDoubleClick={desktop ? () => !option.isOther && completeAnswer(option.reply, option.key) : undefined}
        >
          {desktop ? <kbd>{index + 1}</kbd> : <strong>{option.key}</strong>}
          <span className="agent-choice-copy">
            <span>{option.label}</span>
            {option.description && <small>{option.description}</small>}
          </span>
          {selected === option.key ? <Check size={13} /> : <ChevronRight size={13} />}
        </button>)}
      </div>
      {selectedOption?.isOther && <form className="agent-choice-custom" onSubmit={submitCustom}>
        <input
          ref={customInputRef}
          autoFocus={!desktop}
          value={customValue}
          maxLength={1000}
          onChange={(event) => setCustomValue(event.target.value)}
          placeholder="输入你的自定义答案…"
          aria-label="自定义答案"
        />
        <button type="submit" disabled={!customValue.trim()}>继续</button>
      </form>}
      {selectedOption && !selectedOption.isOther && <button type="button" className="agent-choice-confirm" disabled={disabled} onClick={submitSelected}>
        {desktop ? <>确认并继续 <kbd>Enter</kbd></> : '继续'}
      </button>}
      {desktop && <footer className="agent-choice-footer">
        {questionIndex > 0
          ? <button type="button" onClick={goBack}><ChevronLeft size={11} />上一问</button>
          : <span />}
        <span><kbd>1–{Math.min(9, options.length)}</kbd> 快选 · <kbd>↑↓</kbd> 切换 · <kbd>Enter</kbd> 确认</span>
      </footer>}
      {prompt.hint && <small className="agent-choice-hint">{prompt.hint}</small>}
    </section>
  </div>
}

export function AgentRunTimeline({
  run,
  elapsedMs,
  effectiveStatus,
  statusLabel,
  hasInputRequest,
  plan,
  events,
  subagentEvents,
  interactionTrace,
  inputHistory,
  reasoningHistory,
  effectiveReasoningSummary,
  checks,
  desktop = false,
}) {
  const shouldOpen = ['queued', 'running'].includes(run.status) || (desktop && hasInputRequest)
  const [open, setOpen] = useState(shouldOpen)
  const completedSteps = plan.filter((item) => item.status === 'completed').length
  const progress = plan.length ? Math.round((completedSteps / plan.length) * 100) : Math.max(0, Math.min(100, Number(run.progress) || 0))
  const visibleEvents = events.length
    ? events
    : [{ id: `${run.id}:local`, type: 'lifecycle', label: run.statusMessage || '正在创建任务', status: 'running' }]

  useEffect(() => {
    if (shouldOpen) setOpen(true)
  }, [shouldOpen])

  return <>
    {desktop && hasInputRequest && <div className="agent-attention-banner" role="status" aria-live="assertive">
      <CircleHelp size={15} />
      <div><strong>Agent 已暂停，正在等待你的选择</strong><small>完成下面的选项后会从当前步骤继续，不会重新开始。</small></div>
      <span>等待输入</span>
    </div>}
    <details className={`agent-reasoning status-${effectiveStatus} ${desktop ? 'desktop-enhanced' : ''}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {run.status === 'running' ? <LoaderCircle size={14} className="spin" /> : <BrainCircuit size={14} />}
        <strong>执行过程</strong>
        <span>{run.status === 'running' ? formatAgentDuration(elapsedMs) : formatAgentDuration(run.durationMs)} · {statusLabel}</span>
        <ChevronRight size={13} className="agent-trace-chevron" />
      </summary>
      <div className="agent-reasoning-body">
        {desktop && (plan.length > 0 || run.status === 'running') && <div className="agent-run-progress" aria-label={`执行进度 ${progress}%`}>
          <span style={{ width: `${progress}%` }} />
        </div>}
        {plan.length > 0 && <div className="agent-plan" aria-label="执行计划">
          <div className="agent-plan-heading"><List size={13} /><strong>执行计划</strong><span>{completedSteps}/{plan.length}</span></div>
          <ol>{plan.map((item, index) => <li className={item.status} aria-current={item.status === 'inProgress' ? 'step' : undefined} key={`${item.step}-${index}`}>
            {item.status === 'completed' ? <Check size={11} /> : item.status === 'inProgress' ? <LoaderCircle size={11} className="spin" /> : <span className="agent-plan-dot" />}
            <span>{item.step}</span>
          </li>)}</ol>
        </div>}
        <div className="agent-tool-stack">
          {visibleEvents.map((event) => <div className={`agent-tool-row ${event.status === 'completed' ? 'done' : event.status}`} key={event.id}>
            <AgentEventIcon event={event} />
            <span>{event.label}</span>
            {event.count > 1 ? <small>{event.count} 轮</small> : agentEventDuration(event) && <small>{agentEventDuration(event)}</small>}
          </div>)}
        </div>
        {subagentEvents.filter((event) => event.meta?.reportSummary).map((event) => <div className="agent-reasoning-summary" key={`${event.id}:report`}>
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
              <strong>模型推理摘要 {reasoningHistory.length > 1 || effectiveReasoningSummary ? `${ordinal}/${reasoningHistory.length + (effectiveReasoningSummary ? 1 : 0)}` : ''}</strong>
              <AgentMarkdown value={entry.summary} />
            </div>
          </div>)}
        {effectiveReasoningSummary && <div className="agent-reasoning-summary">
          <BrainCircuit size={12} />
          <div>
            <strong>模型推理摘要 {reasoningHistory.length ? `${reasoningHistory.length + 1}/${reasoningHistory.length + 1}` : ''}</strong>
            <AgentMarkdown value={effectiveReasoningSummary} streaming={run.status === 'running'} />
          </div>
        </div>}
        {checks.length > 0 && <div className="agent-tool-row done"><CheckSquare2 size={13} /><span>完成 {checks.length} 项确定性检查</span></div>}
        {run.response?.route && <code>{run.response.route}</code>}
      </div>
    </details>
  </>
}

export function AgentDiffReview({ run, title, hunks, acceptedText, onChange, onApply, desktop = false }) {
  const changedHunks = hunks.filter((hunk) => hunk.type !== 'equal')
  const [activeIndex, setActiveIndex] = useState(0)
  const hunkRefs = useRef([])
  const acceptedCount = changedHunks.filter((hunk) => hunk.accepted).length
  const addedCharacters = changedHunks.reduce((sum, hunk) => sum + hunk.replacement.length, 0)
  const removedCharacters = changedHunks.reduce((sum, hunk) => sum + hunk.original.length, 0)
  const activeHunk = changedHunks[Math.min(activeIndex, Math.max(0, changedHunks.length - 1))]

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, changedHunks.length - 1)))
  }, [changedHunks.length])

  function updateHunk(id, accepted) {
    onChange((current) => current.map((hunk) => hunk.id === id ? { ...hunk, accepted } : hunk))
  }

  function updateAll(accepted) {
    onChange((current) => current.map((hunk) => hunk.type === 'equal' ? hunk : { ...hunk, accepted }))
  }

  function focusHunk(index) {
    const nextIndex = Math.max(0, Math.min(index, changedHunks.length - 1))
    setActiveIndex(nextIndex)
    hunkRefs.current[nextIndex]?.focus()
    hunkRefs.current[nextIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  function handleKeyDown(event) {
    if (event.isComposing || ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      if (!run.applied && acceptedCount) onApply(run, acceptedText)
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey || !activeHunk) return
    const key = event.key.toLowerCase()
    if (key === 'a') {
      event.preventDefault()
      updateHunk(activeHunk.id, true)
      return
    }
    if (key === 'r') {
      event.preventDefault()
      updateHunk(activeHunk.id, false)
      return
    }
    if (event.key === 'ArrowDown' || key === 'j') {
      event.preventDefault()
      focusHunk(activeIndex + 1)
      return
    }
    if (event.key === 'ArrowUp' || key === 'k') {
      event.preventDefault()
      focusHunk(activeIndex - 1)
    }
  }

  return <details className="agent-write-stage" open>
    <summary className="agent-trace-row">
      <PenLine size={14} />
      <strong>{desktop ? '审阅并写入' : '写入章节'}</strong>
      <span>{title}</span>
      <ChevronRight size={13} className="agent-trace-chevron" />
    </summary>
    <section className={`agent-diff ${desktop ? 'desktop-enhanced' : ''}`} tabIndex={desktop ? 0 : undefined} onKeyDown={desktop ? handleKeyDown : undefined} aria-label="Agent 修改审阅">
      <header>
        <div><FileText size={14} /><strong>{title}</strong></div>
        <span className="diff-add">+{desktop ? addedCharacters : changedHunks.reduce((sum, hunk) => sum + (hunk.accepted ? hunk.replacement.length : 0), 0)}</span>
        <span className="diff-remove">-{desktop ? removedCharacters : changedHunks.reduce((sum, hunk) => sum + (hunk.accepted ? hunk.original.length : 0), 0)}</span>
        {desktop && <div className="agent-diff-batch">
          <button type="button" onClick={() => updateAll(true)} title="接受全部修改"><Check size={11} />全部</button>
          <button type="button" onClick={() => updateAll(false)} title="拒绝全部修改"><X size={11} />全部</button>
        </div>}
      </header>
      {desktop && <nav className="agent-diff-nav" aria-label="切换修改">
        <button type="button" disabled={activeIndex <= 0} onClick={() => focusHunk(activeIndex - 1)}><ChevronLeft size={12} />上一项</button>
        <span>修改 {Math.min(activeIndex + 1, changedHunks.length)} / {changedHunks.length}</span>
        <button type="button" disabled={activeIndex >= changedHunks.length - 1} onClick={() => focusHunk(activeIndex + 1)}>下一项<ChevronRight size={12} /></button>
      </nav>}
      <div className="agent-diff-list">{changedHunks.map((hunk, index) => <article
        ref={(element) => { hunkRefs.current[index] = element }}
        tabIndex={desktop ? (index === activeIndex ? 0 : -1) : undefined}
        aria-current={desktop && index === activeIndex ? 'true' : undefined}
        className={`agent-diff-hunk ${hunk.accepted ? '' : 'rejected'} ${desktop && index === activeIndex ? 'active' : ''}`}
        key={hunk.id}
        onFocus={() => setActiveIndex(index)}
        onClick={() => setActiveIndex(index)}
      >
        <div className="agent-diff-hunk-heading">
          <span>修改 {index + 1}</span>
          <small>{hunk.reason}</small>
          <div>
            <button type="button" className={hunk.accepted ? 'active' : ''} title="接受修改（A）" aria-label={`接受修改 ${index + 1}`} onClick={() => updateHunk(hunk.id, true)}><Check size={12} /></button>
            <button type="button" className={!hunk.accepted ? 'active reject' : ''} title="拒绝修改（R）" aria-label={`拒绝修改 ${index + 1}`} onClick={() => updateHunk(hunk.id, false)}><X size={12} /></button>
          </div>
        </div>
        {hunk.original && <pre className="diff-line removed"><span>-</span>{hunk.original}</pre>}
        {hunk.replacement && <pre className="diff-line added"><span>+</span>{hunk.replacement}</pre>}
      </article>)}</div>
      {desktop && <div className="agent-diff-shortcuts"><span><kbd>A</kbd> 接受</span><span><kbd>R</kbd> 拒绝</span><span><kbd>J/K</kbd> 切换</span><span><kbd>Ctrl Enter</kbd> 应用</span></div>}
      <footer>
        <span>{acceptedCount} / {changedHunks.length} 项已接受</span>
        <button type="button" disabled={run.applied || !acceptedCount} onClick={() => onApply(run, acceptedText)}>
          {run.applied ? <Check size={13} /> : <PenLine size={13} />}
          {run.applied ? '已应用' : desktop ? `应用 ${acceptedCount} 项` : '应用到正文'}
        </button>
      </footer>
    </section>
  </details>
}
