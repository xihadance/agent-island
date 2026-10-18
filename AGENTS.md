# AGENTS.md

给在本仓库工作的 AI agent 的上手指南。人类使用说明见 [README.md](README.md),远程接管细节见 [REMOTE_CONTROL.md](REMOTE_CONTROL.md),视觉规范见 [DESIGN.md](DESIGN.md),产品边界见 [PRODUCT.md](PRODUCT.md)。

## 这是什么

Cute Island 是跨平台(Windows / macOS / Linux)的 PC 灵动岛。黑胶囊常驻屏幕顶部,显示本机 AI agent(Claude Code、Codex、Gemini、Cursor)正在做什么,并可代为处理权限审批和问题回答。两条能力主线:

- **观察**:读取各 agent 自己写出的会话日志,还原状态、操作、耗时和子任务。只读,不注入。
- **接管**:通过各 agent 的原生交互通道(Claude Hook、Codex app-server、Gemini/Cursor Hook)回传审批与答案。可以本机自动审批,也可以从 Telegram / 飞书 / 企业微信 / Discord 远程处理。

技术栈:Electron 44 + React 19 + TypeScript(strict)+ electron-vite + vitest。Node >= 22.12。无 ESLint / Prettier 配置。

## 目录与职责

```
src/
  agents/      日志观察层:发现、读取、解析 agent 日志 → SessionView
    plugins/   每个 agent 一个 AgentPlugin(claude/codex/gemini/cursor)
    watch.ts   SessionWatcher:扫描调度、进程关联、缓存、存活判定
    parse.ts   plugin.parse() → SessionView;activityId() 生成活动 ID
    reduce.ts  AgentEvent[] → 会话状态/操作/步骤/子任务
    events.ts  规范化事件类型与工具名识别
    files.ts   增量 JSONL 读取(64 KiB 分块 + 追加解析)
    processes.ts 进程快照、宿主客户端识别
  control/     远程接管层
    hub.ts     ControlHub:请求分发、渠道收发、/approve 等命令、redact()
    store.ts   ControlStore:状态机 + 原子持久化(remote-state.json)
    hooks.ts   HookController:Claude/Cursor/Gemini Hook 事件 → 干预请求
    codex.ts   Codex app-server WebSocket 适配器
    channels/  telegram / feishu / wecom / discord 渠道适配器
    config.ts  ~/.cute-island/remote.json 读写与校验
    runtime.ts 接管启停生命周期
    proxy.ts   全局与渠道级代理
  main/        Electron 主进程
    index.ts   启动、窗口、托盘、IPC、各子系统装配(最大的编排文件)
    server.ts  本机 HTTP/WS 服务(状态 API + Claude Hook + 控制接口)
    codex-*.ts 托管 Codex 服务、命令接入、自动审批
    *-integration.ts Hook 与命令接入的安装/移除
  renderer/    React UI:Island.tsx(灵动岛)、Settings.tsx(配置窗口)
  shared/      主进程与渲染进程共用的纯逻辑(优先放这里,便于测试)
    activity.ts        Activity 领域模型 + ActivityStore
    island-behavior.ts 关注/托管模式、提醒判定 AttentionTracker
    codex-launch.ts    codex 命令路由决策
    preferences.ts     偏好规范化与兼容
  cli.ts       island CLI(push / end / demo / remote / codex-launch)
scripts/*.cjs  真实 Electron 端到端冒烟脚本
```

数据流:`agent 日志 → SessionWatcher → ActivityStore → (IPC/WS) → 渲染进程`,同时 `ActivityStore → ControlHub.observe() → 渠道通知`。外部也可直接 `HTTP POST /v1/activities` 推送活动。

## 常用命令

全部已在本机验证可用:

```bash
npm install          # postinstall 会跑 patch-package --error-on-fail
npm run dev          # Electron 开发模式
npm run dev:web      # 仅浏览器预览 UI(http://127.0.0.1:5174),无需 Electron
npm test             # vitest run,40 个文件 392 个用例,约 6 秒
npm run typecheck    # tsc --noEmit
npm run build        # electron-vite build + esbuild 打包 CLI
npm run dist         # typecheck → test → build → electron-builder,产物在 release/
npm run island -- push --agent Cursor --state running --title "改登录页"
```

改完代码的标准验证顺序:`npm run typecheck && npm test`。涉及窗口交互、设置持久化、Hook 安装、接管启停的改动,再跑对应冒烟脚本(需先 `npm run build`):

