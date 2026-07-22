# 叙事工坊 Web

面向网文作者的本地创作工作台。前端使用 React + Vite，业务后端使用 Node.js + Express，AI 工作流使用 Python + FastAPI + LangGraph；作品、章节、正文草稿与灵感卡通过 JSON 文件持久化。

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

数据默认写入 `server/data/db.json`。使用 `STORY_DATA_FILE` 可以指定其他数据文件。

部署前需要设置 `AUTH_SECRET`；`WEB_ORIGIN` 用逗号分隔允许访问 API 的 Web 来源。可参考 `.env.example`。

## API

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/ai/reviews/chapter`
- `GET /api/ai/skills`
- `POST /api/ai/agent/runs`
- `GET/POST /api/projects`
- `GET/PATCH/DELETE /api/projects/:projectId`
- `GET/POST /api/projects/:projectId/chapters`
- `PATCH/DELETE /api/projects/:projectId/chapters/:chapterId`
- `GET/PUT /api/projects/:projectId/draft`
- `GET/POST /api/ideas`
- `PATCH/DELETE /api/ideas/:ideaId`

## 验证

```bash
npm test
```

冒烟测试会在临时目录中启动独立 API，覆盖输入校验和核心 CRUD，结束后自动删除测试数据。

## Story Skill 能力

项目内的 `skills/` 是 oh-story-claudecode Skills 的 vendored 副本，Python 服务默认从这里读取 Skill manifest。也可以用 `STORY_SKILLS_ROOT` 指向另一份兼容目录。

`skills/package.json` 只用于把上游 Node 检查脚本保持在 CommonJS 作用域内，避免继承 Web 项目根目录的 ESM 设置。

服务通过受限的 `StorySkillCapability` 把 Skill 暴露为 LangChain 工具。`story` 路由器和 `story-review` 有完整 Web executor；九个文本工作流提供 `prompt-only` executor，未配置模型时状态为 `needs_model`。`browser-cdp` 与 `story-cover` 仍需要浏览器和图片生成适配器，状态为 `registered`。

通用调用入口是 `POST /api/ai/agent/runs`：传入 `message`，可选 `skill` 和 Skill 所需的 `payload`。例如指定 `story-review` 后，Agent 会加载项目内的契约、references 和白名单脚本并返回结构化审稿结果。
