import { expect, test } from 'bun:test'
import { writingTaskTimeoutMs } from './writing-task-executor.mjs'

test('long-form writing tasks use a bounded configurable deadline', () => {
  expect(writingTaskTimeoutMs(undefined)).toBe(15 * 60 * 1000)
  expect(writingTaskTimeoutMs('120000')).toBe(120000)
  expect(writingTaskTimeoutMs('1000')).toBe(60000)
  expect(writingTaskTimeoutMs(String(2 * 60 * 60 * 1000))).toBe(60 * 60 * 1000)
  expect(writingTaskTimeoutMs('invalid')).toBe(15 * 60 * 1000)
})
