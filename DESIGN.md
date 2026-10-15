---
name: Cute Island
description: Dark desktop island and companion settings for local Agent activity.
colors:
  island: "#000"
  white: "#fff"
  settings-background: "#151516"
  settings-sidebar: "#101011"
  settings-text: "#f1f1f3"
  settings-muted: "#aaaab3"
  settings-line: "#303035"
  state-running: "#78b9ff"
  state-thinking: "#c2afff"
  state-approval: "#f3c76a"
  state-success: "#78db9c"
  state-error: "#ff8881"
  island-error-emphasis: "#ff6961"
  settings-accent: "#78db9c"
  settings-accent-hover: "#93e6b0"
  settings-accent-ink: "#112419"
  settings-button: "#252529"
  settings-button-hover: "#333339"
  settings-button-text: "#eeeef1"
  settings-input: "#101012"
  settings-navigation-text: "#b7b7c0"
  settings-navigation-hover: "#202022"
  settings-navigation-current: "#29292d"
  settings-card: "#1e1e21"
  settings-card-enabled: "#1b2820"
  island-secondary-text: "rgba(255, 255, 255, 0.78)"
  island-button: "rgba(255, 255, 255, 0.14)"
  island-button-hover: "rgba(255, 255, 255, 0.24)"
  task-badge: "rgba(120, 185, 255, 0.14)"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    lineHeight: 1.55
  headline:
    fontSize: "25px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-.02em"
  title:
    fontSize: "17px"
    fontWeight: 600
  label:
    fontSize: "14px"
    fontWeight: 550
  section-label:
    fontSize: "13px"
    fontWeight: 600
  supporting:
    fontSize: "13px"
    lineHeight: 1.55
  metadata:
    fontSize: "12px"
  button:
    fontSize: "13px"
  island-title:
    fontSize: "13.5px"
    fontWeight: 600
    letterSpacing: "-0.02em"
  island-detail:
    fontSize: "12.5px"
    lineHeight: 1.35
  command:
    fontFamily: '"Cascadia Code", Consolas, monospace'
    fontSize: "11.5px"
    lineHeight: 1.55
rounded:
  settings-control: "7px"
  settings-navigation: "8px"
  settings-choice: "9px"
  island-detail: "10px"
  settings-card: "12px"
  island-idle: "18px"
  island-compact: "20px"
  island-stack: "28px"
  island-expanded: "40px"
  pill: "99px"
  island-button: "999px"
spacing:
  compact-gap: "8px"
  control-gap: "10px"
  supporting-gap: "12px"
  header-gap: "16px"
  settings-row: "22px"
  settings-row-gap: "24px"
  settings-section: "32px"
components:
  button-primary:
    backgroundColor: "{colors.settings-accent}"
    textColor: "{colors.settings-accent-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.settings-control}"
    padding: "8px 13px"
  button-primary-hover:
    backgroundColor: "{colors.settings-accent-hover}"
  button-secondary:
    backgroundColor: "{colors.settings-button}"
    textColor: "{colors.settings-button-text}"
    typography: "{typography.button}"
    rounded: "{rounded.settings-control}"
    padding: "8px 13px"
  button-secondary-hover:
    backgroundColor: "{colors.settings-button-hover}"
  button-island:
    backgroundColor: "{colors.island-button}"
    textColor: "{colors.white}"
    typography: "{typography.metadata}"
    rounded: "{rounded.island-button}"
    padding: "6px 12px"
  button-island-hover:
    backgroundColor: "{colors.island-button-hover}"
  input:
    backgroundColor: "{colors.settings-input}"
    textColor: "{colors.settings-text}"
    typography: "{typography.supporting}"
    rounded: "{rounded.settings-control}"
    padding: "9px 12px"
  navigation:
    backgroundColor: "transparent"
    textColor: "{colors.settings-navigation-text}"
    typography: "{typography.body}"
    rounded: "{rounded.settings-navigation}"
    padding: "10px 13px"
  navigation-current:
    backgroundColor: "{colors.settings-navigation-current}"
    textColor: "{colors.white}"
  automation-card:
    backgroundColor: "{colors.settings-card}"
    rounded: "{rounded.settings-card}"
  automation-card-enabled:
    backgroundColor: "{colors.settings-card-enabled}"
  switch:
    width: "42px"
    height: "25px"
    rounded: "{rounded.pill}"
    padding: "3px"
  switch-enabled:
    backgroundColor: "{colors.settings-accent}"
  mode-choice:
    rounded: "{rounded.settings-choice}"
    padding: "17px"
  task-badge:
    backgroundColor: "{colors.task-badge}"
    textColor: "{colors.state-running}"
    rounded: "{rounded.settings-choice}"
    padding: "0 5px 0 3px"
    height: "18px"
  island:
    backgroundColor: "{colors.island}"
    textColor: "{colors.white}"
