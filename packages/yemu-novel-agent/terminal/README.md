# 夜雨小说终端 Agent

这是叙事工坊的小说专用终端入口。它借鉴成熟终端 Agent 的会话、斜杠命令、上下文选择、工具状态和写入确认体验，但只调用本项目已有的 Story Skills，不包含编程、Shell、Git、IDE、远程控制、MCP、插件市场或遥测能力。

## 启动

先启动 API 网关和 AI 服务：

```bash
npm run dev:ai
npm run dev:api
```

另开终端启动 Agent：

```bash
npm run novel
```

首次启动会询问叙事工坊账号和密码。密码只用于本次登录，不会写入本地；终端仅在 `.novel-agent/session.json` 保存 API 地址、邮箱和最近选择的作品/章节。

也可以通过环境变量提供登录信息：

```bash
NOVEL_AGENT_EMAIL=author@example.com \
NOVEL_AGENT_PASSWORD='your-password' \
npm run novel
```

## 主要工作流

```text
/projects                 列出并选择作品
/use 1
/chapters                 列出并选择章节
/chapter 3
/write 加强冲突，结尾停在证据反转
/apply                    确认后替换正文，原稿自动进入历史
/review                   审查当前章节
/polish                   去 AI 味，确认后才写入
/tasks                    查看最近任务及其状态
/task                     恢复跟踪最近一次任务
/cancel                   取消最近一次任务
/retry                    重试失败或已取消的任务
/undo                     恢复最近历史正文
```

普通文字会进入持久化创作助手会话；`/skill <名称> <要求>` 可直接调用指定 Story Skill。Skill 以服务端异步任务执行，终端会显示上下文、Skill 和结果事件；执行期间按 Ctrl+C 会取消服务端任务。最近任务 ID 会保存在本地，可在重启终端后用 `/task` 继续查看。输入 `/help` 查看完整命令。

## 非交互模式

适合脚本、编辑器任务或自动化调用：

```bash
npm run novel -- \
  --email author@example.com \
  --project 长夜将明 \
  --chapter 3 \
  --skill story-review \
  -p '重点检查人物动机和章末钩子'
```

加 `--json` 输出原始结构化结果。生产环境建议用 `NOVEL_AGENT_TOKEN` 或 `NOVEL_AGENT_PASSWORD`，不要把密钥直接写进命令历史。

## 写入边界

- 分析、扫描、审稿和普通对话不会写正文。
- `/write` 与 `/polish` 只生成建议稿；必须执行 `/apply` 才会写入。
- 正文建议会先以 ANSI 红色删除、绿色新增的形式展示变更。
- 应用前会重新读取当前正文。若网页端或其他终端已经修改原稿，本次应用会被拒绝。
- 每次替换正文前，服务端会自动保存历史版本；可用 `/undo` 恢复。
