## v0.1.11

- 恢复此前遗漏在功能分支中的远程接管：Telegram、飞书、企业微信、Discord 渠道，以及审批、问题回答、补充指令和 Codex 中断控制。
- 配置窗口新增「远程接管」页，支持图形化编辑渠道和 Codex 原生线程连接；托盘「配置远程接管…」直达该页。兼容原有 `~/.cute-island/remote.json`，保留控制令牌、自定义字段及启停设置。
- 恢复远程 CLI、Claude / Cursor / Gemini Hook 和独立认证的本机控制 API。启停会释放待处理请求，旧按钮和过期审批不可重放。
- 保留 v0.1.10 的独立配置窗口与自动审批。开启远程接管时暂停自动审批响应，关闭后恢复原设置，避免重复处理请求。
- 恢复 Cursor 桌面端无工具 ID 的选择题、答案和权限请求识别，同时保留新版的静默状态及性能修复。

配置入口：**托盘 → 打开配置… → 远程接管**。现有渠道自动读取；首次添加后点击「保存渠道配置」再开启。Token / Secret 仍通过进程环境变量提供，配置页显示缺失的变量名。Agent 接入方法见 [远程接管说明](https://github.com/xihadance/cute-island/blob/main/REMOTE_CONTROL.md)。

验证：298 项测试、类型检查、构建、配置窗口、托盘启停、CLI Hook 释放、旧请求失效及原有灵动岛交互回归。Windows 打包版启动、配置窗口和交互检查通过，四个渠道 SDK 在包内加载通过。测试使用隔离配置和模拟渠道，未连接用户真实机器人。

### 下载

- Windows：`Cute.Island.Setup.0.1.11.exe`
- macOS（Apple Silicon）：`Cute.Island-0.1.11-arm64.dmg`
- Linux（x64）：`.AppImage` 或 `.deb`
