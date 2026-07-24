<div align="center">

# 夜幕 AI 小说 🌙✨

![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)
![Node](https://img.shields.io/badge/node-22-green.svg)
![Python](https://img.shields.io/badge/python-3.12-blue.svg)
![React](https://img.shields.io/badge/React-19-61dafb.svg)
![FastAPI](https://img.shields.io/badge/FastAPI-0.139-009688.svg)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791.svg)
![Redis](https://img.shields.io/badge/Redis-7-DC382D.svg)
![License](https://img.shields.io/badge/license-私有-lightgrey.svg)

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
- 🔍 **可选联网搜索** — 夜雨可路由到 `story-search` 查询题材趋势与公开资料；Tavily 优先，零配置回退 DuckDuckGo
- 🔐 **双格式模型** — 支持 OpenAI 兼容与 Anthropic（Claude）两种格式，均可填自定义 Base URL 走代理
- 💾 **Redis 聊天记忆** — 夜雨会话持久化到 Redis（AOF），刷新或重启后可恢复；不可用时自动回退数据库
- 🐳 **Docker 一键部署** — Compose 编排 PostgreSQL + Redis + AI 服务 + Web API，开箱即用

## 📋 TODO List

### ✅ 已完成

- [x] **智能创建闭环** — AI 书名 / 题材 / 主线 / 章节大纲直接生成作品与初始章节，含重复提交与失败恢复
- [x] **结构化作品记忆** — 六类记忆 CRUD、批量确认、自动注入写作上下文、夜雨整理本章候选
- [x] **可审阅可撤销 AI 修改** — 逐段 diff、接受 / 拒绝、应用前快照、一键恢复、来源过期保护
- [x] **夜雨人格与创作协议** — 身份 / 路由 / 事实优先级 / 执行边界 / 质量底线三层提示词
- [x] **任务重试与防重复** — 幂等键去重、失败分类（超时 / 服务不可用 / 模型配置 / 上下文过长）、一键重试
- [x] **Redis 持久化聊天记忆** — AOF 持久化，不可用回退 JSON / Postgres
- [x] **联网搜索** — `story-search` 能力，Tavily 优先、DuckDuckGo 回退，不伪造结果
- [x] **双模型格式** — OpenAI 兼容 + Anthropic（Claude），含自定义 Base URL
- [x] **伏笔生命周期** — 计划 / 已埋入 / 已回收 / 已放弃，及三类章节关联
- [x] **PostgreSQL 过渡存储** — JSONB 单行保持 API 兼容，提供导入 / 导出 / 状态检查命令
- [x] **窄屏与移动端适配** — 三栏布局、工具栏、弹窗、章节菜单触屏优化

### 📝 规划中

- [ ] 将 `users / sessions / projects / chapters / drafts / ideas` 从 JSONB 状态逐表拆为关系表
- [ ] AI 任务执行从 Node 进程迁移到 Redis 队列和独立 worker，支持多副本扩展
- [ ] 增加 PostgreSQL Compose 集成测试和备份恢复演练
- [ ] 真实浏览器点击验收（Playwright / Puppeteer）

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

> Vite 会把 `/api` 请求代理到本地 API。本地不配置 `DATABASE_URL` 时，数据写入 `server/data/db.json`，无需单独安装 PostgreSQL。

### 生产运行

```bash
npm run build
npm start
```

生产环境由 Express 同时托管 API 和 `dist/` 前端资源，默认监听 `127.0.0.1:8787`（可用 `HOST` / `PORT` 修改）。设置 `DATABASE_URL` 后，完整状态存入 PostgreSQL 单行 JSONB，通过事务和行锁保证多进程写入安全。

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

Web API 默认暴露在 `http://127.0.0.1:8787`。Android 客户端只调用这个 HTTP API，不直接连接 PostgreSQL。Redis 用于持久化夜雨聊天记忆（AOF），AI 任务仍由 Node 进程执行，后续可迁移到独立 worker。

> **📌 注意事项**
>
> 1. `AUTH_SECRET` 必须设置，用于 JWT 签发与 API Key 加密
> 2. `WEB_ORIGIN` 用逗号分隔允许访问 API 的 Web 来源
> 3. 可选配置 `ANTHROPIC_*` / `TAVILY_API_KEY` 启用 Anthropic 默认与联网搜索

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
| `AI_SERVICE_TOKEN` | ✅ | Node 与 AI 服务间的内部令牌 |
| `AI_SERVICE_URL` | — | AI 服务地址，默认 `http://127.0.0.1:8890` |
| `DATABASE_URL` | — | PostgreSQL 连接串；留空用 JSON 文件 |
| `REDIS_URL` | — | Redis 连接串；留空回退数据库 |
| `OPENAI_*` | — | 服务端 OpenAI 默认（可被用户配置覆盖） |
| `ANTHROPIC_*` | — | 服务端 Anthropic 默认 |
| `TAVILY_API_KEY` | — | 联网搜索 Tavily key；留空回退 DuckDuckGo |

## 🧠 聊天记忆与联网搜索

- **Redis 持久化聊天记忆**：设置 `REDIS_URL` 后，夜雨会话（消息、需求、问题、阶段、建书方案）持久化到 Redis（AOF），刷新或重启 Node 后可恢复；Redis 不可用时自动回退到 JSON / Postgres。建书确认与项目创建仍走数据库事务。
- **联网搜索**：夜雨可路由到 `story-search` 能力查询题材趋势、平台热点或公开资料。配置 `TAVILY_API_KEY` 走 Tavily；留空则零配置回退 DuckDuckGo。只有真正发起过搜索才标记为已联网，网络失败时如实返回失败，不伪造结果。

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

**AI 调用**
- `POST /api/ai/agent/runs` — 通用 Story Agent 入口
- `POST /api/ai/tasks` · `GET /api/ai/tasks/:taskId` · `POST /api/ai/tasks/:taskId/cancel` · `POST /api/ai/tasks/:taskId/retry` — 可恢复、可重试的 AI 任务
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
# 提供真实 Redis 时，额外跑持久化与会话跨重启恢复测试
REDIS_TEST_URL=redis://127.0.0.1:6399/0 npm run test:unit
```

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
