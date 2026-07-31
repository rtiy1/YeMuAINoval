import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  ChevronRight,
  FileText,
  PenLine,
  X,
} from 'lucide-react'

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

export function AgentChoicePrompt({ prompt, disabled, onChoose, variant = 'blocking' }) {
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
  const currentQuestion = questions[Math.min(questionIndex, questions.length - 1)]
  const options = choiceOptions(currentQuestion)
  const selectedOption = options.find((option) => option.key === selected)
  const suggestedFollowup = variant === 'followup'

  useEffect(() => {
    setQuestionIndex(0)
    setAnswers({})
    setSelections({})
    setCustomAnswers({})
    setSelected('')
    setCustomValue('')
  }, [promptKey])

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

  function choose(option) {
    if (disabled) return
    setSelected(option.key)
    if (option.isOther) {
      setCustomValue(customAnswers[currentQuestion.id] || '')
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

  return <div className={`agent-choice-response ${suggestedFollowup ? 'suggested-followup' : ''}`}>
    {prompt.intro && <p className="agent-choice-intro">{prompt.intro}</p>}
    <section
      className="agent-choice-card"
      aria-label={suggestedFollowup ? 'Agent 建议的快捷回复' : 'Agent 正在等待你的选择'}
      aria-describedby={`agent-choice-question-${currentQuestion.id}`}
    >
      <header>
        <span>{currentQuestion.header || (suggestedFollowup ? '快捷回复' : '需要你确认')}</span>
        <small>{questions.length > 1 ? `${questionIndex + 1} / ${questions.length}` : suggestedFollowup ? '发送为新消息' : '选择一项继续'}</small>
      </header>
      <p id={`agent-choice-question-${currentQuestion.id}`}>{currentQuestion.question}</p>
      <div className="agent-choice-options" role="radiogroup" aria-label={currentQuestion.question}>
        {options.map((option, index) => <button
          type="button"
          role="radio"
          aria-checked={selected === option.key}
          key={option.key}
          className={selected === option.key ? 'selected' : ''}
          disabled={disabled}
          tabIndex={selected === option.key || (!selected && index === 0) ? 0 : -1}
          onClick={() => choose(option)}
        >
          <strong>{option.key}</strong>
          <span className="agent-choice-copy">
            <span>{option.label}</span>
            {option.description && <small>{option.description}</small>}
          </span>
          {selected === option.key ? <Check size={13} /> : <ChevronRight size={13} />}
        </button>)}
      </div>
      {selectedOption?.isOther && <form className="agent-choice-custom" onSubmit={submitCustom}>
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
      {selectedOption && !selectedOption.isOther && <button type="button" className="agent-choice-confirm" disabled={disabled} onClick={submitSelected}>
        继续
      </button>}
      {prompt.hint && <small className="agent-choice-hint">{prompt.hint}</small>}
    </section>
  </div>
}

export function AgentDiffReview({ run, title, hunks, acceptedText, onChange, onApply }) {
  const changedHunks = hunks.filter((hunk) => hunk.type !== 'equal')
  const acceptedCount = changedHunks.filter((hunk) => hunk.accepted).length

  function updateHunk(id, accepted) {
    onChange((current) => current.map((hunk) => hunk.id === id ? { ...hunk, accepted } : hunk))
  }

  return <details className="agent-write-stage" open>
    <summary className="agent-trace-row">
      <PenLine size={14} />
      <strong>写入章节</strong>
      <span>{title}</span>
      <ChevronRight size={13} className="agent-trace-chevron" />
    </summary>
    <section className="agent-diff" aria-label="Agent 修改审阅">
      <header>
        <div><FileText size={14} /><strong>{title}</strong></div>
        <span className="diff-add">+{changedHunks.reduce((sum, hunk) => sum + (hunk.accepted ? hunk.replacement.length : 0), 0)}</span>
        <span className="diff-remove">-{changedHunks.reduce((sum, hunk) => sum + (hunk.accepted ? hunk.original.length : 0), 0)}</span>
      </header>
      <div className="agent-diff-list">{changedHunks.map((hunk, index) => <article
        className={`agent-diff-hunk ${hunk.accepted ? '' : 'rejected'}`}
        key={hunk.id}
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
      <footer>
        <span>{acceptedCount} / {changedHunks.length} 项已接受</span>
        <button type="button" disabled={run.applied || !acceptedCount} onClick={() => onApply(run, acceptedText)}>
          {run.applied ? <Check size={13} /> : <PenLine size={13} />}
          {run.applied ? '已应用' : '应用到正文'}
        </button>
      </footer>
    </section>
  </details>
}
