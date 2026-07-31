<div align="center">

# 叙事工坊 · YeMu AI Novel 🌙

![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)
![Bun](https://img.shields.io/badge/Bun-1.3.14+-f9f1e1.svg)
![React](https://img.shields.io/badge/React-19-61dafb.svg)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791.svg)
![Redis](https://img.shields.io/badge/Redis-7-DC382D.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

**Web 优先的 AI 小说创作工作台 · 让「夜雨」陪你把想法持续写成作品**

[特性](#-特性) • [快速开始](#-快速开始) • [配置说明](#️-配置说明) • [API](#-api) • [项目结构](#-项目结构) • [致谢](#-致谢)

</div>

---

## ✨ 特性

- 🌐 **Web 创作工作台** — 产品直接运行在浏览器中，章节目录、正文编辑器与右侧「夜雨」Agent 同屏，自动带入当前作品和章节上下文
- 🤖 **Agent 编辑器** — 以 `Thread → Turn → Item` 渲染流式回复、思考摘要、执行计划和工具项；需要确认时直接在 Web 端显示选项卡与自定义输入
- 📝 **章节化写作** — 章节大纲、正文、编辑历史与写作统计独立保存，支持自动保存、撤销重做、章节拆分、TXT 导入与整书导出
- 🧠 **持续作品记忆** — 六类长期事实（角色状态 / 已发生事件 / 世界规则 / 章节摘要 / 不可违背事实 / 语言习惯）自动进入写作上下文，防止长篇写崩设定
- ✏️ **可审阅 AI 修改** — AI 改写以逐项 diff 呈现，可分别接受或拒绝并查看修改原因；应用前保留正文快照，可一键恢复
- 🪝 **伏笔生命周期** — 登记伏笔的分类、重要性、埋入章节、计划回收与实际回收章节，未回收伏笔自动进入上下文
- 🔍 **可选联网搜索** — 工作台 Agent 开启「联网」后先检索再回答；Tavily 优先，零配置回退 DuckDuckGo
- 👥 **双子 Agent 协作** — 可切换单 / 多智能体模式；协作模式由两个子 Agent 并行分析，再交给夜雨结合报告完成最终回复
- 🔐 **双格式模型** — 支持 OpenAI 兼容与 Anthropic（Claude）两种格式，均可填自定义 Base URL 走代理
- 💾 **可恢复 Agent 会话** — 每个作品章节可保存多个 Thread，刷新页面或切换章节后仍能恢复 Turn、Item、追问答案与执行结果
- 🧩 **安全 Skill 市场** — 社区 Skill 经过文件规则与专用模型双重审查后发布，导入后以受限的 prompt-only 模式运行
- ⚙️ **内嵌 Agent Runtime** — Bun API 进程直接调用仓库内的 YeMu Agent Runtime，无额外 Python AI 网关

> 💡 欢迎提交 Issue 或 Pull Request！

## 💻 环境要求

| 组件 | 最低要求 | 说明 |
|------|---------|------|
| **Bun** | 1.3.14+ | API、Agent Runtime、测试与前端构建 |
| **PostgreSQL** | 16（可选） | 生产存储；本地开发可用 JSON 文件回退 |
| **Redis** | 7（可选） | 聊天记忆持久化；未配置则回退数据库 |
| **AI API Key** | 使用 AI 时必需 | 可由用户在设置中保存，也可配置服务端共享 Key |

> **📌 说明**：本项目依赖外部 AI API，不需要本地 GPU。本地开发不配置 `DATABASE_URL` 和 `REDIS_URL` 时，全部回退到 `server/data/db.json`，零依赖即可跑通。

## 🚀 快速开始

### 前置要求

- Bun 1.3.14+
- 使用 AI 功能时，需要一个 OpenAI 兼容或 Anthropic API Key

### 本地开发

```bash
# 1. 克隆项目
git clone https://github.com/rtiy1/YeMuAINoval.git
cd YeMuAINoval

# 2. 安装工作区依赖
bun install --frozen-lockfile

# 3. 配置环境变量
cp .env.example .env
# 至少将 AUTH_SECRET 替换为不少于 32 字符的随机值
```

分别启动 API 和前端：

```bash
bun run dev:api   # API + Agent Runtime  http://127.0.0.1:8787
bun run dev       # Web 前端             http://127.0.0.1:5173
```

启动后可访问 API 健康检查 `http://127.0.0.1:8787/api/health`。默认采用 BYOK，注册登录后在「设置」中保存模型 Key 即可；若要使用 `.env` 中的服务端默认 Key，还需设置 `ALLOW_SHARED_MODEL_KEY=true`。

如果同时配置了 `DATABASE_URL`、`REDIS_URL` 且未关闭 `AI_TASK_QUEUE_ENABLED`，还要单独启动任务 worker：

```bash
bun run dev:worker
```

只想让 Redis 保存聊天记忆、仍使用本地 JSON 数据时，请设置 `AI_TASK_QUEUE_ENABLED=false`，此时 AI 任务继续由 API 进程执行，不要启动 worker。

> Vite 会把 `/api` 请求代理到本地 API。本地不配置 `DATABASE_URL` 时，数据写入 `server/data/db.json`，无需单独安装 PostgreSQL。

### 生产运行

```bash
bun run build
bun run start
```

生产环境由 Express 同时托管 API 和 `dist/` 前端资源，默认监听 `127.0.0.1:8787`（可用 `HOST` / `PORT` 修改）。设置 `DATABASE_URL` 后，用户、会话、作品、章节、正文和素材写入关系表，其余兼容状态保留在版本化 JSONB 中；写操作通过事务保证一致性。

## 🌐 生产部署

当前主线不包含旧的 Docker Compose / Python AI 服务部署栈。生产环境先执行 `bun run build`，再以 `bun run start` 启动同时托管 API 与 `dist/` 的 Bun 服务；PostgreSQL、Redis 和 HTTPS 反向代理按部署平台提供。

公网部署应将 `HOST` 设为平台要求的监听地址，在服务前配置 HTTPS，并把 `WEB_ORIGIN` 与 `APP_PUBLIC_URL` 设置为实际站点地址。刷新令牌 Cookie 默认按请求协议自动设置 `Secure`：HTTPS 会启用，直接 HTTP 部署也能恢复会话，但不应把明文 HTTP 端口暴露到公网。反向代理层数通过 `TRUST_PROXY` 设置。

> **📌 注意事项**
>
> 1. `AUTH_SECRET` 必须设置，用于 JWT 签发与 API Key 加密
> 2. `WEB_ORIGIN` 用逗号分隔允许访问 API 的 Web 来源
> 3. 可选配置 `ANTHROPIC_*` / `TAVILY_API_KEY` 启用 Anthropic 默认与联网搜索

`AUTH_SECRET` 必须与数据库备份一起妥善保管并保持不变；更换后，已有登录会话会失效，数据库中已加密的用户模型 Key 也无法解密。

本站默认采用 BYOK：每位用户在设置中保存自己的模型 Key。`ALLOW_SHARED_MODEL_KEY=false` 会禁止回退到服务端模型 Key；`REGISTRATION_MODE=owner-only` 允许空数据库中的首位站长通过邮箱验证码注册，之后自动关闭注册。生产环境只要允许注册，就必须配置邮件发送。AI 默认不设每日次数额度，但会限制每分钟请求数和单用户并发任务数，可通过 `AI_*_LIMIT` 调整。

## 🗄️ 数据存储与迁移

<details>
<summary>📄 JSON 迁移到 PostgreSQL</summary>

先停止会写入旧 JSON 文件的服务。若 PostgreSQL 可从宿主机访问：

```bash
DATABASE_URL=postgresql://story:password@127.0.0.1:5432/story_studio bun run db:import-json
DATABASE_URL=postgresql://story:password@127.0.0.1:5432/story_studio bun run db:status
DATABASE_URL=postgresql://story:password@127.0.0.1:5432/story_studio bun run db:export-json -- /tmp/story-backup.json
```

`db:import-json` 是状态替换操作，适合首次迁移或恢复备份；启用 `DATABASE_URL` 后服务不再读取 `server/data/db.json`。

生产环境应使用 PostgreSQL 平台或 `pg_dump` / `pg_restore` 制定定期备份策略，并把备份复制到异机对象存储。

</details>

## ⚙️ 配置说明

### 模型配置

在前端「设置」页面自定义 LLM 调用参数，配置按用户加密存储在服务端：

| 配置项 | 说明 |
|--------|------|
| **服务商** | `OpenAI 兼容` 或 `Anthropic（Claude）`；两者均可填自定义 Base URL 走代理 |
| **API Base URL** | OpenAI / Anthropic 兼容地址，留空使用各自官方 API |
| **API Key** | 加密存储（AES-256-GCM，复用 `AUTH_SECRET`），返回时脱敏 |
| **模型名** | 手动输入或点击「获取模型列表」从对应 API 拉取 |
| **Temperature** | 0-2，控制生成随机性 |
| **Max Tokens** | 最大输出 token 数，未填写时默认 4096 |
| **上下文窗口** | 模型上下文窗口大小，用于自动截断超长输入 |

调用 Skill 时，Bun API 读取用户配置并交给进程内的 YeMu Agent Runtime，按服务商选择 OpenAI Completions 或 Anthropic Messages 传输，并可覆盖服务端 `.env` 默认值。

### 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `NODE_ENV` | 生产 ✅ | 生产部署设为 `production` |
| `HOST` / `PORT` | — | Bun 服务监听地址和端口，默认 `127.0.0.1:8787` |
| `AUTH_SECRET` | ✅ | JWT 签发与 API Key 加密密钥（≥32 字符） |
| `VITE_API_URL` | — | Web 构建时的 API 地址；留空使用同源 `/api` |
| `WEB_ORIGIN` | 生产 ✅ | 允许访问 API 的 Web 来源，逗号分隔 |
| `APP_PUBLIC_URL` | 生产 ✅ | 邮件中密码重置链接使用的 HTTPS 站点地址 |
| `ACCESS_TOKEN_TTL_MINUTES` | — | 访问令牌有效期，默认 60 分钟 |
| `REFRESH_SESSION_DAYS` | — | 可滚动续期的登录会话有效期，默认 90 天 |
| `REFRESH_COOKIE_SECURE` | — | `auto` / `true` / `false`，默认按实际请求协议决定 |
| `REFRESH_COOKIE_SAME_SITE` | — | `lax` / `strict` / `none`，跨站前后端需 HTTPS 并设为 `none` |
| `EMAIL_PROVIDER` | 允许注册时 ✅ | 生产使用 `resend`；本地可用 `console` 查看验证码和重置链接 |
| `RESEND_API_KEY` | Resend ✅ | Resend 服务端 API Key |
| `EMAIL_FROM` | Resend ✅ | 已验证域名的发件人地址 |
| `EMAIL_VERIFICATION_CODE_TTL_MINUTES` | — | 注册邮箱验证码有效期，默认 10 分钟 |
| `PASSWORD_RESET_TOKEN_TTL_MINUTES` | — | 单次密码重置链接有效期，默认 30 分钟 |
| `TRUST_PROXY` | — | Express 信任的反向代理层数或 `false` |
| `STORY_DATA_FILE` | — | JSON 回退存储路径，默认 `server/data/db.json` |
| `DATABASE_URL` | 生产建议 | PostgreSQL 连接串；留空使用 JSON 文件 |
| `DATABASE_POOL_MAX` / `DATABASE_SSL` | — | PostgreSQL 连接池大小与 SSL 开关 |
| `REDIS_URL` | — | 写作助手会话与任务队列连接串；留空回退 JSON / PostgreSQL |
| `AI_TASK_QUEUE_ENABLED` | — | 配置 Redis 时是否启用独立任务队列；默认 `true`，启用时还需要 PostgreSQL 和 worker |
| `AI_TASK_CLAIM_IDLE_MS` | — | worker 接管失联任务前的等待时间，最小且默认 180000 ms |
| `AI_TASK_CLAIM_INTERVAL_MS` | — | worker 扫描失联任务的间隔，最小 10000 ms、默认 30000 ms |
| `ALLOW_SHARED_MODEL_KEY` | — | 是否允许用户回退服务端模型 Key；BYOK 部署保持 `false` |
| `REGISTRATION_MODE` | — | `open` / `owner-only` / `closed`；生产默认 `owner-only` |
| `AI_DAILY_REQUEST_LIMIT` | — | 每用户 24 小时额度；`0` 表示不限 |
| `AI_CONCURRENT_REQUEST_LIMIT` | — | 每用户并发 AI 请求与任务上限 |
| `AI_REQUESTS_PER_MINUTE` | — | 每用户 AI HTTP 请求速率上限 |
| `SKILL_REVIEW_MODE` | — | Skill 市场审查模式：生产建议 `required`，本地可用 `optional` |
| `SKILL_REVIEW_API_URL` | 发布 Skill 时 ✅ | 专用安全审查模型的完整接口地址 |
| `SKILL_REVIEW_API_KEY` | 发布 Skill 时 ✅ | 专用审查密钥，仅保存在服务端环境变量 |
| `SKILL_REVIEW_MODEL` | 发布 Skill 时 ✅ | 专用安全审查模型 ID |
| `SKILL_REVIEW_API_STYLE` | — | `responses`（默认）或 `chat-completions` |
| `SKILL_REVIEW_TIMEOUT_MS` | — | 单次 Skill 安全审查超时，默认 45000 ms |
| `OPENAI_*` | — | 服务端 OpenAI 默认（可被用户配置覆盖） |
| `ANTHROPIC_*` | — | 服务端 Anthropic 默认 |
| `TAVILY_API_KEY` | — | 联网搜索 Tavily key；留空回退 DuckDuckGo |

### Skill 市场安全审查

上传的 Skill 会先经过路径穿越、压缩炸弹、符号链接、未知二进制与秘密信息检查，再提交给专用模型进行结构化安全审查。模型需要给出 `allow` / `reject`、风险级别、可核验证据和修复建议；只有 `allow` 且不存在高危或严重发现时才会发布。生产环境应使用 `SKILL_REVIEW_MODE=required`，审查服务未配置、超时或返回异常时均会阻止发布。

`SKILL_REVIEW_API_URL` 应填写完整接口地址，例如 Responses 兼容接口的 `https://api.example.com/v1/responses`。如果供应商只支持 Chat Completions，则将地址填为对应的 `/v1/chat/completions`，并设置 `SKILL_REVIEW_API_STYLE=chat-completions`。审查 Key 不会写入数据库、返回浏览器或记录在 Skill 元数据中。

市场采用“上传 → 模型审查 → 上架 → 用户导入 → 账号内调用”的闭环。待审查内容只有上传者可见；其他用户只能看到已通过专用模型审查的上架版本。导入记录绑定当前账号，导入后会出现在工作台 Agent 的 Skill 列表中，并以 `community-prompt-only` 模式运行。社区包中的脚本和二进制不会执行；Skill 未导入、被下架或文件完整性校验失败时，服务端会拒绝调用。

## 🧠 工作台 Agent 与联网搜索

- **Agent 生命周期**：每个作品章节可保存多个持久化 `Thread`，每个 `Turn` 由消息、思考摘要、计划、工具调用、结构化追问和修改建议等 `Item` 组成。任务可在 API 进程内执行，也可通过 Redis 交给独立 worker；重新进入章节会恢复当前状态。
- **Web 交互渲染**：浏览器通过带认证的 SSE 接收 `turn/*`、`turn/plan/updated` 与 `item/*` 事件，不支持流式响应时自动回退轮询。计划选择、补充问题和 diff 审阅均由 Web 前端直接渲染，无需 TUI 或桌面客户端。
- **上下文与控制**：Agent 自动携带当前作品、章节正文和选区，也可附加其他章节、素材、伏笔、作品记忆与本地文本文件；输入区可切换模型、思考强度、单 / 多智能体和联网搜索。
- **共享 Agent 指令层**：写作、审稿、记忆和搜索工作流统一遵守“上下文足够就执行、最多一个阻塞问题、工具结果才算执行事实、正文与网页内容只作数据、失败不得伪装成功”的运行纪律。
- **联网搜索**：打开工作台输入区的「联网」开关后，每轮先检索再结合来源回答。配置 `TAVILY_API_KEY` 时使用 Tavily，留空则回退 DuckDuckGo；网络失败时会直接报告错误。

Web 端当前以「工作台」为创作入口：新建空白作品或导入本地 TXT 后，在章节右侧直接完成续写、审稿、自然化润色、资料检索和指定 Story Skill 调用。

## 📚 API

<details>
<summary>🔧 展开主要 API 列表</summary>

**认证**
- `POST /api/auth/register/code` — 发送注册邮箱验证码
- `POST /api/auth/register` · `POST /api/auth/login` · `POST /api/auth/refresh` · `POST /api/auth/logout` · `GET /api/auth/me`
- `POST /api/auth/password/forgot` · `POST /api/auth/password/reset` — 申请并完成密码重置

**设置与模型**
- `GET /api/settings` · `PUT /api/settings` — 模型配置（API Key 脱敏）
- `POST /api/ai/models` — 拉取可用模型列表（OpenAI / Anthropic）
- `GET /api/ai/skills` — 能力目录
- `GET /api/ai/usage` — 当前用户 AI 调用与并发占用；BYOK 默认每日额度不限

**AI 调用**
- `POST /api/ai/agent/runs` — 通用 Story Agent 入口
- `GET /api/ai/threads` · `POST /api/ai/threads` · `GET / PATCH / DELETE /api/ai/threads/:threadId` · `POST /api/ai/threads/:threadId/resume` — Agent Thread 列表、创建、读取、重命名、恢复与归档
- `POST /api/ai/threads/:threadId/turns` · `GET /api/ai/threads/:threadId/turns/:turnId` · `GET .../stream` · `POST .../input` · `POST .../regenerate` · `POST .../steer` · `POST .../interrupt` — Turn 生命周期与 `turn/*`、`item/*` SSE 事件
- `GET /api/ai/tasks` · `POST /api/ai/tasks` · `GET /api/ai/tasks/:taskId` · `GET .../stream` · `POST .../cancel` · `POST .../retry` · `POST .../artifacts/apply` — 异步 Task、流式状态、重试和产物应用接口
- `POST /api/ai/reviews/chapter` — 章节诊断

**Skill 市场**
- `GET /api/skill-market` · `POST /api/skill-market` — 浏览或上传社区 Skill
- `GET /api/skill-market/:skillId/download` · `POST .../review` · `POST / DELETE .../install` · `DELETE /api/skill-market/:skillId` — 下载、复审、导入、移除与删除

**引导式创作会话**
- `GET / DELETE /api/writing-assistant/session` · `POST /api/writing-assistant/messages` — 读取、清空或继续持久化建书会话
- `POST /api/writing-assistant/confirm` — 确认并创建建书方案

**作品与章节**
- `GET /api/projects` · `POST /api/projects` · `POST /api/projects/smart` · `POST /api/projects/import` · `GET / PATCH / DELETE /api/projects/:projectId`
- `GET /api/projects/:projectId/chapters` · `POST /api/projects/:projectId/chapters` · `PATCH / DELETE .../chapters/:chapterId`
- `GET /api/projects/:projectId/chapters/:chapterId/draft` · `PUT /api/projects/:projectId/chapters/:chapterId/draft` — 章节正文
- `GET /api/projects/:projectId/chapters/:chapterId/history` · `POST /api/projects/:projectId/chapters/:chapterId/history` — 编辑快照
- `GET /api/projects/:projectId/chapters/:chapterId/context` — 写作上下文

**素材与连续性**
- `GET /api/ideas` · `POST /api/ideas` · `PATCH / DELETE /api/ideas/:ideaId`
- `GET /api/foreshadows` · `POST /api/foreshadows` · `PATCH / DELETE /api/foreshadows/:foreshadowId` — 伏笔生命周期
- `GET /api/story-memories` · `POST /api/story-memories` · `POST /api/story-memories/batch` · `PATCH / DELETE /api/story-memories/:memoryId` — 六类作品长期记忆
- `POST /api/projects/:projectId/chapters/:chapterId/memory-candidates` — 夜雨整理本章记忆候选项

**统计**
- `GET /api/dashboard` — 累计字数、今日 / 本周新增、活跃天数、近七天曲线

</details>

## 🛠️ Story Skill 能力

项目内的根目录 `skills/` 是 oh-story-claudecode Skills 的 vendored 副本，这个位置是运行时约定而不是独立 workspace：`src/agent-runtime.ts` 从仓库根定位 `skills/*/SKILL.md`，Bun API 再以受限工具加载所需的引用文件。部署时需要保留完整仓库工作区，至少不能拆开 `skills/`、`src/`、`server/` 与运行时依赖的 `packages/`。

| 能力 | 内置 Skill |
|------|------------|
| 路由与准备 | `story`、`story-setup` |
| 长短篇创作 | `story-long-write`、`story-short-write` |
| 分析与趋势 | `story-long-analyze`、`story-short-analyze`、`story-long-scan`、`story-short-scan` |
| 审稿与润色 | `story-review`、`story-deslop` |
| 导入与检索 | `story-import`、`story-search` |
| 扩展能力 | `story-cover`、`browser-cdp` |

运行时当前会自动发现 15 个内置 Skill；`GET /api/ai/skills` 会根据当前用户是否已配置模型，将可用状态返回为 `ready` 或 `needs_model`。执行时通过受限读取工具**按需加载 `SKILL.md` 中引用的 references**，不会向 Story Agent 暴露不受限文件系统或 Shell。通用调用入口是 `POST /api/ai/agent/runs`：传入 `message`，可选 `skill` 和 `payload`。

## ✅ 验证

```bash
bun run check
bun run test
bun run build
```

测试覆盖 Agent Thread / Turn / Item、前端 Item 渲染、结构化追问、编辑建议 diff、Cookie、SSE、Story Skills、聊天记忆和主要 API 配置。

```bash
# 提供已有 Redis 时，单独跑持久化与会话跨重启恢复测试
REDIS_TEST_URL=redis://127.0.0.1:6399/0 bun run test:unit
```

GitHub Actions 会在推送与 Pull Request 中自动执行类型检查、完整测试和生产构建。

## 📄 许可证

本项目源代码采用 [MIT License](LICENSE)。

## 📁 项目结构

```
YeMuAINoval/
├── src/                         # React + Vite Web 产品
│   ├── App.jsx                  # 创作工作台与页面状态
│   ├── agent-editor.jsx         # Thread / Turn / Item 助手编辑器
│   ├── agent-interactions.jsx   # 计划选项与 diff 审阅交互
│   ├── agent-runtime.ts         # 产品与内嵌 Agent Runtime 的边界
│   ├── editor-agent.mjs         # Web Agent 消息与结果适配
│   ├── platform.mjs             # 浏览器平台能力
│   └── prompts/                 # 静态模型提示词
├── server/                      # Bun + Express API 与生产静态服务
│   ├── index.mjs                # HTTP 路由、认证与服务编排
│   ├── store.mjs                # JSON / PostgreSQL 聚合存储
│   ├── agent-thread.mjs         # 持久化 Thread / Turn / Item 生命周期
│   ├── story-agent.mjs          # Story Agent 调用入口
│   ├── ai-worker.mjs            # Redis Stream 独立任务 worker
│   ├── chat-memory.mjs          # Redis 聊天记忆
│   ├── data/                    # 本地 JSON 数据与 Skill 市场文件
│   └── migrations/              # PostgreSQL 迁移
├── skills/                      # 根目录 Story Skills（运行时直接加载）
├── public/                      # Web 静态资源与模型图标
├── packages/                    # 内嵌 Agent、模型、TUI 与工具运行时
│   ├── agent/                   # 通用 Agent 状态与执行循环
│   ├── ai/                      # 模型服务商与流式协议
│   ├── catalog/                 # 模型目录
│   ├── coding-agent/            # Agent 工具与运行时实现
│   └── yemu-memory/             # 内嵌记忆能力
├── crates/                      # @yemu/native 使用的 Rust 源码
├── types/                       # 项目类型声明
├── patches/                     # Bun patchedDependencies 补丁
├── docs/                        # 内嵌运行时与项目专题文档
├── scripts/                     # 内嵌运行时构建与验证脚本
├── package.json                 # 根工作区与 Web 产品命令
├── vite.config.js               # Web 开发代理与生产构建
└── tsconfig.app.json            # Web 产品 TypeScript 配置
```

---

<div align="center">

**夜雨** · 一个克制、敏锐、有文学判断力的创作搭档

如果这个项目对你有帮助，欢迎 ⭐ Star 支持

</div>

## 🙏 致谢

- [oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode) — 感谢其提供完整的网文创作 Skills 与工作流，本项目的 Story Skills 基于该项目集成。
- [Codex](https://github.com/openai/codex) — 感谢其 Agent 工作流与协作体验为本项目的设计和持续迭代提供参考。
- [oh-my-pi](https://github.com/can1357/oh-my-pi) - 感谢其开源的Agent核心代码在本项目中的实践
