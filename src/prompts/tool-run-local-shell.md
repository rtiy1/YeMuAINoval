在本地设备上执行一条 shell 命令。仅在桌面端/本地模式且任务关联了作品时可用。

适合运行 Story Skill 声明的辅助脚本（追踪表提交、作者记忆回执、大纲校验、字数统计等）或其他本地命令行工具。

- `command`：要执行的命令行。Windows 优先走 Git Bash，没有则用 cmd；其他系统走 `$SHELL`/`sh`。
- `timeout_ms`：可选超时毫秒数，默认 120000，上限 600000。
- `cwd`：可选工作目录，默认当前作品的本地工作区。

环境变量 `STORY_WORKSPACE` 指向作品工作区根目录，`STORY_SKILLS_DIR` 指向 Skill 安装目录。调用 skill 脚本时用绝对路径，例如：
`node "$STORY_SKILLS_DIR/story/scripts/dashboard-server.mjs" --root "$STORY_WORKSPACE"`

工作区内容与作品文件保持同步：任务开始前由系统自动导出，任务结束后改动自动回收到作品数据。修改作品内容仍优先使用 write_story_file / edit_story_file；脚本生成的追踪、记忆、统计类文件放在工作区内即可。

会损坏系统或造成不可逆损失的命令（格式化磁盘、关机、删除根目录或用户目录等）会被拒绝执行。
