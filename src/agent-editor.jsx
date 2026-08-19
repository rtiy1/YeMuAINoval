import { useEffect, useState } from 'react'
import {
  Check,
  CheckSquare2,
  ChevronRight,
  Code2,
  Copy,
  FilePenLine,
  FilePlus2,
  FileSearch,
  FileText,
  FolderSearch,
  Globe2,
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
  normalizeStructuredAgentQuestion,
  segmentAgentTurnItems,
  shouldShowAgentDiff,
} from './editor-agent.mjs'
import {
  AgentChoicePrompt,
  AgentDiffReview,
} from './agent-interactions.jsx'
import AgentMarkdown from './agent-markdown.jsx'
import { tuiToolArgs, tuiToolNames } from './agent-tool-args.mjs'
import { formatThinkingForDisplay } from '../packages/coding-agent/src/utils/thinking-display.ts'
import { Transcript as YemuTranscript } from '../packages/collab-web/src/components/transcript/Transcript.tsx'

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
  const values = []
  const collect = (value) => {
    if (typeof value === 'string' && value.trim()) {
      values.push(value.trim())
      return
    }
    if (Array.isArray(value)) {
      value.forEach(collect)
      return
    }
    if (value && typeof value === 'object') {
      if (Object.hasOwn(value, 'answers')) collect(value.answers)
      else Object.values(value).forEach(collect)
    }
  }
  collect(item.response)
  return [...new Set(values)].join('；')
}

function tuiAssistantMessage(run, items, { includeFallback = false, terminal = false } = {}) {
  const view = buildAgentTurnView(run)
  const content = []
  for (const item of items || []) {
    if (item.type === 'reasoning') {
      // Reasoning is live-only and never surfaced: hide thinking content from the
      // transcript; the bottom "正在思考中…" working indicator covers the phase.
      continue
    }
    if (item.type === 'dynamicToolCall' || item.type === 'collabAgentToolCall') {
      content.push({
        type: 'toolCall',
        id: item.id,
        name: item.type === 'collabAgentToolCall' ? 'task' : tuiToolNames[item.tool] || item.tool || 'tool',
        arguments: item.type === 'collabAgentToolCall'
          ? { agent: item.receiver, prompt: item.summary }
          : tuiToolArgs(item),
      })
      continue
    }
    if (item.type === 'agentMessage' || item.type === 'plan') {
      const rawText = agentItemText(item)
      const text = /^AI Skill 执行完成[.。]?$/.test(rawText) ? '本轮处理已完成。' : rawText
      if (text) content.push({ type: 'text', text })
    }
  }
  if (includeFallback && !content.some((item) => item.type === 'text') && view.answerText) {
    content.push({ type: 'text', text: view.answerText })
  }
  return {
    role: 'assistant',
    content,
    stopReason: terminal && run.status === 'failed' ? 'error' : terminal && run.status === 'cancelled' ? 'aborted' : 'stop',
    errorMessage: terminal && run.status === 'failed' ? run.text || run.statusMessage : undefined,
  }
}

function segmentIsStreaming(items) {
  return items.some((item) => !['dynamicToolCall', 'collabAgentToolCall'].includes(item.type)
    && item.status === 'inProgress')
}

function tuiToolResult(item) {
  const failed = ['failed', 'interrupted', 'cancelled'].includes(itemStatus(item))
  return {
    role: 'toolResult',
    toolCallId: item.id,
    toolName: tuiToolNames[item.tool] || item.tool || 'tool',
    content: [{ type: 'text', text: failed ? item.meta?.error || '工具执行失败' : item.summary || '执行完成' }],
    details: item.meta?.details || {},
    isError: failed,
  }
}

