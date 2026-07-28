import crypto from 'node:crypto'
import { invokeStoryAgent, invokeStoryAgentDelegates, classifyTaskError } from './story-agent.mjs'
import { accumulateTaskUsage, archiveTaskReasoning } from './agent-thread.mjs'
import { maybeCompactAgentThread } from './context-compaction.mjs'
import { updateDb } from './store.mjs'

const toolCallIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/
const messageToolHistoryLimit = 6
const steeringHistoryLimit = 8

function positiveInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0
}

function mergeReasoningSummaries(...values) {
  const summaries = []
  for (const value of values) {
    const summary = String(value || '').trim()
    if (summary && !summaries.includes(summary)) summaries.push(summary)
  }
  return summaries.join('\n\n').slice(0, 12_000)
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
  task.reasoningSummary = ''
  task.reasoningStartedAt = null
  task.reasoningCompletedAt = null
  task.inputRequestStartedAt = null
  task.modelContinuation = null
  task.continuationMode = 'transcript'
  task.subagents = []
  task.status = 'queued'
  task.progress = 0
  task.statusMessage = '已应用追加指令，继续当前 Agent 轮次'
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
  const event = [...(task.events || [])].reverse().find((item) => item.status === 'running')
  if (!event) return null
  event.status = status
  event.completedAt = new Date().toISOString()
  Object.assign(event, updates)
  return event
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
      if (resumeRunning && task.status === 'running') {
        finishRunningEvent(task, 'interrupted')
        task.executionGeneration += 1
      }
      const executionGeneration = task.executionGeneration
      task.activeExecutionId = executionId
      task.steerRequested = false
      task.status = 'running'
      task.progress = 15
      task.partialOutput = ''
      task.reasoningSummary = ''
      task.reasoningStartedAt = new Date().toISOString()
      task.reasoningCompletedAt = null
      task.statusMessage = '正在构建写作上下文'
      appendEvent(task, 'context', '读取作品、章节与连续性上下文', 'running')
      task.updatedAt = new Date().toISOString()
      return {
        input: task.input,
        user,
        executionGeneration,
        subagents: Array.isArray(task.subagents) ? task.subagents : [],
      }
    })
    if (!prepared) return { status: 'skipped' }
    claimedGeneration = prepared.executionGeneration
    await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId)
      if (task && task.status === 'running' && executionMatches(task, executionId, prepared.executionGeneration)) {
        finishRunningEvent(task)
        task.progress = 35
        task.statusMessage = '正在执行 AI Skill'
        appendEvent(task, 'skill', `执行 ${task.skill || 'story'} Skill`, 'running')
        task.updatedAt = new Date().toISOString()
      }
    })
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    let partialOutput = ''
    let reasoningSummary = ''
    let lastPartialFlush = 0
    let lastPartialLength = 0
    let lastReasoningFlush = 0
    let lastReasoningLength = 0
    const flushReasoningSummary = async (delta) => {
      reasoningSummary += delta
      const now = Date.now()
      if (now - lastReasoningFlush < 60 && reasoningSummary.length - lastReasoningLength < 96) return
      lastReasoningFlush = now
      lastReasoningLength = reasoningSummary.length
      const snapshot = reasoningSummary.slice(0, 12_000)
      await updateDb((db) => {
        const task = db.writingTasks.find((item) => item.id === taskId)
        if (!task || task.status !== 'running' || task.cancelRequested
          || !executionMatches(task, executionId, prepared.executionGeneration)) return
        task.reasoningSummary = snapshot
        task.updatedAt = new Date().toISOString()
        touchAgentThread(db, task)
      })
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
          task.statusMessage = task.subagents.some((item) => item.status === 'running')
            ? '子代理正在并行审阅'
            : '正在汇总子代理报告'
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
    const result = await invokeStoryAgent(prepared.user, executionInput, signal, async (delta) => {
      partialOutput += delta
      const now = Date.now()
      if (now - lastPartialFlush < 60 && partialOutput.length - lastPartialLength < 96) return
      lastPartialFlush = now
      lastPartialLength = partialOutput.length
      const snapshot = partialOutput
      await updateDb((db) => {
        const task = db.writingTasks.find((item) => item.id === taskId)
        if (!task || task.status !== 'running' || task.cancelRequested
          || !executionMatches(task, executionId, prepared.executionGeneration)) return
        task.partialOutput = snapshot
        task.progress = Math.max(45, Math.min(88, 45 + Math.floor(snapshot.length / 120)))
        task.statusMessage = '正在生成回复'
        task.updatedAt = new Date().toISOString()
        touchAgentThread(db, task)
      })
    }, flushReasoningSummary)
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
        task.reasoningSummary = (reasoningSummary || task.reasoningSummary || '').slice(0, 12_000)
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
      appendEvent(task, 'result', '生成可审阅结果', 'completed', {
        status: result.status,
        ...(resultContinuationMode ? { continuationMode: resultContinuationMode } : {}),
      })
      task.status = result.status === 'needs_input' ? 'waiting_input' : 'completed'
      task.progress = 100
      task.statusMessage = result.status === 'needs_input' ? '等待用户回答' : 'AI Skill 执行完成'
      task.partialOutput = partialOutput || task.partialOutput || ''
      task.reasoningSummary = mergeReasoningSummaries(
        reasoningSummary || task.reasoningSummary,
        result?.result?.reasoning_summary,
      )
      task.reasoningCompletedAt = timestamp
      task.inputRequestStartedAt = result.status === 'needs_input' ? timestamp : null
      task.modelContinuation = result.status === 'needs_input' ? privateContinuation : null
      task.continuationMode = resultContinuationMode
      task.activeExecutionId = null
      accumulateTaskUsage(task, result, timestamp)
      task.result = result
      task.updatedAt = timestamp
      touchAgentThread(db, task)
    })
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
        outcome = 'cancelled'
        return
      }
      if (claimedGeneration == null || !executionMatches(task, executionId, claimedGeneration)) {
        outcome = 'superseded'
        return
      }
      if (pendingSteers(task).length) {
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
        appendEvent(task, 'lifecycle', 'worker 中断，等待恢复执行', 'queued')
        task.status = 'queued'
        task.progress = 0
        task.statusMessage = 'worker 停机，任务等待重新认领'
        task.error = null
        task.errorCode = null
        task.retryable = true
        task.updatedAt = new Date().toISOString()
        touchAgentThread(db, task)
        outcome = 'requeued'
        reason = 'worker'
        return
      }
      const classified = classifyTaskError(error, controller.signal.aborted || task.cancelRequested)
      const eventStatus = classified.errorCode === 'cancelled' ? 'cancelled' : 'failed'
      finishRunningEvent(task, eventStatus)
      appendEvent(task, 'lifecycle', classified.message, eventStatus, { errorCode: classified.errorCode })
      task.status = classified.errorCode === 'cancelled' ? 'cancelled' : 'failed'
      task.statusMessage = classified.message
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
    return { status: outcome, ...(reason ? { reason } : {}) }
  }
}
