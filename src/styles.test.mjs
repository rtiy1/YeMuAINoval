import { describe, expect, test } from 'bun:test'

const styles = await Bun.file(new URL('./styles.css', import.meta.url)).text()

function ruleBody(selector, from = 0) {
  const selectorStart = styles.indexOf(selector, from)
  expect(selectorStart).toBeGreaterThanOrEqual(0)
  const bodyStart = styles.indexOf('{', selectorStart)
  let depth = 1
  for (let index = bodyStart + 1; index < styles.length; index += 1) {
    if (styles[index] === '{') depth += 1
    if (styles[index] === '}') depth -= 1
    if (depth === 0) return styles.slice(bodyStart + 1, index)
  }
  throw new Error(`Unclosed CSS rule: ${selector}`)
}

describe('editor assistant styles', () => {
  test('keeps a reopen control visible on tablet widths', () => {
    const responsiveWorkspace = styles.indexOf('/* Persistent, resizable editor workspace */')
    expect(responsiveWorkspace).toBeGreaterThanOrEqual(0)
    const collapsed = ruleBody('.editor-page .agent-rail.collapsed', responsiveWorkspace)

    expect(collapsed).toContain('position: absolute')
    expect(collapsed).toContain('display: flex')
    expect(collapsed).not.toContain('display: none')
  })

  test('keeps the assistant palette dark-compatible and transcript controls flat', () => {
    const darkAssistant = styles.indexOf('/* The assistant owns denser UI than the editor')
    expect(darkAssistant).toBeGreaterThanOrEqual(0)
    const darkSession = ruleBody('.tui-agent-session,', darkAssistant)
    const flatTool = ruleBody('.yemu-collab-transcript .tv-card')
    const flatChoice = ruleBody('.tui-agent-shell .agent-choice-card')
    const webMode = ruleBody('.agent-mode-trigger.web.active')

    expect(darkSession).toContain('background: var(--tui-panel)')
    expect(flatTool).toContain('background: transparent')
    expect(flatTool).toContain('border: 0')
    expect(flatChoice).toContain('background: transparent')
    expect(webMode).toContain('background: #e9f5ef')
    expect(styles.slice(darkAssistant)).toContain("html[data-theme='dark'] .tui-agent-shell.collapsed .assistant-reopen")
  })
})