export function YemuAssistantTranscript({
  messages,
  assistantName,
  working = false,
  choiceDisabled = false,
  onChoose,
}) {
  const entries = []
  const activeTools = new Map()
  let stream = null
  for (const message of messages) {
    if (message.role === 'user') {
      entries.push({
        id: message.id,
        type: 'message',
        timestamp: message.createdAt || null,
        message: { role: 'user', content: [{ type: 'text', text: message.text || '' }] },
      })
      continue
    }
    const view = buildAgentTurnView(message)
    const items = view.items || []
    const running = ['queued', 'running'].includes(message.status)
    const segments = segmentAgentTurnItems(items)
    if (!segments.length && view.answerText) segments.push([])
    for (const [index, segment] of segments.entries()) {
      const inputItem = segment.length === 1 && segment[0].type === 'requestUserInput'
        ? segment[0]
        : null
      if (inputItem) {
        entries.push({
          id: `${message.id}:input:${inputItem.id}`,
          type: 'custom_message',
          customType: 'request-user-input',
          content: '',
          display: true,
          timestamp: inputItem.createdAt || inputItem.completedAt || null,
          details: {
            item: inputItem,
            prompt: normalizeStructuredAgentQuestion({ questions: inputItem.questions }),
            run: message,
          },
        })
        continue
      }
      const last = index === segments.length - 1
      const assistantMessage = tuiAssistantMessage(message, segment, {
        includeFallback: last && segment.length === 0,
        terminal: last && !running,
      })
      if (!assistantMessage.content.length) continue
      if (running && last && segmentIsStreaming(segment)) {
        stream = assistantMessage
      } else {
        entries.push({
          id: `${message.id}:assistant:${index + 1}`,
          type: 'message',
          timestamp: segment[0]?.createdAt || message.completedAt || null,
          message: assistantMessage,
        })
      }
    }
    for (const item of items) {
      if (!['dynamicToolCall', 'collabAgentToolCall'].includes(item.type)) continue
      if (itemStatus(item) === 'running') {
        activeTools.set(item.id, {
          toolCallId: item.id,
          toolName: item.type === 'collabAgentToolCall' ? 'task' : tuiToolNames[item.tool] || item.tool || 'tool',
          args: item.type === 'collabAgentToolCall' ? { agent: item.receiver, prompt: item.summary } : tuiToolArgs(item),
        })
      } else {
        entries.push({ id: `${item.id}:result`, type: 'message', timestamp: item.completedAt || null, message: tuiToolResult(item) })
      }
    }
  }
  return <div className="yemu-collab-transcript">
    <YemuTranscript
      entries={entries}
      stream={stream}
      streamDone={!working}
      activeTools={activeTools}
      working={working}
      userLabel="你"
      agentLabel={assistantName || '夜雨'}
      renderCustomMessage={(entry) => {
        if (entry.customType !== 'request-user-input') return null
        const details = entry.details && typeof entry.details === 'object' ? entry.details : {}
        const inputItem = details.item
        if (!inputItem || typeof inputItem !== 'object') return null
        if (inputItem.status !== 'inProgress') return <CompletedInputItem item={inputItem} />
        if (!details.prompt) return null
        return <section className="agent-transcript-question agent-transcript-question-inline" data-item-type={inputItem.type}>
          <AgentChoicePrompt
            prompt={details.prompt}
            disabled={choiceDisabled || !onChoose}
            onChoose={(reply) => onChoose?.(details.run, reply)}
          />
        </section>
      }}
    />
  </div>
}

function ToolItem({ item }) {
  const status = itemStatus(item)
  const failed = ['failed', 'interrupted', 'cancelled'].includes(status)
  const args = item.arguments || item.meta?.arguments || {}
  const details = item.meta?.details || {}
  const path = args.path || details.path || ''
  const toolIcons = {
    list_story_files: FolderSearch,
    read_story_file: FileSearch,
    write_story_file: FilePlus2,
    edit_story_file: FilePenLine,
    read_story_skill: FileText,
    web_fetch: Globe2,
  }
  const Icon = item.type === 'collabAgentToolCall'
    ? UsersRound
    : item.type === 'dynamicToolCall'
      ? toolIcons[item.tool] || Code2
      : Check
  const label = typeof item.summary === 'string' && item.summary.trim()
    ? item.summary
    : item.type === 'dynamicToolCall'
      ? `调用 ${item.tool || 'Story Skill'}`
      : item.type === 'collabAgentToolCall'
        ? `协作任务${item.receiver ? ` · ${item.receiver}` : ''}`
        : 'Agent 正在处理'
  const meta = item.type === 'dynamicToolCall'
    ? path || (details.chars ? `${details.chars} 字符` : item.tool)
    : item.type === 'collabAgentToolCall'
      ? item.receiver
      : itemDuration(item)

  return <div className={`agent-transcript-tool ${status}`} data-item-type={item.type}>
    <span className="tui-trace-branch" aria-hidden="true">{status === 'running' ? '├' : '└'}</span>
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
  const formatted = formatThinkingForDisplay(text, true)
  if (!formatted.trim()) return null
  const streaming = item.status === 'inProgress'
  const maxChars = streaming ? 4_000 : 12_000
  const displayText = formatted.length > maxChars
    ? `…（已折叠较早思考，仅显示最近内容）…\n\n${formatted.slice(-maxChars)}`
    : formatted
  return <details className="agent-transcript-reasoning">
    <summary>
      <span className={`tui-trace-symbol ${streaming ? 'running' : ''}`} aria-hidden="true">
        {streaming ? '✻' : '◇'}
      </span>
      <span>{streaming ? '思考中' : '思考'}</span>
      {itemDuration(item) && <small>{itemDuration(item)}</small>}
      <ChevronRight size={12} className="agent-trace-chevron" />
    </summary>
    <AgentMarkdown value={displayText} streaming={streaming} />
  </details>
}

