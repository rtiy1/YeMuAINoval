import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'story-api-'))
const dataFile = path.join(tempDir, 'db.json')
const agentRequests = []
const delegateRequests = []
let activeDelegates = 0
let maxActiveDelegates = 0
const aiServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/models') {
    assert.equal(req.headers.authorization, 'Bearer smoke-model-key')
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'deepseek-v4-flash', object: 'model' },
        { id: 'deepseek-v4-pro', object: 'model' },
      ],
    }))
    return
  }
  if (req.method === 'GET' && req.url === '/v1/skills') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      skills: [
        { name: 'story', version: '1.0.0', description: 'router', status: 'ready', executor: 'router-v1' },
        { name: 'story-community', version: '1.0.0', description: 'host', status: 'needs_model', executor: 'community-prompt-only-v1' },
      ],
    }))
    return
  }
  if (req.method !== 'POST' || !['/v1/assistants/writing/turn', '/v1/assistants/writing/proposal', '/v1/agents/story', '/v1/agents/story/delegate', '/v1/agents/story/delegate/stream', '/v1/agents/story/stream', '/v1/memories/extract', '/v1/responses'].includes(req.url)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'not found' }))
    return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw || '{}')
  if (req.url === '/v1/responses') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ verdict: 'allow', risk_level: 'low', summary: '安全审查通过', findings: [] }) }] }],
    }))
    return
  }
  if (req.url === '/v1/memories/extract') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'completed', message: '已整理候选记忆', candidates: [{ type: 'chapter_summary', title: '本章摘要', content: '测试摘要', importance: 3, reason: '正文明确' }] }))
    return
  }
  if (req.url === '/v1/agents/story/delegate' || req.url === '/v1/agents/story/delegate/stream') {
    delegateRequests.push(body)
    activeDelegates += 1
    maxActiveDelegates = Math.max(maxActiveDelegates, activeDelegates)
    await new Promise((resolve) => setTimeout(resolve, 90))
    activeDelegates -= 1
    if (String(body.message || '').includes('子代理部分失败') && body.role === 'scene_planner') {
      res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'planner unavailable' }))
      return
    }
    const labels = {
      continuity_guard: '连续性约束：保留雨夜时间线。',
      scene_planner: '场景建议：提高冲突并保留章末钩子。',
      prose_critic: '文本建议：统一视角并减少重复表达。',
    }
    const delegateResponse = {
      id: `delegate-${body.role}`,
      role: body.role,
      status: 'completed',
      summary: labels[body.role] || '审阅完成。',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }
    if (req.url.endsWith('/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`event: response/completed\ndata: ${JSON.stringify({ response: delegateResponse })}\n\n`)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(delegateResponse))
    return
  }
  if (req.url === '/v1/agents/story' || req.url === '/v1/agents/story/stream') {
    agentRequests.push(body)
    if (String(body.message || '').includes('取消任务')) await new Promise((resolve) => setTimeout(resolve, 300))
    const steerTurn = String(body.message || '').includes('追加指令测试')
    const artifactTurn = String(body.message || '').includes('资料写入审批')
    const steeringMessages = Array.isArray(body.payload?.steering_messages) ? body.payload.steering_messages : []
    if (steerTurn && !steeringMessages.length) await new Promise((resolve) => setTimeout(resolve, 220))
    if (req.url.endsWith('/stream')) {
      const inputHistory = Array.isArray(body.payload?.request_user_input_history) ? body.payload.request_user_input_history : []
      const malformedChoiceTurn = String(body.message || '').includes('兼容选项损坏测试')
      const choiceTurn = String(body.message || '').includes('确认副本方向') || malformedChoiceTurn
      const malformedChoiceOutput = `项目是空白状态，用户给的是宽泛方向，需要确认一个关键分叉。
<choice_request>
{"questions":[{"id":"infinite_flow_mode","header":"无限流模式","question":"你想要的"无限流"是哪种运转方式？","options":[{"label":"副本轮回制","description":"进入独立"副本世界"完成任务"},{"label":"融合流","description":"副本与长期羁绊结合"}]}]}
</choice_request>`
      const response = malformedChoiceTurn && !inputHistory.length
        ? {
          run_id: 'smoke-malformed-choice-run-1',
          status: 'completed',
          route: 'story',
          selected_skill: body.skill || 'story',
          result: {
            output: malformedChoiceOutput,
            continuation_mode: 'transcript',
            usage: { input_tokens: 40, output_tokens: 30, total_tokens: 70 },
          },
        }
        : choiceTurn && !inputHistory.length
        ? {
          run_id: 'smoke-choice-run-1',
          status: 'needs_input',
          route: 'story',
          selected_skill: body.skill || 'story',
          result: {
            output: '请先确认副本方向。',
            question: {
              protocol: 'request_user_input',
              requestId: 'call-smoke-choice',
              questions: [{
                id: 'genre',
                header: '题材',
                question: '副本偏哪种体验？',
                isOther: true,
                options: [
                  { label: '规则怪谈', value: '规则怪谈', description: '强调规则推理。' },
                  { label: '生存闯关', value: '生存闯关', description: '强调资源压力。' },
                ],
              }],
            },
            response_continuation: {
              protocol: 'message_tools',
              call_id: 'call-smoke-choice',
              tool_name: 'request_user_input',
              arguments: {
                questions: [{
                  id: 'genre',
                  header: '题材',
                  question: '副本偏哪种体验？',
                  options: [
                    { label: '规则怪谈', description: '强调规则推理。' },
                    { label: '生存闯关', description: '强调资源压力。' },
                  ],
                }],
              },
              assistant_content: '',
              history: [],
              base_choice_followup: false,
            },
            continuation_mode: 'transcript',
            usage: { input_tokens: 50, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 70 },
          },
        }
        : {
          run_id: choiceTurn
            ? 'smoke-choice-run-2'
            : steerTurn
              ? `smoke-steer-run-${steeringMessages.length ? 2 : 1}`
              : `smoke-stream-run-${agentRequests.length}`,
          status: 'completed',
          route: 'story',
          selected_skill: body.skill || 'story',
          result: {
            output: choiceTurn
              ? '已按规则怪谈完成副本设计。'
              : steerTurn
                ? steeringMessages.length ? '已改为第三人称。' : '这是应被追加指令取代的旧输出。'
                : '测试 AI 输出',
            continuation_mode: choiceTurn && inputHistory.length ? 'message_tools' : 'transcript',
            usage: choiceTurn
              ? { input_tokens: 70, output_tokens: 30, reasoning_output_tokens: 6, total_tokens: 100 }
              : { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 8, total_tokens: 150 },
            ...(artifactTurn ? { artifacts: { characters: [{ name: '审批人物', role: '配角', description: '只有确认后才写入的人物卡。' }] } } : {}),
          },
        }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const reasoning = malformedChoiceTurn && !inputHistory.length
        ? ''
        : choiceTurn
        ? inputHistory.length ? '根据补充信息完成设计。' : '先确认会影响设计的副本方向。'
        : steerTurn
          ? steeringMessages.length ? '根据追加指令重新规划。' : '正在生成第一版。'
          : '正在核对章节上下文。'
      res.write(`event: item/reasoning/summaryTextDelta\ndata: ${JSON.stringify({ delta: reasoning })}\n\n`)
      if (!choiceTurn || inputHistory.length || malformedChoiceTurn) {
        const output = malformedChoiceTurn && !inputHistory.length
          ? malformedChoiceOutput
          : choiceTurn
          ? '已按规则怪谈完成副本设计。'
          : steerTurn
            ? steeringMessages.length ? '已改为第三人称。' : '这是应被追加指令取代的旧输出。'
            : '测试 AI 输出'
        res.write(`event: item/agentMessage/delta\ndata: ${JSON.stringify({ delta: output.slice(0, Math.ceil(output.length / 2)) })}\n\n`)
        if (steerTurn && !steeringMessages.length) await new Promise((resolve) => setTimeout(resolve, 620))
        res.write(`event: item/agentMessage/delta\ndata: ${JSON.stringify({ delta: output.slice(Math.ceil(output.length / 2)) })}\n\n`)
      }
      res.end(`event: response/completed\ndata: ${JSON.stringify({ response })}\n\n`)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'completed', route: 'story', selected_skill: body.skill || 'story', result: { output: '测试 AI 输出' } }))
    return
  }
  const requirements = body.requirements || {}
  if (req.url === '/v1/assistants/writing/turn') {
    const values = { type: '', genre: '', style: '', premise: '', ...requirements }
    const message = String(body.message || '')
    if (!values.type && message.includes('短篇')) values.type = '短篇'
    else if (!values.genre && values.type) values.genre = message
    else if (!values.style && values.genre) values.style = message
    else if (!values.premise && values.style) values.premise = message
    const missing = ['type', 'genre', 'style', 'premise'].filter((field) => !values[field])
    if (missing.length) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'needs_input', phase: 'collecting_requirements', reply: '请继续补充。', selected_skill: values.type === '短篇' ? 'story-short-write' : 'story-long-write', route: 'test', requirements: values, missing, questions: [] }))
      return
    }
    const turnPayload = {
      status: 'completed', phase: 'awaiting_confirmation', missing: [], reply: '建书方案已经准备好，请确认后创建。', selected_skill: values.type === '短篇' ? 'story-short-write' : 'story-long-write', route: 'test', requirements: values,
      proposal: { title: '雾港回声', type: values.type, genre: values.genre, style: values.style, tone: values.premise, chapters: [{ title: '第一章 来信', content: '主角收到一封来自失踪记者的信，并发现日期来自未来。' }, { title: '第二章 旧港', content: '主角前往封闭的旧港寻找第一条线索。' }, { title: '第三章 回声', content: '谎言被揭开一角，新的追踪者出现。' }] },
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(turnPayload))
    return
  }
  const payload = {
    status: 'completed', phase: 'awaiting_confirmation', missing: [],
    reply: '建书方案已经准备好，请确认后创建。',
    selected_skill: requirements.type === '短篇' ? 'story-short-write' : 'story-long-write',
    proposal: {
      title: '雾港回声', type: requirements.type, genre: requirements.genre, style: requirements.style,
      tone: requirements.premise,
      chapters: [{ title: '第一章 来信', content: '主角收到一封来自失踪记者的信，并发现日期来自未来。' }, { title: '第二章 旧港', content: '主角前往封闭的旧港寻找第一条线索。' }, { title: '第三章 回声', content: '谎言被揭开一角，新的追踪者出现。' }],
    },
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
})
await new Promise((resolve, reject) => {
  aiServer.once('error', reject)
  aiServer.listen(0, '127.0.0.1', resolve)
})
const aiAddress = aiServer.address()
const aiServiceUrl = `http://127.0.0.1:${aiAddress.port}`
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: {
    ...process.env,
    NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1', AUTH_SECRET: 'smoke-test-secret-with-enough-entropy',
    STORY_DATA_FILE: dataFile, AI_SERVICE_URL: aiServiceUrl, AI_TASK_QUEUE_ENABLED: 'false',
    ALLOW_SHARED_MODEL_KEY: 'false', REGISTRATION_MODE: 'open', AI_DAILY_REQUEST_LIMIT: '0',
    AI_CONCURRENT_REQUEST_LIMIT: '3', AI_REQUESTS_PER_MINUTE: '60',
    ACCESS_TOKEN_TTL_MINUTES: '120', REFRESH_SESSION_DAYS: '120',
    PASSWORD_RESET_TOKEN_TTL_MINUTES: '30', PASSWORD_RESET_EXPOSE_TOKEN: 'true',
    EMAIL_VERIFICATION_CODE_TTL_MINUTES: '10', EMAIL_VERIFICATION_EXPOSE_CODE: 'true',
    EMAIL_PROVIDER: 'test', APP_PUBLIC_URL: 'https://stories.example',
    SKILL_REVIEW_MODE: 'required', SKILL_REVIEW_API_URL: `${aiServiceUrl}/v1/responses`,
    SKILL_REVIEW_API_KEY: 'smoke-review-key', SKILL_REVIEW_MODEL: 'smoke-review-model',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let baseUrl
let accessToken
let refreshHeader

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';')[0]
}

