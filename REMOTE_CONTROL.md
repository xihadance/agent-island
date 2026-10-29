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

每个 Telegram、飞书、企业微信、Discord 渠道及 Codex 连接都有「测试连通性」按钮，可在保存前检查当前草稿。消息渠道会验证凭据并向目标会话发送一条明确标注的测试消息；Telegram 还会检查已有 Webhook，企业微信会等待认证及发送回执。Codex 测试完成协议握手并检查所有指定 thread ID 是否已加载，不启动或恢复会话。结果显示在对应配置下方，修改配置后旧结果清除；测试最多等待 15 秒，不保存草稿，也不启动消息接收。测试期间须保持远程接管关闭，避免争抢机器人连接。投递成功后，保存配置并开启远程接管，再在消息渠道发送 `/sessions` 验证双向通信和用户权限。

**与自动审批的关系：** 两者同时开启时，Claude Code 和 Codex 的远程入口先按自动审批规则处理，只有规则无法决定的请求才进入灵动岛和远程渠道待办。独立的 Claude 自动审批 HTTP Hook 暂停回传，Codex 独立自动审批连接断开，由远程入口统一回复，避免重复处理。关闭远程接管后恢复独立自动审批。远程接管开关不会替你安装 Hook；请按下文配置需要的接入。

配置中的 `mode` 固定为 `takeover`。修改渠道或 Codex 连接后，关闭再开启即可重新读取；修改端口、令牌、状态文件路径或进程环境变量后需重启服务。再次开启时，Hook 会话在下一次事件到来时重新注册，Codex 重新连接已配置的原会话，不会新建替代会话。

## 代理设置

在「打开配置… → 远程接管 → 灵动岛全局代理」选择跟随系统代理、直连或自定义代理。Telegram、飞书、企业微信、Discord 以及远程 Codex 连接默认继承全局设置，每个连接也可独立选择跟随系统、直连或自定义代理。HTTP 请求、消息接收长连接、重连与连通性测试使用同一规则。

桌面应用默认读取操作系统的代理（含 PAC），无需开启代理软件的 TUN 模式。已开启系统代理时，可保持全局「跟随系统代理」、渠道「继承全局代理」，再测试 Telegram。自定义地址支持 `http://127.0.0.1:7890`、`https://proxy.example:443`、`socks5://127.0.0.1:1080`；请填写代理软件实际监听的协议和端口。SOCKS5 由代理解析目标域名。

关闭远程接管后编辑，点击「保存渠道配置」并重新开启即可生效。测试使用当前草稿，修改全局或单个连接代理后旧测试结果会清除。`localhost`、`127.0.0.1`、`::1` 的本机连接始终直连。

配置保存在 `remote.json` 根级 `proxy` 和各个 `channels[]` / `codex[]` 的 `proxy` 字段中。例如：

```json
{
  "proxy": { "mode": "custom", "url": "http://127.0.0.1:7890" }
}
```

这是需合并到现有配置的字段片段。全局 `mode` 可取 `system`、`direct`、`custom`；连接级还可取 `inherit`。`custom` 需要 `url`，其他模式无需地址。旧配置省略这些字段时，默认跟随系统。独立运行的 Node CLI `remote serve` 在 `system` 模式下使用 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 和 `NO_PROXY` 等环境变量；也可直接使用配置中的自定义代理。

## 接管 Claude、Cursor、Gemini 现有会话

桌面应用可在「远程接管 → Agent Hook 接管」直接安装或移除 Claude Code、Cursor、Gemini CLI 接管。配置分别写入 `~/.claude/settings.json`、`~/.cursor/hooks.json`、`~/.gemini/settings.json`（对应环境变量重定向仍生效）。每次修改前备份，保留其他规则；安装后重新打开客户端或会话。应用生成的启动脚本使用内附 Node 运行时，不需要额外安装 Node 来执行 Hook。

