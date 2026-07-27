<div align="center">

# 夜幕 AI 小说 🌙✨

![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)
![Node](https://img.shields.io/badge/node-22-green.svg)
![Python](https://img.shields.io/badge/python-3.12-blue.svg)
![React](https://img.shields.io/badge/React-19-61dafb.svg)
![FastAPI](https://img.shields.io/badge/FastAPI-0.140-009688.svg)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791.svg)
![Redis](https://img.shields.io/badge/Redis-7-DC382D.svg)
![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)

**面向网文作者的 AI 创作工作台 · 让「夜雨」陪你把一个想法写成一本小说**

[特性](#-特性) • [快速开始](#-快速开始) • [配置说明](#️-配置说明) • [项目结构](#-项目结构)

</div>

---

## ✨ 特性

- 🤖 **统一创作入口** — 左侧「夜雨」是对话式助手：先听你的想法，再确认篇幅、题材、流派和故事核心，自动生成可编辑建书方案
- 📝 **章节化写作** — 章节大纲、正文、编辑历史与写作统计独立保存，支持自动保存、撤销重做、智能分章、导入导出
- 🧠 **持续作品记忆** — 六类长期事实（角色状态 / 已发生事件 / 世界规则 / 章节摘要 / 不可违背事实 / 语言习惯）自动进入写作上下文，防止长篇写崩设定
- ✏️ **可审阅 AI 修改** — AI 改写先变成逐段 diff，按段接受或拒绝、显示修改原因；应用前自动建立快照，可一键恢复
- 🪝 **伏笔生命周期** — 登记伏笔的分类、重要性、埋入章节、计划回收与实际回收章节，未回收伏笔自动进入上下文
- 🔍 **可选联网搜索** — 夜雨对话框旁的「联网搜索」开关打开后，先检索再回答，跟主流 AI 助手一致；Tavily 优先，零配置回退 DuckDuckGo
- 🔐 **双格式模型** — 支持 OpenAI 兼容与 Anthropic（Claude）两种格式，均可填自定义 Base URL 走代理
- 💾 **Redis 聊天记忆** — 夜雨会话持久化到 Redis（AOF），刷新或重启后可恢复；不可用时自动回退数据库
- 🐳 **Docker 一键部署** — Compose 编排 PostgreSQL + Redis + AI 服务 + Web API，开箱即用


> 💡 欢迎提交 Issue 或 Pull Request！

## 💻 环境要求

| 组件 | 最低要求 | 说明 |
|------|---------|------|
| **Node.js** | 22+ | API 网关与前端构建 |
| **Python** | 3.12+ | AI 服务（FastAPI + LangGraph） |
| **PostgreSQL** | 16（可选） | 生产存储；本地开发可用 JSON 文件回退 |
| **Redis** | 7（可选） | 聊天记忆持久化；未配置则回退数据库 |
| **AI API Key** | 必需 | OpenAI 兼容或 Anthropic，至少一个 |

> **📌 说明**：本项目依赖外部 AI API，不需要本地 GPU。本地开发不配置 `DATABASE_URL` 和 `REDIS_URL` 时，全部回退到 `server/data/db.json`，零依赖即可跑通。

## 🚀 快速开始

### 前置要求

- Node.js 22+、Python 3.12+
- 至少一个 AI 服务的 API Key（OpenAI 兼容或 Anthropic）

### 本地开发

```bash
# 1. 克隆项目
git clone https://github.com/rtiy1/YeMuAINoval.git
cd YeMuAINoval

# 2. 准备 AI 服务依赖
python3 -m venv .venv
.venv/bin/pip install -r ai-service/requirements.txt

# 3. 安装前端依赖
npm install

# 4. 配置环境变量
cp .env.example .env
# 至少为 AUTH_SECRET 设置一个随机值
```

分别启动 API、AI 和前端：

```bash
npm run dev:api   # API 网关  http://127.0.0.1:8787
npm run dev:ai    # AI 服务  http://127.0.0.1:8890
npm run dev       # 前端     http://127.0.0.1:5173
```

也可以使用只面向小说创作的终端 Agent。它复用同一账号、模型设置、作品、章节和长期记忆：

```bash
npm run novel
```

终端提供作品/章节上下文切换、写作、审稿、去 AI 味、长短篇分析与扫描、联网资料搜索，以及写入前确认和历史恢复。完整命令见 [`terminal/README.md`](terminal/README.md)。

> Vite 会把 `/api` 请求代理到本地 API。本地不配置 `DATABASE_URL` 时，数据写入 `server/data/db.json`，无需单独安装 PostgreSQL。

### 生产运行

```bash
npm run build
npm start
```

生产环境由 Express 同时托管 API 和 `dist/` 前端资源，默认监听 `127.0.0.1:8787`（可用 `HOST` / `PORT` 修改）。设置 `DATABASE_URL` 后，用户、会话、作品、章节、正文和素材写入关系表，其余兼容状态保留在版本化 JSONB 中；写操作通过事务保证一致性。

## 🐳 Docker Compose 部署

生产部署可直接使用 PostgreSQL + Redis + AI 服务 + Web API 的 Compose 编排：

```bash
cp .env.docker.example .env
# 编辑 .env，至少替换：
#   AUTH_SECRET        随机密钥
#   POSTGRES_PASSWORD  数据库密码
#   AI_SERVICE_TOKEN   内部服务令牌
docker compose up -d --build
docker compose ps
```

Redis 使用 AOF，Linux 部署机应启用内存 overcommit，避免后台重写在内存紧张时失败：

```bash
sudo sysctl -w vm.overcommit_memory=1
# 并在 /etc/sysctl.conf 中持久化：vm.overcommit_memory = 1
```

Web API 默认只绑定宿主机 `127.0.0.1:8787`。Android 客户端只调用这个 HTTP API，不直接连接 PostgreSQL。Redis 同时持久化夜雨聊天记忆（AOF）和 AI Stream 任务，独立 worker 负责执行任务。

生产环境应在 app 前配置 HTTPS 反向代理，并把 `WEB_ORIGIN` 设置为实际站点来源。刷新令牌 Cookie 在生产模式带 `Secure`，不应直接把明文 HTTP 端口暴露到公网。Compose 默认按一层代理设置 `TRUST_PROXY=1`；若确实需要改变监听地址，可设置 `APP_BIND`。

> **📌 注意事项**
>
> 1. `AUTH_SECRET` 必须设置，用于 JWT 签发与 API Key 加密
> 2. `WEB_ORIGIN` 用逗号分隔允许访问 API 的 Web 来源
> 3. 可选配置 `ANTHROPIC_*` / `TAVILY_API_KEY` 启用 Anthropic 默认与联网搜索

`AUTH_SECRET` 必须与数据库备份一起妥善保管并保持不变；更换后，已有登录会话会失效，数据库中已加密的用户模型 Key 也无法解密。

本站默认采用 BYOK：每位用户在设置中保存自己的模型 Key。`ALLOW_SHARED_MODEL_KEY=false` 会禁止回退到服务端模型 Key；`REGISTRATION_MODE=owner-only` 允许空数据库中的首位站长注册，之后自动关闭注册。AI 默认不设每日次数额度，但保留每分钟速率和并发限制保护 worker，可通过 `AI_*_LIMIT` 调整。

## 🗄️ 数据存储与迁移

<details>
<summary>📄 JSON 迁移到 PostgreSQL</summary>

先停止会写入旧 JSON 文件的服务。若 PostgreSQL 可从宿主机访问：

```bash
DATABASE_URL=postgresql://story:password@127.0.0.1:5432/story_studio npm run db:import-json
DATABASE_URL=postgresql://story:password@127.0.0.1:5432/story_studio npm run db:status
DATABASE_URL=postgresql://story:password@127.0.0.1:5432/story_studio npm run db:export-json -- /tmp/story-backup.json
```

使用本项目 Compose 时，PostgreSQL 默认只加入内部网络，推荐通过一次性 app 容器导入：

```bash
docker compose up -d postgres
docker compose run --rm --no-deps \
  -v "$(pwd)/server/data/db.json:/tmp/story-db.json:ro" \
  app npm run db:import-json -- /tmp/story-db.json
docker compose run --rm --no-deps app npm run db:status
```

`db:import-json` 是状态替换操作，适合首次迁移或恢复备份；启用 `DATABASE_URL` 后服务不再读取 `server/data/db.json`。

备份与恢复：

```bash
npm run db:backup -- backups/story-studio.dump
RESTORE_CONFIRM=1 npm run db:restore -- backups/story-studio.dump
npm run test:postgres
```

恢复脚本会暂时停止 app 与 worker，并且无论恢复成功或失败都会重新拉起服务。建议用 cron 或平台定时任务执行备份，并把备份复制到异机对象存储。

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
| **Max Tokens** | 最大输出 token 数（Anthropic 必填，未填默认 4096） |
| **上下文窗口** | 模型上下文窗口大小，用于自动截断超长输入 |

调用 Skill 时，Node 网关读取用户配置透传给 AI 服务，按服务商选择 `ChatOpenAI` 或 `ChatAnthropic`，并覆盖服务端 `.env` 默认值。

### 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `AUTH_SECRET` | ✅ | JWT 签发与 API Key 加密密钥（≥32 字符） |
| `WEB_ORIGIN` | ✅ | 允许访问 API 的 Web 来源，逗号分隔 |
| `TRUST_PROXY` | — | Express 信任的反向代理层数；Compose 默认 `1` |
| `AI_SERVICE_TOKEN` | ✅ | Node 与 AI 服务间的内部令牌 |
| `AI_SERVICE_URL` | — | AI 服务地址，默认 `http://127.0.0.1:8890` |
| `DATABASE_URL` | — | PostgreSQL 连接串；留空用 JSON 文件 |
| `REDIS_URL` | — | Redis 连接串；留空回退数据库 |
| `ALLOW_SHARED_MODEL_KEY` | — | 是否允许用户回退服务端模型 Key；BYOK 部署保持 `false` |
| `REGISTRATION_MODE` | — | `open` / `owner-only` / `closed` |
| `AI_DAILY_REQUEST_LIMIT` | — | 每用户 24 小时额度；`0` 表示不限 |
| `AI_CONCURRENT_REQUEST_LIMIT` | — | 每用户并发 AI 请求与任务上限 |
| `AI_REQUESTS_PER_MINUTE` | — | 每用户 AI HTTP 请求速率上限 |
| `SKILL_REVIEW_MODE` | — | Skill 市场审查模式：生产建议 `required`，本地可用 `optional` |
| `SKILL_REVIEW_API_URL` | 生产 ✅ | 专用安全审查模型的完整接口地址 |
| `SKILL_REVIEW_API_KEY` | 生产 ✅ | 专用审查密钥，仅保存在服务端环境变量 |
| `SKILL_REVIEW_MODEL` | 生产 ✅ | 专用安全审查模型 ID |
| `SKILL_REVIEW_API_STYLE` | — | `responses`（默认）或 `chat-completions` |
| `SKILL_REVIEW_TIMEOUT_MS` | — | 单次 Skill 安全审查超时，默认 45000 ms |
| `OPENAI_*` | — | 服务端 OpenAI 默认（可被用户配置覆盖） |
| `ANTHROPIC_*` | — | 服务端 Anthropic 默认 |
| `TAVILY_API_KEY` | — | 联网搜索 Tavily key；留空回退 DuckDuckGo |

`SOURCE_REPOSITORY_URL` 是 Docker 构建参数，用于页面中的“源代码”入口。部署修改版时，应将它改为能够取得该修改版完整对应源码的公开地址。

### Skill 市场安全审查

上传的 Skill 会先经过路径穿越、压缩炸弹、符号链接、未知二进制与秘密信息检查，再提交给专用模型进行结构化安全审查。模型需要给出 `allow` / `reject`、风险级别、可核验证据和修复建议；只有 `allow` 且不存在高危或严重发现时才会发布。生产 Compose 默认使用 `SKILL_REVIEW_MODE=required`，审查服务未配置、超时或返回异常时均会阻止发布。

`SKILL_REVIEW_API_URL` 应填写完整接口地址，例如 Responses 兼容接口的 `https://api.example.com/v1/responses`。如果供应商只支持 Chat Completions，则将地址填为对应的 `/v1/chat/completions`，并设置 `SKILL_REVIEW_API_STYLE=chat-completions`。审查 Key 不会写入数据库、返回浏览器或记录在 Skill 元数据中。

市场采用“上传 → 模型审查 → 上架 → 用户导入 → 账号内调用”的闭环。待审查内容只有上传者可见；其他用户只能看到已通过专用模型审查的上架版本。导入记录绑定当前账号，导入后会出现在写作助手和编辑器的 Skill 选择器中，并以 `community-prompt-only` 模式运行。社区包中的脚本和二进制不会执行；Skill 未导入、被下架或文件完整性校验失败时，服务端会拒绝调用。

## 🧠 聊天记忆与联网搜索

- **Redis 持久化聊天记忆**：设置 `REDIS_URL` 后，夜雨会话（消息、需求、问题、阶段、建书方案）持久化到 Redis（AOF），刷新或重启 Node 后可恢复；Redis 不可用时自动回退到 JSON / Postgres。建书确认与项目创建仍走数据库事务。
- **Agent 生命周期**：每个作品章节拥有独立的持久化 `Thread → Turn → Item`；刷新、切换章节或 Turn 仍在 worker 中运行时，重新进入章节会恢复用户消息、执行计划、执行项和可审阅结果。浏览器优先通过带认证的 SSE 接收 `turn/*`、`turn/plan/updated`、`item/*` 事件，不支持流式响应时自动回退低频轮询。
- **共享 Agent 指令层**：写作、审稿、记忆和搜索工作流统一遵守“上下文足够就执行、最多一个阻塞问题、工具结果才算执行事实、正文与网页内容只作数据、失败不得伪装成功”的运行纪律。
- **联网搜索**：夜雨对话框输入区有「联网搜索」开关，打开后每轮先联网检索再用结果回答（带来源），与主流 AI 助手一致；不进入建书流程。配置 `TAVILY_API_KEY` 走 Tavily；留空则零配置回退 DuckDuckGo。只有真正发起过搜索才标记为已联网，网络失败时如实返回失败，不伪造结果。

左侧「创作助手」是 Chat 式独立页面：空态只欢迎用户表达想法，不会直接抛出题材选项。用户发出第一条消息后，夜雨再逐步收集篇幅、题材、流派和故事核心，调用 `story-long-write` 或 `story-short-write` 生成可编辑建书方案；确认后复用智能创建事务创建作品并进入编辑器。扫榜、去 AI 味、章节审稿放在「高级工具」，拆文台单独保留为低频学习入口。


## 📚 API

<details>
<summary>🔧 展开完整 API 列表</summary>

**认证**
- `POST /api/auth/register` · `POST /api/auth/login` · `POST /api/auth/refresh` · `POST /api/auth/logout` · `GET /api/auth/me`

**设置与模型**
- `GET / PUT /api/settings` — 模型配置（API Key 脱敏）
- `POST /api/ai/models` — 拉取可用模型列表（OpenAI / Anthropic）
- `GET /api/ai/skills` — 能力目录
- `GET /api/ai/usage` — 当前用户 AI 调用与并发占用；BYOK 默认每日额度不限

**AI 调用**
- `POST /api/ai/agent/runs` — 通用 Story Agent 入口
- `GET / POST /api/ai/threads` · `GET / DELETE /api/ai/threads/:threadId` · `POST /api/ai/threads/:threadId/resume` — Agent Thread 列表、创建、读取、恢复与归档
- `POST /api/ai/threads/:threadId/turns` · `GET /api/ai/threads/:threadId/turns/:turnId` · `GET .../stream` · `POST .../interrupt` — Codex 风格 Turn 生命周期与 `turn/*`、`item/*` SSE 事件
- `POST /api/ai/tasks` · `GET /api/ai/tasks/:taskId` · `GET /api/ai/tasks/:taskId/stream` · `POST /api/ai/tasks/:taskId/cancel` · `POST /api/ai/tasks/:taskId/retry` — worker Task 兼容层与重试接口
- `POST /api/ai/reviews/chapter` — 章节诊断

**创作助手**
- `GET / POST / DELETE /api/writing-assistant/session` — 持久化会话（Redis 优先）
- `POST /api/writing-assistant/confirm` — 确认建书方案

**作品与章节**
- `GET / POST /api/projects` · `POST /api/projects/smart` · `POST /api/projects/import` · `GET / PATCH / DELETE /api/projects/:projectId`
- `GET / POST /api/projects/:projectId/chapters` · `PATCH / DELETE .../chapters/:chapterId`
- `GET / PUT /api/projects/:projectId/chapters/:chapterId/draft` — 章节正文
- `GET / POST /api/projects/:projectId/chapters/:chapterId/history` — 编辑快照
- `GET /api/projects/:projectId/chapters/:chapterId/context` — 写作上下文

**素材与连续性**
- `GET / POST /api/ideas` · `PATCH / DELETE /api/ideas/:ideaId`
- `GET / POST / PATCH / DELETE /api/foreshadows` — 伏笔生命周期
- `GET / POST / PATCH / DELETE /api/story-memories` — 六类作品长期记忆
- `POST /api/projects/:projectId/chapters/:chapterId/memory-candidates` — 夜雨整理本章记忆候选项

**统计**
- `GET /api/dashboard` — 累计字数、今日 / 本周新增、活跃天数、近七天曲线

</details>

## 🛠️ Story Skill 能力

项目内的 `skills/` 是 oh-story-claudecode Skills 的 vendored 副本，Python 服务默认从这里读取 Skill manifest（可用 `STORY_SKILLS_ROOT` 指向另一份兼容目录）。

| Skill | Executor | 状态 |
|-------|----------|------|
| `story` | `router-v1` | ✅ ready |
| `story-review` | `langgraph-solo-v1` | ✅ ready |
| `story-search` | `search-v1` | ✅ ready（联网搜索） |
| `story-deslop` | `deslop-v1` | ⚠️ needs_model |
| `story-long/short-write` 等 8 个 | `prompt-only-v1` | ⚠️ needs_model |
| `story-cover` / `browser-cdp` | — | 🔧 registered（需适配器） |

执行 prompt-only Skill 时会**按需自动加载 SKILL.md 中引用的 references**（默认 200KB 字节预算截断），所有 references 和 scripts 通过路径安全校验自动允许访问。通用调用入口是 `POST /api/ai/agent/runs`：传入 `message`，可选 `skill` 和 `payload`。

## ✅ 验证

```bash
npm test
```

冒烟测试在临时目录启动独立 API，覆盖输入校验与核心 CRUD，结束后自动删除测试数据。`test:unit` 还覆盖编辑建议 diff 与聊天记忆序列化的纯函数。

```bash
# 提供已有 Redis 时，单独跑持久化与会话跨重启恢复测试
REDIS_TEST_URL=redis://127.0.0.1:6399/0 npm run test:unit

# 使用隔离的 Compose 项目完整验证 PostgreSQL、Redis、worker 与备份恢复
npm run test:postgres
```

GitHub Actions 会在推送与 Pull Request 中自动执行完整测试、生产构建和 Compose 集成验证。

## 📄 许可证

本项目源代码采用 [GNU Affero General Public License v3.0 only](LICENSE)

## 📁 项目结构

```
YeMuAINoval/
├── src/                # React + Vite 前端
├── server/             # Node.js Express API 网关（状态拥有者）
│   ├── index.mjs       # 路由、领域模型、上下文构建、任务
│   ├── store.mjs       # JSON / PostgreSQL 聚合存储
│   └── chat-memory.mjs # Redis 聊天记忆
├── ai-service/         # Python FastAPI AI 服务（无状态）
│   └── app/
│       ├── workflows/  # 助手、写作、记忆、审稿
│       └── skills/     # 能力注册、prompt-only、搜索、deslop
├── skills/             # vendored Story Skill 契约
└── docker-compose.yml  # PostgreSQL + Redis + AI + Web
```

---

<div align="center">

**夜雨** · 一个克制、敏锐、有文学判断力的创作搭档

如果这个项目对你有帮助，欢迎 ⭐ Star 支持

</div>
