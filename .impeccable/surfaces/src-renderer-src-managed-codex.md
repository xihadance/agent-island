# Managed Codex automatic remote forwarding

Primary targets: src/renderer/src/CodexServerSettings.tsx and src/renderer/src/RemoteSettings.tsx. Related: Settings.tsx, control/runtime.ts, main/index.ts and shared/codex-launch.ts.

Mode: Operate. Help users start the local Codex service, connect a terminal and use configured message channels to handle the same native requests.

## Direction contract

THESIS: Configured channels receive managed Codex requests automatically; a separate remote Codex connection is unnecessary for the hosted service.

OWN-WORLD: Inherit the existing light/dark settings palettes, system/CJK type, sidebar, restrained dividers, green service action, native disclosures and outlined fields. Keep the black island identity.

STORY: Start the service, connect through command integration or the displayed terminal command, and enable takeover with a saved message channel. The terminal and remote channel handle the same request; the first accepted decision wins.

FIRST VIEWPORT: Within Agent 接入, the Codex section keeps service state and start/stop action together, followed by service boundaries, optional port/path disclosure and terminal command. The remote connection section explains automatic hosted forwarding before offering configuration for other app-servers.

FORM: Ordinary extension of the established settings surface. Runtime linking and explanatory copy introduce no new visual world or token scale.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Implemented behavior — 2026-10-16

When the local managed service runs, remote takeover is enabled and at least one message channel is configured, the runtime links the hosted WebSocket service automatically. No extra Codex entry is persisted in `remote.json`. The terminal remains an active native participant, and a completed request invalidates the other endpoint's old action. Service stop/start, takeover toggles and server restart synchronize the runtime association. Existing configured connections continue to support other app-servers and explicit session scope.

`CodexServerSettings.tsx` states that forwarding is active and that the terminal can still handle requests. Its selectable connection command and existing service controls remain intact. `RemoteSettings.tsx` explains that the Codex connection editor is for other app-servers and explicitly names the first accepted decision. Ordinary independent CLI, desktop and IDE sessions do not automatically migrate into the managed service. Remote takeover pauses automatic approval without discarding the user's saved setting.

## Finish and documentation evidence

The independent finish reviewer returned the full five-section **SHIP** review with no material fixes for the updated managed-service settings. Documentation checked `CodexServerSettings.tsx`, `RemoteSettings.tsx`, `Settings.tsx`, the runtime connection derivation and lifecycle, existing visual-system files and all four valid current native Electron captures:

| Light | Dark | Evidence |
| --- | --- | --- |
| [managed-codex-light.png](../review/managed-codex-light.png) | [managed-codex-dark.png](../review/managed-codex-dark.png) | Running service, remote priority, forwarding state, terminal command and preserved service/command actions. |
| [managed-codex-light-remote.png](../review/managed-codex-light-remote.png) | [managed-codex-dark-remote.png](../review/managed-codex-dark-remote.png) | Configured channel, empty extra Codex list, automatic forwarding/first-decision copy and inherited disabled editing while takeover runs. |

All four are intentional native settings captures scrolled to the relevant section; they are not page-top or full-document screenshots. They use an isolated synthetic service and Telegram API fixture. The persisted channel fields carry fixture IDs and a credential environment-variable name. No real channel messages or model tasks were invoked, and no new shipping raster asset was added.

Final implementation-session validation reports typecheck, build and **423 tests in 46 files** passing. The real Electron managed-Codex smoke exercised synthetic native WebSocket requests and a Telegram API substitute: forwarding without extra connection configuration, remote-first and terminal-first decisions, stale-action rejection, automatic approval pause, takeover toggles and hosted-service restart. Settings/restart, interaction, question, Codex-command and remote-toggle smokes also passed. Documentation did not rerun these checks. This evidence establishes the tested native routing/lifecycle and shown Windows Electron themes; real external delivery, live Codex model execution and macOS/Linux appearance remain outside the review.

The existing palette/type/radius detector advisories are recorded in [the question surface evidence](src-renderer-src-island-tsx.md). They are not repaired or promoted into design rules here. `DESIGN.md` and `.impeccable/design.json` are preserved because this extension adds behavior and copy within the incumbent system. `PRODUCT.md` and `REMOTE_CONTROL.md` already describe the new runtime association. Review and documentation discharge FINISH at this stated scope.
