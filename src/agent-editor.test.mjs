import { expect, test } from 'bun:test'
import { tuiToolArgs, tuiToolNames, tuiToolResultText } from './agent-tool-args.mjs'

test('compacted story write arguments stay valid for the transcript renderer', () => {
  expect(tuiToolArgs({
    tool: 'write_story_file',
    arguments: { path: '设定/角色/夕日红.md', content_chars: 1280 },
  })).toEqual({
    file_path: '设定/角色/夕日红.md',
    content: '',
  })
})

test('tool cards prefer the real bounded output over their fixed summary', () => {
  expect(tuiToolResultText({
    status: 'completed',
    summary: '读取作品文件 · 设定/世界.md',
    meta: { output: '世界由七座浮空城组成。' },
  })).toBe('世界由七座浮空城组成。')
  expect(tuiToolNames.web_fetch).toBe('fetch')
})

test('compacted request input arguments use the compatible ask shape', () => {
  expect(tuiToolArgs({
    tool: 'request_user_input',
    arguments: { questions: 2 },
  })).toEqual({
    question: '等待确认 2 项信息',
    options: [],
  })
})
