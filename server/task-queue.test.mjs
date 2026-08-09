import { expect, test } from 'bun:test'
import {
  refreshTaskClaim,
  taskClaimHeartbeatMs,
  TASK_GROUP,
  TASK_STREAM,
} from './task-queue.mjs'

test('active Redis task claims are refreshed well before stale takeover', () => {
  expect(taskClaimHeartbeatMs(180_000, 'invalid')).toBe(60_000)
  expect(taskClaimHeartbeatMs(180_000, '100')).toBe(1_000)
  expect(taskClaimHeartbeatMs(180_000, '120000')).toBe(90_000)
})

test('refreshing a task claim resets its Redis pending-entry idle time', async () => {
  const calls = []
  const client = {
    async xclaim(...args) {
      calls.push(args)
      return ['message-1']
    },
  }

  await expect(refreshTaskClaim(client, 'worker-1', 'message-1')).resolves.toBe(true)
  expect(calls).toEqual([[
    TASK_STREAM,
    TASK_GROUP,
    'worker-1',
    0,
    'message-1',
    'JUSTID',
  ]])
})
