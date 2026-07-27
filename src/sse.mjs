export function parseSseBlock(block) {
  let event = 'message'
  const data = []
  for (const rawLine of String(block || '').split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '')
    if (field === 'event') event = value || 'message'
    if (field === 'data') data.push(value)
  }
  return data.length ? { event, data: data.join('\n') } : null
}

export async function consumeSseStream(stream, onEvent) {
  if (!stream?.getReader) throw new Error('当前环境不支持流式任务事件')
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const event = parseSseBlock(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (event) await onEvent(event)
        boundary = buffer.indexOf('\n\n')
      }
      if (done) break
    }
    const trailing = parseSseBlock(buffer)
    if (trailing) await onEvent(trailing)
  } finally {
    reader.releaseLock()
  }
}
