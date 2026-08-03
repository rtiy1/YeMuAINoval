import { expect, test } from 'bun:test'
import { classifyTaskError, storyAgentModelCapabilities, storyAgentModelConfig } from './story-agent.mjs'

test('Story Agent uses TUI catalog output limits instead of the legacy Web override', () => {
  const config = storyAgentModelConfig({
    settings: {
      provider: 'openai',
      apiBaseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      maxTokens: 16384,
    },
  })
  expect(config.max_tokens).toBeUndefined()

  const capabilities = storyAgentModelCapabilities({
    provider: 'openai',
    apiBaseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
    maxTokens: 16384,
  })
  expect(capabilities.maxTokens).toBe(128000)
})

test('Story Agent distinguishes a model deadline from an explicit user cancellation', () => {
  const timeout = classifyTaskError(new DOMException('The operation timed out', 'TimeoutError'), false)
  expect(timeout).toEqual({
    errorCode: 'timeout',
    retryable: true,
    message: '模型响应超时，可重试此任务',
  })

  const cancelled = classifyTaskError(new DOMException('Aborted', 'AbortError'), true)
  expect(cancelled).toEqual({
    errorCode: 'cancelled',
    retryable: true,
    message: '任务已取消，可重新提交',
  })
})