若使用仓库中的 CLI，也可生成配置片段，**合并**到已有 Agent 配置的 `hooks` 中，不要覆盖已有规则：

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

可以先在「Agent 接入 → Codex app-server」启动应用托管的本机服务，再用页面给出的 `codex --remote` 命令连接终端客户端。服务使用已安装的 Codex 原生程序，沿用本机登录；启动它并不会接管另一个实例正在运行的会话。

托管服务无需再添加 Codex 远程控制连接。配置 Telegram、飞书、企业微信或 Discord 消息渠道并开启远程接管后，灵动岛自动将托管服务的原生审批和问题转发到这些渠道；终端仍显示同一审批，任一端先处理后另一端的旧按钮失效。停止托管服务或关闭接管会断开转发关联，重新开启自动恢复关联。关联仅存在于运行时，不会向 `remote.json` 写入额外 Codex 连接。

若希望始终直接输入 `codex`，在「Agent 接入 → 直接使用 codex 命令」安装命令接入，然后重新打开终端。开启远程接管且已配置消息渠道时，自动使用运行中的本机托管服务，无需添加 Codex 连接；未使用托管服务时，选择配置中第一条会话 ID 留空的 Codex 连接，全部连接均指定 ID 时不会自动添加参数。远程接管关闭后，若自动审批开启则使用审批服务地址；两者都关闭则恢复普通启动。无需在切换开关时手动增删 `--remote`，已启动会话保持原连接。

`codex` 使用默认配置,`codex -p agentrouter` 或 `--profile agentrouter` 自动读取对应 profile,无需在灵动岛设置名称。服务使用终端的 Codex 配置目录、工作目录和环境变量,通过原生 `-c` 启动参数应用 profile（优先于项目配置）,再应用命令中的显式 `-c`。相同配置复用实例,不同配置同时运行;修改配置文件后新命令自动使用新实例,原会话保持连接。全部实例自动关联原生审批与问答通道,只在运行时管理,不写入 `remote.json`。停止托管服务或退出应用关闭全部实例。外部服务不能自动加载 profile 时提示并保留普通启动。已运行的独立会话需先退出原客户端,再通过 `codex -p agentrouter resume <会话ID>` 恢复。

命令接入支持 PowerShell、Bash / Zsh，保留显式参数；灵动岛或目标服务不可用时恢复普通启动。认证连接的 `tokenEnv` 必须也在终端环境中可用。安装器备份 Shell 配置，移除时保留其他内容；常规 Codex CLI 更新沿用原安装入口，VS Code 插件独立运行。

只连接已经承载目标会话的 App-server。配置显式指定原生 thread ID：

```json
{
  "id": "codex-local",
  "url": "ws://127.0.0.1:4500",
  "threads": [],
  "tokenEnv": "CUTE_ISLAND_CODEX_WS_TOKEN"
}
```

该配置仅用于其他 app-server：将对象加入 `codex` 数组，保存后开启远程接管。灵动岛自身的托管服务自动关联，不需要此项。客户端通过 `codex --remote ws://127.0.0.1:4500` 连接到同一服务。`threads` 留空或省略时，自动接管该服务中全部已加载会话；填写 ID 数组可限定接管范围。启动时立即扫描，此后每 5 秒发现新会话，也会移除已关闭的会话。没有认证的本机监听可省略 `tokenEnv`；非本机连接只接受 `wss://`。服务通过 `thread/loaded/list` 分页检查会话，仅订阅同一实例已加载的线程。

支持命令、文件、权限审批，原生问题回答，简单 MCP 表单，`turn/steer` 和 `turn/interrupt`。运行中追加消息携带 `expectedTurnId`；已确认空闲的线程使用 `turn/start`。权限批准仅作用于当前请求／轮次，不保存“始终允许”规则。Codex App-server／WebSocket 接口存在实验性限制，须使用支持这些方法的版本。

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
| 恢复异常中断的会话 | `/resume 异常请求ID [继续指令]`，也可使用唯一对应待处理通知的原生会话 ID |
| 中断 | `/interrupt 会话ID`，只对支持的 Codex 连接开放 |

