<div align="center">

<img src="build/icon.png" width="112" alt="Cute Island icon: a black capsule on a beige rounded square, holding orange, green and blue dots" />

# Cute Island

**A Dynamic Island for your PC — keep an eye on your local AI agents**

A black capsule sits at the top of your screen showing what Claude Code, Codex, Gemini and Cursor<br />
are doing right now. It speaks up when approval is needed, and you can take over from your phone.

[![Release](https://img.shields.io/github/v/release/xihadance/agent-island?style=flat-square&color=78db9c)](https://github.com/xihadance/agent-island/releases)
[![License](https://img.shields.io/badge/license-MIT-78b9ff?style=flat-square)](#license)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-c2afff?style=flat-square)](#install)
[![Electron](https://img.shields.io/badge/Electron-44-f3c76a?style=flat-square)](https://www.electronjs.org/)

[简体中文](README.md) · **English**

<br />

<a href="media/cute-island-intro.mp4">
  <img src="media/intro-hero.gif" width="760" alt="Full walkthrough of Cute Island capsule morphing, details, approval alerts, and remote takeover" />
</a>

<sub>▶ [Watch the full intro video (60s)](media/cute-island-intro.mp4)</sub>

</div>

---

## What is this

You can't watch a terminal all day while agents run in the background. Cute Island collects their state into a single capsule at the top of your screen:

- **See progress at a glance** — which agent, which client, which step, how long it's been running
- **Never miss an approval** — expands on its own when you need to approve or answer, and won't get buried by routine progress updates
- **Handle it from anywhere** — approve, answer and send follow-up instructions over Telegram, Feishu, WeCom or Discord
- **Stays out of the way** — collapses to a thin bar when idle; in managed mode the mouse passes straight through to the window below

## Supported agents

| Agent | Status detection | Auto-approval | Remote takeover |
| --- | :---: | :---: | :---: |
| **Claude Code** | ✅ | ✅ HTTP Hook | ✅ approve / answer / follow-up |
| **Codex** | ✅ | ✅ app-server | ✅ approve / answer |
| **Cursor** | ✅ | — | ✅ Shell / MCP pre-exec confirm |
| **Gemini CLI** | ✅ | — | ✅ BeforeTool confirm |

> Reading logs can only **display** status. Sending an approval or answer back requires one of the native interaction channels above.

## Install

Grab the package for your platform from [Releases](https://github.com/xihadance/agent-island/releases):

| Platform | Format | In-app update |
| --- | --- | :---: |
| Windows | `.exe` (NSIS installer) | ✅ |
| macOS | `.dmg` | manual |
| Linux | `.AppImage` | ✅ |
| Linux | `.deb` | via package manager |

The settings window opens on first launch. After that, use the tray menu "Open settings…", double-click the tray icon, or pass `--settings`.

## Quick start

1. **Works out of the box** — on launch it picks up Claude Code, Codex, Gemini and Cursor sessions already running on your machine, with no configuration
2. **For auto-approval** — click "Install integration" on the *Agent integration* page, reopen your agent session, then enable the types you want on the *Auto-approval* page
3. **For remote takeover** — configure a message channel on the *Remote takeover* page (credentials go in as environment variable *names*), then tick "Remote takeover"

```bash
# development
npm install
npm run dev

# renderer only, no Electron
npm run dev:web     # http://127.0.0.1:5174
```

Requires Node.js 22.12 or newer.

## Two display modes

Switch in the settings window or the tray right-click menu. Your choice is remembered across restarts.

| | **Focus mode** (default) | **Managed mode** |
| --- | --- | --- |
| At rest | Semi-transparent, solid on hover | Dimmed (28%), idle bar at 16% |
| Mouse | Capsule takes clicks, transparent area passes through | Clicks, scrolls and drags all pass through |
| Interaction | Hover, click to expand, drag, dock to an edge | Only the alert panel takes the mouse |
| Alerts | Expands inward when docked and hidden | Expands on its own and returns to full opacity |

In both modes, **pending approvals, explicit user-input requests, and session or sub-task failures** raise an alert. Click "Got it", press `Esc`, or let the issue resolve, and it returns to where it was. Alerts don't re-fire on client, progress or timer refreshes.

> A plain "waiting" state may just mean waiting on the agent's reply, so it never triggers an alert on its own.

## Features

<details>
<summary><b>Automatic session detection</b> — no setup, works on launch</summary>

<br />

Continuously follows the logs each agent actually writes:

| Agent | Log location |
| --- | --- |
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` |
| Codex | `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl` |
| Gemini | `~/.gemini/tmp/<project>/chats/session-*.json` |
| Cursor | `~/.cursor/projects/<project>/agent-transcripts/<session>/<session>.jsonl` |

Override the roots with `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `CURSOR_HOME`. Set `CUTE_ISLAND_WATCH=0` to turn detection off.

**Timing and state**: elapsed time prefers the most recent user request or an explicit execution-start event from the log, so starting Cute Island mid-run still recovers the duration. Sessions waiting on your answer or approval are not marked as interrupted just because the log went quiet. Sub-agents and background commands are listed separately when expanded, each timed on its own.

**Limits**: apart from Claude sessions that can be correlated, process detection only proves that *some* agent is running — it can't tell every session under that process apart. Use the HTTP / CLI push below when you need exact state.

</details>

<details>
<summary><b>Auto-approval</b> — send approvals and answers back by rule</summary>

<br />

A separate master switch, **off by default**. Permission approvals and multiple-choice answers can be enabled independently.

- Recommended options are recognised via `（推荐）`, `(Recommended)` or the native recommended marker
- With no recommendation, manual answering is kept by default; you can configure it to pick the first option instead
- **Free-form input, passwords, repeated-question markers and questions with no unique answer always stay manual**
- Multi-question requests are only submitted when every question can be answered

The *History* page keeps the last 50 approve / answer / hand-off actions from this launch. It never disguises a submitted answer as a successful tool run.

When auto-approval and remote takeover are both on, Claude Code and Codex are handled by rule first; only what cannot be automated reaches the island and the remote channel. Turn auto-approval or a given rule off and those requests come straight to you. The remote entry point reports results in one place, so nothing is processed twice.

</details>

<details>
<summary><b>Remote takeover</b> — approve, answer and follow up from your phone</summary>

<br />

Supports **Telegram, Feishu, WeCom and Discord**, plus native threads already loaded in the same Codex app-server.

Channel config holds the target chat or channel, the users allowed to act, and **the environment variable name** for credentials — credential values are never entered in the form. Missing variables are reported by name; set them and restart the app.

Before saving, each connection can run "Test connectivity": message channels send a test message, Codex checks the service and its loaded threads.

The takeover service running does not mean every channel is reachable — send `/sessions` in the channel to verify.

**Capability boundaries**:

- Claude Code — permission approvals, question answering, follow-up instructions
- Codex — approvals and questions via the configured app-server
- Cursor — Shell / MCP pre-execution confirmation and follow-up guidance
- Gemini — BeforeTool confirmation and context guidance

Cursor and Gemini approvals only pass through this Hook gate; **native permission policies still apply**, and arbitrary native Q&A screens are out of scope.

Full configuration is in [REMOTE_CONTROL.md](REMOTE_CONTROL.md).

</details>

<details>
<summary><b>Agent integration</b> — install the native interaction channels</summary>

<br />

**Claude Code** — click "Install integration" on the *Agent integration* page, then reopen your session. The installer only adds and removes its own HTTP Hook, preserves other settings, and backs up before editing. It writes to `~/.claude/settings.json` and honours `CLAUDE_CONFIG_DIR`. Requires a Claude Code version that supports HTTP Hooks.

**Codex app-server** — click "Start managed service" and Cute Island finds your installed native Codex CLI and starts the service locally (default port `4500`). Then install "command integration", reopen your terminal, and running `codex` connects automatically per the current switches:

```bash
# or connect manually
codex --remote ws://127.0.0.1:4500

# or run the service yourself (clients must connect to the same service)
codex app-server --listen ws://127.0.0.1:4500
```

Windows integrates with PowerShell; macOS / Linux with Bash / Zsh. Your shell profile is backed up before editing and other content is preserved on removal.

After installing command integration and enabling the managed service, run `codex` for the default configuration or `codex -p agentrouter` for that profile. No duplicate profile setting is needed. `--profile agentrouter`, `--profile=agentrouter`, and `codex -p agentrouter resume <thread-id>` are supported. Exit the original client before resuming an existing thread; running standalone sessions do not migrate automatically.

The service reads the terminal’s `$CODEX_HOME/<name>.config.toml` (current profiles), or `[profiles.<name>]` in `config.toml` (legacy profiles), and inherits its working directory and environment. Profiles are applied as native `-c` startup overrides, above project configuration; explicit command-line `-c` values override the profile. Matching configurations reuse an instance. Different profiles, working directories, environments, or changed files get separate instances, preserving existing sessions. Source configuration files stay unchanged; terminal environment values are passed only in local memory, never saved in settings or logs. Stopping managed services or exiting Cute Island closes all instances. An external app-server that cannot load the requested profile falls back to native startup with a notice.

Cute Island is just another protocol client: it **only joins sessions already loaded in the service**, never starts tasks, and never changes a session's sandbox or approval policy. Only local, unauthenticated `ws://` services are supported.

**Cursor / Gemini** — install from *Remote takeover → Agent Hook takeover*. Existing config is backed up first, other Hooks are preserved, and older Hooks pointing at the same remote config are migrated.

> Launcher scripts use the Node runtime bundled with Electron, so **no separate Node install is needed**. Reopen the client or session after installing.

</details>

<details>
<summary><b>HTTP / CLI push</b> — feed your own status into the island</summary>

<br />

The app only listens on `127.0.0.1:17321`; change the port with `CUTE_ISLAND_PORT`. When `CUTE_ISLAND_TOKEN` is set, requests must carry `Authorization: Bearer <token>` or `X-Island-Token`.

```bash
npm run island -- push --agent Cursor --state running --title "Editing the login page" --progress 0.4
npm run island -- push --id task-1 --agent Codex --state approval --title "Installing dependencies" \
  --command "npm install" --shell PowerShell --cwd "D:/projects/app"
npm run island -- end --result success --summary "Login page updated"
npm run island -- demo
```

```bash
curl -X POST http://127.0.0.1:17321/v1/activities \
  -H 'content-type: application/json' \
  -d '{"id":"run-1","agent":"Cursor","state":"running","title":"Editing the login page","progress":0.4}'
```

`state` can be `thinking`, `running`, `waiting`, `approval`, `success` or `error`. Posting the same `id` again merges the update.

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/activities` | Create or update an activity |
| `POST /v1/activities/<id>/end` | End an activity |
| `GET /v1/activities` | Return current activities |
| `WS /v1/events` | Pushes `{ "type": "activities", "activities": [...] }` on every change |

`operation: { kind, name?, command?, shell?, cwd? }` accepts `kind` values `command`, `read`, `edit`, `search`, `mcp`, `skill`, `agent` and `tool`. `client`, `startedAt`, `endedAt`, `tasks` and `stale` are also accepted.

</details>

<details>
<summary><b>Proxy and updates</b></summary>

<br />

**Proxy** — *Remote takeover → Global proxy* follows the system proxy by default. Each message channel and remote Codex connection can instead choose direct, system proxy, or an HTTP / HTTPS / SOCKS5 proxy. Connectivity tests and live traffic use the same setting; local connections always go direct.

**Updates** — *General → Version and updates* checks GitHub for the latest version once a day by default and **reads version info only — nothing about your machine is uploaded**. A newer version shows its number, release date and notes, and can be skipped.

Windows installers and Linux AppImage support in-app download and install, either immediately or on next exit. Immediate install is deferred with an explanation while there are pending remote requests, sessions waiting on your approval or answer, or sessions still running.

Development builds never check for updates. `CUTE_ISLAND_UPDATE=0` overrides the UI switch, and `CUTE_ISLAND_UPDATE_FEED` can point at a self-hosted feed. Updates never take over session alerts and are never sent to message channels.

</details>

<details>
<summary><b>Resuming interrupted sessions</b></summary>

<br />

When a Codex or Claude Code main session is clearly interrupted by an error, the remote notification offers "Resume session" and "Got it".

Resuming uses the native session ID, verifies native state, then restores execution and submits the continue instruction. `/resume <error-request-id> [instruction]` works too.

- **Codex** — restores the original thread through the configured, running app-server
- **Claude Code** — runs the native CLI in the background in the original working directory, keeping the Hook permission gate

Repeated clicks and restarts do not replay the action. Log silence or a sub-task failure never starts a main session. Turning takeover off stops the recovery processes the app started.

</details>

## Configuration

Settings save automatically to `preferences.json` in the Electron user data directory and stay in sync with the tray. Window position lives in `window-position.json`.

| Page | Contents |
| --- | --- |
| **General** | Theme (light / dark / follow system), display mode, session detection, launch at login, restore position, version and updates |
| **Auto-approval** | Master switch, permission approvals, multiple-choice answers, policy when there is no recommendation |
| **Agent integration** | Install status, Codex app-server, command integration |
| **Remote takeover** | Message channels, Codex connections, agent Hooks, global proxy |
| **History** | Last 50 approve / answer / hand-off actions |

## Development

```bash
npm install
npm run dev          # Electron development
npm run dev:web      # renderer only, browser preview
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run dist         # typecheck + test + build + package for this platform → release/
npm run pack         # runnable directory only
```

Packaging is configured for Windows NSIS, macOS dmg, Linux AppImage and deb, all using `build/icon.png`. Artifacts also produce `latest*.yml` and `*.blockmap` — in-app updates depend on these shipping with the Release.

Integration checks:

```bash
node scripts/smoke-packaged.cjs "release/win-unpacked/Cute Island.exe"   # packaged build
npm run build && node scripts/smoke-interaction.cjs                      # dragging and opacity
```

Both use isolated temp user directories and ports, install nothing, and never move your mouse. Screenshots land in `release/` and `output/playwright/` respectively.

Before releasing, bump `package.json`, `package-lock.json` and `RELEASE_NOTES.md`, then push the tag:

```bash
git tag v0.1.17 && git push origin v0.1.17
```

## Tech stack

Electron · React 19 · TypeScript · Vite · framer-motion · vitest

The window is frameless, transparent, always-on-top, stays out of the taskbar and never steals focus. macOS uses a panel that stays visible across full-screen spaces; Windows and Linux use screen-saver level. Linux needs a desktop compositor for transparent windows to show what is behind them.

## Docs

- [PRODUCT.md](PRODUCT.md) — product definition and capability boundaries
- [DESIGN.md](DESIGN.md) — design notes
- [REMOTE_CONTROL.md](REMOTE_CONTROL.md) — full remote takeover configuration
- [RELEASE_NOTES.md](RELEASE_NOTES.md) — release notes

## License

MIT
