import { invokeStoryAgent, classifyTaskError } from './story-agent.mjs'
import { maybeCompactAgentThread } from './context-compaction.mjs'
import { updateDb } from './store.mjs'

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

export async function executeWritingTask(taskId, { userId = null, controller = new AbortController(), requeueOnAbort = false, resumeRunning = false } = {}) {
  try {
    const prepared = await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId && (!userId || item.userId === userId))
      const user = task ? db.users.find((item) => item.id === task.userId) : null
      if (!task || !user || task.cancelRequested || (task.status !== 'queued' && !(resumeRunning && task.status === 'running'))) return null
      if (resumeRunning && task.status === 'running') finishRunningEvent(task, 'interrupted')
      task.status = 'running'
      task.progress = 15
      task.partialOutput = ''
      task.reasoningSummary = ''
      task.statusMessage = '正在构建写作上下文'
      appendEvent(task, 'context', '读取作品、章节与连续性上下文', 'running')
      task.updatedAt = new Date().toISOString()
      return { input: task.input, user }
    })
    if (!prepared) return { status: 'skipped' }
    await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId)
      if (task && task.status === 'running') {
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
    const flushReasoningSummary = async (delta) => {
      reasoningSummary += delta
      const snapshot = reasoningSummary.slice(0, 12_000)
      await updateDb((db) => {
        const task = db.writingTasks.find((item) => item.id === taskId)
        if (!task || task.status !== 'running' || task.cancelRequested) return
        task.reasoningSummary = snapshot
        task.updatedAt = new Date().toISOString()
        touchAgentThread(db, task)
      })
    }
    const result = await invokeStoryAgent(prepared.user, prepared.input, signal, async (delta) => {
      partialOutput += delta
      const now = Date.now()
      if (now - lastPartialFlush < 60 && partialOutput.length - lastPartialLength < 96) return
      lastPartialFlush = now
      lastPartialLength = partialOutput.length
      const snapshot = partialOutput
      await updateDb((db) => {
        const task = db.writingTasks.find((item) => item.id === taskId)
        if (!task || task.status !== 'running' || task.cancelRequested) return
        task.partialOutput = snapshot
        task.progress = Math.max(45, Math.min(88, 45 + Math.floor(snapshot.length / 120)))
        task.statusMessage = '正在生成回复'
        task.updatedAt = new Date().toISOString()
        touchAgentThread(db, task)
      })
    }, flushReasoningSummary)
    await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId)
      if (!task || task.status === 'cancelled' || task.cancelRequested) return
      const references = Array.isArray(result?.result?.references_loaded) ? result.result.references_loaded : []
      const checks = Array.isArray(result?.result?.checks) ? result.result.checks : []
      finishRunningEvent(task, 'completed', {
        label: `完成 ${result.selected_skill || task.skill || 'story'} Skill`,
        meta: { selectedSkill: result.selected_skill || task.skill || null, route: result.route || '', references: references.length, checks: checks.length },
      })
      appendEvent(task, 'result', '生成可审阅结果', 'completed', { status: result.status })
      task.status = result.status === 'needs_input' ? 'waiting_input' : 'completed'
      task.progress = 100
      task.statusMessage = result.status === 'needs_input' ? '等待用户回答' : 'AI Skill 执行完成'
      task.partialOutput = partialOutput || task.partialOutput || ''
      task.reasoningSummary = reasoningSummary || task.reasoningSummary || ''
      task.result = result
      task.updatedAt = new Date().toISOString()
      touchAgentThread(db, task)
    })
    await maybeCompactAgentThread(taskId).catch(() => undefined)
    return { status: 'completed' }
  } catch (error) {
    let outcome = 'failed'
    await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId)
      if (!task) return
      if (task.status === 'cancelled' && task.cancelRequested) {
        outcome = 'cancelled'
        return
      }
      if (requeueOnAbort && controller.signal.aborted && !task.cancelRequested) {
        finishRunningEvent(task, 'interrupted')
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
      task.updatedAt = new Date().toISOString()
      touchAgentThread(db, task)
    }).catch(() => undefined)
    return { status: outcome }
  }
}
