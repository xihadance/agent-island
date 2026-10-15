# 远程接管

接管模式将原会话的工具审批、人工问答和补充指令接到远程消息渠道。无需修改会话日志，也不会通过键鼠模拟点击。四种 Agent 的日志仍然用于观察；只有 Hook 已注册或原生控制连接建立的会话才显示接管能力。

## 启动

需要 Node.js 22.12+。在仓库中执行：

```powershell
npm install
npm run build:cli
node bin/cute-island.js remote init
```

默认配置为 `~/.cute-island/remote.json`。`init` 创建随机的本机控制令牌和 `enabled: false`，不覆盖已有文件。主应用启动时会自动读取这个文件；也可通过 `CUTE_ISLAND_REMOTE_CONFIG` 或 CLI `--config` 指定另一份配置。

首先配置 Telegram 专用 Bot，将 `channels` 替换为：

```json
[
  {
    "id": "telegram-main",
    "type": "telegram",
    "tokenEnv": "CUTE_ISLAND_TELEGRAM_TOKEN",
    "destination": "你的 chat_id，字符串",
    "allowedUsers": ["你的 Telegram user_id，字符串"]
  }
]
```

`destination` 是接收通知的会话，`allowedUsers` 是能执行操作的人，不能用昵称代替稳定 ID。先在 Telegram 中联系 Bot；Bot 必须有向目标会话发送消息的权限。Token 放在运行进程的环境中，不写入仓库。Windows 示例：

```powershell
$env:CUTE_ISLAND_TELEGRAM_TOKEN = 'BotFather 提供的 token'
node bin/cute-island.js remote enable
node bin/cute-island.js remote serve
```

`remote serve` 是无窗口接管服务，也会运行原来的会话观察器。如果已运行桌面应用，则无需另外运行它；两者使用同一端口，不能同时启动。桌面应用同样需要继承渠道凭据环境变量。`CUTE_ISLAND_WATCH=0` 可关闭日志观察，不影响 Hook 和 Codex 控制。

## 一键启停

在桌面应用的「打开配置… → 远程接管」中选择平台并添加渠道，填写目标会话、允许操作的用户 ID 和凭据环境变量名称，点击「保存渠道配置」。托盘「配置远程接管…」会直接打开这一页，页面底部也可打开原始配置文件或本文。旧版的渠道配置会自动读取，无需迁移。配置渠道和 Agent 接入后，勾选／取消勾选「远程接管」即可开启／关闭，无需重启应用，也不改变“关注／托管”显示偏好。启动失败时菜单会标明失败，可关闭、修正配置后再次开启。

CLI 提供相同的开关：

```powershell
node bin/cute-island.js remote enable
node bin/cute-island.js remote disable
node bin/cute-island.js remote status
```

开关保存在配置的 `enabled` 字段中，重启后保留。新配置默认关闭；旧配置未写 `enabled` 时保持原来的开启行为。`status` 的 `control.enabled` 表示开关设置，`control.running` 表示接管运行时已启动；渠道和 Agent 是否连通仍需查看日志和会话状态。服务未运行时，CLI 只保存设置并明确提示未运行；运行桌面应用或 `remote serve` 后生效。关闭接管后，本机控制 API 和原状态观察仍运行，以便随时再次开启。

关闭时停止渠道连接、重试和 Codex 控制连接，取消尚未提交的审批及指导消息。正在等待的 Hook 在下一次轮询时交回原 Agent；已提交的操作无法撤回，保留为 `uncertain`，需在原会话确认结果。旧通知和按钮不能在重新开启后执行旧请求。

**已安装的 Hook 可以保留。** 配置明确为 `enabled: false` 时，Hook 无需服务在线就会直接交回原 Agent：Claude／Gemini 返回空结果，Cursor 的 Shell／MCP Hook 仅通过本扩展的门禁，原生权限检查仍生效。不要通过删除配置来停用；配置缺失、损坏或接管开启时服务故障仍按未获批准处理。此行为需要 Hook 指向本版本的 CLI。

图形界面编辑渠道前需关闭接管，保存后再开启。草稿不会因切换配置分类丢失；关闭配置窗口前请保存。配置文件在外部被修改时，保存会提示重新读取，避免覆盖其他修改。

**与自动审批的关系：** 远程接管开启时，桌面应用的自动审批不回传决定，Codex 自动审批连接也会断开。关闭远程接管后恢复原自动审批设置。远程接管开关不会替你安装 Hook；Claude 的自动审批 HTTP Hook 与远程 Hook 是不同接入，请按下文配置需要的能力。

配置中的 `mode` 固定为 `takeover`。修改渠道或 Codex 连接后，关闭再开启即可重新读取；修改端口、令牌、状态文件路径或进程环境变量后需重启服务。再次开启时，Hook 会话在下一次事件到来时重新注册，Codex 重新连接已配置的原会话，不会新建替代会话。

## 接管 Claude、Cursor、Gemini 现有会话

