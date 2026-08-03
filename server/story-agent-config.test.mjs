import { expect, test } from 'bun:test'
import { storyAgentModelCapabilities, storyAgentModelConfig } from './story-agent.mjs'

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
