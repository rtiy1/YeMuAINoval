import React from 'react'

/*
 * ── Client-side model output normalizer ──────────────────────────────
 * Models frequently ignore formatting rules and produce outputs like:
 *   核心设定-书名：《xxx》-题材/类型：xxx-目标平台：xxx
 *   ##核心设定表###基本信息-书名：xxx
 *
 * This pass cleans up the most common formatting errors BEFORE the
 * markdown block parser runs.  It does NOT try to be a full markdown
 * renderer — it only fixes patterns that would otherwise render as
 * unreadable walls of text.
 */

/** Split a line that crams field–value pairs with `-` separators. */
function splitCrammedFieldLine(line) {
  // Only act when a line has ≥2 `-`-separated `字段名：值` pairs.
  const fieldCount = (line.match(/[^\s-—]{1,20}[：:]/g) || []).length
  if (fieldCount < 2) return [line]
  // Don't touch headings, table rows, code fences, or list items.
  if (/^\s*(?:#{1,6}\s|[|`]|[-*+]\s|\d+[.)、]\s)/.test(line)) return [line]

  // Split on `-` where the next 1-20 non-whitespace chars include `：` or `:`.
  const parts = line.split(/-(?=[^\s-—]{1,25}[：:])/)
  if (parts.length < 2) return [line]

  return parts.map((part) => {
    const m = part.match(/^([^：:]{1,30})[：:](.+)$/)
    if (!m) return part.trim()
    const key = m[1].trim()
    const val = m[2].trim()
    // Use bold key in list item.
    return `- **${key}**：${val}`
  })
}

/** Detect a line that looks like a section label without `##` prefix. */
const SECTION_LABEL_RE = /^(核心设定|一句话梗概|主角设定|世界观骨架|后宫配置|核心冲突|副本世界规划|副本设计|卷纲|细纲|基本信息|力量体系|剧情单元|章节定位)(.*)$/

function normalizeModelOutput(text) {
  let s = String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r\n?/g, '\n')

  // ── 1. Fix headings: `##标题` → `## 标题` ──────────────────────────
  s = s.replace(/^(#{1,6})([^\s#])/gm, '$1 $2')

  // ── 2. Ensure blank lines before headings ───────────────────────────
  s = s.replace(/([^\n])\n(#{1,6}\s)/g, '$1\n\n$2')

  // ── 3. Promote section labels to `##` headings, splitting trailing
  //      crammed fields into the next line so step 4 can process them. ──
  s = s.split('\n').flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed) return ['']
    const m = trimmed.match(SECTION_LABEL_RE)
    if (!m) return [line]

    const label = m[1]
    let after = m[2].trim()

    // If the label is immediately followed by `-字段：` patterns, split
    // the heading onto its own line and let step 4 handle the fields.
    if (/^-[^\s-—]{1,25}[：:]/.test(after)) {
      const headingLine = `## ${label}`
      const fieldLine = after.replace(/^-/, '') // strip leading dash
      return [headingLine, fieldLine]
    }

    if (!after) return [`## ${label}`]
    // "一句话梗概" followed by actual sentence text → heading + paragraph.
    return [`## ${label}`, after]
  }).join('\n')

  // ── 4. Split crammed field–value lines into markdown lists ──────────
  s = s.split('\n').flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed) return ['']
    return splitCrammedFieldLine(trimmed)
  }).join('\n')

  // ── 5. Collapse ≥3 consecutive blank lines ─────────────────────────
  s = s.replace(/\n{4,}/g, '\n\n\n')

  return s
}

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
 * (with or without a space after `#`) into individual heading lines so the
 * block parser can give each its own <hN>.
 */
function expandCrowdedHeadings(line) {
  const trimmed = line.trim()
  // Count heading-like markers: 1-6 # followed by space+text OR directly by text.
  const headingPattern = /#{1,6}(?:\s+|[^\s#])/g
  const markers = [...trimmed.matchAll(headingPattern)]
  if (markers.length < 2) return [line]
  // Bail out if the line has table pipes, code fences, list bullets, or blockquotes.
  if (/[|`]/.test(trimmed) || /^\s*[-*+>]/.test(trimmed)) return [line]
  // Split before each heading marker, but not inside a # run.
  const parts = trimmed.split(/(?<!#)(?=#{1,6}(?:\s+|[^\s#]))/g).filter(Boolean)
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
  const source = normalizeModelOutput(String(value || ''))
    .replace(/^\s*<\/?proposed_plan>\s*$/gm, '')
  if (!source.trim()) return null
  // Expand lines that pack multiple `##Heading` markers onto one line,
  // then re-fix any headings that became new line-starts.
  const rawLines = source.split('\n')
  const lines = []
  for (const raw of rawLines) {
    if (!raw.trim()) { lines.push(''); continue }
    for (const part of expandCrowdedHeadings(raw)) {
      lines.push(part.replace(/^(#{1,6})([^\s#])/, '$1 $2'))
    }
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