Telegram 的单问题单选可直接点击选项回答；多问题和多选题可逐题点击选项，再按「提交回答」，多选再次点击可取消。选项说明随问题展示，长内容可点「查看详情」。自由输入可引用单题通知回复，多题的其他回答可使用 JSON 命令。飞书、企业微信和 Discord 提供审批按钮，多问题通过相同的 JSON 命令回答。普通“yes”“继续”等裸消息不会自动批准，也不会猜测目标会话。

已接管的问题也会在本地灵动岛展开，支持单选、多选、选项说明和自由输入；内容较长时向下滚动到「提交回答」。从本地或远程任一端提交后，两端同步处理状态，旧按钮无法重复提交。托管模式在回答后自动收起，关注模式可展开查看已提交的答案，直到 Agent 确认完成。仅从日志观察到的问题没有原生控制关联，仍需在原 Agent 中回答。

远程接管与自动审批可同时开启：Claude Code 和 Codex 会先自动批准已开启规则的权限请求、回答符合选择策略的问题；无推荐且选择「保留手动回答」、自由输入、计划确认及不支持的请求继续交给你处理。关闭某条规则或自动审批总开关后，对应请求直接进入远程待办。Cursor 和 Gemini 仍按原远程门禁处理。自动回复前先持久化处理标识，重复请求和应用重启不重放可能已经提交的决定。

Telegram 通知使用 HTML 富文本：状态加粗、命令显示为可复制代码块、长说明和问题放入可展开引用。通知下方提供「查看详情」按钮，长详情自动分条发送，保留完整内容；请求状态变化时更新原消息，并撤去已经失效的操作按钮。无法恢复的日志观察事件标为「仅提醒」，「知道了」只关闭提醒；只有已连接且支持追加指导的会话才显示 `/send` 提示。

### 从异常通知继续任务

Codex、Claude Code 的主会话有明确执行失败记录，且能关联原生会话及恢复入口时，四个渠道的异常通知都会提供「继续会话」和「知道了」。明确的主动中断或取消不会作为执行失败主动通知；中断同时带有原生错误时保留异常通知。正常完成会关闭旧待办，已确认的同一次异常不会因诊断更新再发送。工具失败和一般 Hook 通知不单独创建会话异常。选择「继续会话」会恢复原生会话并发送：

> 请继续上次异常中断的任务。先核对已有进度和执行结果，避免重复已完成的操作，再完成剩余工作。

也可发送 `/resume 通知中的请求ID 先检查测试，再继续原任务` 自定义继续指令。`/sessions` 显示原生会话 ID；它唯一对应一条待处理异常通知时，可直接作为 `/resume` 的目标。普通日志静默、子任务异常和外部 HTTP 推送不会据此启动主会话。旧通知对应的会话已继续或已完成时，恢复会被拒绝。

- **Codex**：需要已配置且运行中的 app-server。先读取原线程核对失败／中断轮次，再 `thread/resume` 加载同一个原生 ID，最后 `turn/start` 提交继续指令。已有连接保留连接归属和 `threads` 限定范围；仅由本机日志发现的线程必须唯一匹配一条本机连接。不会新建或分叉线程，也不会因为启动接管或周期扫描自动恢复离线线程。服务自身已退出时，需先在本机重新启动服务。
- **Claude Code 原生终端接入**：先开启远程接管并安装指向当前配置的 Claude Hook，再在工作目录运行以下命令。在 Claude 的原生启动确认界面启用 cute-island Channels 后，远程继续和 `/send` 会直接进入这个终端会话，由 Claude 显示消息并处理。权限与问题仍通过 Hook 回传。Channels 属于预览功能，需要安装版本支持，且受账户及组织策略限制；启动确认由用户在原生界面完成。

  ```powershell
  node bin/cute-island.js claude
  node bin/cute-island.js claude --resume 01234567-89ab-cdef-0123-456789abcdef
  ```

  开发时也可运行 `npm run island -- claude`。`/sessions` 将此类会话标为「原生终端接入」。只支持交互模式及完整会话 ID；`--continue`、会话选择器、后台与分叉参数会被拒绝。当前任务仍在执行时，旧异常通知不能再次恢复。收到 Claude 的 `confirm_receipt` 工具确认后，指令才标为已接收。超时、断线及应用重启不会重发，也不会转为另一后台进程；关闭接管会断开消息通道，保留用户终端，重新开启后需要重启接入。
