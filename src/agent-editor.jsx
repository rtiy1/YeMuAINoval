import { useEffect, useState } from 'react'
import {
  Bot,
  BrainCircuit,
  Check,
  CheckSquare2,
  ChevronRight,
  CircleHelp,
  Code2,
  Copy,
  FileText,
  List,
  LoaderCircle,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  UsersRound,
  X,
} from 'lucide-react'
import { buildEditHunks, composeAcceptedText } from './edit-proposal.mjs'
import {
  agentEventDuration,
  agentItemText,
  agentReasoningText,
  buildAgentTurnView,
  formatAgentDuration,
} from './editor-agent.mjs'
import {
  AgentChoicePrompt,
  AgentDiffReview,
} from './agent-interactions.jsx'
import AgentMarkdown from './agent-markdown.jsx'

const turnStatusLabels = {
  completed: '已完成',
  needs_input: '等待输入',
  needs_model: '需要配置模型',
  needs_adapter: '能力待接入',
  waiting_input: '等待输入',
  failed: '运行失败',
  cancelled: '已停止',
  interrupted: '已中断',
  queued: '排队中',
  running: '运行中',
}

function itemStatus(item) {
  if (item.status === 'inProgress') return 'running'
  return item.status || 'completed'
}

function itemDuration(item) {
  return agentEventDuration({
    startedAt: item.createdAt,
    completedAt: item.completedAt,
  })
}

function itemResponse(item) {
  if (!item?.response || typeof item.response !== 'object') return ''
  return Object.values(item.response)
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => typeof value === 'string' && value.trim())
    .join('；')
}

function ToolItem({ item }) {
  const status = itemStatus(item)
  const failed = ['failed', 'interrupted', 'cancelled'].includes(status)
  const Icon = item.type === 'collabAgentToolCall' ? UsersRound : item.type === 'dynamicToolCall' ? Code2 : Check
  const label = typeof item.summary === 'string' && item.summary.trim()
    ? item.summary
    : item.type === 'dynamicToolCall'
      ? `调用 ${item.tool || 'Story Skill'}`
      : item.type === 'collabAgentToolCall'
        ? `协作任务${item.receiver ? ` · ${item.receiver}` : ''}`
        : 'Agent 正在处理'
  const meta = item.type === 'dynamicToolCall'
    ? item.tool
    : item.type === 'collabAgentToolCall'
      ? item.receiver
      : itemDuration(item)

  return <div className={`agent-transcript-tool ${status}`} data-item-type={item.type}>
    {status === 'running'
      ? <LoaderCircle size={13} className="spin" />
      : failed
        ? <X size={13} />
        : <Icon size={13} />}
    <div>
      <span>{label}</span>
      {item.meta?.error && <small>{item.meta.error}</small>}
      {item.type === 'collabAgentToolCall' && item.meta?.reportSummary && <AgentMarkdown value={item.meta.reportSummary} />}
    </div>
    {meta && <code>{meta}</code>}
  </div>
}

function ReasoningItem({ item }) {
  const text = agentReasoningText(item)
  if (!text) return null
  return <details className="agent-transcript-reasoning" open={item.status === 'inProgress'}>
    <summary>
      {item.status === 'inProgress'
        ? <LoaderCircle size={13} className="spin" />
        : <BrainCircuit size={13} />}
      <span>思考</span>
      {itemDuration(item) && <small>{itemDuration(item)}</small>}
      <ChevronRight size={12} className="agent-trace-chevron" />
    </summary>
    <AgentMarkdown value={text} streaming={item.status === 'inProgress'} />
  </details>
}

function CompletedInputItem({ item }) {
  const questions = (Array.isArray(item.questions) ? item.questions : [])
    .map((question) => question?.question)
    .filter(Boolean)
    .join('；')
  return <div className="agent-transcript-input" data-item-type={item.type}>
    <CheckSquare2 size={13} />
    <div><span>{questions || '补充信息'}</span><small>{itemResponse(item) || '已回答'}</small></div>
  </div>
}