生成配置片段，**合并**到已有 Agent 配置的 `hooks` 中，不要覆盖已有规则：

```powershell
node bin/cute-island.js remote hook-config --agent claude
node bin/cute-island.js remote hook-config --agent cursor
node bin/cute-island.js remote hook-config --agent gemini
```

生成命令使用当前 Node 路径、当前目录下的 `out/cli.cjs` 和配置绝对路径。若从其他目录运行，使用 `--cli D:/path/to/cute-island/out/cli.cjs`。三个 Agent 分别合并到 Claude settings 的 `hooks`、Cursor `hooks.json`、Gemini `settings.json`。需要时重启并恢复原会话，使 Hook 配置生效。

首次 Hook 调用注册会话。Telegram 发送 `/sessions` 查看会话 ID，或本机执行：

```powershell
node bin/cute-island.js remote status
```

能力边界：

| Agent | 当前实现 |
| --- | --- |
| Claude Code | `PermissionRequest` 单次批准／拒绝；`AskUserQuestion` 单选、多选、自由回答；`ExitPlanMode` 方案确认；简单 MCP 文本／布尔表单；在 `UserPromptSubmit`、`PostToolUse`、失败或 `Stop` 处理点追加指导 |
| Cursor | Shell／MCP 执行前 Hook 的远程确认；工具后／失败后注入上下文；`stop` 提交下一条用户指导 |
| Gemini CLI | `BeforeTool` 的远程确认；`BeforeAgent`／`AfterTool` 追加上下文；权限通知 |

Cursor、Gemini 的“批准”只通过本次 Hook 门禁，保留 Agent 自己的权限检查。它们的任意原生问答窗口不在接管范围。Claude 沙箱网络层的权限提示不一定经过 `PermissionRequest`，没有原生请求关联时仅通知。复杂 MCP Schema、密码字段和 URL 登录流程交回原生界面处理。

接管开启时，Hook 等待远程决定最多 5 分钟，生成的外层 Hook 超时为 330 秒；超时、配置失效或无法访问本机服务时，本次门禁不会自动放行。明确关闭时按上述启停流程交回原 Agent。Cursor 配置启用 `failClosed`。已有其他 Hook、组织策略和权限规则继续生效。

补充指令在下一个支持的 Hook 处理点消费。它不会凭空唤醒已经空闲、没有 Hook 正在运行的会话；`submitted` 只表示已返回给 Hook，不能当作模型已经执行。Claude 官方 Channels 可作为独立的预览方案获得推送消息能力，但需要提前启用、满足官方允许列表，并使用另一只 Bot，不能与本服务争抢 Telegram 更新。

## 接管 Codex

只连接已经承载目标会话的 App-server。配置显式指定原生 thread ID：

```json
{
  "id": "codex-local",
  "url": "ws://127.0.0.1:4500",
  "threads": ["原生 thread ID"],
  "tokenEnv": "CUTE_ISLAND_CODEX_WS_TOKEN"
}
```

将该对象加入配置的 `codex` 数组。没有认证的本机监听可省略 `tokenEnv`；非本机连接只接受 `wss://`。连接成功后，服务先检查 `thread/loaded/list`，仅对同一实例已加载的目标线程订阅。不会为普通 IDE／CLI 的日志另起执行实例，也不会恢复未加载线程来冒充接管。

支持命令、文件、权限审批，原生问题回答，简单 MCP 表单，`turn/steer` 和 `turn/interrupt`。运行中追加消息携带 `expectedTurnId`；已确认空闲的线程使用 `turn/start`。权限批准仅作用于当前请求／轮次，不保存“始终允许”规则。Codex App-server／WebSocket 接口存在实验性限制，须使用支持这些方法的版本。配置启动后才加载的线程需重新连接本服务。

## 远程操作

| 操作 | 命令 |
| --- | --- |
| 查看会话／能力 | `/sessions` |
| 查看待办 | `/pending` |
| 查看完整问题、命令或方案 | `/detail 请求ID` |
| 查看操作或指导消息状态 | `/status ID` |
| 单次批准／拒绝／取消 | `/approve 请求ID`、`/deny 请求ID`、`/cancel 请求ID` |
| 关闭观察提醒 | `/ack 请求ID` |
| 单问题自由回答 | 引用通知回复，或 `/answer 请求ID 答案` |
| 多问题／多选 | `/answer 请求ID {"q1":["A"],"q2":["B","C"]}` |
| 追加指导 | `/send 会话ID 先修复测试，再继续实现` |
| 中断 | `/interrupt 会话ID`，只对支持的 Codex 连接开放 |

Telegram 的单问题单选还提供选项按钮。飞书、企业微信和 Discord 提供审批按钮，多问题通过相同的 JSON 命令回答。普通“yes”“继续”等裸消息不会自动批准，也不会猜测目标会话。长通知是摘要，审批前用 `/detail` 查看完整内容；详情通过多条消息发送。

