import crypto from 'node:crypto'
import { invokeStoryAgent, invokeStoryAgentDelegates, classifyTaskError } from './story-agent.mjs'
import { accumulateTaskUsage, archiveTaskReasoning } from './agent-thread.mjs'
import { maybeCompactAgentThread } from './context-compaction.mjs'
import { applyStoryArtifacts, summarizeStoryArtifacts } from './story-artifacts.mjs'
import { updateDb } from './store.mjs'
import { publishTaskStreamEvent } from './task-stream.mjs'
import { createDeltaRunLog, isDeltaRunLogEnabled, resumeAssistantTail } from './delta-run-log.mjs'

const toolCallIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/
const messageToolHistoryLimit = 6
const steeringHistoryLimit = 8
const maximumWritingTaskTimeoutMs = 30 * 24 * 60 * 60 * 1000
const reasoningSegmentMaxChars = 200_000
const outputSegmentMaxChars = 200_000
const toolOutputMaxChars = 12_000

export function writingTaskTimeoutMs(value = process.env.AI_TASK_TIMEOUT_MS) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const configured = Number(value)
  if (!Number.isFinite(configured) || configured <= 0) return null
  return Math.min(maximumWritingTaskTimeoutMs, Math.max(60_000, Math.floor(configured)))
}

function resumeTaskFromCheckpoint(task) {
  const partialOutput = typeof task.partialOutput === 'string' ? task.partialOutput : ''
  const payload = task.input?.payload && typeof task.input.payload === 'object' ? task.input.payload : {}
  const continuation = Array.isArray(payload.continuation_conversation) ? payload.continuation_conversation : []
  const assistantTail = resumeAssistantTail(task)
  const recoveryMessages = [
    ...(assistantTail ? [{ role: 'assistant', text: assistantTail }] : []),
    {
      role: 'user',
      text: '系统恢复：上一次执行因 worker 退出而中断。保留已经写入的作品文件，先检查文件清单，然后从未完成处直接继续；不要重做已完成的文件，也不要道歉或重复之前的过程。',
    },
  ]
  task.input = {
    ...task.input,
    payload: {
      ...payload,
      continuation_conversation: [...continuation, ...recoveryMessages].slice(-12),
      execution_recovery: {
        kind: 'worker_checkpoint',
        partial_output_chars: partialOutput.length,
      },
    },
  }
  task.continuationMode = 'worker_checkpoint'
  return partialOutput
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0
}

function executionMatches(task, executionId, executionGeneration) {
  return task?.activeExecutionId === executionId
    && positiveInteger(task.executionGeneration) === executionGeneration
}

function pendingSteers(task) {
  return (Array.isArray(task?.steeringHistory) ? task.steeringHistory : [])
    .filter((item) => item?.status === 'pending' && typeof item.text === 'string' && item.text.trim())
    .slice(0, steeringHistoryLimit)
}

function applySteersAtBoundary(task, turnId, { assistantText = '', timestamp = new Date().toISOString() } = {}) {
  const pending = pendingSteers(task)
  if (!pending.length) return false
  archiveTaskReasoning(task, { turnId, completedAt: timestamp })
  const payload = task.input?.payload && typeof task.input.payload === 'object' ? task.input.payload : {}
  const steeringMessages = Array.isArray(payload.steering_messages) ? payload.steering_messages : []
  const continuation = Array.isArray(payload.continuation_conversation) ? payload.continuation_conversation : []
  const steerMessages = pending.map((item) => ({ id: item.id, text: item.text, revision: item.revision }))
  const transcript = [
    ...continuation,
    ...(assistantText.trim() ? [{ role: 'assistant', text: assistantText.trim().slice(0, 12_000) }] : []),
    ...pending.map((item) => ({ role: 'user', text: item.text })),
  ].slice(-12)
  task.input = {
    ...task.input,
    payload: {
      ...payload,
      steering_messages: [...steeringMessages, ...steerMessages].slice(-steeringHistoryLimit),
      continuation_conversation: transcript,
    },
  }
  for (const steer of task.steeringHistory || []) {
    if (pending.some((item) => item.id === steer.id)) {
      steer.status = 'applied'
      steer.appliedAt = timestamp
    }
  }
  task.appliedSteerRevision = Math.max(
    positiveInteger(task.appliedSteerRevision),
    ...pending.map((item) => positiveInteger(item.revision)),
  )
  task.interactionAttempt = Math.max(1, positiveInteger(task.interactionAttempt) || 1) + 1
  task.executionGeneration = Math.max(1, positiveInteger(task.executionGeneration) || 1) + 1
  task.activeExecutionId = null
  task.steerRequested = false
  task.result = null
  task.partialOutput = ''
  task.reasoningStartedAt = null
  task.reasoningCompletedAt = null
  task.inputRequestStartedAt = null
  task.modelContinuation = null
  task.continuationMode = 'transcript'
  task.subagents = []
  task.status = 'queued'
  task.progress = 0
  setTaskActivity(task, 'queued', '已应用追加指令，继续当前 Agent 轮次', timestamp)
  return true
}

