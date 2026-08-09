import { expect, test } from 'bun:test'
import { writingTaskTimeoutMs } from './writing-task-executor.mjs'

test('long-form writing tasks have no wall-clock deadline unless explicitly configured', () => {
  expect(writingTaskTimeoutMs(undefined)).toBeNull()
  expect(writingTaskTimeoutMs('')).toBeNull()
  expect(writingTaskTimeoutMs('0')).toBeNull()
  expect(writingTaskTimeoutMs('120000')).toBe(120000)
  expect(writingTaskTimeoutMs('1000')).toBe(60000)
  expect(writingTaskTimeoutMs(String(2 * 60 * 60 * 1000))).toBe(2 * 60 * 60 * 1000)
  expect(writingTaskTimeoutMs(String(60 * 24 * 60 * 60 * 1000))).toBe(30 * 24 * 60 * 60 * 1000)
  expect(writingTaskTimeoutMs('invalid')).toBeNull()
})
