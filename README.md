# Cute Island

支持通过 Telegram、飞书、企业微信、Discord 远程接管已接入的 Agent 会话，处理审批、人工回答和补充指令。接入方式、能力边界及配置见 [远程接管说明](REMOTE_CONTROL.md)。

远程接管可独立启停：通过「打开配置… → 远程接管」编辑渠道和 Codex 连接，托盘「配置远程接管…」也会直接打开这一页，之后勾选／取消「远程接管」即可切换，也可执行 `remote enable`／`remote disable`。新配置默认关闭，开关会保存；关闭后已安装的 Hook 自动交回原 Agent，无需手工移除，也不影响关注／托管显示模式。

<p align="center">
  <img src="build/icon.png" width="128" alt="Cute Island 图标：米色圆角底上的黑胶囊，里面是橙、绿、蓝三颗圆点">
</p>

Windows、macOS、Linux 上的 PC 灵动岛。黑胶囊贴在屏幕顶部正中，用来看 agent 正在做什么。
首次启动默认位于顶部居中，可以按住胶囊或会话标题拖动；松手记住位置，重启后恢复。默认半透明，鼠标悬浮、拖动、键盘聚焦或点击展开时恢复实色，收起并移开焦点后恢复半透明。

支持两种显示模式，可在独立配置窗口或系统托盘右键菜单中切换，重启后记住选择：

- **关注模式**（默认）：支持悬浮、点击展开、拖动和贴边收纳。贴边隐藏时，待审批、明确的用户输入请求、会话或子任务异常会自动向屏幕内展开提醒；点击「知道了」、按 Escape 或问题恢复后回到原来的边缘，保留会话和位置。
- **托管模式**：平时只保留淡显的紧凑状态或贴边把手（28% 不透明度，空闲细条为 16%），鼠标悬浮不加深，点击、滚动和拖动穿透到下方窗口。明确的审批、用户输入请求、会话失败或后台任务异常会主动展开并恢复实色；提醒期间只显示需要关注的会话，只有提醒面板接收鼠标，周围透明区域继续穿透。点击「知道了」或按 Escape 可收起当前会话的提醒，不会删除会话；问题恢复后也会自动收起，回到原来的贴边状态。

两种模式的提醒均不会因客户端、进度或时间刷新反复弹出；新的审批命令、新一轮任务或异常再次发生时会重新提醒。普通「等待中」也可能表示等待 Agent 回复，不会仅凭这个状态弹出。用户输入提醒识别明确的 `AskUserQuestion`、`AskQuestion`、`ask_user`、`request_user_input` 和 `request_user_input_async` 调用；未配置远程接管时，灵动岛提醒你回到原 Agent 处理。已接管的会话可以通过远程渠道提交审批或答案。浏览器预览可在底部切换两种显示模式。

闲置时它收成一条细胶囊。有活动时变成紧凑态：左侧是状态图标，右侧是一行标题。点一下展开，能看到 agent 名称、说明、进度、最近步骤和耗时。成功会短暂打勾后收回；失败保持展开，直到被新状态盖掉，或点「关闭」。

执行状态和操作类型使用 SVG 图标：命令终端、文件读写、搜索、MCP、Skill 和子 Agent 协作各有标识。执行中显示轻量动画，遵循系统「减少动态效果」设置。Codex 标识采用官方 VS Code 扩展使用的 OpenAI Blossom 矢量图形。

紧凑态、多会话列表和展开详情均显示来源客户端，独立于 Agent 名称和命令 Shell。例如同为 Claude Code 的会话可以分别标注 VS Code、Cursor、Windows Terminal 或 PowerShell。来源标签只用于展示；点击会话仍展开详情。

「执行时间」表示最近一轮执行已持续多久：从本轮开始累计，工具切换、状态刷新和客户端标签变化不重置；新一轮开始时重新计时。紧凑态与会话列表显示在状态下方，展开后显示在右上角。完成或失败后保留本轮耗时；仍有子 Agent 或后台命令运行时继续计时。超过一小时显示 `时:分:秒`。