- **Claude Code 后台兼容路径**：普通启动的会话需要本机已安装并登录 CLI、原工作目录仍存在，并已安装指向当前配置的远程 Hook。在原工作目录启动后台进程 `claude --resume 原生ID --print`，延续同一个会话 ID 和历史，通过标准输入提交继续指令。原来的交互式终端不会同步显示后台输出或自动继续；请在灵动岛查看进度，后台执行结束后，再在本机使用 `claude --resume 原生ID` 查看会话。原会话有忙碌的注册进程或其他正在恢复该 ID 的 CLI 时拒绝重复启动；已知空闲的注册进程不视为任务正在执行。灵动岛关闭接管或退出时，会停止自己启动的 Claude 恢复进程。

操作在执行前持久化，随后通知更新接收结果；等待启动时仍可在渠道处理审批。重复消息、重复点击和应用重启不会重放同一恢复请求。`resolved` 表示原生继续指令已确认接收，任务是否完成仍以会话后续日志为准；`uncertain` 表示结果待确认，请检查原会话，系统不会自动重试。恢复进程再次明确失败时，会重新通知。

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
node scripts/smoke-connectivity.cjs
node scripts/smoke-codex-command.cjs
node scripts/smoke-managed-codex.cjs
node scripts/smoke-codex-profile.cjs <Codex原生程序绝对路径>
```

自动测试使用本机 HTTP／WebSocket 和模拟 Bot API，验证原生 Hook 回传、Codex 关联、重复回复、失效请求、崩溃恢复、渠道授权及重试。`smoke-remote-toggle.cjs` 使用隔离配置和真实 Electron 托盘回调，验证启停、编译后的 CLI Hook 释放、旧审批失效、显示模式独立和重启持久化，不连接实际渠道。真实 Bot、飞书应用、企业微信租户、Discord 权限和实际 Agent 版本仍需在配置自己的账号后进行联调。

`smoke-codex-command.cjs` 在 Windows 上使用真实 Electron、同一个 PowerShell 会话和隔离配置，验证命令接入的安装、动态切换、接管优先级、服务失联回退、CLI 更新及移除恢复，覆盖中文、引号和空参数。服务和 Codex 命令使用本机测试替身，不调用模型或真实消息渠道；同时保存浅色、深色及窄窗口截图。

`smoke-managed-codex.cjs` 使用真实 Electron、隔离的托管服务测试替身及 Telegram API 测试替身，验证无需 Codex 连接配置即可转发原生审批、终端和远端同时处理、旧按钮失效、接管启停和托管服务重启。不调用模型或真实消息渠道。

官方协议参考：[Claude Hooks](https://code.claude.com/docs/en/hooks)、[Claude Channels](https://code.claude.com/docs/en/channels-reference)、[Codex App-server](https://developers.openai.com/codex/app-server/)、[Gemini Hooks](https://geminicli.com/docs/hooks/reference/)、[Cursor Hooks](https://cursor.com/docs/agent/hooks)、[Telegram](https://core.telegram.org/bots/api)、[飞书](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-callbacks)、[企业微信 SDK](https://github.com/WecomTeam/aibot-node-sdk)、[Discord](https://docs.discord.com/developers/interactions/receiving-and-responding)。
