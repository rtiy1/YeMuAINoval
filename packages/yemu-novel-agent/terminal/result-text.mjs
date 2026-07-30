const PRIMARY_TEXT_KEYS = ['reply', 'output', 'text', 'content', 'summary', 'message', 'revised_text']

export function contentToText(value, seen = new Set()) {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.map((item) => contentToText(item, seen)).filter(Boolean).join('\n').trim()
  }
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return ''
  seen.add(value)

  for (const key of PRIMARY_TEXT_KEYS) {
    if (Object.hasOwn(value, key)) {
      const text = contentToText(value[key], seen)
      if (text) return text
    }
  }
  if (Object.hasOwn(value, 'result')) {
    const text = contentToText(value.result, seen)
    if (text) return text
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
}

export function extractAgentText(response) {
  const candidates = [
    response?.reply,
    response?.result?.message,
    response?.result?.summary,
    response?.result?.output,
    response?.result,
    response?.message,
    response,
  ]
  for (const candidate of candidates) {
    const text = contentToText(candidate)
    if (text) return text
  }
  return 'Agent 没有返回可显示的文本。'
}

export function extractWritableText(response) {
  const result = response?.result && typeof response.result === 'object' ? response.result : response
  const candidates = [
    result?.edit_proposal?.revised_text,
    result?.output,
    result?.revised_text,
  ]
  for (const candidate of candidates) {
    const text = contentToText(candidate)
    if (text) return text
  }
  return ''
}

export function errorText(error, fallback = '请求失败') {
  if (error instanceof Error && error.message && error.message !== '[object Object]') return error.message
  const text = contentToText(error)
  return text && text !== '[object Object]' ? text : fallback
}