展开命令可查看命令内容、Shell 和工作目录；长命令支持换行、滚动和选择复制。MCP 显示服务与工具名称，Skill 显示读取或调用的技能名称，子 Agent 显示任务名称。需要审批时自动展开琥珀色提示；配置自动审批并接入支持的 Agent 后，可按规则自动回传批准或回答。

## 配置窗口与自动审批

首次启动会打开独立配置窗口。之后可通过托盘「打开配置…」、双击托盘图标、灵动岛右键菜单，或再次启动应用打开。启动参数 `--settings` 也可直接打开配置。关闭配置窗口后，灵动岛继续运行。

配置分为常规、自动审批、Agent 接入、远程接管和处理记录：

- **常规**：选择浅色、深色或跟随系统主题，切换关注 / 托管模式、控制本机会话识别、显示或隐藏灵动岛、恢复顶部位置、播放演示。
- **自动审批**：独立总开关，默认关闭。可分别开启权限审批、选择题回答；推荐项支持 `（推荐）`、`(Recommended)` 或原生推荐标记。无推荐时默认保留手动回答，也可选择第一项。自由输入、密码、重复问题标识、无法确定唯一答案的问题保留手动处理；多题请求必须能完整回答才提交。
- **远程接管**：图形化添加、编辑和移除 Telegram、飞书、企业微信、Discord 渠道及 Codex 原生线程连接；读取原有 `~/.cute-island/remote.json`，保留控制令牌和自定义字段。修改渠道前先关闭接管，保存后重新开启。凭据填写环境变量名称，实际 Token / Secret 放在应用继承的环境中。开启远程接管时，自动审批暂停响应；关闭后恢复原自动审批设置，避免重复处理。
  每项连接可在保存前点击「测试连通性」：消息渠道发送测试消息，Codex 检查服务和已加载线程；失败原因显示在对应配置下方。
- **Agent 接入**：显示安装和连接状态。读取日志只能展示状态，自动审批必须使用下列原生交互通道。
- **处理记录**：保留本次启动最近 50 条批准、回答或转交手动的记录，可清空；不会把提交回答伪装成工具执行成功。

设置自动保存至 Electron 用户数据目录的 `preferences.json`，与托盘实时同步，重启后恢复。旧版仅含 `mode` 的文件自动兼容。`CUTE_ISLAND_WATCH=0` 优先于界面的会话识别开关。

配置页主题可在「常规 → 外观」选择，也可使用侧栏底部的快捷切换；窄屏时快捷切换位于顶部。默认跟随系统，系统颜色模式改变时即时响应；手动选择浅色或深色后保持该选择。原生窗口背景与配置页同步，主题偏好在重启后保留。

### Claude Code

在「Agent 接入」点击「安装接入」，随后重新打开 Claude Code 会话。安装器只增删自己的 HTTP Hook，保留其他配置，并在修改前创建备份。配置位置为 `~/.claude/settings.json`，支持 `CLAUDE_CONFIG_DIR`。

