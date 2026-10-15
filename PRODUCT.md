# Cute Island

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

跨平台 Electron 桌面灵动岛，用来查看本机 Agent 的执行状态，并通过已接入的交互通道处理权限审批和问题回答。独立配置界面提供自动审批规则与远程接管设置；远程接管让用户从消息渠道接收提醒、处理请求和追加指令。

## Operating Context

已有实现使用 React、TypeScript 和 Electron，支持 Windows、macOS、Linux。托盘管理常驻灵动岛，日志识别覆盖 Claude Code、Codex、Gemini 和 Cursor。独立配置窗口包含常规、自动审批、Agent 接入、远程接管和处理记录，在现有深色界面中管理自动审批、本机 Codex 服务、Agent Hook 与消息渠道。

## Capabilities and Constraints

关注模式和托管模式决定灵动岛的展示及鼠标穿透行为。自动审批是独立的配置，只能通过已接入的真实交互通道回传结果；读取日志本身不能批准请求。保留既有会话、拖动和贴边行为。

Agent 接入页可启动和停止本机 Codex app-server，自动查找已安装的 Codex CLI，也可保存端口和原生程序路径。托管设置会持久化，启用后随灵动岛启动服务并填写审批连接地址，沿用本机 Codex 登录。页面提供 `codex --remote ws://127.0.0.1:<端口>` 连接命令；只有连接到同一服务的会话可被处理，已有独立 CLI、桌面应用或 IDE 插件会话不会自动迁入。停止服务或退出灵动岛会断开相关客户端；远程消息控制仍需配置服务地址与已加载的原生 thread ID。

远程接管支持 Telegram、飞书、企业微信和 Discord 渠道，以及同一 Codex app-server 中已加载的原生线程。渠道配置包含目标会话或频道、允许操作的用户及凭据环境变量名称，不在表单中填写凭据值。缺失的环境变量会按名称显示，需设置后重启应用。

远程接管页可直接安装或移除 Claude Code、Cursor 和 Gemini CLI 的远程 Hook。修改前备份已有配置，保留其他设置与 Hook，并迁移指向同一接管配置的旧版 Hook。应用生成的启动脚本使用内附 Electron 的 Node 运行时，接收 Hook 标准输入，无须另装 Node；安装后需重新打开客户端或会话。Claude 支持权限审批、问题回答与补充指令；Cursor 支持 Shell／MCP 执行前确认与后续指导，Gemini 支持 BeforeTool 确认与上下文指导。Cursor、Gemini 的批准只通过本次 Hook 门禁，原生权限策略仍然生效，任意原生问答界面不在接管范围。

已有远程配置会自动读取。渠道与 Codex 连接修改需要显式保存，也可重新读取配置或打开配置文件与接入说明；编辑连接前须关闭远程接管。远程接管开启时优先处理请求，自动审批保留用户设置但暂停响应，关闭接管后恢复。托盘与配置窗口使用同一持久化状态。接管服务运行不代表所有外部渠道已经连通，用户需在渠道中发送 `/sessions` 验证。

## Open Decisions

主要使用人群为同时使用本机 Agent 的开发者（由现有 README 推断）。本轮未收到可选问题答复时，无推荐选项默认交给用户，可在配置中切换为选择第一项。客户端支持范围按可验证的原生协议实现，并在配置页明确展示。
