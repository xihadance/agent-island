## v0.1.10

- 新增独立配置窗口，包含常规设置、自动审批、Agent 接入和处理记录；支持从托盘、灵动岛右键菜单或 `--settings` 打开，关闭窗口后灵动岛继续运行。
- 新增自动审批模式，默认关闭。支持分别开启权限批准和选择题回答，优先选择「推荐 / Recommended」选项；无推荐时可保留手动回答或选择第一项。自由输入、密码和无法确定答案的问题仍交给用户处理。
- 支持安装或移除 Claude Code 原生 HTTP Hook，自动批准工具权限并回答 `AskUserQuestion`。修改前备份配置，保留其他 Hook 和权限规则；安装后需要重新打开 Claude Code 会话。
- 支持连接本机共享的 Codex app-server，处理命令执行、文件修改、权限请求和选择题；断线自动重连，暂停时断开，不修改会话原有沙箱和审批策略。
- 设置与托盘实时同步，保存到本地并在重启后恢复；兼容旧版配置。保留本次启动最近 50 条自动处理记录。
- 保留现有关注 / 托管模式、拖动贴边、鼠标穿透和会话提醒行为，新增配置窗口交互与持久化回归检查。

自动处理范围：需要支持 HTTP Hook 的 Claude Code，或与客户端共用的本机无认证 Codex WebSocket 服务。普通 Codex CLI、桌面应用和 IDE 插件不会仅凭日志自动接入；Gemini、Cursor 及其他仅日志接入的会话仍在原客户端完成审批和回答。

验证：229 项测试、类型检查、构建、配置窗口与原有灵动岛的真实 Electron 交互回归通过；本机隔离 Codex app-server 的连接握手和持续会话查询通过。Windows 打包版通过启动恢复、配置窗口、Claude 续接、HTTP、preload 和交互检查，无渲染异常，空闲 1.5 秒无布局轮询。

### 下载

- Windows：`Cute.Island.Setup.0.1.10.exe`
- macOS（Apple Silicon）：`Cute.Island-0.1.10-arm64.dmg`
- Linux（x64）：`.AppImage` 或 `.deb`
