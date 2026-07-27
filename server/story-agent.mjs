import { decryptSecret } from './auth.mjs'
import { loadDb } from './store.mjs'
import { enrichStoryAgentPayload } from './writing-context.mjs'

const aiServiceUrl = (process.env.AI_SERVICE_URL || 'http://127.0.0.1:8890').replace(/\/$/, '')
const aiServiceToken = process.env.AI_SERVICE_TOKEN || 'local-ai-service-token'
const sharedModelAccessAllowed = process.env.ALLOW_SHARED_MODEL_KEY === 'true'

function isNetworkError(error) {
  return error?.name === 'TimeoutError'
    || error?.name === 'TypeError'
    || ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(error?.cause?.code)
}

function userModelConfig(user) {
  if (!user?.settings) return sharedModelAccessAllowed ? null : { provider: 'openai', allow_server_fallback: false }
  const settings = user.settings
  return {
    provider: settings.provider === 'anthropic' ? 'anthropic' : 'openai',
    api_base_url: settings.apiBaseUrl || undefined,
    api_key: decryptSecret(settings.apiKeyEnc) || undefined,
    model: settings.model || undefined,
    temperature: settings.temperature ?? undefined,
    max_tokens: settings.maxTokens ?? undefined,
    context_window: settings.contextWindow ?? undefined,
    allow_server_fallback: sharedModelAccessAllowed,
  }
}

export async function invokeStoryAgent(user, input, signal = AbortSignal.timeout(120_000)) {
  const db = await loadDb()
  const payload = enrichStoryAgentPayload(db, user.id, input.payload || {})
  const body = { message: input.message, skill: input.skill || null, payload }
  const modelConfig = userModelConfig(user)
  if (modelConfig) body.model_config = modelConfig
  const response = await fetch(`${aiServiceUrl}/v1/agents/story`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-token': aiServiceToken },
    body: JSON.stringify(body),
    signal,
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) throw Object.assign(new Error(result?.detail || 'Story Agent 处理失败'), { status: response.status >= 500 ? 502 : response.status })
  return result
}

export function classifyTaskError(error, cancelled = false) {
  if (cancelled) return { errorCode: 'cancelled', retryable: true, message: '任务已取消，可重新提交' }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { errorCode: 'timeout', retryable: true, message: '模型响应超时，可重试此任务' }
  if (isNetworkError(error) || error?.status === 502 || error?.status === 503) return { errorCode: 'service_unavailable', retryable: true, message: 'AI 服务暂不可用，可稍后重试' }
  if (error?.status === 400 && /模型|API Key|密钥|model/i.test(error?.message || '')) return { errorCode: 'model_config', retryable: false, message: '模型配置无效，请在设置中检查地址、密钥和模型名' }
  if (/上下文|字符|token|length/i.test(error?.message || '')) return { errorCode: 'context_too_large', retryable: false, message: '输入上下文过长，请缩短正文或素材后重试' }
  return { errorCode: 'unknown', retryable: true, message: error?.message || 'AI Skill 执行失败' }
}
