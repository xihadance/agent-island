---
version: 1
slug: "src-renderer-src-settings-tsx"
primary_target: "src/renderer/src/Settings.tsx"
related_targets: ["src/renderer/src/CodexServerSettings.tsx", "src/renderer/src/RemoteSettings.tsx", "src/renderer/src/settings.css"]
---

# Settings extension

Mode: Operate. Seed key: incumbent-settings-extension (precisely scoped feature; no visual-world replacement).

## Direction contract

WORLD: Preserve the existing dark Electron island, system sans typography, restrained state colors and drawn SVG icons. Extend it into a normal focusable settings window.

FIRST VIEWPORT: Show automatic approval's master switch, permission and question rules, fallback selection, and the route to native Agent integration. Automation is the initial section; a stable sidebar connects general settings, integrations, remote takeover and recent decisions. Agent 接入 presents Claude integration followed by the managed Codex service. Opening `#settings/remote` selects 远程接管 directly, with the takeover switch, service status, connection guidance and Agent Hook setup before channel configuration.

LAYOUT: Desktop sidebar with a readable, bounded form column; narrow browser preview becomes a compact top navigation. Native window minimum width is 640px. Remote channel and Codex fields use two columns on desktop and one at the existing 760px breakpoint. Managed-service and Hook actions also wrap at that breakpoint. Port/program settings and existing-server connection use native disclosures. Save/reload actions wrap, and long configuration paths can break within the column. No modal or marketing composition.

INTERACTION: Switching automation changes the master status immediately after durable save. Tray and configuration share the same state. Pausing stops native replies. Hook installation/removal, errors, disabled controls, loading, history and empty states are real. Remote takeover reads existing configuration and takes precedence over automatic replies while retaining the saved automation preference. Channel/connection drafts require explicit 保存渠道配置; 重新读取 replaces the draft with the current saved configuration. A dirty draft blocks enabling takeover, and active takeover disables connection editing. Save, reload and toggle outcomes have inline status feedback.

Managed Codex configuration is saved separately; unsaved port/program changes block starting, and those fields are disabled while hosting is enabled. Starting persists the enabled setting, launches the local service and supplies its approval address; stopping or quitting disconnects its clients. Running state exposes a selectable CLI connection command with copy feedback. Remote Hook rows show each client's installed state, configuration path and install/remove action. Unsaved remote drafts block Hook changes; installation/removal backs up existing files, preserves unrelated configuration and replaces legacy hooks for the same remote config. Installed hooks use the bundled Electron Node launcher with stdin forwarding.

CONTENT: Chinese product labels. Distinguish logged sessions from connected native interaction channels. Automatic replies support Claude HTTP hooks and Codex shared app-server; unsupported clients stay manual. Managed hosting uses the installed Codex CLI and existing login; independent desktop, IDE and CLI sessions do not migrate automatically. Remote takeover adds Telegram, 飞书, 企业微信 and Discord configuration, plus Codex connection IDs, WebSocket addresses and native thread IDs. Claude, Cursor and Gemini remote Hooks can be installed in the UI, with restart guidance and linked setup instructions. Cursor/Gemini support execution gates and subsequent guidance; their original permission policies remain active and arbitrary native Q&A stays in the client. Channel fields identify the destination and allowed users; credentials are environment-variable names, with missing names shown explicitly. Existing configuration is read automatically, and service-running copy does not imply external channel connectivity. Browser preview is labeled. No approval or answer is called tool execution success.

FINISH: unreviewed and undocumented is unfinished; the original settings build established DESIGN.md and its sidecar. Ordinary extensions finish with review, a verdict and updated product/surface evidence while preserving those design-system files. No new shipping raster assets are used; screenshots are review evidence only.

## Quality bar

Preserve existing island behavior; provide an independent, keyboard-usable configuration window. Forms need linked labels/descriptions, visible focus, durable save feedback, and no horizontal overflow at desktop, 640px and 390px preview widths. Native smoke tests cover settings persistence, tray synchronization, Hook installation/removal, approvals, answers, pause and window lifecycle. Remote coverage additionally includes existing-config reads, editing a saved channel, explicit save/reload, empty configuration, offline zero-channel enable/disable, remote priority and persistence. The original settings detector found no issues; the remote extension's advisory findings and review scope are recorded below.

## Evidence and decisions

The user requested automatic permissions/recommended answers and a configuration UI beyond the tray. Optional questions about unsupported recommendations and preferred clients received no reply during implementation; manual fallback and verified native integrations were used, and fallback is configurable. No aesthetic change was requested. Screenshots live under .impeccable/review and are synthetic smoke-test state. No approved image comp exists for this code-led extension.

