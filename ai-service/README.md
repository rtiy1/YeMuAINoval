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

## 运行

在项目根目录执行：

```bash
python3 -m venv .venv
.venv/bin/pip install -r ai-service/requirements.txt
npm run dev:ai
```

配置项见 `ai-service/.env.example`。Node 网关使用根目录 `.env` 中的 `AI_SERVICE_URL` 和 `AI_SERVICE_TOKEN` 连接此服务。