function OutputItem({ item, assistantName, streaming = false }) {
  const text = agentItemText(item)
  if (!text) return null
  const plan = item.type === 'plan'
  return <section className={`agent-transcript-output ${streaming ? 'streaming' : ''}`} data-item-type={item.type}>
    <header>{plan ? <List size={14} /> : <Bot size={14} />}<strong>{plan ? '计划' : assistantName}</strong></header>
    <AgentMarkdown value={text} streaming={streaming} />
  </section>
}

function PlanSteps({ plan }) {
  if (!plan.length) return null
  const completed = plan.filter((step) => step.status === 'completed').length
  return <details className="agent-transcript-plan" open={plan.some((step) => step.status === 'inProgress')}>
    <summary><List size={13} /><span>执行计划</span><small>{completed}/{plan.length}</small><ChevronRight size={12} className="agent-trace-chevron" /></summary>
    <ol>{plan.map((step, index) => <li className={step.status} key={`${step.step}-${index}`}>
      {step.status === 'completed'
        ? <Check size={11} />
        : step.status === 'inProgress'
          ? <LoaderCircle size={11} className="spin" />
          : <span />}
      <span>{step.step}</span>
    </li>)}</ol>
  </details>
}

function TranscriptItem({ item, assistantName, choicePrompt, choiceDisabled, onChoose }) {
  if (item.type === 'userMessage') return null
  if (['lifecycle', 'dynamicToolCall', 'collabAgentToolCall'].includes(item.type)) return <ToolItem item={item} />
  if (item.type === 'reasoning') return <ReasoningItem item={item} />
  if (item.type === 'requestUserInput') {
    if (item.status === 'inProgress' && choicePrompt) {
      return <section className="agent-transcript-question" data-item-type={item.type}>
        <AgentChoicePrompt prompt={choicePrompt} disabled={choiceDisabled} onChoose={onChoose} />
      </section>
    }
    return <CompletedInputItem item={item} />
  }
  if (['agentMessage', 'plan'].includes(item.type)) {
    return <OutputItem item={item} assistantName={assistantName} streaming={item.status === 'inProgress'} />
  }
  return <ToolItem item={{ ...item, summary: item.summary || item.type }} />
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const succeeded = document.execCommand('copy')
    textarea.remove()
    return succeeded
  }
}

