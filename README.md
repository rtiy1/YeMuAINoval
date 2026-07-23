# 叙事工坊 Web

面向网文作者的创作工作台。前端使用 React + Vite，业务后端使用 Node.js + Express，AI 工作流使用 Python + FastAPI + LangGraph。编辑器支持章节切换保护、自动保存、真实字数统计、章节上下文编排、伏笔生命周期管理，以及从素材库把人物/设定/剧情片段插入光标位置。

账号系统采用短期 JWT 访问令牌和可轮换的 HttpOnly 刷新令牌。密码使用 Node.js `scrypt` 加盐哈希，作品数据按用户隔离。

## 本地开发

分别启动后端和前端：

```bash
npm run dev:api
npm run dev:ai
npm run dev
```

- Web: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:8787/api/health`
- AI: `http://127.0.0.1:8890/health`

Vite 会把 `/api` 请求代理到本地 API。

## 生产运行

```bash
npm run build
npm start
```

生产环境由 Express 同时托管 API 和 `dist/` 前端资源。默认监听 `127.0.0.1:8787`，可以通过 `HOST` 和 `PORT` 修改。

数据默认写入 `server/data/db.json`。使用 `STORY_DATA_FILE` 可以指定其他数据文件。设置 `DATABASE_URL` 后，服务会把完整状态存入 PostgreSQL 的单行 JSONB，并通过事务和行锁保证多进程写入安全；HTTP API 不变，后续可以再逐步拆成用户、作品、章节等关系表。

部署前需要设置 `AUTH_SECRET`；`WEB_ORIGIN` 用逗号分隔允许访问 API 的 Web 来源。可参考 `.env.example`。

### Docker Compose

生产部署可以直接使用 PostgreSQL、Redis、AI 服务和 Web API 的 Compose 编排：

```bash
cp .env.docker.example .env
# 编辑 .env，至少替换 AUTH_SECRET、POSTGRES_PASSWORD、AI_SERVICE_TOKEN
docker compose up -d --build
docker compose ps
```

Web API 默认暴露在 `http://127.0.0.1:8787`。Android 客户端只调用这个 HTTP API，不直接连接 PostgreSQL。Redis 已作为任务队列的基础设施预留，当前 AI 任务仍由 Node 进程执行，后续可迁移到独立 worker。

### JSON 迁移到 PostgreSQL

先停止会写入旧 JSON 文件的服务。若 PostgreSQL 已经能从宿主机访问，可以直接执行：

```bash
DATABASE_URL=postgresql://story:password@127.0.0.1:5432/story_studio npm run db:import-json
DATABASE_URL=postgresql://story:password@127.0.0.1:5432/story_studio npm run db:status
DATABASE_URL=postgresql://story:password@127.0.0.1:5432/story_studio npm run db:export-json /tmp/story-backup.json
```

使用本项目 Compose 时，PostgreSQL 默认只加入内部网络，更推荐通过一次性 app 容器导入：

```bash
docker compose up -d postgres
docker compose run --rm --no-deps \
  -v "$(pwd)/server/data/db.json:/tmp/story-db.json:ro" \
  app npm run db:import-json -- /tmp/story-db.json
docker compose run --rm --no-deps app npm run db:status
```

`db:import-json` 是状态替换操作，适合第一次迁移或恢复备份；启用 `DATABASE_URL` 后服务不会再读取 `server/data/db.json`。

