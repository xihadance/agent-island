## v0.1.12

- 新增应用内托管 Codex app-server：自动检测原生 Codex CLI，启动、停止和随应用恢复本机服务；自动审批使用托管服务地址，无需手工填写 WebSocket 地址。
- 服务页面提供 Codex CLI 连接命令，并明确现有独立客户端不会自动迁入。支持修改端口和程序路径；端口占用时提示，不接管其他进程。
- 远程接管页新增 Claude Code、Cursor、Gemini CLI Hook 安装/移除按钮。修改前备份配置，保留其他 Hook；迁移同一配置的旧版 CLI Hook，避免重复请求。
- Hook 使用应用内附的 Node 运行时，处理 Windows Electron 主程序模式读取标准输入的问题。

使用步骤：Codex 在「Agent 接入」启动托管服务，复制命令到新终端连接，再开启自动审批。Gemini / Cursor 在「远程接管 → Agent Hook 接管」安装，重新打开会话，配置消息渠道后开启远程接管。

能力范围：Codex 仅控制接入该 app-server 的会话。Gemini 的 BeforeTool、Cursor 的 Shell / MCP Hook 提供远程确认和指导，客户端原有权限检查仍生效，任意原生问答尚不能统一回填。

验证：306 项测试、类型检查、构建；隔离原生 Codex 服务的启动、initialize 握手与关闭；真实 Electron 中服务启动/自动连接、Hook 安装移除与内附运行时回传；Windows 本地安装包、打包程序交互和 Cursor / Gemini 打包版 Hook 启动器。验证未创建模型任务，也未连接真实机器人。

### 下载

- Windows：`Cute.Island.Setup.0.1.12.exe`
- macOS（Apple Silicon）：`Cute.Island-0.1.12-arm64.dmg`
- Linux（x64）：`.AppImage` 或 `.deb`