---

# Design System: Cute Island

## Overview

Cute Island is a compact black desktop surface for following local Agent activity. Its visual identity comes from the changing island silhouette, system typography, drawn icons, and restrained state colors. The companion settings window extends that identity into a readable dark form interface.

This document records the implemented system; it does not establish a replacement visual world or a new creative metaphor. Preserve the existing focus and managed behaviors, the island's transparent host window, and its compact, expanded, stacked and docked forms when extending the product.

**Key Characteristics:**

- A black floating island paired with a charcoal settings window.
- System sans typography with Chinese font fallbacks and compact metadata.
- Color attached to activity state, enabled controls and selected navigation.
- Rounded island silhouettes; quieter corners and dividing lines in settings.
- Drawn SVG icons and a small three-dot island mark.

Extraction sources: [island.css](src/renderer/src/island.css), [settings.css](src/renderer/src/settings.css), [Settings.tsx](src/renderer/src/Settings.tsx), [Island.tsx](src/renderer/src/Island.tsx), and the native settings dimensions in [main/index.ts](src/main/index.ts). Token names for literal CSS values describe their existing role; they do not imply that every value is already a CSS custom property. The accompanying [.impeccable/design.json](.impeccable/design.json) stores shadow, motion and breakpoint extensions plus component previews. Its synthesized tonal ramps are panel previews, not additional application colors.

## Colors

Dark neutrals carry the interface. State colors provide the main chromatic information.

### Primary

The settings accent uses the existing success green for enabled switches, the primary integration button, the current navigation icon and handled history entries. Its lighter hover color belongs to the primary settings button; dark green ink keeps the label legible.

### Secondary

Running blue, thinking lavender, approval amber, success green and error coral retain their existing activity meanings. Blue also supplies settings focus outlines and links. The stronger island error emphasis appears on error titles, rings and badges. These are semantic colors, not interchangeable decoration.

### Neutral

The island is black with white text and translucent white supporting text and controls. Settings use a charcoal canvas, a darker sidebar, bright main text, muted descriptions and subtle dividing lines. The enabled automation card adds a low-contrast green surface; inactive and selected navigation use separate neutral tones.

Agent badges retain their own appearances in the existing badge and SVG sources. The browser island preview has its own blue-gray gradient backdrop; it is not the native desktop background.

## Typography

The inherited font stack is the body token, including system UI and Chinese fallbacks. Settings use its body size and line height, with the headline role for the page heading, title for the prominent automation label, label for form labels, and section-label for small section headings. Integration headings use a larger section heading (16px). Supporting descriptions and metadata step down without introducing a separate display family.

The island uses denser type: compact titles use island-title, expanded titles are larger (16px), and most state labels and timing metadata sit between 10px and 12px. Command content uses the command monospace role and remains selectable. Timestamps and progress numbers use tabular numerals. Long compact titles truncate; command blocks and settings help text can wrap.

## Layout

The native island sits inside a transparent host, initially aligned near the top edge. Its content remains within the viewport minus 16px. The rest, idle and compact forms are (92 × 12px), (126 × 36px) and (340 × 40px); expanded width is (380px), stacked width is (400px), and content-dependent heights cap at (520px). Docked forms are (72 × 16px) horizontally or (16 × 72px) vertically. Geometry and attention adjustments remain owned by Island.tsx.

Settings use a sticky sidebar (194px) and a flexible main column capped at (890px), including main padding (36px 38px 42px). Form rows separate copy from controls, with description widths capped at (52ch). Help and informational copy extend to (70–72ch). Section and row spacing use the frontmatter tokens.

At a viewport width of (760px) or less, the sidebar narrows to (165px), the main padding becomes (28px 24px 32px), and rows containing selects may wrap. At (560px) or less, navigation becomes a compact horizontal row above the content, the sidebar footer disappears, and main padding becomes (26px 20px 32px). The native settings window opens at (920 × 740px) and has a minimum of (640 × 540px); the smaller layout supports browser preview rather than a separate mobile application.

