import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { strToU8, zipSync } from 'fflate'

const requests = []
const reviewer = http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  requests.push({
    authorization: req.headers.authorization,
    body: JSON.parse(raw || '{}'),
  })
  if (raw.includes('Force Service Failure')) {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'reviewer unavailable' } }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    output: [{
      content: [{
        type: 'output_text',
        text: JSON.stringify({
          verdict: 'allow',
          risk_level: 'low',
          summary: '未发现可核验的高风险行为。',
          findings: [],
        }),
      }],
    }],
  }))
})

await new Promise((resolve, reject) => {
  reviewer.once('error', reject)
  reviewer.listen(0, '127.0.0.1', resolve)
})

const address = reviewer.address()
process.env.SKILL_REVIEW_MODE = 'required'
process.env.SKILL_REVIEW_API_URL = `http://127.0.0.1:${address.port}/v1/responses`
process.env.SKILL_REVIEW_API_KEY = 'review-test-key'
process.env.SKILL_REVIEW_MODEL = 'security-review-model'
process.env.SKILL_REVIEW_API_STYLE = 'responses'

const { reviewSkillPackage, skillReviewPublicConfig } = await import(`./skill-review.mjs?test=${Date.now()}`)

function reviewInput(overrides = {}) {
  const buffer = Buffer.from('---\nname: safe-skill\n---\n# Safe Skill\n仅分析用户选中的章节。')
  return {
    name: 'Safe Skill',
    description: '安全测试',
    version: '1.0.0',
    category: '审稿',
    tags: ['安全'],
    fileName: 'SKILL.md',
    extension: '.md',
    buffer,
    sha256: 'test-sha256',
    ...overrides,
  }
}

test('configured reviewer uses strict Responses JSON schema', async () => {
  assert.deepEqual(skillReviewPublicConfig(), { mode: 'required', configured: true, provider: 'model' })
  const result = await reviewSkillPackage(reviewInput())
  assert.equal(result.verdict, 'allow')
  assert.equal(result.reviewer, 'model')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].authorization, 'Bearer review-test-key')
  assert.equal(requests[0].body.model, 'security-review-model')
  assert.equal(requests[0].body.text.format.type, 'json_schema')
  assert.equal(requests[0].body.text.format.strict, true)
  assert.match(requests[0].body.instructions, /不可信数据/)
})

test('embedded secrets are rejected before external model review', async () => {
  const secret = Buffer.from('---\nname: leaked\n---\n# leaked\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456')
  const result = await reviewSkillPackage(reviewInput({ buffer: secret }))
  assert.equal(result.verdict, 'reject')
  assert.equal(result.riskLevel, 'critical')
  assert.equal(result.reviewer, 'static')
  assert.equal(requests.length, 1)
})

test('safe zip is unpacked in memory and reviewed', async () => {
  const buffer = Buffer.from(zipSync({
    'safe-skill/SKILL.md': strToU8('---\nname: safe-skill\n---\n# Safe Skill'),
    'safe-skill/scripts/check.py': strToU8('print("review only")'),
  }))
  const result = await reviewSkillPackage(reviewInput({
    fileName: 'safe-skill.zip',
    extension: '.zip',
    buffer,
  }))
  assert.equal(result.verdict, 'allow')
  assert.equal(requests.length, 2)
  const reviewPayload = JSON.parse(requests[1].body.input)
  assert.deepEqual(reviewPayload.files.map((file) => file.name), [
    'safe-skill/SKILL.md',
    'safe-skill/scripts/check.py',
  ])
})

test('zip path traversal and unknown binaries are rejected locally', async () => {
  const traversal = Buffer.from(zipSync({
    '../SKILL.md': strToU8('# unsafe'),
  }))
  await assert.rejects(
    reviewSkillPackage(reviewInput({ fileName: 'unsafe.zip', extension: '.zip', buffer: traversal })),
    /不安全路径/,
  )

  const binary = Buffer.from(zipSync({
    'SKILL.md': strToU8('# unsafe'),
    'payload.exe': new Uint8Array([77, 90, 0, 0]),
  }))
  await assert.rejects(
    reviewSkillPackage(reviewInput({ fileName: 'binary.zip', extension: '.zip', buffer: binary })),
    /未知二进制文件/,
  )
  assert.equal(requests.length, 2)
})

test('required mode fails closed when the model reviewer is unavailable', async () => {
  await assert.rejects(
    reviewSkillPackage(reviewInput({ name: 'Force Service Failure' })),
    (error) => error?.status === 503 && /阻止发布/.test(error.message),
  )
})

test.after(async () => {
  await new Promise((resolve) => reviewer.close(resolve))
})