async function call(method, route, body, options = {}) {
  const headers = {}
  if (body) headers['content-type'] = 'application/json'
  if (accessToken && options.auth !== false) headers.authorization = `Bearer ${accessToken}`
  if (options.cookie) headers.cookie = options.cookie
  if (options.origin) headers.origin = options.origin
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = response.status === 204 ? null : await response.json()
  return { response, payload }
}

async function streamTask(taskId, { auth = true } = {}) {
  const headers = { accept: 'text/event-stream' }
  if (auth && accessToken) headers.authorization = `Bearer ${accessToken}`
  const response = await fetch(`${baseUrl}/api/ai/tasks/${taskId}/stream`, { headers })
  const body = await response.text()
  const tasks = [...body.matchAll(/event: task\ndata: (.+)\n/g)].map((match) => JSON.parse(match[1]))
  return { response, body, tasks }
}

async function streamTurn(threadId, turnId, { auth = true } = {}) {
  const headers = { accept: 'text/event-stream' }
  if (auth && accessToken) headers.authorization = `Bearer ${accessToken}`
  const response = await fetch(`${baseUrl}/api/ai/threads/${threadId}/turns/${turnId}/stream`, { headers })
  const body = await response.text()
  const events = [...body.matchAll(/event: ([^\n]+)\ndata: (.+)\n/g)].map((match) => ({
    event: match[1],
    payload: JSON.parse(match[2]),
  }))
  return { response, body, events }
}

async function waitForTaskStatus(taskId, statuses, attempts = 100) {
  const expected = new Set(Array.isArray(statuses) ? statuses : [statuses])
  let latest = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await call('GET', `/api/ai/tasks/${taskId}`)
    if (expected.has(latest.payload?.task?.status)) return latest.payload.task
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`任务 ${taskId} 未进入预期状态：${[...expected].join(', ')}；当前为 ${latest?.payload?.task?.status || 'unknown'}`)
}

