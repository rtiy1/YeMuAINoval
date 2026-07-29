# Windows 客户端

Windows 客户端基于 Tauri 2，复用现有 React/Vite 的业务内核和同一套 Node API。Web 端仍按原方式独立运行并保持稳定基础形态；客户端通过单独的 Desktop 能力层持续增加桌面交互，不会改变已有部署，也不需要长期维护一份完整的前端副本。

## 前端边界

- 共享内核：Agent 问题 JSON、Thread / Turn / Item 状态、时间线事件、Diff 数据、账号与作品 API
- Web 基础层：保留现有浏览器工作台和浏览器文件、网络能力回退
- Desktop 增强层：只在 Tauri 环境启用键盘快速选择、明确的等待输入状态、Diff 批量审阅、后台系统通知和原生系统能力
- 后续客户端专属布局可以继续挂在 `desktop-surface` 下，服务端协议和作品数据仍与 Web 共用

## 当前能力

- 保留 Web 工作台的账号、作品、章节、素材、记忆、Skill 市场和「夜雨」Agent
- 可连接本机 `http://127.0.0.1:8787/api`，也可连接自建的 HTTPS 夜幕服务
- 使用原生 HTTP 客户端保存刷新 Cookie，关闭并重新打开客户端后可恢复登录
- 通过 Windows 文件选择器导入 TXT
- 通过 Windows“另存为”对话框导出当前章节或整本小说
- 使用系统默认浏览器打开搜索来源和项目外部链接
- 保留窗口位置与大小，并阻止重复启动多个主窗口
- 将 Agent 的结构化问题渲染为可用数字键、方向键和 Enter 操作的桌面选项卡
- 在 Agent 等待回答时暂停普通输入，并明确提示从当前步骤继续
- 支持逐项接受 / 拒绝、全部接受 / 拒绝和键盘切换 Agent Diff
- 客户端退到后台后，通过 Windows 系统通知提示 Agent 已完成、失败或等待选择

客户端不内置 Node、Python、数据库或 AI 服务。这样 Web 和 Windows 端始终读写同一份服务端数据，安装包也不会携带数据库密钥或模型 Key。离线单机版可以后续作为单独发行形态实现。

## 本地开发

Windows 需要：

- Node.js 22+
- Rust stable（通过 rustup 安装）
- Visual Studio 2022 的“使用 C++ 的桌面开发”工作负载
- Microsoft Edge WebView2 Runtime

先按根目录 README 启动 API 和 AI 服务：

```powershell
npm ci
npm run dev:api
npm run dev:ai
```

然后在另一个终端启动客户端：

```powershell
npm run desktop
```

登录页顶部的“Windows 客户端”区域可以测试、保存和切换应用服务器。进入工作台后也可以在“设置 → Windows 客户端”中修改；切换服务器会重载客户端，不会迁移两个服务器之间的数据。

## 生成安装包

在 Windows 开发机执行：

```powershell
npm ci
npm run desktop:build -- --bundles nsis
```

安装包输出到：

```text
src-tauri\target\release\bundle\nsis\
```

也可以在 GitHub Actions 中手动运行 `Windows client` 工作流并下载构建产物。当前工作流生成未签名的 NSIS 安装包，正式公开分发前应配置 Windows 代码签名；否则 SmartScreen 可能显示未知发布者警告。

## 安全边界

- 公网服务器应使用 HTTPS；HTTP 能力主要用于连接本机开发服务
- 模型 API Key 仍只提交给 Node 服务端，并由服务端加密保存
- 客户端仅获准调用 HTTP、系统通知、原生打开/保存对话框和读写用户明确选择的文本文件
- 自定义服务器地址保存在本机 WebView 配置中，不包含账号密码
- 客户端和服务器均继续遵守项目的 AGPL-3.0-only 许可证
