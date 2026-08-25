import crypto from 'node:crypto'
import { decryptSecret, encryptSecret, maskKey } from './auth.mjs'
import { normalizeThreadCompactionSettings } from './agent-thread.mjs'

const PROFILE_LIMIT = 12
const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const REASONING_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const MODEL_VENDORS = new Set(['openai', 'anthropic', 'deepseek', 'openrouter', 'custom'])
const PROFILE_FIELDS = [
  'provider',
  'vendor',
  'apiBaseUrl',
  'apiKeyEnc',
  'model',
  'reasoningEffort',
  'thinkingBudgets',
  'temperature',
  'maxTokens',
  'contextWindow',
]

export function cleanModelBaseUrl(value) {
  if (value == null || value === '') return ''
  if (typeof value !== 'string') throw Object.assign(new Error('API Base URL 必须是文本'), { status: 400 })
  const text = value.trim().replace(/\/+$/, '')
  if (!text) return ''
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw Object.assign(new Error('API Base URL 格式不正确'), { status: 400 })
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw Object.assign(new Error('API Base URL 仅支持不带认证信息的 HTTP/HTTPS 地址'), { status: 400 })
  }
  return text
}

function detectedVendor(provider, apiBaseUrl) {
  if (provider === 'anthropic') return 'anthropic'
  try {
    const hostname = new URL(apiBaseUrl).hostname.toLowerCase()
    if (hostname === 'api.openai.com') return 'openai'
    if (hostname === 'api.deepseek.com' || hostname.endsWith('.deepseek.com')) return 'deepseek'
    if (hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai')) return 'openrouter'
  } catch {
    // An empty official URL or a legacy invalid value is handled below.
  }
  return apiBaseUrl ? 'custom' : 'openai'
}

function defaultProfileName(vendor) {
  return {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    deepseek: 'DeepSeek',
    openrouter: 'OpenRouter',
    custom: '自定义服务',
  }[vendor] || '模型连接'
}

function legacyProfile(settings = {}) {
  const provider = settings.provider === 'anthropic' ? 'anthropic' : 'openai'
  const apiBaseUrl = typeof settings.apiBaseUrl === 'string' ? settings.apiBaseUrl : ''
  const vendor = detectedVendor(provider, apiBaseUrl)
  return {
    id: 'default',
    name: defaultProfileName(vendor),
    vendor,
    provider,
    apiBaseUrl,
    apiKeyEnc: settings.apiKeyEnc || null,
    model: typeof settings.model === 'string' ? settings.model : '',
    reasoningEffort: typeof settings.reasoningEffort === 'string' ? settings.reasoningEffort : '',
    thinkingBudgets: settings.thinkingBudgets ?? null,
    temperature: settings.temperature ?? null,
    contextWindow: settings.contextWindow ?? null,
  }
}

function normalizedStoredProfile(profile, index) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null
  const id = PROFILE_ID_PATTERN.test(String(profile.id || '')) ? String(profile.id) : `profile-${index + 1}`
  const provider = profile.provider === 'anthropic' ? 'anthropic' : 'openai'
  const apiBaseUrl = typeof profile.apiBaseUrl === 'string' ? profile.apiBaseUrl : ''
  const requestedVendor = MODEL_VENDORS.has(profile.vendor) ? profile.vendor : detectedVendor(provider, apiBaseUrl)
  const vendor = requestedVendor === 'anthropic' && provider !== 'anthropic'
    ? 'custom'
    : requestedVendor !== 'anthropic' && provider === 'anthropic'
      ? 'anthropic'
      : requestedVendor
  return {
    id,
    name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim().slice(0, 60) : defaultProfileName(vendor),
    vendor,
    provider,
    apiBaseUrl,
    apiKeyEnc: profile.apiKeyEnc || null,
    model: typeof profile.model === 'string' ? profile.model : '',
    reasoningEffort: typeof profile.reasoningEffort === 'string' ? profile.reasoningEffort : '',
    thinkingBudgets: profile.thinkingBudgets ?? null,
    temperature: profile.temperature ?? null,
    contextWindow: profile.contextWindow ?? null,
  }
}

