# 桌面端（Tauri v2 + Bun sidecar）

叙事工坊 · YeMu AI Novel 的本地优先桌面版。**不需要网站/服务器**：免登录、无 PostgreSQL、无 Redis，所有数据落在本机。

## 一句话架构

```
┌──────────────────────────────────────────────┐
│ Tauri 壳 (Rust, 系统 WebView)                │
│   └─ 创建窗口 → http://127.0.0.1:<随机端口>   │
│   └─ 拉起 Bun sidecar（随包分发）             │
└──────────────┬───────────────────────────────┘
               │ localhost（同源，无 CORS）
┌──────────────▼───────────────────────────────┐
│ Bun 运行的本地服务 server/index.mjs           │
│   - AUTH_MODE=local  → 免登录，隐式本地用户    │
│   - 存储 JSON       → db.json（无 PostgreSQL）│
│   - AI 任务进程内    → 无 Redis、无 worker     │
│   - 托管 dist/ 前端  → 浏览器/webview 直接访问  │
│   - 内嵌 YeMu Agent Runtime                  │
└──────────────────────────────────────────────┘
```

- **语言**：沿用项目既有 TypeScript + Bun 全栈，桌面壳用 Rust（Tauri v2）。
  后台服务因要运行 Bun 和原生模块（sherpa-onnx / onnxruntime / @yemu/natives）必须待在独立进程，
  Tauri 只负责窗口与生命周期。
- **免登录原理**：`AUTH_MODE=local` 时服务端 `authenticate` 中间件不再验 JWT，而是自动返回
  一个隐式本地用户（`local-user`）。前端启动时 `api.restoreSession()` 走 `/api/auth/refresh`，
  本地模式恒返回该用户 → 登录页永远不会出现，直接进入工作区。**前端无需任何改动。**

## 本地模式做了什么

| 项 | 处理 |
|----|------|
| 登录/注册/找回密码 | `AUTH_MODE=local` 时注册/登录/刷新均返回隐式本地用户；退出为 no-op |
| 用户体系 | 首次请求自动创建 `local-user` 并附赠一本「我的第一本书」，幂等 |
| PostgreSQL | 不配置 `DATABASE_URL`，`store.mjs` 走 `server/data/db.json`（本就是默认回退） |
| Redis / AI worker | 不配置 `REDIS_URL`，`isTaskQueueEnabled()` 为 false，AI 任务留在 API 进程内 |
| `ioredis` 依赖 | 改为惰性加载，本地模式完全不引入 Redis 客户端 |
| 模型 Key | 保存在本地用户的 `settings`，用数据目录里的持久化 `AUTH_SECRET` 加密，重启可解 |
| 数据目录 | `db.json`、`skill-market/`、`auth-secret` 统一放在数据目录（默认 `.data/desktop/`，桌面壳指向系统应用数据目录） |

实现要点（便于维护）：

- `server/index.mjs`：`AUTH_MODE === 'local'` 定义 `localMode`，`authenticate` 短路返回 `ensureLocalUser()`；
  生产模式校验（邮箱/强 AUTH_SECRET）在 localMode 下跳过。
- `server/index.mjs`：`PORT=0` 时实际端口写入 `STORY_PORT_FILE`，桌面壳轮询该文件即可得到 URL。
- `server/task-queue.mjs`：`createTaskRedis` 内部才 `require('ioredis')`。

## 目录结构

```
scripts/
  desktop-start.mjs        # 本地模式启动器（随机/固定端口，默认数据 .data/desktop/）
  fetch-bun-runtime.mjs    # 下载官方 Bun 到 src-tauri/binaries/（Tauri sidecar）
  generate-icons.py        # 生成 src-tauri/icons 图标集
  open-browser.mjs         # 跨平台打开默认浏览器
src-tauri/
  Cargo.toml  build.rs
  tauri.conf.json          # bundle：server/src/skills/node_modules/dist + bun sidecar
  src/main.rs              # Rust 壳：dev 等待 8787；prod 拉起 sidecar、读端口、建窗口、退出回收
  capabilities/default.json
  icons/                   # 生成的 PNG/ICO/ICNS
  binaries/                # 下载的 Bun（gitignore，勿提交）
```