## Elevation & Depth

The island floats with an ambient black shadow, a faint white inset edge and a subtle top highlight. Error and approval states replace the inset edge with their attention color. Keyboard focus uses a stronger inset white edge. Exact values are captured in the sidecar.

Settings remain flat: surface tone, borders, dividers and spacing establish hierarchy. The automation card changes border and surface color when enabled. Existing component focus outlines sit outside controls; they are not persistent decorative halos.

## Shapes

The island silhouette changes with its mode, using the corresponding frontmatter radius. Its compact session rows, circular Agent badges and pill buttons echo that form. Expanded detail surfaces use smaller curved corners.

Settings controls and notices use the control radius; navigation, mode choices and the automation card have their own slightly larger radii. Dividing lines are thin (1px). Switches have a pill track and a circular thumb. SVG settings icons use a (24 × 24) viewBox, a (1.6px) stroke and round caps and joins, normally rendered at (20px).

## Components

### Buttons and fields

Settings buttons use the secondary variant by default and the green primary variant for Agent integration. Both have a minimum height (36px). Hover changes background and border; disabled buttons, inputs and selects reduce opacity to (.5). Settings interactive elements share a blue focus outline (2px) with offset (4px). Text inputs use a dark inset-looking surface, a visible border, a green caret and a muted placeholder. Selects retain their native control behavior. Island dismissal buttons remain pills with translucent white fills and their existing white focus treatment.

### Navigation

Current settings navigation is indicated by a filled neutral background, bright label and green icon. Hover uses a lighter background. Labels remain visible alongside icons on desktop and beneath them in the narrow layout. The initial section and page-specific content belong to the [settings surface brief](.impeccable/surfaces/src-renderer-src-settings-tsx.md), rather than a global layout requirement.

### Switches and automation card

The switch retains its semantic switch role, linked label and description. Its circular thumb moves (16px) when checked, with background and transform transitions (150ms ease-out). The automation card combines a prominent labeled switch with a separated status/footer row. Enabled state changes the card surface, border, supporting text and status dot together. Paused state remains an explicit text state.

### Mode choices

Radio choices use bordered, rounded rows with the control at the start. The selected choice gains a green-tinted fill and border. Focus and managed display modes remain distinct from automatic approval.

### Activity and history

The island's small blue task badge has a compact icon and count; Agent badges preserve identity separately from activity state. Activity colors are accompanied by icons or text. Settings history uses divided rows with action, Agent, time and a wrapping summary. Empty history uses a centered drawn icon, concise explanation and a route to Agent setup.

### Feedback and motion

Settings show save status in a live region, loading text while fetching configuration, a bordered inline error with a retry action, and a labeled browser-preview notice. Source text distinguishes connected approval channels from log observation and distinguishes an approval or answer from execution success.

The island preserves its geometry spring and state animations. Settings motion is limited to the switch. Reduced-motion handling disables the switch transition and CSS activity/progress animations; the island's geometry and opacity transitions reduce to a near-instant duration. Exact motion values are in the sidecar.

**Verification note (2026-10-15):** The finish reviewer marked the standalone settings extension **SHIP**, with no material findings, after inspecting all eight captures in [.impeccable/review](.impeccable/review). The mechanical detector returned an empty finding list. Typecheck, build, 229 tests, native settings smoke/restart and original interaction smoke passed as reported by the implementation session. Transient error, focus, loading and the real browser-preview notice were assessed from source, not rendered captures. Narrow-layout evidence used Electron responsive emulation; macOS/Linux appearance and independent external Agent protocol certification were outside this visual review. No new shipping raster asset or image comp was introduced.

## Do's and Don'ts

### Do

- Do preserve the black island silhouette, dark settings surfaces and existing system font stack.
- Do keep state colors attached to their existing meanings and pair status color with text or an icon.
- Do retain visible keyboard focus, linked control labels, disabled feedback and reduced-motion behavior.
- Do preserve focus, managed, attention and docking behaviors when extending island presentation.
- Do reuse the existing drawn icon and Agent badge sources.

### Don't

- Don't treat automatic approval as a display mode or imply that observing logs establishes an approval connection.
- Don't describe an approved permission or submitted answer as successful tool execution.
- Don't replace the existing visual identity as part of an ordinary settings extension.
- Don't promote synthetic preview data, review screenshots or sidecar tonal ramps into product content or new visual tokens.
