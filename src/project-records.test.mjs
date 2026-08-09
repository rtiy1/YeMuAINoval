import { expect, test } from 'bun:test'
import { recordsWithoutProject } from './project-records.mjs'

test('removes every client-side record associated with a deleted project', () => {
  const records = [
    { id: 'material-1', projectId: 'project-1' },
    { id: 'material-2', projectId: 'project-2' },
    { id: 'global-material', projectId: null },
  ]

  expect(recordsWithoutProject(records, 'project-1')).toEqual([
    { id: 'material-2', projectId: 'project-2' },
    { id: 'global-material', projectId: null },
  ])
})
