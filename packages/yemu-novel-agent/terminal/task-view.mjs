import { buildEditHunks } from '../src/edit-proposal.mjs'

export function changedTaskEvents(events, previous = new Map()) {
  const next = new Map(previous)
  const changed = []
  for (const event of Array.isArray(events) ? events : []) {
    const signature = `${event.status || ''}:${event.label || ''}:${event.completedAt || ''}`
    if (next.get(event.id) !== signature) changed.push(event)
    next.set(event.id, signature)
  }
  return { changed, next }
}

export function terminalDiffHunks(originalText, revisedText, blocks = []) {
  return buildEditHunks(originalText, revisedText, blocks).filter((hunk) => hunk.type !== 'equal')
}
