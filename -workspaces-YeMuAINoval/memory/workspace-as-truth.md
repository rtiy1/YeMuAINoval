---
name: workspace-as-truth
description: 磁盘文件夹是作品的唯一真相，db.json 只存会话/任务运行时状态
metadata:
  node_type: memory
  type: project
  originSessionId: acb6cdd9-b331-47b7-9564-f94ea2f55381
  modified: 2026-11-27T09:45:03.771Z
---

2026-11-27 完成的架构重构：产品从「Web 多用户 + db.json 存虚拟作品文件」改为
「本地文件夹即作品」的桌面应用。

**核心原则**：
- 用户打开一个文件夹 = 一本书。`正文/ 大纲/ 设定/ 追踪/ 参考资料/` 里的 Markdown
  就是作品，磁盘是唯一真相，用户可以用任何编辑器同时修改
- 结构化数据（伏笔/记忆/关系图/统计/历史）在 `.yemu/`，复制文件夹 = 完整备份
- **模型 API Key 不进工作区**（用应用级 `AUTH_SECRET` 加密，存应用数据目录），
  因为工作区要能安全分享
- `db.json` 降级为运行时状态（会话、任务队列、用户设置）

**关键实现**：
- `server/workspace-store.mjs` —— 目录约定、章节解析、路径沙箱、原子写、历史快照、对账
- `server/workspace-adapter.mjs` —— 把旧 API（`/api/projects/:id/chapters/:chapterId/draft`）
  映射到磁盘，`projectId` = 工作区根路径，`chapterId` = 章节号。**前端 UI 零改动**
- 章节目录约定必须匹配 `skills/story*` 的技能（`正文/第NNN章_标题.md`），
  因为技能脚本会直接读写这些路径

**已删除**：账号体系、技能市场、web_fetch、PostgreSQL、Redis、Docker 部署。

相关：[[novel-agent-tool-scope]]
