import { threadCompactionPlan } from './agent-thread.mjs'
import { invokeContextCompaction } from './story-agent.mjs'
import { loadDb, updateDb } from './store.mjs'

const activeCompactions = new Set()

async function compactThread({ taskId = null, threadId = null, userId = null, force = false, instructions = '' }) {
  const snapshot = await loadDb()
  const task = taskId
    ? snapshot.writingTasks.find((item) => item.id === taskId && item.status === 'completed')
    : null
  const resolvedThreadId = threadId || task?.threadId
  const resolvedUserId = userId || task?.userId
  if (!resolvedThreadId || !resolvedUserId) return null
  const thread = snapshot.agentThreads.find((item) => item.id === resolvedThreadId && item.userId === resolvedUserId && item.status !== 'archived')
  const user = snapshot.users.find((item) => item.id === resolvedUserId)
  if (!thread || !user) return null
  if (activeCompactions.has(thread.id)) {
    if (force) throw Object.assign(new Error('这个会话正在压缩，请稍后再试'), { status: 409 })
    return null
  }
  const plan = threadCompactionPlan(thread, snapshot.writingTasks, {
    contextWindow: user.settings?.contextWindow,
    compaction: user.settings?.compaction,
    force,
  })
  if (!plan) {
    return force ? {
      status: 'unchanged',
      threadId: thread.id,
      reason: '当前没有可压缩的较早对话；至少需要保留一轮最近上下文。',
    } : null
  }

  activeCompactions.add(thread.id)
  const previousSummary = thread.contextSummary || ''
  try {
    const result = await invokeContextCompaction(user, {
      existingSummary: previousSummary,
      messages: plan.messages,
      instructions,
    }, AbortSignal.timeout(300_000))
    if (result?.status !== 'completed' || !String(result.summary || '').trim()) {
      throw new Error('上下文压缩没有返回可用摘要')
    }

    return await updateDb((db) => {
      const currentThread = db.agentThreads.find((item) => item.id === thread.id && item.userId === resolvedUserId)
      const currentTask = taskId ? db.writingTasks.find((item) => item.id === taskId) : null
      if (!currentThread || currentThread.contextSummary !== previousSummary) return null
      const alreadyCompacted = new Set(currentThread.compactedTurnIds || [])
      const newTurnIds = plan.turnIds.filter((id) => !alreadyCompacted.has(id))
      if (!newTurnIds.length) return null
      const timestamp = new Date().toISOString()
      currentThread.contextSummary = String(result.summary).trim().slice(0, 30000)
      currentThread.compactedTurnIds = [...alreadyCompacted, ...newTurnIds].slice(-40)
      currentThread.compactedTurnCount = Math.max(0, Number(currentThread.compactedTurnCount) || 0) + newTurnIds.length
      currentThread.contextSummaryUpdatedAt = timestamp
      currentThread.updatedAt = timestamp
      if (currentTask) {
        currentTask.events ||= []
        currentTask.events.push({
          id: `${currentTask.id}:${currentTask.events.length + 1}`,
          type: 'context',
          label: `已将 ${newTurnIds.length} 轮较早对话压缩为滚动摘要`,
          status: 'completed',
          meta: {
            compactedTurns: newTurnIds.length,
            estimatedTokens: plan.estimatedTokens,
            thresholdTokens: plan.thresholdTokens,
            keepRecentTokens: plan.keepRecentTokens,
          },
          startedAt: timestamp,
          completedAt: timestamp,
        })
        currentTask.updatedAt = timestamp
      }
      return {
        status: 'compacted',
        threadId: currentThread.id,
        compactedTurns: newTurnIds.length,
        compactedTurnCount: currentThread.compactedTurnCount,
        estimatedTokens: plan.estimatedTokens,
        thresholdTokens: plan.thresholdTokens,
        keptTurnCount: plan.keptTurnCount,
        summaryUpdatedAt: timestamp,
      }
    })
  } finally {
    activeCompactions.delete(thread.id)
  }
}

export async function maybeCompactAgentThread(taskId) {
  try {
    return await compactThread({ taskId })
  } catch {
    return null
  }
}

export async function compactAgentThread(threadId, userId, options = {}) {
  return await compactThread({
    threadId,
    userId,
    force: true,
    instructions: String(options.instructions || '').trim().slice(0, 2000),
  })
}
