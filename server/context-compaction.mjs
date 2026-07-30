import { threadCompactionPlan } from './agent-thread.mjs'
import { invokeContextCompaction } from './story-agent.mjs'
import { loadDb, updateDb } from './store.mjs'

const activeCompactions = new Set()

export async function maybeCompactAgentThread(taskId) {
  const snapshot = await loadDb()
  const task = snapshot.writingTasks.find((item) => item.id === taskId && item.status === 'completed')
  if (!task?.threadId || activeCompactions.has(task.threadId)) return null
  const thread = snapshot.agentThreads.find((item) => item.id === task.threadId && item.userId === task.userId && item.status !== 'archived')
  const user = snapshot.users.find((item) => item.id === task.userId)
  if (!thread || !user) return null
  const plan = threadCompactionPlan(thread, snapshot.writingTasks, {
    contextWindow: user.settings?.contextWindow,
    maxTokens: user.settings?.maxTokens,
  })
  if (!plan) return null

  activeCompactions.add(thread.id)
  const previousSummary = thread.contextSummary || ''
  try {
    const result = await invokeContextCompaction(user, {
      existingSummary: previousSummary,
      messages: plan.messages,
    }, AbortSignal.timeout(300_000))
    if (result?.status !== 'completed' || !String(result.summary || '').trim()) return null

    return await updateDb((db) => {
      const currentThread = db.agentThreads.find((item) => item.id === thread.id && item.userId === task.userId)
      const currentTask = db.writingTasks.find((item) => item.id === taskId)
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
            transcriptBudget: plan.transcriptBudget,
          },
          startedAt: timestamp,
          completedAt: timestamp,
        })
        currentTask.updatedAt = timestamp
      }
      return {
        threadId: currentThread.id,
        compactedTurns: newTurnIds.length,
        summaryUpdatedAt: timestamp,
      }
    })
  } catch {
    return null
  } finally {
    activeCompactions.delete(thread.id)
  }
}
