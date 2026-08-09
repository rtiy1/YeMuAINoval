function chapterChangeId(change) {
  const match = /^chapter:(.+)$/.exec(String(change?.id || ''))
  return match?.[1] || ''
}

export function changedChapterIds(application) {
  const changes = Array.isArray(application?.fileChanges) ? application.fileChanges : []
  return new Set(changes
    .filter((change) => change?.category === '正文' || /^chapter:/.test(String(change?.id || '')))
    .map(chapterChangeId)
    .filter(Boolean))
}

export function shouldRefreshActiveDraft(application, activeChapterId) {
  if (activeChapterId == null) return false
  return changedChapterIds(application).has(String(activeChapterId))
}

export function canReplaceActiveDraft({ activeKey, expectedKey, currentDraft, savedDraft }) {
  return activeKey === expectedKey && currentDraft === savedDraft
}