export function modelProfiles(settings = {}) {
  const source = Array.isArray(settings?.modelProfiles) ? settings.modelProfiles.slice(0, PROFILE_LIMIT) : []
  const profiles = source.map(normalizedStoredProfile).filter(Boolean)
  if (!profiles.length) return [legacyProfile(settings)]
  const seen = new Set()
  return profiles.map((profile, index) => {
    if (!seen.has(profile.id)) {
      seen.add(profile.id)
      return profile
    }
    let id = `profile-${index + 1}`
    while (seen.has(id)) id = `${id}-copy`
    seen.add(id)
    return { ...profile, id }
  })
}

export function activeModelProfile(settings = {}) {
  const profiles = modelProfiles(settings)
  return profiles.find((profile) => profile.id === settings?.activeModelProfileId) || profiles[0]
}

export function activeModelSettings(settings = {}) {
  return {
    ...activeModelProfile(settings),
    compaction: normalizeThreadCompactionSettings(settings?.compaction),
  }
}

export function hasActiveModelCredential(settings = {}) {
  return Boolean(activeModelProfile(settings)?.apiKeyEnc)
}

function sanitizedEffort(value) {
  const effort = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return REASONING_EFFORTS.has(effort) ? effort : ''
}

function sanitizedThinkingBudgets(value) {
  if (value == null) return null
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const budgets = {}
  for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const budget = Number(source[level])
    if (Number.isFinite(budget) && budget >= 0) budgets[level] = Math.min(128000, Math.round(budget))
  }
  return budgets
}

function sanitizedOptionalNumber(value, minimum, maximum) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= minimum ? Math.min(maximum, number) : null
}

function sanitizedProfile(input, previous, index) {
  const requestedId = String(input?.id || '')
  const id = PROFILE_ID_PATTERN.test(requestedId) ? requestedId : crypto.randomUUID()
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const provider = source.provider === undefined
    ? previous?.provider === 'anthropic' ? 'anthropic' : 'openai'
    : source.provider === 'anthropic' ? 'anthropic' : 'openai'
  const fallbackBaseUrl = previous?.apiBaseUrl || ''
  const apiBaseUrl = source.apiBaseUrl === undefined ? fallbackBaseUrl : cleanModelBaseUrl(source.apiBaseUrl)
  const requestedVendor = MODEL_VENDORS.has(source.vendor)
    ? source.vendor
    : previous?.vendor || detectedVendor(provider, apiBaseUrl)
  const vendor = requestedVendor === 'anthropic' && provider !== 'anthropic'
    ? 'custom'
    : requestedVendor !== 'anthropic' && provider === 'anthropic'
      ? 'anthropic'
      : requestedVendor
  const nameValue = source.name === undefined ? previous?.name : source.name
  const name = typeof nameValue === 'string' && nameValue.trim()
    ? nameValue.trim().slice(0, 60)
    : `${defaultProfileName(vendor)}${index ? ` ${index + 1}` : ''}`
  let apiKeyEnc = previous?.apiKeyEnc || null
  if (source.clearApiKey === true) apiKeyEnc = null
  const incomingKey = source.apiKey === undefined || source.apiKey === null ? '' : String(source.apiKey).trim()
  if (incomingKey) apiKeyEnc = encryptSecret(incomingKey)

  return {
    id,
    name,
    vendor,
    provider,
    apiBaseUrl,
    apiKeyEnc,
    model: source.model === undefined ? previous?.model || '' : typeof source.model === 'string' ? source.model.trim().slice(0, 120) : '',
    reasoningEffort: source.reasoningEffort === undefined ? previous?.reasoningEffort || '' : sanitizedEffort(source.reasoningEffort),
    thinkingBudgets: source.thinkingBudgets === undefined ? previous?.thinkingBudgets ?? null : sanitizedThinkingBudgets(source.thinkingBudgets),
    temperature: source.temperature === undefined ? previous?.temperature ?? null : sanitizedOptionalNumber(source.temperature, 0, 2),
    contextWindow: source.contextWindow === undefined ? previous?.contextWindow ?? null : sanitizedOptionalNumber(source.contextWindow, 100, 2_000_000),
  }
}

