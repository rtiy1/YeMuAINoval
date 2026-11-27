在本地设备上执行一条 shell 命令。桌面端始终可用，工作目录就是当前作品的书根。

适合运行 Story Skill 声明的辅助脚本（追踪表提交、作者记忆回执、大纲校验、字数统计等），或 git、批量重命名等命令行操作。

- `command`：要执行的命令行。Windows 优先走 Git Bash，没有则用 cmd；其他系统走 `$SHELL`/`sh`。
- `timeout_ms`：可选超时毫秒数，默认 120000，上限 600000。
- `cwd`：可选工作目录，必须位于书根之内，默认书根。

环境变量 `STORY_WORKSPACE` 指向书根，`STORY_SKILLS_DIR` 指向 Skill 安装目录。调用 skill 脚本时用绝对路径，例如：
`node "$STORY_SKILLS_DIR/story/scripts/dashboard-server.mjs" --root "$STORY_WORKSPACE"`

工作区就是作品本身：正文、大纲、设定、追踪都是磁盘上的真实文件，命令改了什么就立刻是什么，不需要再同步。日常改写仍优先用 write_story_file / edit_story_file（它们会留历史快照）；脚本批量生成的追踪、记忆、统计类文件直接写在工作区里即可。

会损坏系统或造成不可逆损失的命令（格式化磁盘、关机、删除根目录或用户目录等）会被拒绝执行。
