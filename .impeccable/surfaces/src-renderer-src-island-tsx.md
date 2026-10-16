# Island question extension

Primary target: src/renderer/src/Island.tsx. Related: QuestionAnswers.tsx, App.tsx, island.css, Settings.tsx, main/index.ts, control/hooks.ts, control/channels/telegram.ts.

Mode: Operate. Users handle Claude Code questions locally or through Telegram. Preserve remote takeover priority, native Hook submission, black capsule, docking, passive mouse handling and activity identity.

## Direction contract

THESIS: Show the same native questions at both interaction points, and accept the first submitted answer exactly once.

OWN-WORLD: Inherit the black capsule, system font, translucent white controls and amber selection indicator. Keep options as labeled radio or checkbox rows with readable supporting descriptions.

STORY: Read the question and option explanations, choose all required answers, then submit. The other channel receives the submitted state. Remote takeover explicitly pauses automatic answers.

FIRST VIEWPORT: Existing Agent header leads the expanded capsule. Question hint, legend and options follow; the submit button sits after the last question. Long content scrolls inside the existing 520px island maximum. Native keyboard input remains available during pending questions.

FORM: Local extension of the established island; no concept seed or visual-world change applies.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Implemented surface — 2026-10-16

The ordinary Operate extension presents native single-choice, multiple-choice and free-text questions in the existing expanded island. Each question uses a fieldset and legend; options keep their labels and supporting descriptions together. Amber communicates selection, a white outline communicates keyboard focus, and the established translucent control treatment remains intact. The submit action waits for every required answer, disables during submission and after settlement, and exposes errors in an alert. Disconnected or expired requests cannot submit.

The same native request may be handled locally or through its configured remote channel. The first accepted answer settles the request; later actions cannot submit it again. Submitted answers remain inspectable in focus mode until the Agent confirms completion. Managed mode returns to its passive capsule after answering. Remote takeover retains priority over automatic approval and automatic answers; log-only questions still require the original Agent's interaction channel.

The original brief covered Claude Code and Telegram. The related managed Codex service extension now automatically links its native requests to configured channels while retaining terminal handling, as recorded in [the managed service surface](src-renderer-src-managed-codex.md). This expands supported request routing without changing the island's visual world.

## Finish and documentation evidence

The independent finish reviewer returned a full five-section **SHIP** review with no material fixes for this question surface. The documentation pass checked `QuestionAnswers.tsx`, `Island.tsx`, `App.tsx`, the question styles in `island.css`, the priority copy in `Settings.tsx`, the existing `DESIGN.md` and sidecar, and all four current Electron captures:

| Capture | Evidence |
| --- | --- |
| [question-multiple.png](../review/question-multiple.png) | Existing Agent header, input attention, descriptions, selected radio option and the next multiple-choice question. |
| [question-submit.png](../review/question-submit.png) | Intentional scroll to selected checkbox rows, supplemental text field and enabled submit action. |
| [question-submitted.png](../review/question-submitted.png) | Submitted native status, disabled choices and retained accepted answers in focus mode. |
| [question-long.png](../review/question-long.png) | Long supporting description wrapping, free-text field and bounded internal scrolling. |

Captures are valid current synthetic fixture states of the Electron island, clipped to the island bounds. They establish the shown states, not every transient condition. The submit capture intentionally omits the header because it shows the lower scroll position. No new shipping raster assets were introduced; these images are review evidence only.

Final implementation-session validation reports typecheck, build and **423 tests across 46 files** passing. Real Electron question smoke verified native Claude Hook answer payloads, multiple selections, original input preservation, local/remote settlement, stale-action rejection, managed collapse, focus-mode submitted state, free-text typing and long content. Settings/restart, interaction, Codex command, remote-toggle and managed-Codex smokes also passed. These are reported session results; this documentation pass did not rerun tests or applications. Real external message delivery, live model tasks and macOS/Linux visual appearance are outside this review.

The once-run detector in [question-detector.json](../review/question-detector.json) has **0 primary findings and 26 advisory findings**: 19 palette, five type and two radius documentation discrepancies. They concern longstanding incumbent extraction gaps rather than a new visual direction. `DESIGN.md` and `.impeccable/design.json` remain authoritative and untouched; no advisory value or new prohibition is canonized to silence the detector. Review and documentation discharge this extension's FINISH condition at the scope stated above.
