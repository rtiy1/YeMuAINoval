import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveModelIcon } from '../src/model-icons.mjs'

test('resolves common model families to local Lobe icons', () => {
  const cases = new Map([
    ['DeepSeek V4 Flash', 'deepseek-color.svg'],
    ['anthropic/claude-4-sonnet', 'claude-color.svg'],
    ['gemini-2.5-pro', 'gemini-color.svg'],
    ['qwen3-coder-plus', 'qwen-color.svg'],
    ['glm-4.5-air', 'chatglm-color.svg'],
    ['moonshot-v1-128k', 'kimi-color.svg'],
    ['doubao-seed-1-6', 'doubao-color.svg'],
    ['mistral-large-latest', 'mistral-color.svg'],
    ['meta-llama/llama-4-maverick', 'meta-color.svg'],
    ['openai/gpt-5', 'openai.svg'],
  ])

  for (const [model, icon] of cases) assert.equal(resolveModelIcon(model), icon, model)
})

test('uses the generic fallback for empty and unknown model names', () => {
  assert.equal(resolveModelIcon(''), '')
  assert.equal(resolveModelIcon('custom-private-model'), '')
})