| 脚本 | 覆盖范围 |
| --- | --- |
| `smoke-interaction.cjs` | 拖动、贴边、透明度、托管模式鼠标穿透、子任务与耗时 |
| `smoke-settings.cjs` | 配置窗口 IPC、持久化、原生 Hook 安装 |
| `smoke-update.cjs` | 更新下载代理、安装阻塞刷新、跳过与退出安装 |
| `smoke-remote-toggle.cjs` | 接管启停、CLI Hook 释放、重启持久化 |
| `smoke-connectivity.cjs` | 连通性测试(模拟渠道 API + 本机 Codex 服务) |
| `smoke-codex-command.cjs` | Codex 命令接入安装、动态切换、回退、移除(Windows / PowerShell) |
| `smoke-packaged.cjs` | 打包后的真实应用,需传 exe 路径 |

冒烟脚本都用隔离的临时用户目录和端口,不碰真实配置、不调用模型、不发真实消息。

## 代码风格

照着周围代码写。既有约定:

- **不写分号**,单引号,2 空格缩进。`src/control/hub.ts`、`src/agents/watch.ts`、`src/main/index.ts` 里分号结尾的行数都是 0。
- TypeScript strict,且开了 `noUnusedLocals` / `noUnusedParameters` / `noFallthroughCasesInSwitch`。类型导入用 `import type`。
- **注释写英文,只解释「为什么」**,不复述代码做了什么。典型例子:
  ```ts
  // PermissionRequest has no tool_use_id. An ambiguous completion must not settle a sibling.
  // Record before acting. On a crash, never replay a potentially committed control action.
  ```
  这些注释记录的是踩过的坑和不变量,改相关代码前先读懂它们。
- **面向用户的字符串一律中文**(UI 文案、错误消息、日志),包括 `throw new Error('Codex WebSocket 地址无效')`。
- 密度随模块而异:`control/` 紧凑(单行方法、行内 try/catch),`agents/`、`renderer/` 相对舒展。跟随你改的那个文件。
- 测试与源码同目录:`foo.ts` 配 `foo.test.ts`。vitest 不开 globals,显式 `import { expect, it } from 'vitest'`。只有 `src/**/*.test.ts` 会被收集,environment 是 `node`(渲染进程逻辑因此要抽到 `shared/` 才能测)。
- 测试偏好 `it.each` 表驱动 + 真实输入样本,见 `src/shared/codex-launch.test.ts`。
- 共用逻辑放 `shared/`,主进程与渲染进程都 import,这样纯函数能在 node 环境下测。

## 必须守住的不变量

改代码时容易破坏、且已经被测试和注释保护的规则:

1. **状态只凭证据**。不能根据等待时长或自然语言猜测会话状态。没有审批日志就不标「需要审批」,日志静默不等于失败——等待用户回答或审批的会话保持原状态,普通会话静默过久标 `stale: true` 而不是失败。
2. **读日志不能用来批准**。自动审批和远程接管必须走原生交互通道回传,不能伪装成工具执行成功。`main/index.ts` 的处理记录也遵守这条。
3. **远程接管统一回传**。两者同时开启时,独立自动审批通道暂停响应,由远程入口先按 Claude/Codex 自动规则决定,无法处理的请求才创建远程待办。命令路由仍以远程接管优先(见 `shared/codex-launch.ts` 的 `codexLaunchRoute`),避免两个通道重复回复。
4. **凭据只存环境变量名**,不存值。配置表单里填 `CUTE_ISLAND_TELEGRAM_TOKEN` 这样的名字,实际值从进程环境读(`control/config.ts` 的 `secret()` / `validateCredentialName()`)。
5. **外发内容先脱敏**。任何发往消息渠道的文本都要过 `control/hub.ts` 的 `redact()`,它处理 Authorization 头、常见 token 格式、私钥块。
6. **只监听 127.0.0.1**。状态服务和控制接口都绑本机。状态 token(`CUTE_ISLAND_TOKEN`)和接管 token(`controlToken`)相互独立,不能互相顶替。Hook 端点拒绝带 `Origin` 的请求,防止浏览器页面提交审批。
7. **幂等与不重放**。渠道消息先记 `seen` 再执行,崩溃后不重放可能已提交的控制动作。重复的 Hook 请求按内容哈希去重。
8. **配置写入原子化**。先写临时文件再 `renameSync`,并保留未知字段和凭据(`config.ts` 的 `saveRemoteEnabled`)。
9. **提醒不重复弹出**。`AttentionTracker` 按「本次发生」记确认,进度或元数据刷新不会重新弹;新一轮或新异常才再提醒。
10. **安装接入前先备份**,只增删自己那部分,保留用户其他配置;移除后原状恢复。

