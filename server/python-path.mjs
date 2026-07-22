import { existsSync } from 'node:fs'
import path from 'node:path'

export function resolvePython(rootDir) {
  const candidates = process.platform === 'win32'
    ? [path.join(rootDir, '.venv', 'Scripts', 'python.exe')]
    : [path.join(rootDir, '.venv', 'bin', 'python'), path.join(rootDir, '.venv', 'bin', 'python3')]
  return candidates.find((candidate) => existsSync(candidate)) || (process.platform === 'win32' ? 'python' : 'python3')
}
