export const tuiToolNames = {
  list_story_files: 'glob',
  read_story_file: 'read',
  write_story_file: 'write',
  edit_story_file: 'edit',
  read_story_skill: 'read',
  request_user_input: 'ask',
  submit_story_result: 'resolve',
}

export function tuiToolArgs(item) {
  const args = item.arguments || item.meta?.arguments || {}
  const tool = tuiToolNames[item.tool] || item.tool || 'tool'
  if (tool === 'write') {
    return {
      file_path: args.path,
      content: typeof args.content === 'string' ? args.content : '',
    }
  }
  if (tool === 'edit') return { ...args, file_path: args.path }
  if (tool === 'read') return { ...args, file_path: args.path }
  if (tool === 'glob') return { ...args, pattern: args.prefix ? `${args.prefix}/**/*` : '**/*' }
  if (tool === 'ask' && !Array.isArray(args.questions)) {
    const questionCount = Math.max(1, Number(args.questions) || 1)
    return {
      question: questionCount > 1 ? `等待确认 ${questionCount} 项信息` : '等待用户确认',
      options: [],
    }
  }
  return args
}