### Remote takeover extension — 2026-10-15

The user requested recovery of existing remote functionality omitted from the main application entry point. This is an ordinary Operate settings extension: the dark surfaces, inherited system/CJK font stack, drawn icons, enabled green, status colors, switches, buttons and field styling remain incumbent. The UI provides structured channel and Codex editing alongside configuration-file and setup-document actions.

The finish reviewer returned **SHIP**, with no material fixes, scoped to this remote settings extension. Documentation review checked `RemoteSettings.tsx`, `Settings.tsx`, the settings CSS delta, the existing `DESIGN.md`/sidecar, and all seven remote captures:

- `../review/remote-desktop.png` and `../review/remote-desktop-bottom.png`: an existing Telegram channel, missing credential-name feedback, saved state and file/setup actions.
- `../review/remote-640.png`: the narrower native layout with one-column fields.
- `../review/remote-mobile.png` and `../review/remote-mobile-bottom.png`: compact top navigation, wrapping fields, save/reload feedback and the configuration path in the narrow preview.
- `../review/remote-empty.png`: no-config guidance and disabled takeover control.
- `../review/remote-automation-priority.png`: automatic approval retains its saved switch value while text and card state communicate remote priority.

Implementation-session evidence reports **298 tests passed**, real Electron smoke covering restored remote modules, saved-channel editing, zero-channel offline enable/disable, tray synchronization, remote priority and persistence, plus a packaged smoke with no renderer errors and a generated v0.1.11 installer. These are reported validation results, not tests rerun by the documentation pass. Captures contain synthetic fixture state. No real external bot messages were sent; external delivery and end-to-end bot connectivity are not established by this evidence. The four platform-specific editors, Codex fields, linked labels, error/disabled conditions and revision-aware draft handling were also inspected in source; the captures do not show every platform or transient state.

The detector's color, font and radius advisories reflect pre-existing documentation/extraction gaps, not a new visual direction. Remote field label (`#c2c2ca`), border (`#46464e`) and placeholder (`#90909b`) values already occur in the incumbent connection form; its dark input surface, 7px corners and 13px field type are reused. The inherited system font and existing settings shapes remain unchanged. `DESIGN.md` and `.impeccable/design.json` are deliberately preserved; this extension does not regenerate tokens or promote advisory values into new system rules.

### Managed Codex service and remote Hook setup — 2026-10-15

The user requested application-managed Codex hosting for approvals and a usable takeover path for Gemini and Cursor. `CodexServerSettings.tsx` extends Agent 接入 with service lifecycle, saved port/native executable and CLI connection guidance; `RemoteSettings.tsx` adds Claude/Cursor/Gemini Hook installation and removal. The existing typography, dark surfaces, state colors, buttons and responsive form system remain authoritative. No shipping raster assets or new visual system were introduced.

The finish reviewer returned the full five-section **SHIP** review with no required fixes. This documentation pass inspected the new component, the integration sections, the CSS delta, existing design files and all eight valid captures:

- `../review/settings-connections.png` and `../review/connections-server-running.png`: stopped/running service, connected status, start/stop action, client boundary copy and selectable connection command.
- `../review/connections-640.png` and `../review/connections-mobile.png`: service actions and text wrapping in the narrow native and compact preview layouts.
- `../review/remote-hooks-installed.png` and `../review/remote-hooks-lower.png`: installed Hook controls, configuration paths, Cursor/Gemini capability limits and the route to channels.
- `../review/remote-640.png` and `../review/remote-mobile.png`: uninstalled Hook controls, missing-credential feedback and wrapping paths. These two files now show this extension, replacing the earlier remote-review captures at the same paths.

Implementation-session validation reports **306 tests**, typecheck and build passing; real Electron smoke covered a managed fake server starting, automatically connecting and stopping, Hook install/remove, and actual remotely approved Cursor/Gemini Hook replies through the generated runtime wrapper. Original interaction and tray smokes also passed. An isolated native Codex process passed startup, initialize and shutdown without running tasks, and the v0.1.12 installer was built. This documentation pass did not rerun applications or tests. Captures use synthetic fixture state; no real bots were contacted, and external bot delivery and live Agent task execution are not established by this evidence.

The detector ran once with no primary findings and 18 advisory findings for incumbent extraction gaps. Existing visual-system guidance and sidecar tokens are preserved. Port/program editing, transient errors, native disclosures, focus and clipboard fallback were checked in source where not shown in the captures.