function CompletedInputItem({ item }) {
  const questions = (Array.isArray(item.questions) ? item.questions : [])
    .map((question) => question?.question)
    .filter(Boolean)
    .join('；')
  return <div className="agent-transcript-input" data-item-type={item.type}>
    <span className="tui-trace-branch" aria-hidden="true">└</span>
    <CheckSquare2 size={13} />
    <div><span>{questions || '补充信息'}</span><small>{itemResponse(item) || '已回答'}</small></div>
  </div>
}

function OutputItem({ item, assistantName, streaming = false }) {
  const text = agentItemText(item)
  if (!text) return null
  const plan = item.type === 'plan'
  return <section className={`agent-transcript-output ${streaming ? 'streaming' : ''}`} data-item-type={item.type}>
    <header><span className={`tui-output-symbol ${streaming ? 'running' : ''}`} aria-hidden="true">{plan ? '▤' : streaming ? '✻' : '◆'}</span><strong>{plan ? '计划' : assistantName}</strong></header>
    <AgentMarkdown value={text} streaming={streaming} />
  </section>
}

function PlanSteps({ plan }) {
  if (!plan.length) return null
  const completed = plan.filter((step) => step.status === 'completed').length
  return <details className="agent-transcript-plan" open={plan.some((step) => step.status === 'inProgress')}>
    <summary><span className="tui-trace-symbol" aria-hidden="true">▤</span><span>执行计划</span><small>{completed}/{plan.length}</small><ChevronRight size={12} className="agent-trace-chevron" /></summary>
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
  onFollowup,
  onRegenerate,
  choiceDisabled = false,
  regenerateDisabled = false,
  controlsOnly = false,
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
  const showDiff = shouldShowAgentDiff(run, view)
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
    {!controlsOnly && <div className="agent-transcript-status">
      <span className={`tui-turn-symbol ${['queued', 'running'].includes(run.status) ? 'running' : view.effectiveStatus}`} aria-hidden="true">
        {['queued', 'running'].includes(run.status) ? '✻' : view.effectiveStatus === 'needs_input' ? '?' : '◆'}
      </span>
      <span>{turnStatusLabels[view.effectiveStatus] || '运行中'}</span>
      <small>{formatAgentDuration(elapsed)}</small>
    </div>}

    <PlanSteps plan={plan} />

    {!controlsOnly && <div className="agent-transcript">
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
      {view.suggestedChoicePrompt && onFollowup && <section className="agent-transcript-question agent-suggested-followup" data-item-type="suggestedFollowup">
        <AgentChoicePrompt
          prompt={view.suggestedChoicePrompt}
          disabled={choiceDisabled}
          onChoose={onFollowup}
          variant="followup"
        />
      </section>}
    </div>}

    {controlsOnly && view.suggestedChoicePrompt && onFollowup && <section className="agent-transcript-question agent-suggested-followup" data-item-type="suggestedFollowup">
      <AgentChoicePrompt prompt={view.suggestedChoicePrompt} disabled={choiceDisabled} onChoose={onFollowup} variant="followup" />
    </section>}

    {controlsOnly && ['failed', 'cancelled', 'interrupted'].includes(run.status) && <div className="agent-error-retry">
      <div>
        <strong>{turnStatusLabels[view.effectiveStatus] || '运行失败'}</strong>
        {run.text || run.statusMessage ? <small>{run.text || run.statusMessage}</small> : null}
      </div>
      {onRegenerate && <button type="button" disabled={regenerateDisabled} onClick={() => onRegenerate(run)}>
        <RotateCcw size={13} />
        <span>重试</span>
      </button>}
    </div>}

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
        {run.artifactPreview.documents > 0 && <span>{run.artifactPreview.documents} 份作品文件</span>}
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
      <span>{run.artifactApplication.summary || '资料变更已确认'}{run.artifactApplication.fileChanges?.length ? ` · ${run.artifactApplication.fileChanges.map((item) => item.path).join('、')}` : ''}</span>
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
