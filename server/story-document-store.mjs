import { applyStoryArtifacts } from './story-artifacts.mjs'
import { loadDb, updateDb } from './store.mjs'
import { readStoryFileForAgent } from './writing-context.mjs'

export function writeStoryDocumentToState(db, userId, projectId, file) {
  const application = applyStoryArtifacts(db, {
    userId,
    projectId,
    artifacts: { documents: [file] },
  })
  if (!application.applied || application.documents !== 1) {
    throw new Error('作品文件写入数据库失败')
  }
  return {
    file: readStoryFileForAgent(db, userId, projectId, file.path),
    application,
  }
}

export async function writeStoryDocument(userId, projectId, file) {
  return await updateDb((db) => writeStoryDocumentToState(db, userId, projectId, file))
}

export async function readStoryDocument(userId, projectId, path) {
  return readStoryFileForAgent(await loadDb(), userId, projectId, path)
}
