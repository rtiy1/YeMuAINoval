const MODEL_ICON_RULES = [
  { pattern: /deep[\s._-]?seek/, file: 'deepseek-color.svg' },
  { pattern: /claude|anthropic/, file: 'claude-color.svg' },
  { pattern: /gemini/, file: 'gemini-color.svg' },
  { pattern: /gemma/, file: 'gemma-color.svg' },
  { pattern: /qwen|qwq|tongyi|dashscope|alibaba/, file: 'qwen-color.svg' },
  { pattern: /chatglm|(^|[\s/_.-])glm|zhipu|bigmodel/, file: 'chatglm-color.svg' },
  { pattern: /kimi|moonshot/, file: 'kimi-color.svg' },
  { pattern: /minimax|(^|[\s/_.-])abab/, file: 'minimax-color.svg' },
  { pattern: /doubao|bytedance|volcengine|seedream|(^|[\s/_.-])seed[\s/_.-]/, file: 'doubao-color.svg' },
  { pattern: /stepfun|(^|[\s/_.-])step[\s/_.-]/, file: 'stepfun-color.svg' },
  { pattern: /grok|(^|[\s/_.-])xai([\s/_.-]|$)/, file: 'grok.svg' },
  { pattern: /mistral|mixtral|codestral|pixtral/, file: 'mistral-color.svg' },
  { pattern: /llama|(^|[\s/_.-])meta([\s/_.-]|$)/, file: 'meta-color.svg' },
  { pattern: /ollama/, file: 'ollama.svg' },
  { pattern: /openrouter/, file: 'openrouter-color.svg' },
  { pattern: /siliconflow|siliconcloud/, file: 'siliconcloud-color.svg' },
  { pattern: /perplexity|(^|[\s/_.-])sonar([\s/_.-]|$)/, file: 'perplexity-color.svg' },
  { pattern: /cohere|command[\s._-]?r/, file: 'cohere-color.svg' },
  { pattern: /bedrock/, file: 'bedrock-color.svg' },
  { pattern: /azure/, file: 'azure-color.svg' },
  { pattern: /hunyuan|tencent/, file: 'hunyuan-color.svg' },
  { pattern: /baichuan/, file: 'baichuan-color.svg' },
  { pattern: /(^|[\s/_.-])(yi|lingyi)([\s/_.-]|$)|01[\s._-]?ai/, file: 'yi-color.svg' },
  { pattern: /(^|[\s/_.-])(gpt|o1|o3|o4|codex|chatgpt|openai)([\s/_.-]|$)/, file: 'openai.svg' },
]

export function resolveModelIcon(model) {
  const value = String(model || '').trim().toLowerCase()
  if (!value) return ''
  return MODEL_ICON_RULES.find(({ pattern }) => pattern.test(value))?.file || ''
}
