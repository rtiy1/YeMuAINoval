export function recordsWithoutProject(records, projectId) {
  const items = Array.isArray(records) ? records : []
  return items.filter((item) => String(item?.projectId ?? '') !== String(projectId ?? ''))
}