## API

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/settings` — 获取当前用户的 LLM 模型配置（API Key 脱敏返回）
- `PUT /api/settings` — 更新模型配置（API Base URL、API Key、模型名、Temperature、Max Tokens、上下文窗口）
- `POST /api/ai/models` — 用当前配置的 API 拉取可用模型列表
- `POST /api/ai/reviews/chapter`
- `GET /api/ai/skills`
- `POST /api/ai/agent/runs`
- `GET /api/dashboard` — 返回累计字数、今日/本周新增、活跃天数和近七天写作曲线
- `GET/POST /api/projects`
- `POST /api/projects/smart` — 校验 AI 书名、题材、主线与章节大纲并原子化创建作品
- `POST /api/projects/import` — 从结构化 TXT 解析结果批量导入作品章节
- `GET/PATCH/DELETE /api/projects/:projectId`
- `GET/POST/DELETE /api/writing-assistant/session` — 持久化全局创作助手会话；`POST /api/writing-assistant/confirm` 确认建书方案
- `GET/POST /api/projects/:projectId/chapters`
- `PATCH/DELETE /api/projects/:projectId/chapters/:chapterId`
- `GET/PUT /api/projects/:projectId/chapters/:chapterId/draft` — 读取/保存独立章节正文
- `GET/POST /api/projects/:projectId/chapters/:chapterId/history` — 读取/保存持久化编辑快照
- `GET/PUT /api/projects/:projectId/draft` — 兼容旧客户端的当前章节正文入口
- `GET/POST /api/ideas`
- `PATCH/DELETE /api/ideas/:ideaId` — 素材支持目录、标签、置顶和作品关联
- `GET /api/projects/:projectId/chapters/:chapterId/context` — 获取当前章节写作上下文
- `GET/POST/PATCH/DELETE /api/foreshadows` — 伏笔登记、状态流转和章节关联
- `POST /api/ai/tasks`、`GET /api/ai/tasks/:taskId`、`POST /api/ai/tasks/:taskId/cancel` — 可恢复 AI 任务

## 模型配置

用户可在前端「设置」页面自定义 LLM 调用参数，配置按用户加密存储在服务端：

- **API Base URL** — OpenAI 兼容 API 地址，支持中转/第三方服务
- **API Key** — 加密存储（AES-256-GCM，复用 `AUTH_SECRET`），返回时脱敏
- **模型名** — 可手动输入或点击「获取模型列表」从 API 拉取可用模型
- **Temperature** — 0-2，控制生成随机性
- **Max Tokens** — 最大输出 token 数
- **上下文窗口** — 模型上下文窗口大小，用于自动截断超长输入

调用 Skill 时，Node 网关自动读取用户配置并透传给 AI 服务，AI 服务用用户配置覆盖服务端 `.env` 默认值。未配置时回退到服务端环境变量。

总览页的全局创作助手会先收集篇幅、题材、流派和故事核心，再调用 `story-long-write` 或 `story-short-write` 生成可编辑建书方案。确认后复用智能创建事务创建作品并进入编辑器；编辑器助手会根据当前作品篇幅携带作品、流派和章节上下文继续写作。

## 验证

```bash
npm test
```

冒烟测试会在临时目录中启动独立 API，覆盖输入校验和核心 CRUD，结束后自动删除测试数据。

## Story Skill 能力

项目内的 `skills/` 是 oh-story-claudecode Skills 的 vendored 副本，Python 服务默认从这里读取 Skill manifest。也可以用 `STORY_SKILLS_ROOT` 指向另一份兼容目录。

`skills/package.json` 只用于把上游 Node 检查脚本保持在 CommonJS 作用域内，避免继承 Web 项目根目录的 ESM 设置。

服务通过受限的 `StorySkillCapability` 把 Skill 暴露为 LangChain 工具。`story` 路由器和 `story-review` 有完整 Web executor；`story-deslop` 有确定性检查 + LLM 改写 executor；其余八个文本工作流使用 `prompt-only` executor，执行时会**按需自动加载 SKILL.md 中引用的 references**（不再只传契约）。未配置模型时状态为 `needs_model`。`browser-cdp` 与 `story-cover` 仍需要浏览器和图片生成适配器，状态为 `registered`。

**references 按需加载**：执行器解析 SKILL.md 中的 `references/xxx.md` 引用路径，自动读取对应文件并拼入 LLM 上下文，按字节预算（默认 200KB）截断。所有 skill 的 references 和 scripts 现在通过路径安全校验自动允许访问，不再逐文件硬编码白名单。

通用调用入口是 `POST /api/ai/agent/runs`：传入 `message`，可选 `skill` 和 Skill 所需的 `payload`。例如指定 `story-review` 后，Agent 会加载项目内的契约、references 和白名单脚本并返回结构化审稿结果。前端工具箱页的 Skill 能力目录中，每个 `ready`/`needs_model` 状态的 Skill 都可直接点击调用，弹出输入面板并展示执行结果。
