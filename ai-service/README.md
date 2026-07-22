# Story Studio AI Service

独立的 Python AI 工作流服务。FastAPI 负责内部 HTTP 接口，LangGraph 负责编排可扩展工作流；浏览器不直接访问本服务，而是经过带账号认证的 Node API 网关。

## 当前工作流

`POST /v1/reviews/chapter`

执行顺序：

1. 规范化正文并计算段落、句子、对话等指标。
2. 运行确定性的规则扫描。
3. 配置模型后运行 LLM 编辑审查。
4. 合并结果并输出结构化评分、问题和修改建议。

没有配置 `OPENAI_API_KEY` 时仍能完成规则扫描，便于本地开发和自动化测试。

## Skill 执行器

`POST /v1/agents/story` 是通用调用入口，按 `skill` 参数路由到对应执行器：

| Skill | Executor | 说明 |
|-------|----------|------|
| `story` | `router-v1` | 意图路由器，分发到具体 skill |
| `story-review` | `langgraph-solo-v1` | 确定性检查 + LLM 审查（LangGraph） |
| `story-deslop` | `deslop-v1` | 确定性检查 + LLM 改写正文 |
| 其余 8 个文本 skill | `prompt-only-v1` | 契约 + 按需引用 → LLM |
| `browser-cdp` / `story-cover` | 无 | 需浏览器/图片适配器，状态 `registered` |

### references 按需加载

`prompt-only-v1` 和 `deslop-v1` 执行器会解析 SKILL.md 中的 `references/xxx.md` 引用路径，自动读取对应文件并拼入 LLM system prompt。按字节预算（默认 200KB）截断，防止 2.7MB 全量引用超限。返回结果包含 `references_loaded`（已加载的引用列表）和 `references_truncated` 标记。

### 路径安全

Skill registry 通过 `_inside_root` 防止路径逃逸（`..` 越界），通过扩展名限制只允许读取 `.md`/`.txt` 引用和 `.js` 脚本。所有 skill 的 references/scripts 自动允许访问，不再逐文件硬编码白名单。

## 运行

在项目根目录执行：

```bash
python3 -m venv .venv
.venv/bin/pip install -r ai-service/requirements.txt
npm run dev:ai
```

配置项见 `ai-service/.env.example`。Node 网关使用根目录 `.env` 中的 `AI_SERVICE_URL` 和 `AI_SERVICE_TOKEN` 连接此服务。
