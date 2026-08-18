// 桌面本地模式启动器
// ---------------------------------------------------------------
// 以「本地工作区」方式启动 YeMu 服务：
//   - AUTH_MODE=local      —— 免登录，所有请求走隐式本地用户
//   - 不配置 DATABASE_URL  —— 数据落本地 JSON（db.json）
//   - 不配置 REDIS_URL     —— AI 任务在 API 进程内执行，无需 worker
//   - AUTH_SECRET 持久化在数据目录 —— 本地保存的模型 Key 重启后仍可解密
// 默认监听 127.0.0.1 随机端口（实际端口写入 STORY_PORT_FILE）。
//
// 用法：
//   bun scripts/desktop-start.mjs            # 随机端口，保持运行
//   bun scripts/desktop-start.mjs --port 8787  # 固定端口（tauri dev 用）
//   bun scripts/desktop-start.mjs --open     # 启动并打开默认浏览器
//   DESKTOP_DATA_DIR=/path bun scripts/desktop-start.mjs
// ---------------------------------------------------------------
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = process.env.DESKTOP_DATA_DIR
  ? path.resolve(process.env.DESKTOP_DATA_DIR)
  : process.env.STORY_DATA_FILE
    ? path.dirname(path.resolve(process.env.STORY_DATA_FILE))
    : path.join(repoRoot, '.data', 'desktop')
const portFile = path.join(dataRoot, 'port.txt')
const authSecretFile = path.join(dataRoot, 'auth-secret')

function parseArgs(args) {
  const out = { open: args.includes('--open'), port: null }
  const index = args.indexOf('--port')
  if (index !== -1 && args[index + 1]) {
    const parsed = Number(args[index + 1])
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) out.port = parsed
    else throw new Error(`无效端口: ${args[index + 1]}`)
  }
  return out
}

async function ensureAuthSecret() {
  await fs.mkdir(dataRoot, { recursive: true })
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET
  try {
    const existing = (await fs.readFile(authSecretFile, 'utf8')).trim()
    if (existing.length >= 32) return existing
  } catch {
    // 不存在则生成
  }
  const generated = randomBytes(48).toString('base64url')
  await fs.writeFile(authSecretFile, generated, { encoding: 'utf8', mode: 0o600 })
  return generated
}

async function buildEnv(port) {
  return {
    ...process.env,
    AUTH_MODE: 'local',
    AUTH_SECRET: await ensureAuthSecret(),
    HOST: '127.0.0.1',
    PORT: port != null ? String(port) : '0', // 随机端口时写 STORY_PORT_FILE
    STORY_PORT_FILE: portFile,
    STORY_DATA_FILE: path.join(dataRoot, 'db.json'),
    STORY_SKILL_MARKET_DIR: process.env.STORY_SKILL_MARKET_DIR || path.join(dataRoot, 'skill-market'),
    AI_TASK_QUEUE_ENABLED: 'false',
    DATABASE_URL: '',
    REDIS_URL: '',
    WEB_ORIGIN: 'http://127.0.0.1',
    NODE_ENV: process.env.NODE_ENV || 'development',
    ...(process.env.ALLOW_SHARED_MODEL_KEY === undefined ? { ALLOW_SHARED_MODEL_KEY: 'false' } : {}),
  }
}

async function waitForPort(seconds = 30) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    try {
      const raw = (await fs.readFile(portFile, 'utf8')).trim()
      const value = Number(raw)
      if (Number.isInteger(value) && value > 0) return value
    } catch {
      // 尚未写入，等待
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`等待服务端口超时（${seconds}s 内未生成 ${portFile}）`)
}

const args = parseArgs(process.argv)
const bunRuntime = process.env.BUN_RUNTIME || process.execPath
const serverEntry = process.env.SERVER_ENTRY || path.join(repoRoot, 'server', 'index.mjs')

await fs.mkdir(dataRoot, { recursive: true })
const env = await buildEnv(args.port)
console.log(`[desktop] 数据目录: ${dataRoot}`)
console.log(`[desktop] 启动服务: ${bunRuntime} ${serverEntry}`)
const child = spawn(bunRuntime, [serverEntry], { env, stdio: 'inherit' })

let loggedReady = false
let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[desktop] 收到 ${signal}，正在退出`)
  if (!child.killed) child.kill('SIGTERM')
  setTimeout(() => process.exit(0), 500)
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(signal))

child.on('exit', (code) => {
  process.exit(loggedReady ? (code ?? 0) : 1)
})

try {
  const actualPort = await waitForPort()
  const url = `http://127.0.0.1:${actualPort}`
  console.log(`[desktop] 已就绪: ${url}`)
  loggedReady = true
  if (args.open) {
    const { open } = await import('./open-browser.mjs')
    await open(url)
  }
} catch (error) {
  console.error(`[desktop] 启动失败: ${error.message}`)
  child.kill('SIGTERM')
  process.exit(1)
}