`PermissionRequest` 回传本次工具权限的批准；`PreToolUse` 的 `AskUserQuestion` 将完整推荐答案写入 `updatedInput.answers`。计划确认保留手动处理。协议依据 [Claude Code Hook 文档](https://code.claude.com/docs/en/hooks#allow-with-updatedinput)。需要支持 HTTP Hook 的 Claude Code 版本。

Hook 调用本机 `POST /v1/hooks/claude`，沿用 `CUTE_ISLAND_PORT` / `CUTE_ISLAND_TOKEN`；修改端口或令牌后需重新安装接入。暂停自动审批时返回空 Hook 结果；应用退出或连接失败时由 Claude Code 恢复正常流程。按钮可移除接入。

### Codex app-server

在「Agent 接入 → Codex app-server」点击「启动托管服务」，灵动岛会检测已安装的原生 Codex CLI 并在本机启动服务。启动设置会保留，下次随应用恢复；停止服务或退出灵动岛会关闭自己启动的进程。默认端口为 4500，可展开设置修改端口和程序路径。端口被占用时会提示，不接管占用端口的其他进程。

服务启动后，在同页「直接使用 codex 命令」点击「安装命令接入」，重新打开终端，以后直接运行 `codex` 或 `codex -p agentrouter`。开启自动审批或远程接管时，命令接入会读取当前开关并自动添加 `--remote`；远程接管优先。两者都关闭、灵动岛退出或目标服务不可用时，新启动的命令恢复普通方式。同一终端内切换开关无需重新安装。

Windows 接入 PowerShell，macOS / Linux 接入 Bash / Zsh。安装前备份 Shell 配置，保留其他内容；「移除命令接入」删除应用添加的部分，重新打开终端后恢复原命令。手动指定 `--remote`、`--no-daemon` 或 `--worktree` 时保留你的选择，`exec`、`login`、`app-server` 等不支持远程模式的子命令原样执行。也可不安装接入，手动运行页面中的 `codex --remote ws://127.0.0.1:4500`。

命令接入调用原来的 Codex 安装入口，常规 CLI 更新继续生效；若更新改变了安装位置，重新安装接入。VS Code 的 Codex 插件、Codex 桌面应用独立运行。开关只改变后续命令的启动方式，已运行的会话继续使用原连接；关闭接管后，如自动审批仍开启，后续命令仍使用远程连接。沿用本机 Codex 登录，只有连接同一服务的会话可被处理。

若已有服务，展开「连接已有的 app-server」，填写**与你的 Codex 客户端共用**的本机 WebSocket 服务地址，例如 `ws://127.0.0.1:4500`，保存后开启自动审批。服务端可以使用以下命令启动，使用它的客户端也必须连接到同一服务：

```bash
codex app-server --listen ws://127.0.0.1:4500
```

使用 `codex -p agentrouter --remote ws://127.0.0.1:4500` 等自定义 provider 时，服务端也必须能读取对应的 `[model_providers.<ID>]` 定义。仅在客户端选择 profile 不会把该定义同步给 app-server；可将 profile 中的 provider 表加入服务端用户级 `$CODEX_HOME/config.toml`，保留原来的默认 provider。凭据环境变量也须在服务端进程中可用。若提示 `Model provider custom not found`，检查服务端是否定义了 `[model_providers.custom]`；provider 的 `name` 是显示名称，表名才是 ID。参见 [Codex 配置文档](https://developers.openai.com/codex/config-reference/)。

灵动岛作为另一个协议客户端，只加入服务已加载的会话，不启动任务，也不修改会话原有的沙箱或审批策略。支持命令执行、文件修改、权限请求和 `item/tool/requestUserInput`；单次批准使用 `accept`，权限授予限本轮，不添加永久规则。断线后每 5 秒重连，暂停时断开连接。协议类型基于本机 `codex app-server generate-ts --experimental` 生成的定义核对。

仅支持本机无认证的 `ws://` 服务。独立运行的普通 Codex CLI、桌面应用、VS Code 插件不会因被日志识别而自动接入。手机消息渠道的远程接管只需配置同一服务地址，会话 ID 可留空；开启后每 5 秒自动发现已加载会话，也可填写 ID 限定范围，并配置认证环境变量，支持本机 ws 或远程 wss。Claude、Cursor、Gemini 的远程 Hook 接入见[远程接管说明](REMOTE_CONTROL.md)。未接入会话仍由原客户端处理。

浏览器预览点击底部「打开配置」或访问 `http://127.0.0.1:5174/#settings` 可查看配置界面；预览只保存浏览器设置，不执行本机审批或修改 Agent 配置。

### Gemini、Cursor 的接管安装

在「远程接管 → Agent Hook 接管」点击「安装 Gemini CLI 接管」或「安装 Cursor 接管」，重新打开对应客户端或会话，再配置消息渠道并开启远程接管。也支持安装 Claude Code 远程 Hook。安装前备份原配置，保留其他 Hook，可随时移除；同一远程配置的旧版 CLI Hook 会迁移，避免重复请求。

Gemini 支持 `BeforeTool` 确认及上下文指导，Cursor 支持 Shell / MCP 执行前确认及后续指导。它们只通过本次 Hook 门禁，不替代客户端原生权限策略；任意原生选择题尚不能统一回填。完整步骤见 [远程接管说明](REMOTE_CONTROL.md)。

## 开发

需要 Node.js 22.12 或更高版本。

```bash
npm install
npm run dev
```

只看界面、不启动 Electron 时：

```bash
npm run dev:web
```

浏览器打开 http://127.0.0.1:5174 。页面底部可以播放演示、模拟失败或清空。
还可以点击「MCP / Skill / 命令」查看各种操作，或点击「需要审批」查看审批提示。

## 把状态推过来

应用只监听 `127.0.0.1:17321`。端口用 `CUTE_ISLAND_PORT` 改。如果设置了 `CUTE_ISLAND_TOKEN`，请求要带 `Authorization: Bearer <token>` 或 `X-Island-Token`。

```bash
npm run island -- push --agent Cursor --state running --title "正在修改登录页" --progress 0.4
npm run island -- push --id vscode-task --agent Codex --client "VS Code" --state running --title "正在检查测试"
npm run island -- end --result success --summary "登录页已更新"
npm run island -- demo
```

也可以直接 POST：

```bash
curl -X POST http://127.0.0.1:17321/v1/activities \
  -H 'content-type: application/json' \
  -d '{"id":"run-1","agent":"Cursor","state":"running","title":"正在修改登录页","progress":0.4}'

curl -X POST http://127.0.0.1:17321/v1/activities/run-1/end \
  -H 'content-type: application/json' \
  -d '{"result":"success","summary":"登录页已更新"}'
```

`state` 可以是 `thinking`、`running`、`waiting`、`approval`、`success`、`error`。同一个 `id` 再次 POST 会合并更新。`GET /v1/activities` 返回当前活动。`WS /v1/events` 会在每次变化时推送 `{ "type": "activities", "activities": [...] }`。

多个活动同时存在时，按 agent 分组显示会话列表，点击各行查看详情。同一 agent 内按失败、需要审批、执行、思考、等待、成功排序。

HTTP 可传 `client: "VS Code"`，CLI 使用 `--client "VS Code"` 显式指定来源。省略时保留已有值；传 `client: null` 或 `--client null` 清空；名称最多 40 个字符。

HTTP 可传 `startedAt`（本轮开始）和 `endedAt`（本轮结束），均为 Unix 毫秒时间戳。新一轮可显式更新 `startedAt` 并设置活动状态；未指定时，首次推送或结束后的下一次执行从收到更新时计时。普通更新保留本轮开始时间，结束时间仅在完成或失败状态使用。

可通过 CLI 显式推送操作和审批状态：

```bash
npm run island -- push --id task-1 --agent Codex --state approval --title "安装依赖" --command "npm install" --shell PowerShell --cwd "D:/projects/app" --detail "需要访问网络"
npm run island -- push --id task-1 --state running --kind mcp --name "context7 / query_docs" --title "获取组件文档"
npm run island -- push --id task-1 --state running --kind skill --name frontend-design --title "读取设计技能"
npm run island -- push --id task-1 --state thinking --kind null --title "整理结果"
```

HTTP 对应字段为 `operation: { kind, name?, command?, shell?, cwd? }`，`kind` 支持 `command`、`read`、`edit`、`search`、`mcp`、`skill`、`agent`、`tool`。传 `operation: null` 清空；普通更新省略时保留。步骤可带 `kind`，`status: "waiting"` 表示该步骤等待审批。

## 自动识别本机会话

应用启动时会恢复已经开始的本机会话，之后持续跟踪四种 agent 的日志。明确的回合结束标记会显示完成；工具失败或回合失败保持可见，直到关闭或有新状态。

Claude Code 的原生 API 错误（`isApiErrorMessage`）显示失败，即使该记录同时带有 `stop_sequence`；用户中断标记同样会结束当前计时。本地 `/list-agents` 等带本地命令关联标记的操作不会覆盖失败状态或开始新一轮。原生 `continued-in` 续接记录会移除旧会话卡片，将旧目录的子任务状态关联到新会话，避免压缩续接后出现重复会话。应用观察期间新产生的完成或失败记录，即使首次发现晚于短暂的新鲜窗口，也会正常显示。

检测到 agent 进程时，会从最近 24 小时、每种 agent 最新 64 个候选记录中寻找未结束的会话；已跟踪的会话不会因超过这个窗口而消失。新版 Claude Code 的忙碌会话还会通过 `~/.claude/sessions/<PID>.json` 和存活 PID 关联，可恢复超过 24 小时的长任务。没有进程依据时只检查最近两分钟的记录，且不复活旧的完成记录。文件暂时不更新不会被当作成功；已跟踪任务的具体登记变为空闲或关联进程退出、且日志静默超过一分钟后显示中断。仍在等用户回答问题、且日志里还没有答复时，保持「需要你回复」，不会因为一直没回复就被记成中断。这包括 Claude 的 `AskUserQuestion`、Cursor 的 `AskQuestion`、Gemini 的 `ask_user`，以及 Codex 的 `request_user_input`。等待用户审批（包括 Codex MCP 工具授权和 `request_permissions`）的会话同样保持「需要审批」，日志静默不会把它记成中断。Cursor 桌面端记录没有工具 ID 和结果行，要等后一条助手消息里出现新的工具调用才会给之前的调用收尾；只带文字说明的消息不收尾，待回答的问题和待审批的请求因此不会被前面的旧调用盖住，也不会因此被记成中断。另一个 Claude 进程不会无限维持旧会话的运行状态；缺少具体会话登记时，同类进程依据最多保留 30 分钟静默宽限。

| Agent | 记录位置 |
| --- | --- |
| Claude Code | `~/.claude/projects/<项目>/<会话>.jsonl` |
| Codex | `~/.codex/sessions/年/月/日/rollout-*.jsonl` |
| Gemini | `~/.gemini/tmp/<项目>/chats/session-*.json`，兼容 JSONL |
| Cursor | `~/.cursor/projects/<项目>/agent-transcripts/<会话>/<会话>.jsonl` |

Cursor 桌面版和 CLI 均可作为会话恢复线索，但进程存在不代表某个会话仍在执行。已跟踪的普通 Cursor 任务静默超过一分钟时，保留最后记录的状态、操作和计时，标注「暂未收到更新」，不会仅因静默一分钟或三十分钟就显示失败、停止子任务或弹出托管异常提醒。后续日志更新会恢复正常显示；明确的完成、失败、审批和用户提问仍按日志处理。不再需要关注的待确认会话可展开后关闭。`stale: true` 表示显示的是最后记录、当前状态尚未确认；HTTP 可用 `stale: false` 清除此标记，终态也会自动清除。

Windows 上这些目录在 `%USERPROFILE%` 下面，布局相同。可以用 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GEMINI_CLI_HOME`、`CURSOR_HOME` 改根目录。支持原生可执行文件及通过 Node.js 启动的 npm agent。设置 `CUTE_ISLAND_WATCH=0` 可以关掉自动识别，只保留上面的 HTTP 接口。

扫描使用异步 I/O：已发现的日志约每 800 毫秒检查一次，新文件约每 10 秒发现一次，有近期任务时进程查询间隔 5 秒，空闲时延长为 30 秒；内容未变化时不重新读取和解析。同一轮扫描只推送一份最终活动列表。常驻扫描复用文件系统变更通知和目录索引，每分钟全量校准一次；变更通知不可用时恢复定期遍历。启动后在后台刷新进程快照，慢查询不再阻塞本轮日志更新；Windows 查询进程完成后立即退出，停止监听时释放目录监听器。内置 Agent 的 JSONL 首次按 64 KiB 分块读取并建立状态，之后只解析追加的数据；保留未写完的记录，文件替换或截断后重新建立状态。后台任务的启动记录不会因落到文件尾部窗口以外而丢失；Gemini JSON 整份读取，上限 16 MiB。

执行时间优先使用日志中最近一轮用户请求或明确的执行开始事件时间，结束时间取对应完成记录。中途启动灵动岛也能恢复日志记录的耗时。没有开始时间时使用本轮第一条带时间的执行记录；日志完全不含时间戳时，从首次观察到该轮计时，因此无法还原启动灵动岛之前的耗时。计时在界面内每秒刷新，不会额外扫描日志或改变会话排序。

子 Agent 与后台命令在展开后单独列出，紧凑态显示运行数量。嵌套子 Agent 会逐层合并到顶层会话；仍有下级任务运行时保持执行状态。默认清理静默超过 30 分钟且缺少存活依据的后台任务，但原生忙碌登记或仍活跃的下级任务会保留对应任务。会话元数据尚未写完整时暂缓归类，后续扫描会重试。

每个子任务显示可见的状态和执行时间：有关联子会话时显示思考中、执行中、等待中或需要审批；结束后显示已完成、失败或已停止。计时来自任务启动/结束事件及子会话日志，普通状态或详情更新不会重置，结束后冻结。缺少可靠起止时间显示「未记录」。`tasks` 可传可选的 `state`、`startedAt` 和 `endedAt`；同一任务更新保留已知时间，新一轮显式更换 `startedAt`。子会话需要审批时，即使父会话还在正常执行，也会触发托管提醒。开始新一轮时移除已结束的旧子任务，避免历史异常重复提醒；跨轮次仍在运行的任务继续保留。

Codex 子线程继承的父会话历史不会重复计入任务：以日志首条 metadata 确定线程身份，并根据 `subagent_history_start_ordinal` 排除继承的审批、异常和子任务。兼容 `SubAgentActivity.started` 与旧版协作事件。会话归属依据原生线程 ID 和父子关系，不会因标题、目录或历史内容相同就合并独立会话。

自动识别依赖各 agent 实际写出的日志。除可关联的 Claude 会话外，进程检测只能证明某种 agent 在运行，无法精确区分该进程下所有会话；缺少结束标记的旧日志仍可能被判断为活动。需要精确状态时可以使用 HTTP/CLI 推送。

客户端识别同样按会话取证：Codex 使用 `session_meta` 中的来源，命令行显示「CLI」，兼容编辑器共享的扩展标识显示「IDE 扩展」。新版 Claude Code 使用原生会话登记的 PID 和进程祖先识别宿主，优先显示编辑器或终端应用，其次显示 PowerShell、cmd 等 Shell；进程退出后保留本次运行中观察到的来源。没有可靠信息时显示「未知客户端」，不会根据工具的 Shell、工作目录或同类 Agent 进程猜测。Cursor/Gemini 等没有可关联来源的记录可通过 HTTP/CLI 指定客户端。

操作识别基于工具名称和记录的参数。读取 `SKILL.md` 表示「读取技能」，不代表能证明该技能后续的所有指令都已执行。MCP 支持直接工具调用和 `functions.exec` 中明确写出的静态 MCP 工具名；动态生成的调用名称无法可靠识别。审批识别支持明确的 Codex 审批请求（含 MCP 工具授权的 `request_user_input` / `elicitation_request` 事件与 `request_permissions`）、`sandbox_permissions: "require_escalated"` 请求、Cursor 的 `request_smart_mode_approval`（原因取 `smart_mode_block_reason`）和 Gemini 的等待审批状态；请求可能被原工具自动放行，后续执行或结果记录会更新状态。没有审批日志的会话不会根据等待时长或自然语言猜测为需要审批，可使用 `approval` 状态显式推送。

## 窗口

窗口无边框、透明、置顶，不进任务栏，也不抢焦点。只有胶囊本身接收点击，周围的透明区域会把鼠标让给下面的窗口。托盘菜单可以显示、隐藏、播放演示或退出。

拖动超过 5 像素才移动窗口，轻点仍展开详情；命令内容保留选择复制和滚动，关闭按钮可正常点击。拖到屏幕工作区顶部、左右或底部边缘附近（24 像素内）松手后，会缩成贴边的小把手；点击把手向屏幕内展开，再点胶囊空白处、外部透明区域或按 Escape 可重新收纳。悬浮只改变透明度，不会展开；普通执行进展通过把手颜色提示，待审批、明确的用户输入请求或异常则自动展开提醒，点击「知道了」、按 Escape 或问题恢复后重新收纳。把手也可以直接拖离边缘，恢复普通悬浮。展开时会自动避让边界，位置和贴边状态在重启后恢复。显示器断开后会将胶囊移回可见区域；托盘「恢复顶部居中」可取消贴边并重置位置。位置记录保存在应用用户数据目录的 `window-position.json`，浏览器预览使用本地存储。

macOS 使用 panel，并在全屏空间保持可见。Windows 和 Linux 使用 screen-saver 级别置顶。Linux 需要桌面合成器，透明窗口才能透出后面的内容。

## 打包

```bash
npm run dist
```

该命令依次执行类型检查、测试、构建和当前平台打包，产物在 `release/`。仅生成可运行目录时用 `npm run pack`。配置已经写好 Windows NSIS、macOS dmg、Linux AppImage 和 deb。三端安装包都用 `build/icon.png`。

生产构建压缩 JS/CSS，React 和动画库只保留构建后的代码，不重复分发其 npm 包。Electron 仅打包简体中文、繁体中文和英语资源，并启用最大压缩；需要其他系统对话框语言时可扩展 `build.electronLanguages`。运行时仍使用 Electron，安装体积的主要部分来自 Chromium/Node.js。

Windows 打包后的集成验证（使用隔离的临时用户目录和端口，不安装应用）：

```bash
node scripts/smoke-packaged.cjs "release/win-unpacked/Cute Island.exe"
```

它验证启动前会话恢复、Claude 续接与 API 异常、本地命令不重置失败计时、HTTP、preload、展开/关闭、成功自动收起和空闲布局开销，并将截图存入 `release/`。

拖动与透明度集成检查（使用隔离的 Electron 用户目录和模拟光标，不移动你的鼠标）：

```bash
npm run build
node scripts/smoke-interaction.cjs
```

它验证实际窗口移动、点击与拖动区分、命令选择、透明度、四边收纳与点击展开、托管模式鼠标穿透与提醒、子任务状态与执行时间、子会话审批、重启恢复和托盘重置，截图保存在 `output/playwright/`。

发布前同步更新 `package.json`、`package-lock.json` 和 `RELEASE_NOTES.md`。推送版本标签，或在 Actions 里手动运行 Release，都会在三端打包成功后发布到这个仓库的 [Releases](https://github.com/xihadance/cute-island/releases)，并附上版本说明。手动运行时，标签取 `package.json` 里的版本号，例如当前是 `v0.1.14`。

```bash
git tag v0.1.14
git push origin v0.1.14
```

## 图标

应用图标是米色圆角方块，中间一条黑胶囊，胶囊里三颗圆点：橙、绿、蓝。

| 文件 | 用途 |
| --- | --- |
| `build/icon.png` | 1024 像素，Windows、macOS、Linux 安装包图标 |
| `build/tray.png` | 32 像素托盘图标源图。运行时托盘读 `src/main/tray-icon.ts` 里嵌进去的同一张图 |
| `src/renderer/favicon.png` | 开发时浏览器页签图标，由 `src/renderer/index.html` 引用 |
