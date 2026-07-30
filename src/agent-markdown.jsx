import React from 'react'

function inlineMarkdown(value, keyPrefix) {
  const source = String(value || '')
  // Handle bold, inline code, and italic.  Also strip stray <br> tags.
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g
  const nodes = []
  let cursor = 0
  let match
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) nodes.push(source.slice(cursor, match.index))
    const token = match[0]
    const key = `${keyPrefix}:${match.index}`
    if (token.startsWith('**')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    else nodes.push(<em key={key}>{token.slice(1, -1)}</em>)
    cursor = match.index + token.length
  }
  if (cursor < source.length) nodes.push(source.slice(cursor))
  return nodes
}

/*
 * Split a single line that crams multiple `##Heading` / `###Heading` markers
 * into individual heading lines so the block parser can give each its own <hN>.
 * Only fires when the whole line is composed of heading patterns (no tables,
 * code fences, lists, or blockquotes).
 */
function expandCrowdedHeadings(line) {
  const trimmed = line.trim()
  // Count heading-like markers: 1-6 # immediately followed by non-space/non-# text.
  const headingPattern = /#{1,6}[^\s#]/g
  const markers = [...trimmed.matchAll(headingPattern)]
  if (markers.length < 2) return [line]
  // Bail out if the line has table pipes, code fences, list bullets, or blockquotes.
  if (/[|`]/.test(trimmed) || /^\s*[-*+>]/.test(trimmed)) return [line]
  // Split on heading boundaries, but avoid splitting inside a # sequence
  // by requiring the position NOT be preceded by another #.
  const parts = trimmed.split(/(?<!#)(?=#{1,6}[^\s#])/g).filter(Boolean)
  return parts.length > 1 ? parts : [line]
}

function tableCells(line) {
  const cells = String(line || '').trim().split('|')
  if (cells[0]?.trim() === '') cells.shift()
  if (cells.at(-1)?.trim() === '') cells.pop()
  return cells.map((cell) => cell.trim())
}

function isTableDelimiter(line) {
  const cells = tableCells(line)
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

export default function AgentMarkdown({ value, streaming = false }) {
  const source = String(value || '')
    .replace(/^\s*<\/?proposed_plan>\s*$/gm, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r\n?/g, '\n')
  if (!source.trim()) return null
  // Expand lines that pack multiple `##Heading` markers onto one line.
  const rawLines = source.split('\n')
  const lines = []
  for (const raw of rawLines) {
    if (!raw.trim()) { lines.push(''); continue }
    for (const part of expandCrowdedHeadings(raw)) lines.push(part)
  }
  const blocks = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }
    if (/^```/.test(line.trim())) {
      const language = line.trim().slice(3).trim()
      const content = []
      index += 1
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        content.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push(<pre className="agent-markdown-code" key={`code:${index}`}><code data-language={language || undefined}>{content.join('\n')}</code></pre>)
      continue
    }
    if (index + 1 < lines.length && line.includes('|') && isTableDelimiter(lines[index + 1])) {
      const headers = tableCells(line)
      const rows = []
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index]))
        index += 1
      }
      blocks.push(<div className="agent-markdown-table-wrap" key={`table:${index}`}><table><thead><tr>{headers.map((cell, cellIndex) => <th key={`h:${cellIndex}`}>{inlineMarkdown(cell, `th:${cellIndex}`)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={`r:${rowIndex}`}>{headers.map((_, cellIndex) => <td key={`c:${cellIndex}`}>{inlineMarkdown(row[cellIndex] || '', `td:${rowIndex}:${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>)
      continue
    }
    const heading = line.match(/^(#{1,6})\s*(.+)$/)
    if (heading) {
      const level = Math.min(4, heading[1].length)
      const Heading = `h${level}`
      blocks.push(<Heading key={`heading:${index}`}>{inlineMarkdown(heading[2], `heading:${index}`)}</Heading>)
      index += 1
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = []
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ''))
        index += 1
      }
      blocks.push(<ul key={`ul:${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, `ul:${index}:${itemIndex}`)}</li>)}</ul>)
      continue
    }
    if (/^\s*\d+[.)、]\s+/.test(line)) {
      const items = []
      while (index < lines.length && /^\s*\d+[.)、]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)、]\s+/, ''))
        index += 1
      }
      blocks.push(<ol key={`ol:${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, `ol:${index}:${itemIndex}`)}</li>)}</ol>)
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push(<blockquote key={`quote:${index}`}>{quote.map((item, itemIndex) => <React.Fragment key={itemIndex}>{itemIndex > 0 && <br />}{inlineMarkdown(item, `quote:${index}:${itemIndex}`)}</React.Fragment>)}</blockquote>)
      continue
    }
    const paragraph = [line]
    index += 1
    while (
      index < lines.length
      && lines[index].trim()
      && !/^(#{1,6})\s*/.test(lines[index])
      && !/^\s*(?:[-*+]|\d+[.)、])\s+/.test(lines[index])
      && !/^\s*>\s?/.test(lines[index])
      && !/^```/.test(lines[index].trim())
      && !(index + 1 < lines.length && lines[index].includes('|') && isTableDelimiter(lines[index + 1]))
    ) {
      paragraph.push(lines[index])
      index += 1
    }
    blocks.push(<p key={`p:${index}`}>{paragraph.map((item, itemIndex) => <React.Fragment key={itemIndex}>{itemIndex > 0 && <br />}{inlineMarkdown(item, `p:${index}:${itemIndex}`)}</React.Fragment>)}</p>)
  }

  return <div className={`agent-markdown ${streaming ? 'streaming' : ''}`}>{blocks}{streaming && <span className="agent-stream-cursor" aria-hidden="true" />}</div>
}