try {
  baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('API 启动超时')), 5000)
    child.stdout.on('data', (chunk) => {
      const match = chunk.toString().match(/Story API listening on (http:\/\/[^\s]+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    })
    child.stderr.on('data', (chunk) => reject(new Error(chunk.toString())))
    child.on('exit', (code) => reject(new Error(`API 提前退出：${code}`)))
  })

  const health = await call('GET', '/api/health', null, { auth: false })
  assert.equal(health.response.status, 200)
  assert.equal(health.payload.users, 0)
  assert.equal(health.payload.storage.backend, 'json')
  assert.deepEqual(health.payload.skillReview, { mode: 'required', configured: true, provider: 'model' })
  assert.deepEqual(health.payload.email, { provider: 'test', configured: true })
  assert.deepEqual(health.payload.authSession, { accessMinutes: 120, refreshDays: 120 })

  const sameOrigin = await call('POST', '/api/auth/refresh', null, { auth: false, origin: baseUrl })
  assert.equal(sameOrigin.response.status, 401)
  const foreignOrigin = await call('POST', '/api/auth/refresh', null, { auth: false, origin: 'https://invalid.example' })
  assert.equal(foreignOrigin.response.status, 403)
  if (process.env.CODESPACES === 'true' && process.env.CODESPACE_NAME) {
    const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'
    const codespacesOrigin = await call('POST', '/api/auth/refresh', null, { auth: false, origin: `https://${process.env.CODESPACE_NAME}-5173.${domain}` })
    assert.equal(codespacesOrigin.response.status, 401)
  }

  const anonymous = await call('GET', '/api/projects', null, { auth: false })
  assert.equal(anonymous.response.status, 401)

  const invalid = await call('POST', '/api/auth/register', { name: '测试', email: 'bad-email', password: 'password123' }, { auth: false })
  assert.equal(invalid.response.status, 400)

  const registrationCode = await call('POST', '/api/auth/register/code', { email: 'author@example.com' }, { auth: false })
  assert.equal(registrationCode.response.status, 202)
  assert.match(registrationCode.payload.verificationCode, /^\d{6}$/)
  const wrongCode = `${registrationCode.payload.verificationCode.slice(0, 5)}${registrationCode.payload.verificationCode.endsWith('0') ? '1' : '0'}`
  const unverified = await call('POST', '/api/auth/register', { name: '第一作者', email: 'author@example.com', password: 'password123', verificationCode: wrongCode }, { auth: false })
  assert.equal(unverified.response.status, 400)
  const registered = await call('POST', '/api/auth/register', { name: '第一作者', email: 'author@example.com', password: 'password123', verificationCode: registrationCode.payload.verificationCode }, { auth: false })
  assert.equal(registered.response.status, 201)
  assert.equal(registered.payload.user.email, 'author@example.com')
  assert.equal(registered.payload.user.passwordHash, undefined)
  accessToken = registered.payload.accessToken
  refreshHeader = cookieFrom(registered.response)
  assert.ok(refreshHeader?.startsWith('story_refresh='))
  const accessClaims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'))
  assert.equal(accessClaims.exp - accessClaims.iat, 120 * 60)
  assert.match(registered.response.headers.get('set-cookie') || '', /Max-Age=10368000/)

  const skillSource = '---\nname: smoke-test-skill\ndescription: API smoke test\n---\n# Smoke test Skill\n'
  const uploadedSkill = await call('POST', '/api/skill-market', {
    name: 'Smoke Test Skill',
    description: 'Used to verify marketplace upload and download.',
    version: '1.0.0',
    category: '写作',
    tags: ['smoke', 'writing'],
    fileName: 'smoke-test-skill.md',
    contentBase64: Buffer.from(skillSource).toString('base64'),
  })
  assert.equal(uploadedSkill.response.status, 201)
  assert.equal(uploadedSkill.payload.item.name, 'Smoke Test Skill')
  assert.equal(uploadedSkill.payload.item.isOwner, true)
  assert.equal(uploadedSkill.payload.item.downloads, 0)
  assert.equal(uploadedSkill.payload.item.review.status, 'approved')
  assert.equal(uploadedSkill.payload.item.review.reviewer, 'model')
  assert.equal(uploadedSkill.payload.item.isListed, true)
  const marketSkillId = uploadedSkill.payload.item.id

  const duplicatedSkill = await call('POST', '/api/skill-market', {
    name: 'Smoke Test Skill',
    description: 'Duplicate version.',
    version: '1.0.0',
    category: '写作',
    fileName: 'duplicate.md',
    contentBase64: Buffer.from(skillSource).toString('base64'),
  })
  assert.equal(duplicatedSkill.response.status, 409)

  const invalidSkill = await call('POST', '/api/skill-market', {
    name: 'Invalid Skill',
    description: 'Invalid archive content.',
    version: '1.0.0',
    category: '其他',
    fileName: 'invalid.zip',
    contentBase64: Buffer.from('not a zip').toString('base64'),
  })
  assert.equal(invalidSkill.response.status, 400)

  const marketList = await call('GET', '/api/skill-market')
  assert.equal(marketList.response.status, 200)
  assert.equal(marketList.payload.items.length, 1)
  assert.equal(marketList.payload.items[0].id, marketSkillId)
  assert.deepEqual(marketList.payload.review, { mode: 'required', configured: true, provider: 'model' })

  const importedSkill = await call('POST', `/api/skill-market/${marketSkillId}/install`)
  assert.equal(importedSkill.response.status, 200)
  assert.equal(importedSkill.payload.item.installed, true)
  assert.equal(importedSkill.payload.item.installCount, 1)
  const marketSkillKey = importedSkill.payload.item.skillKey

  const installedCatalog = await call('GET', '/api/ai/skills')
  assert.equal(installedCatalog.response.status, 200)
  assert.equal(installedCatalog.payload.skills.some((skill) => skill.name === 'story-community'), false)
  assert.equal(installedCatalog.payload.skills.find((skill) => skill.name === marketSkillKey)?.source, 'market')

  const marketRun = await call('POST', '/api/ai/agent/runs', { message: '执行已导入能力', skill: marketSkillKey, payload: {} })
  assert.equal(marketRun.response.status, 200)
  assert.equal(agentRequests.at(-1).skill, 'story-community')
  assert.equal(agentRequests.at(-1).payload.community_skill.key, marketSkillKey)
  assert.match(agentRequests.at(-1).payload.community_skill.instructions, /Smoke test Skill/)

  const removedImport = await call('DELETE', `/api/skill-market/${marketSkillId}/install`)
  assert.equal(removedImport.response.status, 204)
  const blockedMarketRun = await call('POST', '/api/ai/agent/runs', { message: '不导入直接调用', skill: marketSkillKey, payload: {} })
  assert.equal(blockedMarketRun.response.status, 403)

  const marketDownload = await fetch(`${baseUrl}/api/skill-market/${marketSkillId}/download`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  assert.equal(marketDownload.status, 200)
  assert.match(marketDownload.headers.get('content-disposition') || '', /smoke-test-skill\.md/)
  assert.equal(await marketDownload.text(), skillSource)

  const marketListAfterDownload = await call('GET', '/api/skill-market')
  assert.equal(marketListAfterDownload.payload.items[0].downloads, 1)

  const removedSkill = await call('DELETE', `/api/skill-market/${marketSkillId}`)
  assert.equal(removedSkill.response.status, 204)
  const emptyMarket = await call('GET', '/api/skill-market')
  assert.equal(emptyMarket.payload.items.length, 0)

  const initialUsage = await call('GET', '/api/ai/usage')
  assert.deepEqual(initialUsage.payload.usage, { used: 2, limit: null, remaining: null, active: 0, concurrentLimit: 3 })
  for (let attempt = 0; attempt < 35; attempt += 1) {
    assert.equal((await call('GET', '/api/ai/usage')).response.status, 200, 'read-only polling must not consume the AI request rate limit')
  }
  const seededProjects = await call('GET', '/api/projects')
  assert.equal(seededProjects.payload.projects.length, 1)
  assert.equal(seededProjects.payload.projects[0].title, '我的第一本书')
  const privateProjectId = seededProjects.payload.projects[0].id

  const refreshed = await call('POST', '/api/auth/refresh', null, { auth: false, cookie: refreshHeader })
  assert.equal(refreshed.response.status, 200)
  accessToken = refreshed.payload.accessToken
  refreshHeader = cookieFrom(refreshed.response)

  const created = await call('POST', '/api/projects', { title: '自动化测试作品', type: '短篇', genre: '悬疑推理' })
  assert.equal(created.response.status, 201)
  const projectId = created.payload.project.id

  assert.equal((await call('POST', '/api/projects', { title: '无效篇幅', type: '超长篇', genre: '悬疑推理' })).response.status, 400)
  assert.equal((await call('PATCH', `/api/projects/${projectId}`, { type: '超长篇' })).response.status, 400)
  assert.equal((await call('PATCH', `/api/projects/${projectId}`, { status: '暂停更新' })).response.status, 400)

  assert.equal((await call('PUT', '/api/settings', { apiBaseUrl: 'ftp://invalid.example/v1' })).response.status, 400)
  assert.equal((await call('PUT', '/api/settings', { apiBaseUrl: 'https://user:password@example.com/v1' })).response.status, 400)

  assert.equal((await call('GET', '/api/writing-assistant/session')).payload.session, null)
  const assistantStart = await call('POST', '/api/writing-assistant/messages', { message: '我想写一本小说' })
  assert.equal(assistantStart.payload.phase, 'collecting_requirements')
  assert.deepEqual(assistantStart.payload.missing, ['type', 'genre', 'style', 'premise'])
  const assistantType = await call('POST', '/api/writing-assistant/messages', { message: '短篇' })
  assert.equal(assistantType.payload.requirements.type, '短篇')
  const assistantGenre = await call('POST', '/api/writing-assistant/messages', { message: '悬疑推理' })
  assert.equal(assistantGenre.payload.requirements.genre, '悬疑推理')
  const assistantStyle = await call('POST', '/api/writing-assistant/messages', { message: '克苏鲁悬疑' })
  assert.equal(assistantStyle.payload.requirements.style, '克苏鲁悬疑')
  const assistantProposal = await call('POST', '/api/writing-assistant/messages', { message: '失踪记者留下三封来自未来的信，主角必须在旧港找到真相。' })
  assert.equal(assistantProposal.response.status, 200)
  assert.equal(assistantProposal.payload.phase, 'awaiting_confirmation')
  assert.equal(assistantProposal.payload.selectedSkill, 'story-short-write')
  assert.equal(assistantProposal.payload.proposal.style, '克苏鲁悬疑')
  const assistantSessionId = assistantProposal.payload.session.id
  const assistantCreated = await call('POST', '/api/writing-assistant/confirm', { sessionId: assistantSessionId, proposal: assistantProposal.payload.proposal })
  assert.equal(assistantCreated.response.status, 201)
  assert.equal(assistantCreated.payload.project.style, '克苏鲁悬疑')
  assert.equal(assistantCreated.payload.chapters.length, 3)
  const assistantDuplicate = await call('POST', '/api/writing-assistant/confirm', { sessionId: assistantSessionId, proposal: assistantProposal.payload.proposal })
  assert.equal(assistantDuplicate.response.status, 200)
  assert.equal(assistantDuplicate.payload.project.id, assistantCreated.payload.project.id)
  assert.equal((await call('DELETE', `/api/projects/${assistantCreated.payload.project.id}`)).response.status, 204)
  assert.equal((await call('DELETE', '/api/writing-assistant/session')).response.status, 204)

  const initialChapters = await call('GET', `/api/projects/${projectId}/chapters`)
  assert.equal(initialChapters.response.status, 200)
  assert.equal(initialChapters.payload.chapters.length, 1)
  const firstChapterId = initialChapters.payload.chapters[0].id
  assert.equal((await call('PATCH', `/api/projects/${projectId}/chapters/${firstChapterId}`, { title: '第一章 雨夜' })).response.status, 200)
  assert.equal((await call('PATCH', `/api/projects/${projectId}/chapters/${firstChapterId}`, { state: 'published' })).response.status, 400)

  const draft = await call('PUT', `/api/projects/${projectId}/chapters/${firstChapterId}/draft`, { content: '雨落下来。真相仍在门后。' })
  assert.equal(draft.response.status, 200)
  assert.equal(draft.payload.project.words, '12')
  assert.equal(draft.payload.chapter.words, '12')
  assert.equal(draft.payload.stats.todayWords, 12)

  const historySnapshot = await call('POST', `/api/projects/${projectId}/chapters/${firstChapterId}/history`, { content: '雨落下来。' })
  assert.equal(historySnapshot.response.status, 201)
  const duplicateSnapshot = await call('POST', `/api/projects/${projectId}/chapters/${firstChapterId}/history`, { content: '雨落下来。' })
  assert.equal(duplicateSnapshot.response.status, 200)
  assert.equal(duplicateSnapshot.payload.duplicate, true)
  const persistedHistory = await call('GET', `/api/projects/${projectId}/chapters/${firstChapterId}/history`)
  assert.equal(persistedHistory.payload.snapshots.length, 1)
  assert.equal(persistedHistory.payload.snapshots[0].content, '雨落下来。')

  const secondChapter = await call('POST', `/api/projects/${projectId}/chapters`, { title: '第二章 门后' })
  assert.equal(secondChapter.response.status, 201)
  const secondDraft = await call('PUT', `/api/projects/${projectId}/chapters/${secondChapter.payload.chapter.id}/draft`, { content: '第二章内容' })
  assert.equal(secondDraft.response.status, 200)
  assert.equal(secondDraft.payload.project.words, '17')
  assert.equal((await call('GET', `/api/projects/${projectId}/chapters/${firstChapterId}/draft`)).payload.content, '雨落下来。真相仍在门后。')
  assert.equal((await call('GET', `/api/projects/${projectId}/chapters/${secondChapter.payload.chapter.id}/draft`)).payload.content, '第二章内容')

  const dashboard = await call('GET', '/api/dashboard')
  assert.equal(dashboard.response.status, 200)
  assert.ok(dashboard.payload.stats.projectCount >= 2)
  assert.ok(dashboard.payload.stats.chapterCount >= 3)
  assert.equal(dashboard.payload.stats.todayWords, 17)
  assert.equal(dashboard.payload.stats.totalWritingDays, 1)
  assert.equal(dashboard.payload.stats.currentStreak, 1)
  assert.equal(dashboard.payload.stats.longestStreak, 1)
  assert.equal(dashboard.payload.stats.monthWords, 17)
  assert.equal(dashboard.payload.stats.averageWordsPerWritingDay, 17)
  assert.equal(dashboard.payload.stats.calendar.length, 365)
  assert.equal(dashboard.payload.stats.calendar.at(-1).words, 17)

  const imported = await call('POST', '/api/projects/import', {
    title: '导入测试作品', type: '长篇', genre: '都市现实',
    chapters: [{ title: '序章', content: '这是序章。' }, { title: '第一章 归来', content: '城市灯火重新亮起。' }],
  })
  assert.equal(imported.response.status, 201)
  assert.equal(imported.payload.chapters.length, 2)
  assert.equal(imported.payload.project.chapters, 2)
  assert.equal(imported.payload.project.words, '14')
  assert.equal((await call('GET', `/api/projects/${imported.payload.project.id}/chapters/2/draft`)).payload.content, '城市灯火重新亮起。')
  assert.equal((await call('DELETE', `/api/projects/${imported.payload.project.id}`)).response.status, 204)

  const beforeInvalidSmart = (await call('GET', '/api/projects')).payload.projects.length
  const invalidSmart = await call('POST', '/api/projects/smart', { title: '不完整方案', genre: '悬疑', tone: '寻找真相', chapters: [] })
  assert.equal(invalidSmart.response.status, 400)
  assert.equal((await call('GET', '/api/projects')).payload.projects.length, beforeInvalidSmart)
  const smart = await call('POST', '/api/projects/smart', {
    title: '雾港来信', type: '长篇', genre: '悬疑推理', style: '克苏鲁悬疑', tone: '失踪记者留下三封互相矛盾的信。',
    chapters: [{ title: '第一章 无人来信', content: '主角收到第一封信，并发现邮戳来自未来。' }, { title: '第二章 旧港', content: '主角回到封闭多年的旧港调查。' }],
  })
  assert.equal(smart.response.status, 201)
  assert.equal(smart.payload.chapters.length, 2)
  assert.equal(smart.payload.project.title, '雾港来信')
  assert.equal(smart.payload.project.style, '克苏鲁悬疑')
  assert.equal(smart.payload.chapters[0].outline, '主角收到第一封信，并发现邮戳来自未来。')
  assert.equal((await call('GET', `/api/projects/${smart.payload.project.id}/chapters/1/draft`)).payload.content, '')

  const smartIdea = await call('POST', '/api/ideas', { label: '线索', title: '未来邮戳', body: '邮戳日期比寄信日早三天。', projectId: smart.payload.project.id, pinned: true })
  assert.equal(smartIdea.response.status, 201)
  const smartMemory = await call('POST', '/api/story-memories', { projectId: smart.payload.project.id, type: 'canon_fact', title: '记者身份', content: '失踪记者曾在旧港工作。', importance: 5, sourceChapterId: '1' })
  assert.equal(smartMemory.response.status, 201)
  const memoryBatch = await call('POST', '/api/story-memories/batch', { projectId: smart.payload.project.id, memories: [
    { type: 'character_state', title: '主角状态', content: '主角已经返回旧港。', importance: 4, sourceChapterId: '2', characterName: '主角' },
    { type: 'chapter_summary', title: '第二章摘要', content: '主角回到旧港调查来信。', sourceChapterId: '2' },
  ] })
  assert.equal(memoryBatch.response.status, 201)
  assert.equal(memoryBatch.payload.created.length, 2)
  assert.equal((await call('GET', `/api/story-memories?projectId=${smart.payload.project.id}`)).payload.memories.length, 3)
  const smartForeshadow = await call('POST', '/api/foreshadows', { projectId: smart.payload.project.id, title: '第三封信', content: '第三封信会揭示失踪记者的真实身份。', status: 'planted', importance: 5, plantChapterId: '1', targetChapterId: '2' })
  assert.equal(smartForeshadow.response.status, 201)
  const smartContext = await call('GET', `/api/projects/${smart.payload.project.id}/chapters/2/context`)
  assert.equal(smartContext.response.status, 200)
  assert.equal(smartContext.payload.context.chapter.outline, '主角回到封闭多年的旧港调查。')
  assert.equal(smartContext.payload.context.materials[0].title, '未来邮戳')
  assert.equal(smartContext.payload.context.version, 3)
  assert.deepEqual(smartContext.payload.context.layers.near.chapters.map((chapter) => chapter.id), [1])
  assert.deepEqual(smartContext.payload.context.summaryStatus.missingChapterIds, [1])
  assert.equal(smartContext.payload.context.storyMemory[0].title, '记者身份')
  assert.equal(smartContext.payload.context.storyMemory.length, 3)
  assert.equal(smartContext.payload.context.unresolvedForeshadows[0].title, '第三封信')
  assert.equal((await call('DELETE', `/api/projects/${smart.payload.project.id}`)).response.status, 204)

  const idea = await call('POST', '/api/ideas', { label: '线索', title: '反锁的门', body: '门从里面反锁，但屋里没有人。', projectId, folder: '第一卷', tags: ['密室', '伏笔'] })
  assert.equal(idea.response.status, 201)
  assert.deepEqual(idea.payload.idea.tags, ['密室', '伏笔'])
  const pinnedIdea = await call('PATCH', `/api/ideas/${idea.payload.idea.id}`, { pinned: true, folder: '核心线索' })
  assert.equal(pinnedIdea.response.status, 200)
  assert.equal(pinnedIdea.payload.idea.pinned, true)
  assert.equal((await call('GET', '/api/ideas')).payload.ideas[0].folder, '核心线索')

  const foreshadow = await call('POST', '/api/foreshadows', { projectId, title: '门后的回声', content: '每次雨夜都能听见门后传来三下敲门声。', category: '案件线索', importance: 4, plantChapterId: String(firstChapterId), targetChapterId: String(secondChapter.payload.chapter.id) })
  assert.equal(foreshadow.response.status, 201)
  assert.equal(foreshadow.payload.foreshadow.status, 'planned')
  const foreshadows = await call('GET', `/api/foreshadows?projectId=${projectId}`)
  assert.equal(foreshadows.response.status, 200)
  assert.equal(foreshadows.payload.foreshadows[0].title, '门后的回声')
  const plantedForeshadow = await call('PATCH', `/api/foreshadows/${foreshadow.payload.foreshadow.id}`, { status: 'planted' })
  assert.equal(plantedForeshadow.payload.foreshadow.status, 'planted')
  const resolvedForeshadow = await call('PATCH', `/api/foreshadows/${foreshadow.payload.foreshadow.id}`, { status: 'resolved', chapterId: String(secondChapter.payload.chapter.id) })
  assert.equal(resolvedForeshadow.payload.foreshadow.status, 'resolved')
  assert.equal(resolvedForeshadow.payload.foreshadow.resolvedChapterId, String(secondChapter.payload.chapter.id))
  assert.equal((await call('GET', `/api/foreshadows?projectId=${projectId}&status=resolved`)).payload.foreshadows.length, 1)
  const resolvedAtCreation = await call('POST', '/api/foreshadows', { projectId, title: '旧照片', content: '照片背后的日期解释了失踪时间。', status: 'resolved', resolvedChapterId: String(secondChapter.payload.chapter.id) })
  assert.equal(resolvedAtCreation.payload.foreshadow.resolvedChapterId, String(secondChapter.payload.chapter.id))
  assert.equal((await call('DELETE', `/api/foreshadows/${resolvedAtCreation.payload.foreshadow.id}`)).response.status, 204)
  assert.equal((await call('DELETE', `/api/projects/${projectId}/chapters/${secondChapter.payload.chapter.id}`)).response.status, 204)
  const cleanedForeshadow = await call('GET', `/api/foreshadows?projectId=${projectId}`)
  assert.equal(cleanedForeshadow.payload.foreshadows[0].status, 'planted')
  assert.equal(cleanedForeshadow.payload.foreshadows[0].targetChapterId, null)
  assert.equal(cleanedForeshadow.payload.foreshadows[0].resolvedChapterId, null)

  const agentThread = await call('POST', '/api/ai/threads', { projectId, chapterId: String(firstChapterId) })
  assert.equal(agentThread.response.status, 201)
  assert.equal(agentThread.payload.thread.status, 'active')
  assert.equal((await call('GET', '/api/ai/threads')).payload.threads[0].id, agentThread.payload.thread.id)
  const titledThread = await call('PATCH', `/api/ai/threads/${agentThread.payload.thread.id}`, { title: '雨夜续写记录', isFavorited: true })
  assert.equal(titledThread.response.status, 200)
  assert.equal(titledThread.payload.thread.title, '雨夜续写记录')
  assert.equal(titledThread.payload.thread.isFavorited, true)
  const reusedThread = await call('POST', '/api/ai/threads', { projectId, chapterId: String(firstChapterId) })
  assert.equal(reusedThread.response.status, 200)
  assert.equal(reusedThread.payload.thread.id, agentThread.payload.thread.id)

  const task = await call('POST', `/api/ai/threads/${agentThread.payload.thread.id}/turns`, {
    skill: 'story',
    message: '继续写作',
    payload: {
      chapter_title: '第一章 雨夜',
      content: '雨落下来。',
      source_text: '雨落下来。',
      reviewable_edit: true,
    },
  })
  assert.equal(task.response.status, 202)
  assert.ok(['queued', 'running', 'completed'].includes(task.payload.task.status))
  assert.equal(task.payload.task.threadId, agentThread.payload.thread.id)
  assert.equal(task.payload.task.turnId, task.payload.turn.id)
  assert.equal(task.payload.turn.threadId, agentThread.payload.thread.id)
  assert.equal(task.payload.turn.items[0].type, 'userMessage')
  assert.equal(task.payload.turn.plan.length, 0)
  assert.equal(task.payload.task.events[0].type, 'lifecycle')
  assert.equal(task.payload.task.events[0].status, 'completed')
  const anonymousStream = await streamTurn(agentThread.payload.thread.id, task.payload.turn.id, { auth: false })
  assert.equal(anonymousStream.response.status, 401)
  const streamed = await streamTurn(agentThread.payload.thread.id, task.payload.turn.id)
  assert.equal(streamed.response.status, 200)
  assert.match(streamed.response.headers.get('content-type'), /text\/event-stream/)
  assert.ok(streamed.events.some((event) => event.event === 'turn/started'))
  const startedTurn = streamed.events.find((event) => event.event === 'turn/started').payload.turn
  assert.equal(startedTurn.task.partialOutput, '')
  assert.equal(startedTurn.task.reasoningSummary, '')
  assert.ok(streamed.events.some((event) => event.event === 'item/agentMessage/delta'))
  assert.ok(streamed.events.some((event) => event.event === 'item/reasoning/summaryPartAdded'))
  assert.ok(streamed.events.some((event) => event.event === 'item/reasoning/summaryTextDelta'))
  assert.ok(streamed.events.some((event) => event.event === 'item/completed' && event.payload?.item?.meta?.modelReasoning === true))
  const reasoningStartedIndex = streamed.events.findIndex((event) => event.event === 'item/started' && event.payload?.item?.meta?.modelReasoning === true)
  const reasoningDeltaIndex = streamed.events.findIndex((event) => event.event === 'item/reasoning/summaryTextDelta')
  const reasoningCompletedIndex = streamed.events.findIndex((event) => event.event === 'item/completed' && event.payload?.item?.meta?.modelReasoning === true)
  assert.ok(reasoningStartedIndex >= 0 && reasoningStartedIndex < reasoningDeltaIndex && reasoningDeltaIndex < reasoningCompletedIndex)
  assert.ok(streamed.events.some((event) => event.event === 'item/started' || event.event === 'item/completed'))
  assert.equal(streamed.events.at(-1).event, 'turn/completed')
  assert.equal(streamed.events.at(-1).payload.turn.status, 'completed')
  const completedTask = await call('GET', `/api/ai/tasks/${task.payload.task.id}`)
  assert.equal(completedTask.payload.task.status, 'completed')
  assert.equal(completedTask.payload.task.result.result.output, '测试 AI 输出')
  assert.equal(completedTask.payload.task.reasoningSummary, '正在核对章节上下文。')
  assert.equal(completedTask.payload.task.usage.total_tokens, 150)
  assert.equal(completedTask.payload.task.usageHistory.length, 1)
  assert.deepEqual(completedTask.payload.task.events.map((event) => event.type), ['lifecycle', 'context', 'skill', 'result'])
  assert.equal(completedTask.payload.task.events.some((event) => event.status === 'running'), false)
  const completedRequest = agentRequests.find((request) => request.message === '继续写作')
  assert.equal(completedRequest.model_config.allow_server_fallback, false)
  assert.equal(completedRequest.model_config.api_key, undefined)
  assert.deepEqual(completedRequest.payload.conversation, [])
  const savedModelSettings = await call('PUT', '/api/settings', {
    provider: 'openai',
    apiBaseUrl: aiServiceUrl,
    apiKey: 'smoke-model-key',
    model: 'deepseek-v4-flash',
  })
  assert.equal(savedModelSettings.response.status, 200)
  assert.match(savedModelSettings.payload.settings.apiKeyMask, /^smo/)
  const refreshedModels = await call('POST', '/api/ai/models', {})
  assert.equal(refreshedModels.response.status, 200)
  assert.deepEqual(refreshedModels.payload.models, ['deepseek-v4-flash', 'deepseek-v4-pro'])

  const persistedThread = await call('GET', `/api/ai/threads/${agentThread.payload.thread.id}`)
  assert.equal(persistedThread.payload.thread.turns.length, 1)
  assert.equal(persistedThread.payload.thread.turns[0].source.sourceText, '雨落下来。')
  assert.equal(persistedThread.payload.thread.turns[0].task.status, 'completed')
  assert.deepEqual(persistedThread.payload.thread.turns[0].plan, [])
  assert.deepEqual(persistedThread.payload.thread.turns[0].items.map((item) => item.type), ['userMessage', 'lifecycle', 'lifecycle', 'dynamicToolCall', 'reasoning', 'agentMessage'])
  assert.equal((await call('POST', `/api/ai/threads/${agentThread.payload.thread.id}/resume`)).payload.thread.id, agentThread.payload.thread.id)
  assert.equal((await call('GET', `/api/ai/threads?projectId=${projectId}&chapterId=${firstChapterId}`)).payload.thread.id, agentThread.payload.thread.id)

  const contextualTask = await call('POST', `/api/ai/threads/${agentThread.payload.thread.id}/turns`, {
    skill: 'story-review',
    message: '检查前后衔接',
    payload: { content: '雨落下来。' },
  })
  assert.equal(contextualTask.response.status, 202)
  assert.equal((await streamTurn(agentThread.payload.thread.id, contextualTask.payload.turn.id)).events.at(-1).payload.turn.status, 'completed')
  const contextualRequest = agentRequests.find((request) => request.message === '检查前后衔接')
  assert.deepEqual(contextualRequest.payload.conversation, [
    { role: 'user', text: '继续写作' },
    { role: 'assistant', text: '测试 AI 输出' },
  ])

  const artifactTask = await call('POST', `/api/ai/threads/${agentThread.payload.thread.id}/turns`, {
    skill: 'story',
    message: '资料写入审批',
    payload: { content: '雨落下来。', tool_policy: { mutateStoryData: 'propose' } },
  })
  assert.equal(artifactTask.response.status, 202)
  await streamTurn(agentThread.payload.thread.id, artifactTask.payload.turn.id)
  const pendingArtifactTask = await waitForTaskStatus(artifactTask.payload.task.id, 'completed')
  assert.equal(pendingArtifactTask.artifactApplication, null)
  assert.equal(pendingArtifactTask.artifactPreview.characters, 1)
  assert.equal((await call('GET', '/api/ideas')).payload.ideas.some((item) => item.title === '审批人物'), false)
  const appliedArtifacts = await call('POST', `/api/ai/tasks/${artifactTask.payload.task.id}/artifacts/apply`)
  assert.equal(appliedArtifacts.response.status, 200)
  assert.equal(appliedArtifacts.payload.application.characters, 1)
  assert.equal((await call('GET', '/api/ideas')).payload.ideas.some((item) => item.title === '审批人物'), true)

  const steerTask = await call('POST', `/api/ai/threads/${agentThread.payload.thread.id}/turns`, {
    skill: 'story',
    message: '追加指令测试',
    payload: { content: '雨落下来。' },
  })
  assert.equal(steerTask.response.status, 202)
  const steerStreamPromise = streamTurn(agentThread.payload.thread.id, steerTask.payload.turn.id)
  await waitForTaskStatus(steerTask.payload.task.id, 'running')
  const blockedParallelTurn = await call('POST', `/api/ai/threads/${agentThread.payload.thread.id}/turns`, {
    skill: 'story',
    message: '不应并发创建的轮次',
    payload: { content: '雨落下来。' },
  })
  assert.equal(blockedParallelTurn.response.status, 409)
  const steerKey = 'smoke-steer-idempotency'
  const steerAccepted = await call(
    'POST',
    `/api/ai/threads/${agentThread.payload.thread.id}/turns/${steerTask.payload.turn.id}/steer`,
    { message: '保留剧情，改成第三人称。', expectedTurnId: steerTask.payload.turn.id, idempotencyKey: steerKey },
  )
  assert.equal(steerAccepted.response.status, 202)
  assert.equal(steerAccepted.payload.input.status, 'pending')
  assert.equal(steerAccepted.payload.turn.id, steerTask.payload.turn.id)
  assert.equal(steerAccepted.payload.task.id, steerTask.payload.task.id)
  const reusedSteer = await call(
    'POST',
    `/api/ai/threads/${agentThread.payload.thread.id}/turns/${steerTask.payload.turn.id}/steer`,
    { message: '保留剧情，改成第三人称。', expectedTurnId: steerTask.payload.turn.id, idempotencyKey: steerKey },
  )
  assert.equal(reusedSteer.response.status, 200)
  assert.equal(reusedSteer.payload.reused, true)
  const conflictingSteer = await call(
    'POST',
    `/api/ai/threads/${agentThread.payload.thread.id}/turns/${steerTask.payload.turn.id}/steer`,
    { message: '换成第一人称。', expectedTurnId: steerTask.payload.turn.id, idempotencyKey: steerKey },
  )
  assert.equal(conflictingSteer.response.status, 409)
  const steeredStream = await steerStreamPromise
  assert.equal(steeredStream.events.at(-1).event, 'turn/completed')
  assert.ok(steeredStream.events.some((event) => event.event === 'turn/steer/accepted'))
  assert.ok(steeredStream.events.some((event) => event.event === 'turn/steered'))
  const streamedAgentIds = steeredStream.events
    .filter((event) => event.event === 'item/started' && ['agentMessage', 'plan'].includes(event.payload?.item?.type))
    .map((event) => event.payload.item.id)
  assert.ok(streamedAgentIds.some((id) => id.endsWith(':1')))
  assert.ok(streamedAgentIds.some((id) => id.endsWith(':2')))
  assert.equal(steeredStream.events.filter((event) => event.event === 'turn/completed').length, 1)
  const completedSteerTask = await waitForTaskStatus(steerTask.payload.task.id, 'completed')
  assert.equal(completedSteerTask.result.result.output, '已改为第三人称。')
  assert.equal(completedSteerTask.interactionAttempt, 2)
  assert.equal(completedSteerTask.steeringHistory.length, 1)
  assert.equal(completedSteerTask.steeringHistory[0].status, 'applied')
  assert.equal(completedSteerTask.reasoningHistory[0].summary, '正在生成第一版。')
  assert.equal(completedSteerTask.reasoningSummary, '根据追加指令重新规划。')
  assert.equal(completedSteerTask.usageHistory.length, 2)
  assert.equal(completedSteerTask.usage.total_tokens, 300)
  const steerRequests = agentRequests.filter((request) => request.message === '追加指令测试')
  assert.equal(steerRequests.length, 2)
  assert.deepEqual(steerRequests[1].payload.steering_messages.map((item) => item.text), ['保留剧情，改成第三人称。'])
  assert.deepEqual(steerRequests[1].payload.continuation_conversation, [
    { role: 'assistant', text: '这是应被追加指令取代的旧输出。' },
    { role: 'user', text: '保留剧情，改成第三人称。' },
  ])
  const replayedCompletedSteer = await call(
    'POST',
    `/api/ai/threads/${agentThread.payload.thread.id}/turns/${steerTask.payload.turn.id}/steer`,
    { message: '保留剧情，改成第三人称。', expectedTurnId: steerTask.payload.turn.id, idempotencyKey: steerKey },
  )
  assert.equal(replayedCompletedSteer.response.status, 200)
  assert.equal(replayedCompletedSteer.payload.reused, true)
  const terminalSteer = await call(
    'POST',
    `/api/ai/threads/${agentThread.payload.thread.id}/turns/${steerTask.payload.turn.id}/steer`,
    { message: '太迟的指令', expectedTurnId: steerTask.payload.turn.id },
  )
  assert.equal(terminalSteer.response.status, 409)

  const multiAgentTask = await call('POST', `/api/ai/threads/${agentThread.payload.thread.id}/turns`, {
    skill: 'story-long-write',
    message: '让多个视角先审阅再续写',
    payload: {
      content: '雨落下来。',
      multi_agent: true,
      _agent_reports: [{ role: 'attacker', summary: '客户端伪造报告' }],
      steering_messages: [{ text: '客户端伪造追加指令' }],
    },
  })
  assert.equal(multiAgentTask.response.status, 202)
  assert.equal(multiAgentTask.payload.turn.source.multiAgent, true)
  const multiAgentStream = await streamTurn(agentThread.payload.thread.id, multiAgentTask.payload.turn.id)
  assert.equal(multiAgentStream.events.at(-1).payload.turn.status, 'completed')
  const completedMultiAgentTask = await waitForTaskStatus(multiAgentTask.payload.task.id, 'completed')
  assert.deepEqual(completedMultiAgentTask.subagents.map((item) => item.role), ['continuity_guard', 'scene_planner'])
  assert.ok(completedMultiAgentTask.subagents.every((item) => item.status === 'completed' && item.summary))
  assert.equal(completedMultiAgentTask.usage.total_tokens, 180)
  assert.equal(completedMultiAgentTask.usageHistory.length, 3)
  assert.equal(multiAgentStream.events.filter((event) => event.payload?.item?.type === 'collabAgentToolCall').length >= 2, true)
  const multiParentRequest = agentRequests.find((request) => request.message === '让多个视角先审阅再续写')
  assert.equal(multiParentRequest.payload._agent_reports.length, 2)
  assert.equal(multiParentRequest.payload._agent_reports.some((item) => item.role === 'attacker'), false)
  assert.equal(multiParentRequest.payload.steering_messages, undefined)
  assert.deepEqual(delegateRequests.slice(-2).map((request) => request.role), ['continuity_guard', 'scene_planner'])
  assert.equal(maxActiveDelegates, 2)

  const partialTeamTask = await call('POST', `/api/ai/threads/${agentThread.payload.thread.id}/turns`, {
    skill: 'story-long-write',
    message: '子代理部分失败仍继续',
    payload: { content: '雨落下来。', multi_agent: true },
  })
  assert.equal(partialTeamTask.response.status, 202)
  await streamTurn(agentThread.payload.thread.id, partialTeamTask.payload.turn.id)
  const completedPartialTeam = await waitForTaskStatus(partialTeamTask.payload.task.id, 'completed')
  assert.deepEqual(completedPartialTeam.subagents.map((item) => item.status), ['completed', 'failed'])
  assert.equal(completedPartialTeam.usage.total_tokens, 165)
  assert.equal(completedPartialTeam.usageHistory.length, 2)
  const partialTeamParent = agentRequests.find((request) => request.message === '子代理部分失败仍继续')
  assert.deepEqual(partialTeamParent.payload._agent_reports.map((item) => item.role), ['continuity_guard'])

  const choiceTask = await call('POST', `/api/ai/threads/${agentThread.payload.thread.id}/turns`, {
    skill: 'story',
    message: '确认副本方向后再设计',
    payload: {
      content: '雨落下来。',
      _model_continuation: {
        protocol: 'openai_responses',
        previous_response_id: 'resp_client_must_not_control',
        call_id: 'call-client',
        answers: { genre: { answers: ['恶意注入'] } },
      },
    },
  })
  assert.equal(choiceTask.response.status, 202)
  const waitingChoiceTask = await waitForTaskStatus(choiceTask.payload.task.id, 'waiting_input')
  assert.equal(waitingChoiceTask.result.status, 'needs_input')
  assert.equal(waitingChoiceTask.reasoningSummary, '先确认会影响设计的副本方向。')
  assert.equal(waitingChoiceTask.usage.total_tokens, 70)
  assert.equal(waitingChoiceTask.continuationMode, 'message_tools')
  assert.equal(waitingChoiceTask.result.result.response_continuation, undefined)
  const initialChoiceRequest = agentRequests.find((request) => request.message === '确认副本方向后再设计'
    && !request.payload?.request_user_input_history?.length)
  assert.equal(initialChoiceRequest.payload._model_continuation, undefined)
  const rejectedChoiceSteer = await call(
    'POST',
    `/api/ai/threads/${agentThread.payload.thread.id}/turns/${choiceTask.payload.turn.id}/steer`,
    { message: '不应绕过结构化回答', expectedTurnId: choiceTask.payload.turn.id },
  )
  assert.equal(rejectedChoiceSteer.response.status, 409)
  const answeredChoice = await call(
    'POST',
    `/api/ai/threads/${agentThread.payload.thread.id}/turns/${choiceTask.payload.turn.id}/input`,
    { answers: { genre: '规则怪谈' } },
  )
  assert.equal(answeredChoice.response.status, 202)
  const resumedChoiceStream = await streamTurn(agentThread.payload.thread.id, choiceTask.payload.turn.id)
  assert.equal(resumedChoiceStream.events.at(-1).payload.turn.status, 'completed')
  const completedChoiceTask = await waitForTaskStatus(choiceTask.payload.task.id, 'completed')
  assert.equal(completedChoiceTask.result.result.output, '已按规则怪谈完成副本设计。')
  assert.equal(completedChoiceTask.reasoningHistory.length, 1)
  assert.equal(completedChoiceTask.reasoningHistory[0].summary, '先确认会影响设计的副本方向。')
  assert.equal(completedChoiceTask.reasoningSummary, '根据补充信息完成设计。')
  assert.equal(completedChoiceTask.inputHistory[0].response.answerText, '题材：规则怪谈')
  assert.equal(completedChoiceTask.usage.total_tokens, 170)
  assert.equal(completedChoiceTask.usageHistory.length, 2)
  assert.equal(completedChoiceTask.result.result.usage.total_tokens, 170)
  assert.equal(completedChoiceTask.continuationMode, 'message_tools')
  assert.equal(completedChoiceTask.events.find((event) => event.type === 'input')?.meta?.continuationMode, 'message_tools')
  assert.equal([...completedChoiceTask.events].reverse().find((event) => event.type === 'result')?.meta?.continuationMode, 'message_tools')
  const resumedChoiceRequest = agentRequests.find((request) => request.message === '确认副本方向后再设计'
    && request.payload?.request_user_input_history?.length === 1)
  assert.deepEqual(resumedChoiceRequest.payload.conversation, initialChoiceRequest.payload.conversation)
  assert.deepEqual(resumedChoiceRequest.payload.continuation_conversation, [
    { role: 'assistant', text: '题材：副本偏哪种体验？' },
    { role: 'user', text: '题材：规则怪谈' },
  ])
  assert.deepEqual(resumedChoiceRequest.payload._model_continuation, {
    protocol: 'message_tools',
    call_id: 'call-smoke-choice',
    tool_name: 'request_user_input',
    arguments: {
      questions: [{
        id: 'genre',
        header: '题材',
        question: '副本偏哪种体验？',
        options: [
          { label: '规则怪谈', description: '强调规则推理。' },
          { label: '生存闯关', description: '强调资源压力。' },
        ],
      }],
    },
    assistant_content: '',
    history: [],
    base_choice_followup: false,
    answers: { genre: { answers: ['规则怪谈'] } },
  })
  const choiceThread = await call('GET', `/api/ai/threads/${agentThread.payload.thread.id}`)
  const choiceTurn = choiceThread.payload.thread.turns.find((turn) => turn.id === choiceTask.payload.turn.id)
  assert.equal(choiceTurn.items.filter((item) => item.type === 'reasoning').length, 2)
  assert.equal(choiceTurn.items.find((item) => item.type === 'requestUserInput').status, 'completed')

  const malformedChoiceTask = await call('POST', `/api/ai/threads/${agentThread.payload.thread.id}/turns`, {
    skill: 'story',
    message: '兼容选项损坏测试',
    payload: { content: '' },
  })
  assert.equal(malformedChoiceTask.response.status, 202)
  const recoveredMalformedChoice = await streamTurn(agentThread.payload.thread.id, malformedChoiceTask.payload.turn.id)
  const recoveredMalformedTask = recoveredMalformedChoice.events.at(-1).payload.turn.task
  assert.equal(recoveredMalformedTask.status, 'waiting_input')
  assert.equal(recoveredMalformedTask.result.status, 'needs_input')
  assert.equal(recoveredMalformedTask.inputRequest.questions[0].id, 'infinite_flow_mode')
  assert.deepEqual(recoveredMalformedTask.inputRequest.options.map((option) => option.label), ['副本轮回制', '融合流'])
  assert.match(recoveredMalformedTask.reasoningSummary, /需要确认一个关键分叉/)
  assert.doesNotMatch(recoveredMalformedTask.result.result.output, /choice_request/)
  const answeredMalformedChoice = await call(
    'POST',
    `/api/ai/threads/${agentThread.payload.thread.id}/turns/${malformedChoiceTask.payload.turn.id}/input`,
    { answers: { infinite_flow_mode: '融合流' } },
  )
  assert.equal(answeredMalformedChoice.response.status, 202)
  await streamTurn(agentThread.payload.thread.id, malformedChoiceTask.payload.turn.id)
  const completedMalformedChoice = await waitForTaskStatus(malformedChoiceTask.payload.task.id, 'completed')
  assert.equal(completedMalformedChoice.result.result.output, '已按规则怪谈完成副本设计。')
  assert.match(completedMalformedChoice.reasoningHistory[0].summary, /需要确认一个关键分叉/)

  const interruptedTurn = await call('POST', `/api/ai/threads/${agentThread.payload.thread.id}/turns`, {
    skill: 'story',
    message: '取消任务',
    payload: { content: '雨落下来。' },
  })
  await waitForTaskStatus(interruptedTurn.payload.task.id, 'running')
  const steerBeforeInterrupt = await call(
    'POST',
    `/api/ai/threads/${agentThread.payload.thread.id}/turns/${interruptedTurn.payload.turn.id}/steer`,
    { message: '这条追加指令应随取消失效', expectedTurnId: interruptedTurn.payload.turn.id, idempotencyKey: 'steer-before-interrupt' },
  )
  assert.equal(steerBeforeInterrupt.response.status, 202)
  const interrupted = await call('POST', `/api/ai/threads/${agentThread.payload.thread.id}/turns/${interruptedTurn.payload.turn.id}/interrupt`)
  assert.equal(interrupted.response.status, 200)
  assert.equal(interrupted.payload.turn.status, 'interrupted', JSON.stringify(interrupted.payload.turn))
  assert.equal(interrupted.payload.turn.items.at(-1).type, 'agentMessage')
  assert.equal((await streamTurn(agentThread.payload.thread.id, interruptedTurn.payload.turn.id)).events.at(-1).event, 'turn/completed')
  const cancelledSteerTask = await waitForTaskStatus(interruptedTurn.payload.task.id, 'cancelled')
  assert.equal(cancelledSteerTask.steeringHistory[0].status, 'cancelled')
  const regeneratedTurn = await call(
    'POST',
    `/api/ai/threads/${agentThread.payload.thread.id}/turns/${interruptedTurn.payload.turn.id}/regenerate`,
  )
  assert.equal(regeneratedTurn.response.status, 202)
  assert.equal(regeneratedTurn.payload.turn.id, interruptedTurn.payload.turn.id)
  assert.notEqual(regeneratedTurn.payload.task.id, interruptedTurn.payload.task.id)
  assert.equal(regeneratedTurn.payload.task.parentTaskId, interruptedTurn.payload.task.id)
  assert.equal(regeneratedTurn.payload.task.attempt, 2)
  assert.match(regeneratedTurn.payload.task.statusMessage, /重新生成/)
  const regeneratedStream = await streamTurn(agentThread.payload.thread.id, interruptedTurn.payload.turn.id)
  assert.equal(regeneratedStream.events.at(-1).payload.turn.status, 'completed')
  const regeneratedThread = await call('GET', `/api/ai/threads/${agentThread.payload.thread.id}`)
  assert.equal(regeneratedThread.payload.thread.turns.at(-1).id, interruptedTurn.payload.turn.id)
  assert.equal(regeneratedThread.payload.thread.turns.at(-1).task.id, regeneratedTurn.payload.task.id)
  const staleRegeneration = await call(
    'POST',
    `/api/ai/threads/${agentThread.payload.thread.id}/turns/${choiceTask.payload.turn.id}/regenerate`,
  )
  assert.equal(staleRegeneration.response.status, 409)
  const duplicateTask = await call('POST', '/api/ai/tasks', { skill: 'story', message: '重复任务', idempotencyKey: 'same-operation', payload: { project_id: projectId, chapter_id: String(firstChapterId) } })
  const duplicateTaskResult = await streamTask(duplicateTask.payload.task.id)
  assert.equal(duplicateTaskResult.tasks.at(-1).status, 'completed', JSON.stringify(duplicateTaskResult.tasks.at(-1)))
  const reusedTask = await call('POST', '/api/ai/tasks', { skill: 'story', message: '重复任务', idempotencyKey: 'same-operation', payload: { project_id: projectId, chapter_id: String(firstChapterId) } })
  assert.equal(reusedTask.response.status, 200)
  assert.equal(reusedTask.payload.task.id, duplicateTask.payload.task.id)
  assert.equal(reusedTask.payload.task.reused, true)
  const cancelTask = await call('POST', '/api/ai/tasks', { skill: 'story', message: '取消任务', payload: { project_id: projectId, chapter_id: String(firstChapterId) } })
  assert.equal(cancelTask.response.status, 202)
  const cancelled = await call('POST', `/api/ai/tasks/${cancelTask.payload.task.id}/cancel`)
  assert.equal(cancelled.response.status, 200)
  assert.equal(cancelled.payload.task.status, 'cancelled')
  assert.equal(cancelled.payload.task.errorCode, 'cancelled')
  assert.equal(cancelled.payload.task.events.at(-1).status, 'cancelled')
  const retried = await call('POST', `/api/ai/tasks/${cancelTask.payload.task.id}/retry`)
  assert.equal(retried.response.status, 202)
  assert.equal(retried.payload.task.attempt, 2)
  assert.equal(retried.payload.task.parentTaskId, cancelTask.payload.task.id)
  assert.match(retried.payload.task.events[0].label, /重试任务已排队/)
  const reusedRetry = await call('POST', `/api/ai/tasks/${cancelTask.payload.task.id}/retry`)
  assert.equal(reusedRetry.response.status, 200)
  assert.equal(reusedRetry.payload.task.id, retried.payload.task.id)
  assert.equal(reusedRetry.payload.task.reused, true)

  assert.equal((await call('DELETE', `/api/ai/threads/${agentThread.payload.thread.id}`)).response.status, 204)
  assert.equal((await call('GET', `/api/ai/threads?projectId=${projectId}&chapterId=${firstChapterId}`)).payload.thread, null)
  assert.equal((await call('GET', '/api/ai/threads?includeArchived=true')).payload.threads.some((thread) => thread.id === agentThread.payload.thread.id), true)
  const replacementThread = await call('POST', '/api/ai/threads', { projectId, chapterId: String(firstChapterId) })
  assert.equal(replacementThread.response.status, 201)
  assert.notEqual(replacementThread.payload.thread.id, agentThread.payload.thread.id)

  assert.equal((await call('DELETE', `/api/projects/${projectId}`)).response.status, 204)

  const secondCode = await call('POST', '/api/auth/register/code', { email: 'second@example.com' }, { auth: false })
  assert.equal(secondCode.response.status, 202)
  const second = await call('POST', '/api/auth/register', { name: '第二作者', email: 'second@example.com', password: 'password456', verificationCode: secondCode.payload.verificationCode }, { auth: false })
  assert.equal(second.response.status, 201)
  accessToken = second.payload.accessToken
  const secondProjects = await call('GET', '/api/projects')
  assert.equal(secondProjects.payload.projects.length, 1)
  assert.equal((await call('GET', `/api/projects/${privateProjectId}`)).response.status, 404)

  const loggedIn = await call('POST', '/api/auth/login', { email: 'author@example.com', password: 'password123' }, { auth: false })
  assert.equal(loggedIn.response.status, 200)
  accessToken = loggedIn.payload.accessToken
  refreshHeader = cookieFrom(loggedIn.response)
  assert.equal((await call('GET', '/api/projects')).payload.projects.length, 1)

  const oldAccessToken = accessToken
  const oldRefreshHeader = refreshHeader
  const unknownRecovery = await call('POST', '/api/auth/password/forgot', { email: 'missing@example.com' }, { auth: false })
  assert.equal(unknownRecovery.response.status, 202)
  assert.equal(unknownRecovery.payload.resetToken, undefined)
  const recovery = await call('POST', '/api/auth/password/forgot', { email: 'author@example.com' }, { auth: false })
  assert.equal(recovery.response.status, 202)
  assert.equal(recovery.payload.message, unknownRecovery.payload.message)
  assert.ok(recovery.payload.resetToken)
  const invalidReset = await call('POST', '/api/auth/password/reset', { token: 'x'.repeat(43), password: 'password789' }, { auth: false })
  assert.equal(invalidReset.response.status, 400)
  const reset = await call('POST', '/api/auth/password/reset', { token: recovery.payload.resetToken, password: 'password789' }, { auth: false })
  assert.equal(reset.response.status, 200)
  assert.equal(reset.payload.message, '密码已更新，请使用新密码登录。')
  accessToken = oldAccessToken
  assert.equal((await call('GET', '/api/projects')).response.status, 401)
  assert.equal((await call('POST', '/api/auth/refresh', null, { auth: false, cookie: oldRefreshHeader })).response.status, 401)
  assert.equal((await call('POST', '/api/auth/password/reset', { token: recovery.payload.resetToken, password: 'password999' }, { auth: false })).response.status, 400)
  assert.equal((await call('POST', '/api/auth/login', { email: 'author@example.com', password: 'password123' }, { auth: false })).response.status, 401)
  const relogged = await call('POST', '/api/auth/login', { email: 'author@example.com', password: 'password789' }, { auth: false })
  assert.equal(relogged.response.status, 200)
  accessToken = relogged.payload.accessToken
  refreshHeader = cookieFrom(relogged.response)

  const loggedOut = await call('POST', '/api/auth/logout', null, { auth: false, cookie: refreshHeader })
  assert.equal(loggedOut.response.status, 204)
  assert.equal((await call('POST', '/api/auth/refresh', null, { auth: false, cookie: refreshHeader })).response.status, 401)

  console.log('API smoke test passed: verified registration, configurable sessions, password reset, isolation, validation, CRUD, logout')
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }
  aiServer.close()
  await rm(tempDir, { recursive: true, force: true })
}