function sanitizedCompaction(input, previousSettings) {
  const incoming = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const previous = previousSettings?.compaction && typeof previousSettings.compaction === 'object' && !Array.isArray(previousSettings.compaction)
    ? previousSettings.compaction
    : {}
  const compaction = { ...previous }
  if (incoming.enabled !== undefined) compaction.enabled = incoming.enabled !== false
  if (incoming.strategy !== undefined) compaction.strategy = incoming.strategy === 'off' ? 'off' : 'context-full'
  for (const [field, minimum, maximum] of [
    ['thresholdPercent', -1, 99],
    ['thresholdTokens', -1, 2_000_000],
    ['reserveTokens', 0, 2_000_000],
    ['keepRecentTokens', 1, 2_000_000],
  ]) {
    if (incoming[field] === undefined) continue
    if (field === 'reserveTokens' && (incoming[field] === null || incoming[field] === '')) {
      compaction[field] = null
      continue
    }
    const number = Number(incoming[field])
    if (Number.isFinite(number)) compaction[field] = Math.min(maximum, Math.max(minimum, Math.round(number)))
  }
  return normalizeThreadCompactionSettings(compaction)
}

function withoutLegacyProfileFields(settings = {}) {
  const result = { ...settings }
  for (const field of PROFILE_FIELDS) delete result[field]
  return result
}

export function sanitizeModelSettings(input = {}, existing = {}) {
  const currentProfiles = modelProfiles(existing)
  const previousById = new Map(currentProfiles.map((profile) => [profile.id, profile]))
  let profiles

  if (Array.isArray(input.modelProfiles)) {
    const source = input.modelProfiles.slice(0, PROFILE_LIMIT)
    profiles = source.map((profile, index) => sanitizedProfile(profile, previousById.get(String(profile?.id || '')), index))
    if (!profiles.length) profiles = [sanitizedProfile({}, null, 0)]
  } else {
    profiles = currentProfiles.map((profile) => ({ ...profile }))
    const hasLegacyPatch = ['provider', 'vendor', 'apiBaseUrl', 'apiKey', 'clearApiKey', 'model', 'reasoningEffort', 'thinkingBudgets', 'temperature', 'contextWindow']
      .some((field) => input[field] !== undefined)
    if (hasLegacyPatch) {
      const activeId = input.activeModelProfileId || existing?.activeModelProfileId
      const activeIndex = Math.max(0, profiles.findIndex((profile) => profile.id === activeId))
      profiles[activeIndex] = sanitizedProfile({ ...input, id: profiles[activeIndex].id }, profiles[activeIndex], activeIndex)
    }
  }

  const seen = new Set()
  profiles = profiles.map((profile) => {
    if (!seen.has(profile.id)) {
      seen.add(profile.id)
      return profile
    }
    let id = crypto.randomUUID()
    while (seen.has(id)) id = crypto.randomUUID()
    seen.add(id)
    return { ...profile, id }
  })

  const requestedActiveId = typeof input.activeModelProfileId === 'string' ? input.activeModelProfileId : existing?.activeModelProfileId
  const activeModelProfileId = profiles.some((profile) => profile.id === requestedActiveId) ? requestedActiveId : profiles[0].id
  const settings = withoutLegacyProfileFields(existing)
  settings.modelProfiles = profiles
  settings.activeModelProfileId = activeModelProfileId
  settings.compaction = input.compaction === undefined
    ? normalizeThreadCompactionSettings(existing?.compaction)
    : sanitizedCompaction(input.compaction, existing)
  return settings
}

export function publicModelProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    vendor: profile.vendor,
    provider: profile.provider,
    apiBaseUrl: profile.apiBaseUrl || '',
    apiKeyMask: maskKey(decryptSecret(profile.apiKeyEnc)),
    model: profile.model || '',
    reasoningEffort: profile.reasoningEffort || '',
    thinkingBudgets: profile.thinkingBudgets ?? null,
    temperature: profile.temperature ?? null,
    contextWindow: profile.contextWindow ?? null,
  }
}