function boundedRecord(value, limit = 24_000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    return JSON.stringify(value).length <= limit ? value : null
  } catch {
    return null
  }
}

function boundedToolOutput(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  if (value.length <= toolOutputMaxChars) return value
  const headChars = Math.floor(toolOutputMaxChars * 0.3)
  const tailChars = toolOutputMaxChars - headChars
  return `${value.slice(0, headChars)}\n…（工具输出省略 ${value.length - toolOutputMaxChars} 字符）…\n${value.slice(-tailChars)}`
}

function messageToolExchange(value, { output = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const callId = typeof value.call_id === 'string' ? value.call_id.trim() : ''
  const toolName = typeof value.tool_name === 'string' ? value.tool_name.trim() : ''
  const argumentsValue = boundedRecord(value.arguments)
  const assistantContent = typeof value.assistant_content === 'string'
    ? value.assistant_content.trim().slice(0, 8_000)
    : ''
  if (!toolCallIdPattern.test(callId) || toolName !== 'request_user_input' || !argumentsValue) return null
  const exchange = { callId, toolName, arguments: argumentsValue, assistantContent }
  if (output) {
    const outputValue = boundedRecord(value.output, 24_000)
    if (!outputValue || !boundedRecord(outputValue.answers, 20_000)) return null
    exchange.output = outputValue
  }
  return exchange
}

function responseContinuation(result) {
  const value = result?.result?.response_continuation
  const requestId = typeof result?.result?.question?.requestId === 'string'
    ? result.result.question.requestId.trim()
    : ''
  if (!value || !requestId) return null
  if (value.protocol === 'openai_responses') {
    const responseId = typeof value.response_id === 'string' ? value.response_id.trim() : ''
    const callId = typeof value.call_id === 'string' ? value.call_id.trim() : ''
    if (!/^resp_[A-Za-z0-9_-]{1,195}$/.test(responseId)
      || !toolCallIdPattern.test(callId)
      || callId !== requestId) return null
    return { protocol: 'openai_responses', responseId, callId }
  }
  if (value.protocol !== 'message_tools') return null
  const pending = messageToolExchange(value)
  const rawHistory = value.history === undefined ? [] : value.history
  if (!pending || pending.callId !== requestId || !Array.isArray(rawHistory) || rawHistory.length > messageToolHistoryLimit) return null
  const history = rawHistory.map((item) => messageToolExchange(item, { output: true }))
  if (history.some((item) => !item)) return null
  const callIds = [...history.map((item) => item.callId), pending.callId]
  if (new Set(callIds).size !== callIds.length) return null
  return {
    protocol: 'message_tools',
    ...pending,
    history,
    baseChoiceFollowup: value.base_choice_followup === true,
  }
}

function continuationMode(result, continuation) {
  if (continuation) return continuation.protocol
  const value = result?.result?.continuation_mode
  return ['openai_responses', 'message_tools', 'transcript', 'transcript_fallback'].includes(value) ? value : null
}

function appendEvent(task, type, label, status = 'completed', meta = {}) {
  const timestamp = new Date().toISOString()
  task.events ||= []
  const event = {
    id: `${task.id}:${task.events.length + 1}`,
    type,
    label,
    status,
    meta,
    startedAt: timestamp,
    ...(status === 'running' ? {} : { completedAt: timestamp }),
  }
  task.events.push(event)
  return event
}

function finishRunningEvent(task, status = 'completed', updates = {}) {
  const event = [...(task.events || [])].reverse().find((item) => item.status === 'running'
    && !['tool', 'reasoning'].includes(item.type))
  if (!event) return null
  event.status = status
  event.completedAt = new Date().toISOString()
  Object.assign(event, updates)
  return event
}

function setTaskActivity(task, phase, statusMessage, timestamp = new Date().toISOString()) {
  if (task.activityPhase !== phase) task.activityPhaseStartedAt = timestamp
  task.activityPhase = phase
  task.lastActivityAt = timestamp
  if (statusMessage) task.statusMessage = statusMessage
}

const storyToolLabels = {
  read_story_skill: '读取 Story Skill',
  list_story_files: '查看作品文件',
  read_story_file: '读取作品文件',
  web_fetch: '读取网页',
  write_story_file: '写入作品文件',
  edit_story_file: '修改作品文件',
  request_user_input: '请求补充信息',
  submit_story_result: '提交创作结果',
}

function storyToolLabel(event) {
  const path = String(event?.arguments?.path || event?.details?.path || event?.arguments?.url || event?.details?.finalUrl || '').trim()
  const base = storyToolLabels[event?.toolName] || `调用 ${event?.toolName || '工具'}`
  return path ? `${base} · ${path}` : base
}

async function recordStoryToolEvent(taskId, executionId, executionGeneration, event) {
  if (!event?.toolCallId || !event?.toolName) return
  let streamEvent = null
  await updateDb((db) => {
    const task = db.writingTasks.find((item) => item.id === taskId)
    if (!task || task.status !== 'running' || !executionMatches(task, executionId, executionGeneration)) return
    task.events ||= []
    const id = `${task.turnId}:tool:${event.toolCallId}`
    const existing = task.events.find((item) => item.id === id)
    const timestamp = new Date().toISOString()
    const argumentsValue = event.arguments && typeof event.arguments === 'object' ? event.arguments : {}
    const details = event.details && typeof event.details === 'object' ? event.details : {}
    const output = boundedToolOutput(event.output)
    const inputQuestions = event.toolName === 'request_user_input'
      && event.phase === 'end'
      && Array.isArray(argumentsValue.questions)
      && argumentsValue.questions.length
      ? argumentsValue.questions.slice(0, 3)
      : null
    const meta = {
      ...(existing?.meta || {}),
      toolName: event.toolName,
      interactionAttempt: Math.max(1, positiveInteger(task.interactionAttempt) || 1),
      arguments: Object.keys(argumentsValue).length ? argumentsValue : existing?.meta?.arguments || {},
      ...(Object.keys(details).length ? { details } : {}),
      ...(output ? { output } : {}),
      ...(event.isError ? { error: '工具执行失败' } : {}),
    }
    const status = event.phase === 'end' ? (event.isError ? 'failed' : 'completed') : 'running'
    const next = {
      ...(existing || {}),
      id,
      type: 'tool',
      label: storyToolLabel({ ...event, arguments: meta.arguments }),
      status,
      meta,
      startedAt: existing?.startedAt || timestamp,
      ...(status === 'running' ? {} : { completedAt: timestamp }),
    }
    if (existing) Object.assign(existing, next)
    else task.events.push(next)
    if (event.phase === 'start') {
      setTaskActivity(task, 'tool', `正在${next.label}`, timestamp)
    } else if (event.toolName !== 'request_user_input') {
      setTaskActivity(task, 'model_waiting', event.isError ? '工具执行失败，等待模型处理' : '工具执行完成，等待模型继续处理', timestamp)
    }
    if (inputQuestions) {
      task.pendingInputRequest = {
        requestId: event.toolCallId,
        questions: structuredClone(inputQuestions),
        requestedAt: timestamp,
        interactionAttempt: Math.max(1, positiveInteger(task.interactionAttempt) || 1),
      }
    }
    task.updatedAt = timestamp
    touchAgentThread(db, task)
    streamEvent = {
      type: 'tool_event',
      phase: event.phase,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      label: next.label,
      status,
      arguments: meta.arguments,
      details: meta.details || {},
      output: meta.output || '',
      isError: event.isError === true,
      interactionAttempt: task.interactionAttempt || 1,
      executionGeneration,
    }
  })
  if (streamEvent) publishTaskStreamEvent(taskId, streamEvent)
}

function touchAgentThread(db, task) {
  if (!task?.threadId) return
  const thread = db.agentThreads?.find((item) => item.id === task.threadId)
  if (thread) thread.updatedAt = task.updatedAt
}

export async function executeWritingTask(taskId, {
  userId = null,
  controller = new AbortController(),
  executionId = crypto.randomUUID(),
  requeueOnAbort = false,
  resumeRunning = false,
} = {}) {
  let claimedGeneration = null
  try {
    const prepared = await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId && (!userId || item.userId === userId))
      const user = task ? db.users.find((item) => item.id === task.userId) : null
      if (!task || !user || task.cancelRequested || (task.status !== 'queued' && !(resumeRunning && task.status === 'running'))) return null
      task.executionGeneration = Math.max(1, positiveInteger(task.executionGeneration) || 1)
      const recoverCheckpoint = task.resumeFromCheckpoint === true || (resumeRunning && task.status === 'running')
      let checkpointOutput = ''
      if (recoverCheckpoint) {
        archiveTaskReasoning(task, { turnId: task.turnId || task.id, completedAt: new Date().toISOString() })
        checkpointOutput = resumeTaskFromCheckpoint(task)
        finishRunningEvent(task, 'interrupted')
      }
      if (resumeRunning && task.status === 'running') {
        task.executionGeneration += 1
      }
      delete task.resumeFromCheckpoint
      const executionGeneration = task.executionGeneration
      task.activeExecutionId = executionId
      task.steerRequested = false
      task.status = 'running'
      task.pendingInputRequest = null
      task.progress = 15
      task.partialOutput = checkpointOutput
      task.reasoningStartedAt = new Date().toISOString()
      task.reasoningCompletedAt = null
      setTaskActivity(task, 'context', '正在构建写作上下文')
      appendEvent(task, 'context', '读取作品、章节与连续性上下文', 'running')
      task.updatedAt = new Date().toISOString()
      return {
        input: task.input,
        user,
        turnId: task.turnId || task.id,
        executionGeneration,
        interactionAttempt: Math.max(1, positiveInteger(task.interactionAttempt) || 1),
        subagents: Array.isArray(task.subagents) ? task.subagents : [],
        checkpointOutput,
      }
    })
    if (!prepared) return { status: 'skipped' }
    claimedGeneration = prepared.executionGeneration
    await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId)
      if (task && task.status === 'running' && executionMatches(task, executionId, prepared.executionGeneration)) {
        finishRunningEvent(task)
        task.progress = 35
        setTaskActivity(task, 'skill', '正在准备 AI Skill')
        appendEvent(task, 'skill', `执行 ${task.skill || 'story'} Skill`, 'running')
        task.updatedAt = new Date().toISOString()
      }
    })
    // CLI agents are bounded by explicit cancellation, not by a fixed wall clock.
    // Operators can still opt into a deployment-specific hard deadline.
    const timeoutMs = writingTaskTimeoutMs()
    const signal = timeoutMs === null
      ? controller.signal
      : AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
    let partialOutput = prepared.checkpointOutput
    let reasoningSegmentOrdinal = 0
    const reasoningSegments = new Map()
    let outputSegmentOrdinal = 0
    const outputSegments = new Map()
    let checkpointTimer = null
    let checkpointDirty = false
    let checkpointQueue = Promise.resolve()
    // Optional bounded per-delta run log (YEMU_DELTA_RUN_LOG=1): packed, capped,
    // written on checkpoints, deleted at finalization. TEXT-ONLY by privacy
    // design — reasoning/CoT is never persisted (see delta-run-log.mjs), and is
    // streamed live only. Aggregate fields remain the canonical durable state;
    // this log is a lossless tail for exact resume.
    const deltaRunLog = isDeltaRunLogEnabled() ? createDeltaRunLog() : null
    // P0 telemetry (YEMU_STREAM_TELEMETRY=1): where the first visible/reasoning
    // token actually lands, without persisting anything.
    const streamTelemetry = {
      outputDeltas: 0,
      reasoningDeltas: 0,
      outputChars: 0,
      reasoningChars: 0,
      firstOutputDeltaAt: null,
      firstReasoningDeltaAt: null,
    }
    const flushCheckpoint = () => {
      if (checkpointTimer) clearTimeout(checkpointTimer)
      checkpointTimer = null
      if (!checkpointDirty) return checkpointQueue
      checkpointDirty = false
      const outputSnapshot = partialOutput
      const outputSegmentSnapshots = [...outputSegments.values()].map((segment) => ({
        ...segment,
        meta: { ...segment.meta },
      }))
      checkpointQueue = checkpointQueue.then(() => updateDb((db) => {
        const task = db.writingTasks.find((item) => item.id === taskId)
        if (!task || task.status !== 'running' || task.cancelRequested
          || !executionMatches(task, executionId, prepared.executionGeneration)) return
        task.partialOutput = outputSnapshot
        if (deltaRunLog) task.deltaRuns = deltaRunLog.snapshot()
        task.events ||= []
        for (const segment of outputSegmentSnapshots) {
          const existing = task.events.find((event) => event.id === segment.id)
          if (existing) Object.assign(existing, segment)
          else task.events.push(segment)
        }
        task.progress = Math.max(45, Math.min(88, 45 + Math.floor(outputSnapshot.length / 120)))
        setTaskActivity(task, 'output', '正在生成回复')
        task.updatedAt = new Date().toISOString()
        touchAgentThread(db, task)
      }))
      return checkpointQueue
    }
    const scheduleCheckpoint = () => {
      checkpointDirty = true
      if (checkpointTimer) return
      checkpointTimer = setTimeout(() => {
        void flushCheckpoint().catch(() => undefined)
      }, 500)
      checkpointTimer.unref?.()
    }
    const ensureReasoningSegment = (messageId) => {
      const key = String(messageId || `assistant-${reasoningSegmentOrdinal + 1}`)
      const existing = reasoningSegments.get(key)
      if (existing) return existing
      reasoningSegmentOrdinal += 1
      const timestamp = new Date().toISOString()
      const segment = {
        id: `${prepared.turnId}:reasoning:${prepared.interactionAttempt}:${reasoningSegmentOrdinal}`,
        type: 'reasoning',
        label: '模型思考',
        status: 'running',
        meta: {
          modelReasoning: true,
          reasoningSegment: true,
          messageId: key,
          interactionAttempt: prepared.interactionAttempt,
          summary: '',
        },
        startedAt: timestamp,
      }
      reasoningSegments.set(key, segment)
      publishTaskStreamEvent(taskId, {
        type: 'reasoning_event',
        phase: 'start',
        itemId: segment.id,
        messageId: key,
        interactionAttempt: prepared.interactionAttempt,
        executionGeneration: prepared.executionGeneration,
      })
      return segment
    }
    const ensureOutputSegment = (messageId) => {
      const key = String(messageId || `assistant-${outputSegmentOrdinal + 1}`)
      const existing = outputSegments.get(key)
      if (existing) return existing
      outputSegmentOrdinal += 1
      const timestamp = new Date().toISOString()
      const segment = {
        id: `${prepared.turnId}:agent:${prepared.interactionAttempt}:${outputSegmentOrdinal}`,
        type: 'output',
        label: '模型回复',
        status: 'running',
        meta: {
          outputSegment: true,
          messageId: key,
          interactionAttempt: prepared.interactionAttempt,
          text: '',
        },
        startedAt: timestamp,
      }
      outputSegments.set(key, segment)
      publishTaskStreamEvent(taskId, {
        type: 'output_event',
        phase: 'start',
        itemId: segment.id,
        messageId: key,
        interactionAttempt: prepared.interactionAttempt,
        executionGeneration: prepared.executionGeneration,
      })
      return segment
    }
    const flushOutputSegment = (delta, context = {}) => {
      markLiveActivity('output', '正在生成回复')
      const segment = ensureOutputSegment(context.messageId)
      const previousLength = segment.meta.text.length
      segment.meta.text = `${segment.meta.text}${delta}`.slice(0, outputSegmentMaxChars)
      const acceptedDelta = segment.meta.text.slice(previousLength)
      partialOutput += acceptedDelta
      if (acceptedDelta) {
        publishTaskStreamEvent(taskId, {
          type: 'output_event',
          phase: 'delta',
          itemId: segment.id,
          messageId: segment.meta.messageId,
          delta: acceptedDelta,
          interactionAttempt: prepared.interactionAttempt,
          executionGeneration: prepared.executionGeneration,
        })
        deltaRunLog?.record('text', segment.meta.messageId, acceptedDelta, Date.now())
        streamTelemetry.outputDeltas += 1
        streamTelemetry.outputChars += acceptedDelta.length
        if (streamTelemetry.firstOutputDeltaAt === null) streamTelemetry.firstOutputDeltaAt = Date.now()
      }
      scheduleCheckpoint()
    }
    const flushReasoningSummary = (delta, context = {}) => {
      markLiveActivity('reasoning', '模型正在处理')
      const segment = ensureReasoningSegment(context.messageId)
      const previousLength = segment.meta.summary.length
      segment.meta.summary = `${segment.meta.summary}${delta}`.slice(0, reasoningSegmentMaxChars)
      const acceptedDelta = segment.meta.summary.slice(previousLength)
      if (acceptedDelta) {
        publishTaskStreamEvent(taskId, {
          type: 'reasoning_event',
          phase: 'delta',
          itemId: segment.id,
          messageId: segment.meta.messageId,
          delta: acceptedDelta,
          interactionAttempt: prepared.interactionAttempt,
          executionGeneration: prepared.executionGeneration,
        })
        // NOTE: reasoning/CoT is deliberately NOT recorded into deltaRuns —
        // it is never persisted (see delta-run-log.mjs): streamed live + counted
        // in memory only.
        streamTelemetry.reasoningDeltas += 1
        streamTelemetry.reasoningChars += acceptedDelta.length
        if (streamTelemetry.firstReasoningDeltaAt === null) streamTelemetry.firstReasoningDeltaAt = Date.now()
      }
      scheduleCheckpoint()
    }
    const completeReasoningSegment = async (event) => {
      const segment = reasoningSegments.get(String(event?.messageId || ''))
      if (!segment || segment.status !== 'running') return
      const timestamp = new Date().toISOString()
      segment.status = event?.stopReason === 'aborted' ? 'interrupted' : event?.stopReason === 'error' ? 'failed' : 'completed'
      segment.completedAt = timestamp
      segment.meta.stopReason = event?.stopReason || 'stop'
      publishTaskStreamEvent(taskId, {
        type: 'reasoning_event',
        phase: 'end',
        itemId: segment.id,
        messageId: segment.meta.messageId,
        status: segment.status,
        summary: segment.meta.summary,
        completedAt: timestamp,
        interactionAttempt: prepared.interactionAttempt,
        executionGeneration: prepared.executionGeneration,
      })
      scheduleCheckpoint()
      await flushCheckpoint()
    }
    const completeOutputSegment = async (event) => {
      const segment = outputSegments.get(String(event?.messageId || ''))
      if (!segment || segment.status !== 'running') return
      const timestamp = new Date().toISOString()
      segment.status = event?.stopReason === 'aborted' ? 'interrupted' : event?.stopReason === 'error' ? 'failed' : 'completed'
      segment.completedAt = timestamp
      segment.meta.stopReason = event?.stopReason || 'stop'
      publishTaskStreamEvent(taskId, {
        type: 'output_event',
        phase: 'end',
        itemId: segment.id,
        messageId: segment.meta.messageId,
        status: segment.status,
        text: segment.meta.text,
        completedAt: timestamp,
        interactionAttempt: prepared.interactionAttempt,
        executionGeneration: prepared.executionGeneration,
      })
      scheduleCheckpoint()
      await flushCheckpoint()
    }
    const completeAssistantMessageSegments = async (event) => {
      await completeReasoningSegment(event)
      await completeOutputSegment(event)
    }
    let delegates = prepared.subagents
    const reusableDelegates = delegates.length > 0
      && delegates.every((item) => ['completed', 'failed', 'needs_model'].includes(item?.status))
    if (prepared.input?.payload?.multi_agent === true && !reusableDelegates) {
      delegates = await invokeStoryAgentDelegates(prepared.user, prepared.input, signal, async (delegate) => {
        await updateDb((db) => {
          const task = db.writingTasks.find((item) => item.id === taskId)
          if (!task || task.status !== 'running' || task.cancelRequested
            || !executionMatches(task, executionId, prepared.executionGeneration)) return
          task.subagents ||= []
          const index = task.subagents.findIndex((item) => item.id === delegate.id)
          const previous = index >= 0 ? task.subagents[index] : null
          const next = {
            ...previous,
            ...delegate,
            startedAt: delegate.startedAt || previous?.startedAt || new Date().toISOString(),
          }
          if (index >= 0) task.subagents[index] = next
          else task.subagents.push(next)
          task.subagents = task.subagents.sort((left, right) => positiveInteger(left.ordinal) - positiveInteger(right.ordinal)).slice(0, 2)
          if (delegate.status !== 'running' && delegate.usage) {
            accumulateTaskUsage(task, {
              run_id: delegate.runId || `${executionId}:delegate:${delegate.id}`,
              status: delegate.status,
              result: { usage: delegate.usage },
            }, delegate.completedAt || new Date().toISOString())
          }
          const delegatesRunning = task.subagents.some((item) => item.status === 'running')
          setTaskActivity(
            task,
            'collaboration',
            delegatesRunning ? '子代理正在并行审阅' : '正在汇总子代理报告',
          )
          task.updatedAt = new Date().toISOString()
          touchAgentThread(db, task)
        })
      })
    }
    const reports = delegates
      .filter((item) => item?.status === 'completed' && typeof item.summary === 'string' && item.summary.trim())
      .sort((left, right) => positiveInteger(left.ordinal) - positiveInteger(right.ordinal))
      .map((item) => ({ role: item.role, status: item.status, summary: item.summary }))
    const executionInput = {
      ...prepared.input,
      payload: {
        ...(prepared.input?.payload || {}),
        ...(reports.length ? { _agent_reports: reports } : {}),
      },
    }
    const modelWaitingAt = new Date().toISOString()
    await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId)
      if (!task || task.status !== 'running' || task.cancelRequested
        || !executionMatches(task, executionId, prepared.executionGeneration)) return
      setTaskActivity(task, 'model_waiting', '已提交给模型，等待首个响应', modelWaitingAt)
      task.updatedAt = modelWaitingAt
      touchAgentThread(db, task)
    })
    publishTaskStreamEvent(taskId, {
      type: 'activity_event',
      phase: 'model_waiting',
      message: '已提交给模型，等待首个响应',
      occurredAt: modelWaitingAt,
      interactionAttempt: prepared.interactionAttempt,
      executionGeneration: prepared.executionGeneration,
    })
    let liveActivityPhase = 'model_waiting'
    const markLiveActivity = (phase, message) => {
      if (liveActivityPhase === phase) return
      liveActivityPhase = phase
      const occurredAt = new Date().toISOString()
      publishTaskStreamEvent(taskId, {
        type: 'activity_event',
        phase,
        message,
        occurredAt,
        interactionAttempt: prepared.interactionAttempt,
        executionGeneration: prepared.executionGeneration,
      })
      void updateDb((db) => {
        const task = db.writingTasks.find((item) => item.id === taskId)
        if (!task || task.status !== 'running' || task.cancelRequested
          || !executionMatches(task, executionId, prepared.executionGeneration)) return
        setTaskActivity(task, phase, message, occurredAt)
        task.updatedAt = occurredAt
        touchAgentThread(db, task)
      }).catch(() => undefined)
    }
    const modelCallStartedAt = Date.now()
    const result = await invokeStoryAgent(prepared.user, executionInput, signal, flushOutputSegment, flushReasoningSummary, async (event) => {
      if (event?.phase === 'start') {
        liveActivityPhase = 'tool'
        for (const segment of reasoningSegments.values()) {
          if (segment.status === 'running') {
            await completeReasoningSegment({ messageId: segment.meta.messageId, stopReason: 'toolUse' })
          }
        }
      } else if (event?.phase === 'end') {
        liveActivityPhase = 'model_waiting'
      }
      await recordStoryToolEvent(
        taskId,
        executionId,
        prepared.executionGeneration,
        event,
      )
    }, completeAssistantMessageSegments)
    await flushCheckpoint()
    const finalizingAt = new Date().toISOString()
    await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId)
      if (!task || task.status !== 'running' || task.cancelRequested
        || !executionMatches(task, executionId, prepared.executionGeneration)) return
      setTaskActivity(task, 'finalizing', '正在整理生成结果', finalizingAt)
      task.updatedAt = finalizingAt
      touchAgentThread(db, task)
    })
    publishTaskStreamEvent(taskId, {
      type: 'activity_event',
      phase: 'finalizing',
      message: '正在整理生成结果',
      occurredAt: finalizingAt,
      interactionAttempt: prepared.interactionAttempt,
      executionGeneration: prepared.executionGeneration,
    })
    if (process.env.YEMU_STREAM_TELEMETRY === '1') {
      const elapsedMs = Date.now() - modelCallStartedAt
      console.log('[ai-task-delta]', JSON.stringify({
        taskId,
        turnId: prepared.turnId,
        interactionAttempt: prepared.interactionAttempt,
        executionGeneration: prepared.executionGeneration,
        elapsedMs,
        ...streamTelemetry,
        firstOutputDeltaAfterMs: streamTelemetry.firstOutputDeltaAt === null
          ? null : streamTelemetry.firstOutputDeltaAt - modelCallStartedAt,
        firstReasoningDeltaAfterMs: streamTelemetry.firstReasoningDeltaAt === null
          ? null : streamTelemetry.firstReasoningDeltaAt - modelCallStartedAt,
      }))
    }
    const privateContinuation = responseContinuation(result)
    const resultContinuationMode = continuationMode(result, privateContinuation)
    if (result?.result && typeof result.result === 'object' && !Array.isArray(result.result)) {
      delete result.result.response_continuation
    }
    let finalOutcome = { status: 'completed' }
    await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId)
      if (!task) {
        finalOutcome = { status: 'skipped' }
        return
      }
      // Turn is terminal (cancelled / superseded / steer/requeued / completed):
      // the lossy-safe aggregates are the durable truth from here on.
      if (deltaRunLog) delete task.deltaRuns
      if (task.status === 'cancelled' || task.cancelRequested) {
        finalOutcome = { status: 'cancelled' }
        return
      }
      if (!executionMatches(task, executionId, prepared.executionGeneration)) {
        finalOutcome = { status: 'superseded' }
        return
      }
      const references = Array.isArray(result?.result?.references_loaded) ? result.result.references_loaded : []
      const checks = Array.isArray(result?.result?.checks) ? result.result.checks : []
      const timestamp = new Date().toISOString()
      if (pendingSteers(task).length) {
        task.reasoningCompletedAt = timestamp
        accumulateTaskUsage(task, result, timestamp)
        finishRunningEvent(task, 'interrupted', {
          label: '旧输出已在追加指令边界结束',
          meta: { interactionAttempt: task.interactionAttempt || 1 },
        })
        applySteersAtBoundary(task, task.turnId, {
          assistantText: partialOutput || result?.result?.output || '',
          timestamp,
        })
        appendEvent(task, 'input', '已应用追加指令，重新规划当前轮次', 'completed', {
          steerRevision: task.appliedSteerRevision,
          interactionAttempt: task.interactionAttempt,
        })
        task.updatedAt = timestamp
        touchAgentThread(db, task)
        finalOutcome = { status: 'requeued', reason: 'steer' }
        return
      }
      finishRunningEvent(task, 'completed', {
        label: `完成 ${result.selected_skill || task.skill || 'story'} Skill`,
        meta: { selectedSkill: result.selected_skill || task.skill || null, route: result.route || '', references: references.length, checks: checks.length },
      })
      const artifacts = result?.result?.artifacts
      const mutationPolicy = task.input?.payload?.tool_policy?.mutateStoryData
      const artifactPreview = result.status === 'completed' ? summarizeStoryArtifacts(artifacts) : null
      const artifactApplication = artifactPreview && mutationPolicy !== 'propose'
        ? applyStoryArtifacts(db, {
          userId: task.userId,
          projectId: task.projectId,
          artifacts,
          timestamp,
        })
        : null
      if (artifactPreview && mutationPolicy === 'propose') {
        task.pendingArtifacts = structuredClone(artifacts)
        task.artifactPreview = artifactPreview
        result.result.artifacts_pending = artifactPreview
        appendEvent(task, 'artifact', artifactPreview.summary, 'completed', { ...artifactPreview, approvalRequired: true })
      }
      if (artifactApplication?.applied) {
        task.artifactApplication = artifactApplication
        result.result.artifacts_applied = artifactApplication
        appendEvent(task, 'artifact', artifactApplication.summary, 'completed', artifactApplication)
      }
      appendEvent(task, 'result', '生成可审阅结果', 'completed', {
        status: result.status,
        ...(resultContinuationMode ? { continuationMode: resultContinuationMode } : {}),
      })
      task.status = result.status === 'needs_input' ? 'waiting_input' : 'completed'
      task.progress = 100
      setTaskActivity(
        task,
        result.status === 'needs_input' ? 'waiting_input' : 'completed',
        result.status === 'needs_input' ? '等待用户回答' : 'AI Skill 执行完成',
        timestamp,
      )
      task.partialOutput = partialOutput || task.partialOutput || ''
      task.reasoningCompletedAt = timestamp
      task.inputRequestStartedAt = result.status === 'needs_input' ? timestamp : null
      task.pendingInputRequest = null
      task.modelContinuation = result.status === 'needs_input' ? privateContinuation : null
      task.continuationMode = resultContinuationMode
      task.activeExecutionId = null
      accumulateTaskUsage(task, result, timestamp)
      task.result = result
      task.updatedAt = timestamp
      touchAgentThread(db, task)
    })
    publishTaskStreamEvent(taskId, { type: 'snapshot' })
    if (finalOutcome.status === 'requeued') return finalOutcome
    if (['superseded', 'cancelled', 'skipped'].includes(finalOutcome.status)) return finalOutcome
    await maybeCompactAgentThread(taskId).catch(() => undefined)
    return finalOutcome
  } catch (error) {
    let outcome = 'failed'
    let reason = null
    await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId)
      if (!task) return
      if (task.status === 'cancelled' && task.cancelRequested) {
        if (deltaRunLog) delete task.deltaRuns
        outcome = 'cancelled'
        return
      }
      if (claimedGeneration == null || !executionMatches(task, executionId, claimedGeneration)) {
        if (deltaRunLog) delete task.deltaRuns
        outcome = 'superseded'
        return
      }
      task.pendingInputRequest = null
      if (pendingSteers(task).length) {
        if (deltaRunLog) delete task.deltaRuns
        finishRunningEvent(task, 'interrupted')
        applySteersAtBoundary(task, task.turnId, {
          assistantText: task.partialOutput || '',
          timestamp: new Date().toISOString(),
        })
        appendEvent(task, 'input', '已应用追加指令，恢复当前轮次', 'queued')
        task.error = null
        task.errorCode = null
        task.retryable = true
        task.updatedAt = new Date().toISOString()
        touchAgentThread(db, task)
        outcome = 'requeued'
        reason = 'steer'
        return
      }
      if (requeueOnAbort && controller.signal.aborted && !task.cancelRequested) {
        finishRunningEvent(task, 'interrupted')
        task.executionGeneration = Math.max(1, positiveInteger(task.executionGeneration) || 1) + 1
        task.activeExecutionId = null
        task.resumeFromCheckpoint = true
        appendEvent(task, 'lifecycle', 'worker 中断，等待恢复执行', 'queued')
        task.status = 'queued'
        task.progress = 0
        setTaskActivity(task, 'queued', 'worker 停机，任务等待重新认领')
        task.error = null
        task.errorCode = null
        task.retryable = true
        task.updatedAt = new Date().toISOString()
        touchAgentThread(db, task)
        outcome = 'requeued'
        reason = 'worker'
        return
      }
      // Terminal failure / user cancel: drop the transient delta log here too.
      // (The requeue-on-worker-abort branch above intentionally keeps it so the
      // next claim can resume at the exact token boundary.)
      if (deltaRunLog) delete task.deltaRuns
      // Only an explicit task cancellation is a user cancel. AbortSignal.timeout()
      // also aborts the combined signal, but must remain a retryable timeout.
      const classified = classifyTaskError(error, task.cancelRequested === true)
      const eventStatus = classified.errorCode === 'cancelled' ? 'cancelled' : 'failed'
      finishRunningEvent(task, eventStatus)
      appendEvent(task, 'lifecycle', classified.message, eventStatus, { errorCode: classified.errorCode })
      task.status = classified.errorCode === 'cancelled' ? 'cancelled' : 'failed'
      setTaskActivity(task, task.status, classified.message)
      task.error = classified.errorCode === 'cancelled' ? null : classified.message
      task.errorCode = classified.errorCode
      task.retryable = classified.retryable
      task.activeExecutionId = null
      for (const delegate of task.subagents || []) {
        if (delegate.status === 'running') {
          delegate.status = eventStatus === 'cancelled' ? 'interrupted' : 'failed'
          delegate.completedAt = new Date().toISOString()
        }
      }
      task.updatedAt = new Date().toISOString()
      touchAgentThread(db, task)
    }).catch(() => undefined)
    publishTaskStreamEvent(taskId, { type: 'snapshot' })
    return { status: outcome, ...(reason ? { reason } : {}) }
  }
}
