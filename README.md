# 夜幕小说智能体

这是夜幕 Agent 的产品层：React Web、Tauri 桌面端、Bun API、任务队列、作品数据与中文网络小说 Story Skills。

智能体执行层位于 `src/agent-runtime.ts`，直接使用仓库内的 `@yemu/agent-core`：

- 内置 model catalog 与多供应商传输
- AgentSession、自动重试、上下文压缩和流式事件
- 受限的 Story Skill 读取工具
- Web 端可恢复的用户追问
- 结构化正文建议、artifact 和审稿结果
- 独立的协作角色执行

旧 Python/LangGraph AI 服务已移除。

从仓库根目录运行：

```bash
bun install
bun run yemu:api
bun run dev
```

测试与构建：

```bash
bun run check
bun run test
bun run build
```

用户可在产品设置中配置 OpenAI 兼容或 Anthropic 模型。服务端共享模型凭据仅在 `ALLOW_SHARED_MODEL_KEY=true` 时启用。
