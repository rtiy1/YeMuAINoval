const RELATIONSHIP_KINDS = [
  { id: 'romance', label: '情感', shortLabel: '情' },
  { id: 'kinship', label: '亲缘', shortLabel: '亲' },
  { id: 'alliance', label: '同盟', shortLabel: '盟' },
  { id: 'conflict', label: '对立', shortLabel: '敌' },
  { id: 'neutral', label: '其他', shortLabel: '关' },
]

const RELATIONSHIP_KIND_PATTERNS = [
  ['romance', /love|romance|lover|spouse|marriage|爱|恋|夫妻|情侣|婚|暧昧|倾慕|心上人|未婚/i],
  ['kinship', /family|kin|parent|sibling|父|母|子|女|兄|弟|姐|妹|姑|舅|叔|姑|血缘|亲属|家族/i],
  ['conflict', /enemy|rival|conflict|hostile|betray|敌|仇|冲突|对立|背叛|追杀|宿敌|竞争|嫌隙/i],
  ['alliance', /ally|friend|partner|mentor|colleague|友|盟|同伴|搭档|战友|合作|师徒|同门|上下级|主仆|同僚/i],
]

function relationshipKind(edge) {
  const description = `${edge?.kind || ''} ${edge?.label || ''}`
  return RELATIONSHIP_KIND_PATTERNS.find(([, pattern]) => pattern.test(description))?.[0] || 'neutral'
}

function relationshipRoleKind(node) {
  const role = String(node?.role || '')
  if (/protagonist|lead|主角|主人公|男主|女主|核心/i.test(role)) return 'lead'
  if (/antagonist|villain|反派|对手|敌对/i.test(role)) return 'antagonist'
  if (/support|配角|同伴|导师|助手|军师/i.test(role)) return 'support'
  return 'neutral'
}

function relationshipGraphText(value, limit) {
  return Array.from(String(value || '').trim()).slice(0, limit).join('')
}

function graphHash(value) {
  let hash = 2166136261
  for (const character of String(value)) {
    hash ^= character.codePointAt(0) || 0
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function buildRelationshipLayout(nodes, edges, width = 920, height = 620) {
  if (!nodes.length) return []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const validEdges = edges.filter((edge) => nodeById.has(edge?.source) && nodeById.has(edge?.target) && edge.source !== edge.target)
  const degree = new Map(nodes.map((node) => [node.id, 0]))
  validEdges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1)
  })

  const orderedNodes = [...nodes].sort((a, b) => {
    const degreeDifference = (degree.get(b.id) || 0) - (degree.get(a.id) || 0)
    return degreeDifference || String(a.id).localeCompare(String(b.id), 'zh-CN')
  })
  const positions = new Map()
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  orderedNodes.forEach((node, index) => {
    if (index === 0) {
      positions.set(node.id, { x: width / 2, y: height / 2 })
      return
    }
    const offset = (graphHash(node.id) % 31) / 31
    const angle = index * goldenAngle + offset * 0.32
    const radius = Math.min(Math.min(width, height) * 0.39, 65 + Math.sqrt(index) * 64)
    positions.set(node.id, {
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius * 0.72,
    })
  })

  const idealDistance = Math.max(88, Math.min(152, Math.sqrt((width * height) / nodes.length) * 0.68))
  const horizontalPadding = 76
  const verticalPadding = 52
  const iterations = nodes.length > 70 ? 110 : 170

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const temperature = Math.max(0.35, (1 - iteration / iterations) * 4.2)
    const force = new Map(nodes.map((node) => [node.id, { x: 0, y: 0 }]))
    const push = (id, x, y) => {
      const current = force.get(id)
      if (!current) return
      current.x += x
      current.y += y
    }

    for (let first = 0; first < nodes.length; first += 1) {
      for (let second = first + 1; second < nodes.length; second += 1) {
        const firstPosition = positions.get(nodes[first].id)
        const secondPosition = positions.get(nodes[second].id)
        if (!firstPosition || !secondPosition) continue
        let deltaX = firstPosition.x - secondPosition.x
        let deltaY = firstPosition.y - secondPosition.y
        let distanceSquared = deltaX * deltaX + deltaY * deltaY
        if (distanceSquared < 1) {
          const angle = ((graphHash(`${nodes[first].id}:${nodes[second].id}`) % 360) * Math.PI) / 180
          deltaX = Math.cos(angle)
          deltaY = Math.sin(angle)
          distanceSquared = 1
        }
        const distance = Math.sqrt(distanceSquared)
        const repulsion = (idealDistance * idealDistance) / distance
        const forceX = (deltaX / distance) * repulsion
        const forceY = (deltaY / distance) * repulsion
        push(nodes[first].id, forceX, forceY)
        push(nodes[second].id, -forceX, -forceY)
      }
    }

    validEdges.forEach((edge) => {
      const source = positions.get(edge.source)
      const target = positions.get(edge.target)
      if (!source || !target) return
      const deltaX = target.x - source.x
      const deltaY = target.y - source.y
      const distance = Math.max(1, Math.sqrt(deltaX * deltaX + deltaY * deltaY))
      const attraction = (distance - idealDistance) * 0.085
      const forceX = (deltaX / distance) * attraction
      const forceY = (deltaY / distance) * attraction
      push(edge.source, forceX, forceY)
      push(edge.target, -forceX, -forceY)
    })

    nodes.forEach((node) => {
      const position = positions.get(node.id)
      if (!position) return
      push(node.id, (width / 2 - position.x) * 0.008, (height / 2 - position.y) * 0.008)
    })

    nodes.forEach((node) => {
      const position = positions.get(node.id)
      const nodeForce = force.get(node.id)
      if (!position || !nodeForce) return
      const forceLength = Math.sqrt(nodeForce.x * nodeForce.x + nodeForce.y * nodeForce.y)
      const scale = forceLength > temperature ? temperature / forceLength : 1
      position.x = Math.min(width - horizontalPadding, Math.max(horizontalPadding, position.x + nodeForce.x * scale))
      position.y = Math.min(height - verticalPadding, Math.max(verticalPadding, position.y + nodeForce.y * scale))
    })
  }

  return nodes.map((node) => ({
    ...node,
    degree: degree.get(node.id) || 0,
    roleKind: relationshipRoleKind(node),
    ...positions.get(node.id),
  }))
}

function relationshipEdgeCurve(source, target, edge, index = 0) {
  const deltaX = target.x - source.x
  const deltaY = target.y - source.y
  const distance = Math.max(1, Math.sqrt(deltaX * deltaX + deltaY * deltaY))
  const direction = graphHash(`${edge?.source}:${edge?.target}:${edge?.label}:${index}`) % 2 ? 1 : -1
  const bend = Math.min(42, Math.max(12, distance * 0.075)) * direction
  const controlX = (source.x + target.x) / 2 - (deltaY / distance) * bend
  const controlY = (source.y + target.y) / 2 + (deltaX / distance) * bend
  return {
    path: `M ${source.x} ${source.y} Q ${controlX} ${controlY} ${target.x} ${target.y}`,
    labelX: source.x * 0.25 + controlX * 0.5 + target.x * 0.25,
    labelY: source.y * 0.25 + controlY * 0.5 + target.y * 0.25,
  }
}

export {
  RELATIONSHIP_KINDS,
  buildRelationshipLayout,
  relationshipEdgeCurve,
  relationshipGraphText,
  relationshipKind,
  relationshipRoleKind,
}