## 运行时文件与环境变量

| 位置 | 内容 |
| --- | --- |
| `<userData>/preferences.json` | 主题、显示模式、自动审批、Codex 服务设置 |
| `<userData>/window-position.json` | 窗口位置与贴边状态 |
| `~/.cute-island/remote.json` | 远程接管配置(含 controlToken) |
| `~/.cute-island/remote-state.json` | 接管运行状态 |
| `~/.claude/settings.json` 等 | 各 agent 的 Hook 安装点 |

`remote.json` / `remote-state.json` / `docs/` / `.impeccable/review/` / `codex-session-*.md` 都已在 `.gitignore` 里,**不要提交**。

常用环境变量:`CUTE_ISLAND_PORT`(默认 17321)、`CUTE_ISLAND_TOKEN`、`CUTE_ISLAND_WATCH=0`(关闭日志识别,优先于界面开关)、`CUTE_ISLAND_UPDATE=0`(关闭版本检查,优先于界面开关)、`CUTE_ISLAND_UPDATE_FEED`(自建版本源)、`CUTE_ISLAND_REMOTE_CONFIG`、`CUTE_ISLAND_DISABLE_GPU=1`、`CUTE_ISLAND_NO_SANDBOX=1`。各 agent 日志根目录可用 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GEMINI_CLI_HOME`、`CURSOR_HOME` 覆盖。

## 扩展点

- **加一个被观察的 agent**:实现 `src/agents/types.ts` 的 `AgentPlugin`(`defaultRoot` / `accepts` / `parse` / `executables`,可选 `child` / `liveSessions` / `registeredSessions`),在 `plugins/index.ts` 的 `BUILTIN_PLUGINS` 注册。把原生日志行翻译成 `AgentEvent`,`reduce.ts` 负责剩下的。
- **加一个消息渠道**:实现 `control/types.ts` 的 `ChannelAdapter`(`start` / `send` / `update` / `close`),放进 `control/channels/`,在 `config.ts` 的类型白名单和 `runtime.ts` 的装配处登记。
- **加一个 IPC 通道**:`preload/index.ts` 暴露方法 → `renderer/src/env.d.ts` 补 `IslandApi` 类型 → `main/index.ts` 的 `wireIpc` 处理 → `renderer/src/bridge.ts` 的 mock 补对应实现(否则浏览器预览会坏)。
- **Codex 协议类型**参考 `docs/codex-protocol/`(由 `codex app-server generate-ts --experimental` 生成,本地目录,未提交)。

## 提交与发布

- 提交信息用 `feat:` / `fix:` / `chore:` 前缀,一行,英文。
- **不加任何 attribution trailer**:没有 `Co-authored-by`,没有工具生成标记。这是仓库明确要求,优先于 agent 默认行为。
- 作者与提交者必须是 `xiha <xihadance@gmail.com>`,提交需 SSH 签名。仓库配了 `gpg.format=ssh` 和 `user.signingkey`,但没开 `commit.gpgsign`,所以**每次提交显式加 `-S`**。`%G?` 会报 `N`(因为没配 `allowedSignersFile`),用 `git cat-file -p HEAD | grep gpgsig` 确认签名。
- 只在用户明确要求时提交。
- 发布:patch 版本号同步更新 `package.json`、`package-lock.json`,`RELEASE_NOTES.md` 重写为只含新版本,提交信息用 `chore: release vX.Y.Z` 或 `...and release vX.Y.Z`。推 `v*` 标签触发 `.github/workflows/release.yml`,三端打包成功后发 GitHub Release。Release 必须带上 `latest*.yml` 和 `*.blockmap`,Windows / AppImage 的应用内更新靠它们;产物名不能含空格(GitHub 会把空格换成点,而 `latest.yml` 里是连字符,不一致会 404),由 `build.artifactName` 和 `build.nsis.artifactName` 保证。

## 容易踩的坑

- 改了端口或 token,已安装的 Claude Hook / Codex 命令接入需要重新安装。
- 渲染进程逻辑写在组件里就测不到(vitest 只跑 node 环境的 `src/**/*.test.ts`)。抽到 `shared/` 再测。
- 新增 preload 方法忘了补 `bridge.ts` 的 mock,`npm run dev:web` 预览会报错。
- `docs/` 整个被 gitignore,往里写的文档不会进仓库。