export function AgentEditorTurn({
  run,
  elapsedMs = 0,
  assistantName,
  onApply,
  onApplyArtifacts,
  onChoose,
  onRegenerate,
  choiceDisabled = false,
  regenerateDisabled = false,
}) {
  const view = buildAgentTurnView(run)
  const plan = Array.isArray(run.plan) ? run.plan : []
  const protocolItems = view.usesItemProtocol
    ? view.items
    : [
      ...view.activityItems,
      ...view.reasoningItems,
      ...view.completedInputItems,
      ...(view.activeInputItem ? [view.activeInputItem] : []),
    ]
  const hasOutputItem = protocolItems.some((item) => ['agentMessage', 'plan'].includes(item.type) && agentItemText(item))
  const showSyntheticOutput = !hasOutputItem && !view.choicePrompt && Boolean(view.answerText)
  const syntheticOutput = {
    id: `${run.id}:stream-output`,
    type: view.isPlan ? 'plan' : 'agentMessage',
    status: run.status === 'running' ? 'inProgress' : 'completed',
    content: [{ type: 'outputText', text: view.answerText }],
  }
  const showDiff = run.editRequested && view.outputText && view.originalText
  const [hunks, setHunks] = useState(() => (
    showDiff ? buildEditHunks(view.originalText, view.outputText, view.proposal?.blocks || []) : []
  ))
  const [copied, setCopied] = useState(false)
  const [applyingArtifacts, setApplyingArtifacts] = useState(false)

  useEffect(() => {
    setHunks(showDiff ? buildEditHunks(view.originalText, view.outputText, view.proposal?.blocks || []) : [])
  }, [view.originalText, view.outputText, view.proposal, showDiff])

  const changedHunks = hunks.filter((hunk) => hunk.type !== 'equal')
  const acceptedText = changedHunks.length ? composeAcceptedText(hunks) : view.outputText
  const elapsed = ['queued', 'running'].includes(run.status) ? elapsedMs : run.durationMs

  async function copyAnswer() {
    const value = view.outputText || view.answerText
    if (!value || !await copyText(value)) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return <article className={`agent-turn agent-editor-turn ${run.status}`} data-agent-protocol={view.usesItemProtocol ? 'items' : 'legacy'}>
    <div className="agent-transcript-status">
      {['queued', 'running'].includes(run.status)
        ? <LoaderCircle size={12} className="spin" />
        : view.effectiveStatus === 'needs_input'
          ? <CircleHelp size={12} />
          : <Check size={12} />}
      <span>{turnStatusLabels[view.effectiveStatus] || '运行中'}</span>
      <small>{formatAgentDuration(elapsed)}</small>
    </div>

    <PlanSteps plan={plan} />

    <div className="agent-transcript">
      {protocolItems.map((item) => <TranscriptItem
        key={item.id}
        item={item}
        assistantName={assistantName}
        choicePrompt={view.choicePrompt}
        choiceDisabled={choiceDisabled}
        onChoose={onChoose}
      />)}
      {showSyntheticOutput && <OutputItem
        item={syntheticOutput}
        assistantName={assistantName}
        streaming={run.status === 'running'}
      />}
    </div>

    {run.status !== 'running' && !view.choicePrompt && Boolean(view.outputText || view.answerText) && <div className="agent-answer-actions">
      <button type="button" onClick={copyAnswer} title="复制回复" aria-label="复制回复">
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span>{copied ? '已复制' : '复制回复'}</span>
      </button>
      {onRegenerate && <button
        type="button"
        disabled={regenerateDisabled}
        onClick={() => onRegenerate(run)}
        title="使用相同输入重新生成本次回复"
        aria-label="重新生成"
      >
        <RotateCcw size={13} />
        <span>重新生成</span>
      </button>}
    </div>}

    {run.artifactPreview && !run.artifactApplication && <section className="agent-mutation-preview">
      <header><ShieldAlert size={15} /><div><strong>资料变更需要确认</strong><small>确认后才会写入作品</small></div></header>
      <div className="agent-mutation-counts">
        {run.artifactPreview.projectUpdated && <span>作品设定</span>}
        {run.artifactPreview.characters > 0 && <span>{run.artifactPreview.characters} 张人物卡</span>}
        {run.artifactPreview.worldbuilding > 0 && <span>{run.artifactPreview.worldbuilding} 条世界观</span>}
        {run.artifactPreview.chapters > 0 && <span>{run.artifactPreview.chapters} 章大纲</span>}
        {run.artifactPreview.documents > 0 && <span>{run.artifactPreview.documents} 份 Skill 资料</span>}
      </div>
      <button type="button" disabled={applyingArtifacts} onClick={async () => {
        setApplyingArtifacts(true)
        try {
          await onApplyArtifacts(run)
        } finally {
          setApplyingArtifacts(false)
        }
      }}>
        {applyingArtifacts ? <LoaderCircle size={13} className="spin" /> : <ShieldCheck size={13} />}
        {applyingArtifacts ? '写入中' : '确认写入'}
      </button>
    </section>}

    {run.artifactApplication?.applied && <div className="agent-mutation-applied">
      <ShieldCheck size={13} />
      <span>{run.artifactApplication.summary || '资料变更已确认'}</span>
    </div>}

    {view.checks.length > 0 && <div className="agent-runtime-checks">
      <CheckSquare2 size={13} />
      <span>已完成 {view.checks.length} 项确定性检查</span>
    </div>}

    {view.findings.length > 0 && <div className="agent-finding-list">{view.findings.slice(0, 6).map((finding, index) => <div key={`${finding.issue}-${index}`}>
      <span>{finding.severity || `${index + 1}`}</span>
      <p><strong>{finding.issue}</strong>{finding.fix && <small>{finding.fix}</small>}</p>
    </div>)}</div>}

    {showDiff && changedHunks.length > 0 && <AgentDiffReview
      run={run}
      title={run.source?.selectedText ? '当前选区' : run.source?.chapterTitle}
      hunks={hunks}
      acceptedText={acceptedText}
      onChange={setHunks}
      onApply={onApply}
    />}
  </article>
}
