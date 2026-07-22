import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolvePython } from './python-path.mjs'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(serverDir, '..')
const python = resolvePython(rootDir)
const task = process.argv[2]

const args = task === 'dev'
  ? ['-m', 'uvicorn', 'app.main:app', '--app-dir', 'ai-service', '--host', '127.0.0.1', '--port', '8890']
  : task === 'test'
    ? ['-m', 'unittest', 'discover', '-s', 'ai-service/tests', '-v']
    : null

if (!args) {
  console.error('Usage: node server/ai-task.mjs <dev|test>')
  process.exit(1)
}

const child = spawn(python, args, { cwd: rootDir, stdio: 'inherit' })

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => {
  console.error(`无法启动 Python：${error.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
