import { invokeStoryAgent, classifyTaskError } from './story-agent.mjs'
import { updateDb } from './store.mjs'

export async function executeWritingTask(taskId, { userId = null, controller = new AbortController(), requeueOnAbort = false, resumeRunning = false } = {}) {
  try {
    const prepared = await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId && (!userId || item.userId === userId))
      const user = task ? db.users.find((item) => item.id === task.userId) : null
      if (!task || !user || task.cancelRequested || (task.status !== 'queued' && !(resumeRunning && task.status === 'running'))) return null
      task.status = 'running'
      task.progress = 15
      task.statusMessage = '正在构建写作上下文'
      task.updatedAt = new Date().toISOString()
      return { input: task.input, user }
    })
    if (!prepared) return { status: 'skipped' }
    await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId)
      if (task && task.status === 'running') {
        task.progress = 35
        task.statusMessage = '正在执行 AI Skill'
        task.updatedAt = new Date().toISOString()
      }
    })
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    const result = await invokeStoryAgent(prepared.user, prepared.input, signal)
    await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId)
      if (!task || task.status === 'cancelled' || task.cancelRequested) return
      task.status = 'completed'
      task.progress = 100
      task.statusMessage = 'AI Skill 执行完成'
      task.result = result
      task.updatedAt = new Date().toISOString()
    })
    return { status: 'completed' }
  } catch (error) {
    let outcome = 'failed'
    await updateDb((db) => {
      const task = db.writingTasks.find((item) => item.id === taskId)
      if (!task) return
      if (requeueOnAbort && controller.signal.aborted && !task.cancelRequested) {
        task.status = 'queued'
        task.progress = 0
        task.statusMessage = 'worker 停机，任务等待重新认领'
        task.error = null
        task.errorCode = null
        task.retryable = true
        task.updatedAt = new Date().toISOString()
        outcome = 'requeued'
        return
      }
      const classified = classifyTaskError(error, controller.signal.aborted || task.cancelRequested)
      task.status = classified.errorCode === 'cancelled' ? 'cancelled' : 'failed'
      task.statusMessage = classified.message
      task.error = classified.errorCode === 'cancelled' ? null : classified.message
      task.errorCode = classified.errorCode
      task.retryable = classified.retryable
      task.updatedAt = new Date().toISOString()
    }).catch(() => undefined)
    return { status: outcome }
  }
}
