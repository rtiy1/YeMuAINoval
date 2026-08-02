import { expect, test } from 'bun:test'
import viteConfig from '../vite.config.js'

test('Vite deduplicates React across the app and collab-web workspace', () => {
  expect(viteConfig.resolve?.dedupe).toEqual(['react', 'react-dom'])
})
