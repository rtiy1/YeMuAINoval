import crypto from 'node:crypto'
import {
  STORY_AGENT_RUNTIME_INFO,
  listStorySkills,
  runContextCompaction,
  runStoryAgent,
  runStoryDelegate,
} from '../src/agent-runtime.ts'
import { decryptSecret } from './auth.mjs'
import { loadDb } from './store.mjs'
import { enrichStoryAgentPayload, readStoryFileForAgent } from './writing-context.mjs'
import { decorateInstalledMarketSkill } from './market-skill-runtime.mjs'
import { readStoryWorkspaceFile, writeStoryWorkspaceFile } from './story-workspace.mjs'

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
    reasoning_effort: settings.reasoningEffort || undefined,
    temperature: settings.temperature ?? undefined,
    max_tokens: settings.maxTokens ?? undefined,
    context_window: settings.contextWindow ?? undefined,
    allow_server_fallback: sharedModelAccessAllowed,
  }
}

async function preparedStoryAgentBody(user, input) {
  const db = await loadDb()
  const payload = enrichStoryAgentPayload(db, user.id, input.payload || {}, input.message)
  const prepared = await decorateInstalledMarketSkill(user.id, { ...input, payload })
  return {
    message: prepared.message,
    skill: prepared.skill || null,
    payload: prepared.payload,
    model_config: userModelConfig(user),
  }
}

async function readCurrentStoryFile(userId, projectId, requestedPath) {
  const [workspaceFile, databaseFile] = await Promise.all([
    readStoryWorkspaceFile(userId, projectId, requestedPath),
    loadDb().then((db) => readStoryFileForAgent(db, userId, projectId, requestedPath)),
  ])
  if (!workspaceFile) return databaseFile
  if (!databaseFile) return workspaceFile
  const workspaceUpdatedAt = Date.parse(workspaceFile.updatedAt || '') || 0
  const databaseUpdatedAt = Date.parse(databaseFile.updatedAt || '') || 0
  return databaseUpdatedAt >= workspaceUpdatedAt ? databaseFile : workspaceFile
}

export async function invokeStoryAgent(user, input, signal = AbortSignal.timeout(300_000), onDelta = null, onReasoningDelta = null, onToolEvent = null) {
  const body = await preparedStoryAgentBody(user, input)
  const projectId = body.payload?.project_id || body.payload?.projectId || null
  const canWriteWorkspace = body.payload?.tool_policy?.mutateStoryData === 'allow'
  return await runStoryAgent(body, {
    signal,
    onDelta: onDelta || undefined,
    onReasoningDelta: onReasoningDelta || undefined,
    onToolEvent: onToolEvent || undefined,
    readStoryFile: projectId
      ? async (path) => readCurrentStoryFile(user.id, projectId, path)
      : undefined,
    writeStoryFile: projectId && canWriteWorkspace
      ? async (file) => writeStoryWorkspaceFile(user.id, projectId, file)
      : undefined,
  })
}

function delegateRoles(input) {
  const skill = String(input?.skill || '')
  if (skill === 'story-search' || input?.payload?.multi_agent !== true) return []
  if (/(?:review|analyze|scan|deslop)/.test(skill)) return ['continuity_guard', 'prose_critic']
  return ['continuity_guard', 'scene_planner']
}

export async function invokeStoryAgentDelegates(user, input, signal = AbortSignal.timeout(300_000), onEvent = null) {
  const roles = delegateRoles(input)
  if (!roles.length) return []
  const body = await preparedStoryAgentBody(user, input)
  const projectId = body.payload?.project_id || body.payload?.projectId || null
  const runs = roles.map(async (role, ordinal) => {
    const id = `${role}:${ordinal + 1}`
    const runId = crypto.randomUUID()
    await onEvent?.({
      id,
      runId,
      path: `/root/${role}`,
      role,
      ordinal,
      status: 'running',
      startedAt: new Date().toISOString(),
    })
    try {
      const result = await runStoryDelegate({ ...body, role }, {
        signal,
        readStoryFile: projectId
          ? async (path) => readCurrentStoryFile(user.id, projectId, path)
          : undefined,
      })
      const completed = {
        id,
        runId,
        path: `/root/${role}`,
        role,
        ordinal,
        status: result.status,
        summary: typeof result.summary === 'string' ? result.summary.slice(0, 6_000) : '',
        usage: result.usage,
        error: result.error || null,
        completedAt: new Date().toISOString(),
      }
      await onEvent?.(completed)
      return completed
    } catch (error) {
      if (signal.aborted) throw error
      const failed = {
        id,
        runId,
        path: `/root/${role}`,
        role,
        ordinal,
        status: 'failed',
        summary: '',
        usage: null,
        error: '子代理审阅失败，主代理已降级继续',
        completedAt: new Date().toISOString(),
      }
      await onEvent?.(failed)
      return failed
    }
  })
  return Promise.all(runs)
}

export async function invokeContextCompaction(user, input, signal = AbortSignal.timeout(300_000)) {
  return await runContextCompaction(userModelConfig(user), {
    existingSummary: typeof input?.existingSummary === 'string' ? input.existingSummary : '',
    messages: Array.isArray(input?.messages) ? input.messages : [],
  }, { signal })
}

export async function listStoryAgentSkills() {
  return await listStorySkills()
}

export function storyAgentRuntimeInfo() {
  return STORY_AGENT_RUNTIME_INFO
}

export function classifyTaskError(error, cancelled = false) {
  if (cancelled) return { errorCode: 'cancelled', retryable: true, message: '任务已取消，可重新提交' }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { errorCode: 'timeout', retryable: true, message: '模型响应超时，可重试此任务' }
  if (isNetworkError(error) || error?.status === 502 || error?.status === 503) return { errorCode: 'service_unavailable', retryable: true, message: 'AI 服务暂不可用，可稍后重试' }
  if (error?.status === 400 && /模型|API Key|密钥|model/i.test(error?.message || '')) return { errorCode: 'model_config', retryable: false, message: '模型配置无效，请在设置中检查地址、密钥和模型名' }
  if (/上下文|字符|token|length/i.test(error?.message || '')) return { errorCode: 'context_too_large', retryable: false, message: '输入上下文过长，请缩短正文或素材后重试' }
  return { errorCode: 'unknown', retryable: true, message: error?.message || 'AI Skill 执行失败' }
}
