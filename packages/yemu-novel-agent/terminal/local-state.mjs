import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function statePath(cwd = process.cwd()) {
  return process.env.NOVEL_AGENT_STATE || path.join(cwd, '.novel-agent', 'session.json')
}

export async function loadLocalState(cwd = process.cwd()) {
  try {
    const raw = await readFile(statePath(cwd), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export async function saveLocalState(state, cwd = process.cwd()) {
  const target = statePath(cwd)
  await mkdir(path.dirname(target), { recursive: true })
  const safe = {
    apiBase: state.apiBase || undefined,
    email: state.email || undefined,
    projectId: state.projectId || undefined,
    chapterId: state.chapterId == null ? undefined : String(state.chapterId),
    lastTaskId: state.lastTaskId || undefined,
  }
  await writeFile(target, `${JSON.stringify(safe, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}
