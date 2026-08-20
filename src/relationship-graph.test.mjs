import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRelationshipLayout,
  relationshipEdgeCurve,
  relationshipGraphText,
  relationshipKind,
  relationshipRoleKind,
} from './relationship-graph.mjs'

test('classifies common Chinese relationship labels', () => {
  assert.equal(relationshipKind({ label: '青梅竹马，彼此倾慕' }), 'romance')
  assert.equal(relationshipKind({ label: '同父异母的兄妹' }), 'kinship')
  assert.equal(relationshipKind({ label: '结盟的战友' }), 'alliance')
  assert.equal(relationshipKind({ label: '宿敌' }), 'conflict')
  assert.equal(relationshipKind({ label: '旧识' }), 'neutral')
})

test('classifies character roles for visual emphasis', () => {
  assert.equal(relationshipRoleKind({ role: '女主角' }), 'lead')
  assert.equal(relationshipRoleKind({ role: '幕后反派' }), 'antagonist')
  assert.equal(relationshipRoleKind({ role: '主角军师' }), 'lead')
  assert.equal(relationshipRoleKind({ role: '重要配角' }), 'support')
  assert.equal(relationshipRoleKind({ role: '神秘旅人' }), 'neutral')
})

test('builds a deterministic bounded layout with degrees', () => {
  const nodes = [
    { id: 'a', name: '阿蘅', role: '女主角' },
    { id: 'b', name: '柏舟', role: '重要配角' },
    { id: 'c', name: '长庚', role: '反派' },
    { id: 'd', name: '冬青', role: '旅人' },
  ]
  const edges = [
    { source: 'a', target: 'b', label: '同伴' },
    { source: 'a', target: 'c', label: '宿敌' },
    { source: 'a', target: 'd', label: '旧识' },
  ]

  const firstLayout = buildRelationshipLayout(nodes, edges)
  const secondLayout = buildRelationshipLayout(nodes, edges)

  assert.deepEqual(firstLayout, secondLayout)
  assert.equal(firstLayout.find((node) => node.id === 'a').degree, 3)
  assert.equal(firstLayout.find((node) => node.id === 'b').degree, 1)
  firstLayout.forEach((node) => {
    assert.ok(node.x >= 76 && node.x <= 844)
    assert.ok(node.y >= 52 && node.y <= 568)
  })
})

test('creates curved paths and truncates graph labels by characters', () => {
  const curve = relationshipEdgeCurve(
    { x: 100, y: 120 },
    { x: 300, y: 260 },
    { source: 'a', target: 'b', label: '并肩作战' },
    0,
  )

  assert.match(curve.path, /^M 100 120 Q /)
  assert.ok(Number.isFinite(curve.labelX))
  assert.ok(Number.isFinite(curve.labelY))
  assert.equal(relationshipGraphText('沈砚之与叶晚', 4), '沈砚之与')
})
