# Cute Island

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

跨平台 Electron 桌面灵动岛，用来查看本机 Agent 的执行状态。用户要求增加自动权限审批、推荐问题回答和独立配置界面。

## Operating Context

已有实现使用 React、TypeScript 和 Electron，支持 Windows、macOS、Linux。托盘管理常驻灵动岛，日志识别覆盖 Claude Code、Codex、Gemini 和 Cursor。独立配置窗口是此次扩展。

## Capabilities and Constraints

关注模式和托管模式决定灵动岛的展示及鼠标穿透行为。自动审批是独立的配置，只能通过已接入的真实交互通道回传结果；读取日志本身不能批准请求。保留既有会话、拖动和贴边行为。

## Open Decisions

主要使用人群为同时使用本机 Agent 的开发者（由现有 README 推断）。本轮未收到可选问题答复时，无推荐选项默认交给用户，可在配置中切换为选择第一项。客户端支持范围按可验证的原生协议实现，并在配置页明确展示。
