---
name: novel-agent-tool-scope
description: 产品定位是小说创作 agent，不接入 coding-agent 全套工具，保持 33MB 运行时
metadata:
  node_type: memory
  type: project
  originSessionId: acb6cdd9-b331-47b7-9564-f94ea2f55381
  modified: 2026-11-27T09:44:56.514Z
---

用户在 2026-11-27 明确选择：产品只做**小说创作 agent**，不需要通用编码能力。

**决定**：不接入 `packages/coding-agent`（发布名 `@yemu/agent-runtime`）的 28 个通用工具，
继续用 `src/agent-runtime.ts` 里的 10 个小说工具 + 纯 JS 实现的 `glob`/`grep`。

**为什么**：
- `coding-agent` 的工具（ast_grep、ast_edit、lsp、browser、computer 等）是为代码仓库设计的，
  对写小说是冗余
- 它的 `grep`/`glob` 底层是 `@yemu/native`（Rust N-API），仓库无预编译 `.node`，
  接入需要装 Rust + 三平台各编译一次
- 每个工具还耦合 `@yemu/tui` 和 20+ 个 coding-agent 内部模块
- 运行时体积会从 33MB 涨到 100MB+

**How to apply**：
- 新增能力时优先写纯 JS 实现（`Bun.Glob`、遍历+正则），不要引入 Rust 依赖
- 不要提议「接入 coding-agent 标准工具」，除非用户明确要求通用编码能力
- 小说场景的文件量级（几百个 md）不需要 ripgrep 级性能

相关：[[workspace-as-truth]]