## 开发使用

### 只跑服务（不需要 Rust 工具链）

```bash
bun run desktop:start          # 本地模式，随机端口，终端保持运行
bun run desktop:open           # 启动并打开默认浏览器
bun run desktop:api            # 固定 127.0.0.1:8787 本地模式（tauri dev 的前置命令）
```

验证本地模式（无需登录、JSON 存储、in-process Agent）：

```bash
curl -s http://127.0.0.1:8787/api/health   # storage.backend == "json"
curl -s http://127.0.0.1:8787/api/auth/me  # 返回 local-user
curl -s http://127.0.0.1:8787/api/projects # 已有「我的第一本书」
```

### 跑桌面壳（需要 Rust 工具链）

```bash
# 一次安装：Rust (rustup) + Tauri CLI
rustup default stable
bun install    # 已含 @tauri-apps/cli

bun run desktop:tauri:dev     # = tauri dev（自动先跑 desktop:api 本地模式服务）
```

开发模式下 webview 直接加载 `http://127.0.0.1:8787`（服务端托管 `dist/`，非 Vite HMR）；
要热更 React 仍可用原来的 `bun run dev`（Vite）配合 `bun run dev:api` 在浏览器里开发，
桌面壳只用于最终集成验证。

### 打包（Windows / macOS）

在目标系统上执行（先在 `src-tauri/binaries/` 放好对应的 Bun sidecar）：

```bash
# 按需下载 Bun 运行时（Tauri sidecar 命名）
bun scripts/fetch-bun-runtime.mjs              # 全部平台
bun scripts/fetch-bun-runtime.mjs x86_64-pc-windows-msvc
bun scripts/fetch-bun-runtime.mjs aarch64-apple-darwin

# 生成图标（仓库已含产物，重做图标时才需要；或直接用 tauri icon）
python3 scripts/generate-icons.py

# 打包
bun run desktop:tauri:build   # = tauri build（Windows 默认 nsis/msi，macOS app/dmg）
```

产物在 `src-tauri/target/release/bundle/`：Windows 为 NSIS/MSI 安装包，macOS 为 `.app` 与 `.dmg`。

## CI

`.github/workflows/desktop-build.yml` 在推送 `v*` tag（或手动触发）时构建三款：
`windows-x64`(NSIS)、`macos-x64`、`macos-arm64`，产物作为 Artifact 上传。

## 已知限制与注意

- **体积**：为保留全部原生模块（语音/文本嵌入/PDF），`node_modules` 会整体打进安装包，
  安装包会较大（百 MB 级）。这是「保留原生能力」的取舍；后续可按需剪掉 `pg`/`ioredis` 等
  不会再用的依赖并做 tree-shaking 来瘦身。
- **不要用 `bun build --compile` 打成单文件**：原生 `.node` 模块（sherpa-onnx、onnxruntime-node、
  mupdf、@yemu/natives）塞进单二进制很脆弱。当前方案（Bun 运行时 + node_modules）最稳。
- **系统 WebView 差异**：Tauri 用系统 WebView（Windows WebView2 / macOS WKWebView），
  个别前端 API 需在目标系统实测；SSE（AI 流式）走 fetch 正常。
- **数据即目录**：卸载/清理时整个数据目录即工作区；备份 = 复制 `db.json` 与 `skill-market/`。
- `AUTH_SECRET` 由桌面壳持久化到数据目录，务必随数据目录一起备份，否则已保存的模型 Key 无法解密。

## 后续可做（非本 MVP）

- 移除 `pg`/`ioredis` 依赖及 `store.mjs` 的 Postgres 分支，进一步瘦身。
- 登录页/注册页 UI 路由彻底摘除（当前靠服务端隐式用户天然屏蔽，无需改）。
- 用 `tauri-plugin-fs`/`tauri-plugin-dialog` 做原生文件对话框（导入/导出 TXT、选择作品目录）。
- 自动更新（`tauri-plugin-updater`）。