状态含义：`pending` 等待处理，`queued` 回复已收到但还未提交，`submitted` 已发送至 Agent 等待确认，`resolved` 原生请求已确认处理，`cancelled/expired` 已失效，`uncertain` 无法确认结果。重复事件不重复执行；本地已回答、请求被取消或过期后，旧按钮失效。重启后待决的控制请求标为 `uncertain`，不自动重放批准。通知发送采用重试，极端断网时可能收到相同请求 ID 的重复通知，但只能决定一次。

本机也可以提交决定或指导：

```powershell
node bin/cute-island.js remote respond --id REQUEST_ID --revision 1 --action deny
node bin/cute-island.js remote send --session SESSION_ID --text '先修复测试'
```

## 其他渠道

每个渠道配置唯一 ID，且同一 Bot 只配置一个接收端。全部使用主动建立的连接，不需要将桌面的控制端口暴露到公网。

```json
[
  {
    "id": "feishu-main",
    "type": "feishu",
    "appId": "cli_...",
    "secretEnv": "CUTE_ISLAND_FEISHU_SECRET",
    "destination": "oc_...",
    "allowedUsers": ["ou_..."]
  },
  {
    "id": "wecom-main",
    "type": "wecom",
    "appId": "智能机器人 bot_id",
    "secretEnv": "CUTE_ISLAND_WECOM_SECRET",
    "destination": "userid 或 chatid",
    "allowedUsers": ["userid"]
  },
  {
    "id": "discord-main",
    "type": "discord",
    "tokenEnv": "CUTE_ISLAND_DISCORD_TOKEN",
    "destination": "channel_id",
    "allowedUsers": ["user_id"]
  }
]
```

- 飞书：企业自建应用启用机器人、发送消息权限，以及 `im.message.receive_v1` 和 `card.action.trigger` 长连接订阅；发布应用并加入目标会话。
- 企业微信：使用智能机器人长连接能力，不是传统群 Webhook；需要对应企业已开通。SDK 只能借助有效回调帧编辑卡片，其他状态变更发送跟进消息；旧按钮仍由服务端状态校验拒绝。
- Discord：添加 Bot，授予查看频道、发送消息、读消息历史权限，启用 Message Content Intent；按钮先 defer，避免超过 3 秒响应时限。
- Telegram：长轮询与 Webhook 互斥；服务检测到已有 Webhook 会报告错误，不会擅自删除它。不要同时运行其他轮询同一 Bot 的程序。

## 本机接口和数据

新增接口始终监听 `127.0.0.1`，需要 `Authorization: Bearer <controlToken>`。原来的 `CUTE_ISLAND_TOKEN` 与接管令牌独立，未开启认证的状态 API 也不能访问控制接口。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /v1/control` | `control` 开关／运行状态，以及会话、请求、指导及投递状态 |
| `POST /v1/control/enabled` | `{enabled: true或false}`，保存并立即切换接管 |
| `POST /v1/control/hook` | `{agent, invocationId, event}` 注册 Hook 事件 |
| `GET /v1/control/requests/:id?invocation=...` | 原 Hook 领取决定 |
| `POST /v1/control/requests/:id/respond` | `{revision, decision:{action, answers?}}` |
| `POST /v1/control/messages` | `{sessionId, text}` |

状态写入配置旁的 `remote-state.json`，临时文件写完后原子替换。配置和状态文件包含本机控制凭据或操作上下文，不要提交到仓库。外发内容遮蔽常见凭据字段和 Token，但无法识别所有业务秘密；只连接有权查看对应任务内容的会话和用户。不会自动发送完整聊天历史。

## 验证

```powershell
npm run typecheck
npm test
npm run build
node scripts/smoke-remote-toggle.cjs
```

自动测试使用本机 HTTP／WebSocket 和模拟 Bot API，验证原生 Hook 回传、Codex 关联、重复回复、失效请求、崩溃恢复、渠道授权及重试。`smoke-remote-toggle.cjs` 使用隔离配置和真实 Electron 托盘回调，验证启停、编译后的 CLI Hook 释放、旧审批失效、显示模式独立和重启持久化，不连接实际渠道。真实 Bot、飞书应用、企业微信租户、Discord 权限和实际 Agent 版本仍需在配置自己的账号后进行联调。

官方协议参考：[Claude Hooks](https://code.claude.com/docs/en/hooks)、[Claude Channels](https://code.claude.com/docs/en/channels-reference)、[Codex App-server](https://developers.openai.com/codex/app-server/)、[Gemini Hooks](https://geminicli.com/docs/hooks/reference/)、[Cursor Hooks](https://cursor.com/docs/agent/hooks)、[Telegram](https://core.telegram.org/bots/api)、[飞书](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-callbacks)、[企业微信 SDK](https://github.com/WecomTeam/aibot-node-sdk)、[Discord](https://docs.discord.com/developers/interactions/receiving-and-responding)。
