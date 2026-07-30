function splitParagraphs(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim()
  return normalized ? normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean) : []
}

function lcsTable(left, right) {
  const table = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0))
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  return table
}

export function buildEditHunks(originalText, revisedText, reasons = []) {
  const original = splitParagraphs(originalText)
  const revised = splitParagraphs(revisedText)
  const table = lcsTable(original, revised)
  const operations = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < original.length || rightIndex < revised.length) {
    if (leftIndex < original.length && rightIndex < revised.length && original[leftIndex] === revised[rightIndex]) {
      operations.push({ type: 'equal', original: original[leftIndex], replacement: revised[rightIndex] })
      leftIndex += 1
      rightIndex += 1
    } else if (rightIndex < revised.length && (leftIndex === original.length || table[leftIndex][rightIndex + 1] >= table[leftIndex + 1][rightIndex])) {
      operations.push({ type: 'insert', original: '', replacement: revised[rightIndex] })
      rightIndex += 1
    } else {
      operations.push({ type: 'delete', original: original[leftIndex], replacement: '' })
      leftIndex += 1
    }
  }

  const hunks = []
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index]
    if (operation.type === 'delete' && operations[index + 1]?.type === 'insert') {
      hunks.push({ ...operation, type: 'replace', replacement: operations[index + 1].replacement })
      index += 1
    } else if (operation.type === 'insert' && operations[index + 1]?.type === 'delete') {
      hunks.push({ ...operation, type: 'replace', original: operations[index + 1].original })
      index += 1
    } else {
      hunks.push(operation)
    }
  }

  let reasonIndex = 0
  return hunks.map((hunk, index) => {
    if (hunk.type === 'equal') return { ...hunk, id: `hunk-${index}`, accepted: true, reason: '' }
    const matchingReason = reasons.find((item) => item.original === hunk.original && item.replacement === hunk.replacement)
    const reason = matchingReason?.reason || reasons[reasonIndex++]?.reason || ({ insert: '新增这一段内容。', delete: '删除这一段内容。', replace: '替换这一段内容。' }[hunk.type])
    return { ...hunk, id: `hunk-${index}`, accepted: true, reason }
  })
}

export function composeAcceptedText(hunks) {
  return (hunks || []).map((hunk) => {
    if (hunk.type === 'equal') return hunk.original
    return hunk.accepted ? hunk.replacement : hunk.original
  }).filter(Boolean).join('\n\n')
}

export { splitParagraphs }
