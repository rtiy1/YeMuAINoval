/**
 * One-time cleanup that removes every persisted chain-of-thought field from the
 * database. Reasoning is intentionally streamed to the UI live and then
 * discarded — it is never stored, per the product's no-CoT-to-storage rule.
 *
 * This module only deletes data that was written by older builds:
 *   - `writingTask.reasoningSummary`
 *   - `writingTask.reasoningHistory`
 *   - `writingTask.reasoningStartedAt` / `reasoningCompletedAt`
 *   - `writingTask.events[]` entries of type `reasoning` (which carry the
 *     200k-char segment summaries — the dominant bloat)
 *   - defensive: the same fields on `agentThread` entries
 *
 * It is idempotent (no-op when nothing is left) so it can run on every boot;
 * the caller persists only when `changed` is set.
 *
 * @module server/purge-reasoning
 */

const TASK_REASONING_FIELDS = ['reasoningSummary', 'reasoningHistory', 'reasoningStartedAt', 'reasoningCompletedAt']
const THREAD_REASONING_FIELDS = ['reasoningSummary', 'reasoningHistory']

/**
 * Strip reasoning data from a live db object (mutates in place; returns stats).
 * @param {object} db - the loaded store (was `db.json`, or a Postgres state).
 * @returns {{ changed: boolean, purgedTasks: number, purgedEvents: number, purgedHistory: number }}
 */
export function purgeReasoningData(db) {
  const result = { changed: false, purgedTasks: 0, purgedEvents: 0, purgedHistory: 0 }
  if (!db || typeof db !== 'object') return result

  for (const task of Array.isArray(db.writingTasks) ? db.writingTasks : []) {
    if (!task || typeof task !== 'object') continue
    let taskChanged = false
    for (const key of TASK_REASONING_FIELDS) {
      if (!Object.hasOwn(task, key)) continue
      if (key === 'reasoningHistory') result.purgedHistory += 1
      delete task[key]
      taskChanged = true
    }
    if (Array.isArray(task.events)) {
      const before = task.events.length
      task.events = task.events.filter((event) => event?.type !== 'reasoning')
      const removed = before - task.events.length
      if (removed > 0) {
        taskChanged = true
        result.purgedEvents += removed
      }
    }
    if (taskChanged) {
      result.purgedTasks += 1
      result.changed = true
    }
  }

  for (const thread of Array.isArray(db.agentThreads) ? db.agentThreads : []) {
    if (!thread || typeof thread !== 'object') continue
    let threadChanged = false
    for (const key of THREAD_REASONING_FIELDS) {
      if (!Object.hasOwn(thread, key)) continue
      delete thread[key]
      threadChanged = true
    }
    if (threadChanged) {
      result.purgedTasks += 1
      result.changed = true
    }
  }

  return result
}
