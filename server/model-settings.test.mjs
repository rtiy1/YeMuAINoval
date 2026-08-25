import { expect, test } from 'bun:test'
import { decryptSecret, encryptSecret } from './auth.mjs'
import {
  activeModelProfile,
  activeModelSettings,
  cleanModelBaseUrl,
  modelProfiles,
  publicModelProfile,
  sanitizeModelSettings,
} from './model-settings.mjs'

test('legacy model settings are exposed as one default profile', () => {
  const settings = {
    provider: 'openai',
    apiBaseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnc: encryptSecret('legacy-secret-key'),
    model: 'deepseek-chat',
    temperature: 0.4,
    compaction: { enabled: false, strategy: 'off' },
  }

  expect(modelProfiles(settings)).toEqual([
    expect.objectContaining({
      id: 'default',
      name: 'DeepSeek',
      vendor: 'deepseek',
      provider: 'openai',
      model: 'deepseek-chat',
    }),
  ])
  expect(activeModelSettings(settings)).toEqual(expect.objectContaining({
    apiBaseUrl: 'https://api.deepseek.com/v1',
    compaction: expect.objectContaining({ enabled: false, strategy: 'off' }),
  }))
})

test('multiple provider profiles keep independent encrypted credentials', () => {
  const initial = sanitizeModelSettings({
    activeModelProfileId: 'openai-main',
    modelProfiles: [
      {
        id: 'openai-main',
        name: '主要写作',
        vendor: 'openai',
        provider: 'openai',
        apiKey: 'openai-secret-key',
        model: 'gpt-test',
      },
      {
        id: 'claude-backup',
        name: '长文备用',
        vendor: 'anthropic',
        provider: 'anthropic',
        apiKey: 'anthropic-secret-key',
        model: 'claude-test',
      },
    ],
  })

  const switched = sanitizeModelSettings({
    activeModelProfileId: 'claude-backup',
    modelProfiles: [
      { ...publicModelProfile(initial.modelProfiles[0]), model: 'gpt-new' },
      publicModelProfile(initial.modelProfiles[1]),
    ],
  }, initial)

  expect(activeModelProfile(switched).id).toBe('claude-backup')
  expect(decryptSecret(switched.modelProfiles[0].apiKeyEnc)).toBe('openai-secret-key')
  expect(decryptSecret(switched.modelProfiles[1].apiKeyEnc)).toBe('anthropic-secret-key')
  expect(switched.modelProfiles[0].model).toBe('gpt-new')
  expect(switched).not.toHaveProperty('apiKeyEnc')
  expect(switched).not.toHaveProperty('maxTokens')
})

test('legacy quick settings patch only changes the active profile', () => {
  const initial = sanitizeModelSettings({
    activeModelProfileId: 'second',
    modelProfiles: [
      { id: 'first', name: '一号', model: 'model-a' },
      { id: 'second', name: '二号', model: 'model-b' },
    ],
  })
  const updated = sanitizeModelSettings({ model: 'model-b-new', reasoningEffort: 'high' }, initial)

  expect(updated.modelProfiles.map((profile) => profile.model)).toEqual(['model-a', 'model-b-new'])
  expect(updated.modelProfiles[1].reasoningEffort).toBe('high')
})

test('stored key can be explicitly removed without affecting another profile', () => {
  const initial = sanitizeModelSettings({
    activeModelProfileId: 'first',
    modelProfiles: [
      { id: 'first', apiKey: 'first-secret' },
      { id: 'second', apiKey: 'second-secret' },
    ],
  })
  const updated = sanitizeModelSettings({
    activeModelProfileId: 'first',
    modelProfiles: [
      { ...publicModelProfile(initial.modelProfiles[0]), clearApiKey: true },
      publicModelProfile(initial.modelProfiles[1]),
    ],
  }, initial)

  expect(updated.modelProfiles[0].apiKeyEnc).toBeNull()
  expect(decryptSecret(updated.modelProfiles[1].apiKeyEnc)).toBe('second-secret')
})

test('model base URL rejects embedded credentials and query parameters', () => {
  expect(cleanModelBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
  expect(() => cleanModelBaseUrl('https://user:pass@example.com/v1')).toThrow()
  expect(() => cleanModelBaseUrl('https://api.example.com/v1?key=secret')).toThrow()
})
