---
name: Cute Island
description: Black desktop island and simple light, dark and system-aware settings for local Agent activity.
colors:
  island: '#000'
  white: '#fff'
  state-running: '#78b9ff'
  state-thinking: '#c2afff'
  state-approval: '#f3c76a'
  state-success: '#78db9c'
  state-error: '#ff8881'
  island-error-emphasis: '#ff6961'
  island-secondary-text: rgba(255, 255, 255, 0.74)
  island-muted-text: rgba(255, 255, 255, 0.55)
  island-subtle-text: rgba(255, 255, 255, 0.48)
  island-line: rgba(255, 255, 255, 0.10)
  island-raised: rgba(255, 255, 255, 0.06)
  island-button: rgba(255, 255, 255, 0.14)
  island-button-hover: rgba(255, 255, 255, 0.24)
  task-badge: rgba(120, 185, 255, 0.14)
  settings-background: '#121214'
  settings-sidebar: '#0c0c0e'
  settings-text: '#f1f1f3'
  settings-secondary: '#c2c2ca'
  settings-muted: '#aaaab3'
  settings-line: '#32323a'
  settings-card-line: '#3a3a44'
  settings-accent: '#78db9c'
  settings-accent-hover: '#93e6b0'
  settings-accent-ink: '#112419'
  settings-focus: '#78b9ff'
  settings-surface: '#1c1c21'
  settings-input: '#19191c'
  settings-button: '#252529'
  settings-hover: '#333339'
  settings-selected: '#29292d'
  settings-control-border: '#626670'
  settings-control-hover: '#858995'
  settings-placeholder: '#a1a1ad'
  settings-enabled-border: '#547b61'
  settings-enabled-surface: '#1b2820'
  settings-enabled-muted: '#bbcebf'
  settings-switch: '#3c3c44'
  settings-switch-knob: '#e7e7eb'
  settings-warning-text: '#f3c76a'
  settings-warning-surface: '#26231e'
  settings-warning-border: '#63563b'
  settings-error-text: '#ffbdb8'
  settings-error-surface: '#311f20'
  settings-error-border: '#a56864'
  settings-selection: '#294b36'
  settings-scrollbar: '#676773'
  settings-mark: '#000'
  settings-mark-border: '#35353a'
  settings-mark-amber: '#edb77c'
  settings-light-background: '#eef0f3'
  settings-light-sidebar: '#e4e7eb'
  settings-light-text: '#202329'
  settings-light-secondary: '#454d58'
  settings-light-muted: '#575e68'
  settings-light-line: '#d2d7dd'
  settings-light-card-line: '#c6ccd4'
  settings-light-accent: '#21734b'
  settings-light-accent-hover: '#195e3c'
  settings-light-accent-ink: '#ffffff'
  settings-light-focus: '#2362b0'
  settings-light-surface: '#ffffff'
  settings-light-input: '#ffffff'
  settings-light-button: '#ffffff'
  settings-light-hover: '#e9ecf0'
  settings-light-selected: '#e3e8e5'
  settings-light-control-border: '#8a919a'
  settings-light-control-hover: '#626975'
  settings-light-placeholder: '#68707b'
  settings-light-enabled-border: '#7caa8d'
  settings-light-enabled-surface: '#eaf5ee'
  settings-light-enabled-muted: '#42644e'
  settings-light-switch: '#727984'
  settings-light-switch-knob: '#ffffff'
  settings-light-warning-text: '#825a16'
  settings-light-warning-surface: '#fff8e9'
  settings-light-warning-border: '#cfb471'
  settings-light-error-text: '#9c322e'
  settings-light-error-surface: '#fff1ef'
  settings-light-error-border: '#c98982'
  settings-light-selection: '#d3eadb'
  settings-light-scrollbar: '#929aa5'
typography:
  body:
    fontFamily: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif
    fontSize: 14px
    lineHeight: 1.65
  headline:
    fontSize: 26px
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: -.02em
  title:
    fontSize: 17px
    fontWeight: 600
  label:
    fontSize: 14px
    fontWeight: 600
  section-label:
    fontSize: 14px
    fontWeight: 650
  supporting:
    fontSize: 13px
    lineHeight: 1.65
  metadata:
    fontSize: 12px
  button:
    fontSize: 13px
  island-title:
    fontSize: 13.5px
    fontWeight: 650
    letterSpacing: -0.02em
  island-agent:
    fontSize: 11.5px
    fontWeight: 600
    letterSpacing: -0.02em
  island-metadata:
    fontSize: 10px
  island-detail:
    fontSize: 12.5px
    lineHeight: 1.35
  command:
    fontFamily: '"Cascadia Code", Consolas, monospace'
    fontSize: 11.5px
    lineHeight: 1.55
  integration-title:
    fontSize: 14px
    fontWeight: 650
  brand:
    fontSize: 15px
    fontWeight: 650
  choice-label:
    fontSize: 13px
    fontWeight: 550
  mode-label:
    fontSize: 14px
    fontWeight: 550
  timestamp:
    fontSize: 11px
rounded:
  settings-control: 8px
  settings-navigation: 8px
  settings-choice: 12px
  island-task-badge: 9px
  island-detail: 12px
  settings-card: 12px
  island-idle: 18px
  island-compact: 20px
  island-stack: 28px
  island-expanded: 32px
  pill: 99px
  island-button: 999px
  theme-preview-line: 2px
  theme-preview-action: 3px
  theme-preview: 6px
  theme-quick-choice: 4px
  settings-mark: 999px
spacing:
  compact-gap: 8px
  control-gap: 10px
  supporting-gap: 12px
  header-gap: 16px
  settings-row: 20px
  settings-row-gap: 24px
  settings-section: 20px
  settings-header-bottom: 24px
  settings-main-top: 40px
  settings-main-inline: 44px
  settings-main-bottom: 48px
components:
  button-primary:
    backgroundColor: '{colors.settings-accent}'
    textColor: '{colors.settings-accent-ink}'
    typography: '{typography.button}'
    rounded: '{rounded.settings-control}'
    padding: 8px 13px
    height: 38px
  button-primary-hover:
    backgroundColor: '{colors.settings-accent-hover}'
  button-secondary:
    backgroundColor: '{colors.settings-button}'
    textColor: '{colors.settings-text}'
    typography: '{typography.button}'
    rounded: '{rounded.settings-control}'
    padding: 8px 13px
    height: 38px
  button-secondary-hover:
    backgroundColor: '{colors.settings-hover}'
  button-island:
    backgroundColor: '{colors.island-button}'
    textColor: '{colors.white}'
    typography: '{typography.metadata}'
    rounded: '{rounded.island-button}'
    padding: 6px 12px
  button-island-hover:
    backgroundColor: '{colors.island-button-hover}'
  input:
    backgroundColor: '{colors.settings-input}'
    textColor: '{colors.settings-text}'
    typography: '{typography.supporting}'
    rounded: '{rounded.settings-control}'
    padding: 9px 12px
  navigation:
    backgroundColor: transparent
    textColor: '{colors.settings-secondary}'
    typography: '{typography.body}'
    rounded: '{rounded.settings-navigation}'
    padding: 10px 12px
  navigation-current:
    backgroundColor: '{colors.settings-enabled-surface}'
    textColor: '{colors.settings-accent}'
  settings-section:
    backgroundColor: '{colors.settings-surface}'
    rounded: '{rounded.settings-card}'
    padding: 0 20px 4px
  settings-section-light:
    backgroundColor: '{colors.settings-light-surface}'
    rounded: '{rounded.settings-card}'
    padding: 0 20px 4px
  automation-card:
    backgroundColor: '{colors.settings-surface}'
    rounded: '{rounded.settings-card}'
  automation-card-enabled:
    backgroundColor: '{colors.settings-enabled-surface}'
  switch:
    width: 42px
    height: 25px
    rounded: '{rounded.pill}'
    padding: 3px
  switch-enabled:
    backgroundColor: '{colors.settings-accent}'
  mode-choice:
    rounded: '{rounded.settings-choice}'
    padding: 16px
  task-badge:
    backgroundColor: '{colors.task-badge}'
    textColor: '{colors.state-running}'
    rounded: '{rounded.island-task-badge}'
    padding: 0 5px 0 3px
    height: 18px
  island:
    backgroundColor: '{colors.island}'
    textColor: '{colors.white}'
  theme-choice:
    rounded: '{rounded.settings-choice}'
    padding: 10px
    typography: '{typography.choice-label}'
  theme-choice-selected:
    backgroundColor: '{colors.settings-enabled-surface}'
    textColor: '{colors.settings-accent}'
  theme-preview:
    height: 76px
    rounded: '{rounded.theme-preview}'
  theme-quick:
    backgroundColor: '{colors.settings-background}'
    rounded: '{rounded.settings-navigation}'
    padding: 4px
  theme-quick-choice:
    rounded: '{rounded.theme-quick-choice}'
    padding: 6px
  button-primary-light:
    backgroundColor: '{colors.settings-light-accent}'
    textColor: '{colors.settings-light-accent-ink}'
    typography: '{typography.button}'
    rounded: '{rounded.settings-control}'
    padding: 8px 13px
    height: 38px
  button-primary-hover-light:
    backgroundColor: '{colors.settings-light-accent-hover}'
  button-secondary-light:
    backgroundColor: '{colors.settings-light-button}'
    textColor: '{colors.settings-light-text}'
    typography: '{typography.button}'
    rounded: '{rounded.settings-control}'
    padding: 8px 13px
    height: 38px
  button-secondary-hover-light:
    backgroundColor: '{colors.settings-light-hover}'
  input-light:
    backgroundColor: '{colors.settings-light-input}'
    textColor: '{colors.settings-light-text}'
    typography: '{typography.supporting}'
    rounded: '{rounded.settings-control}'
    padding: 9px 12px
  navigation-light:
    backgroundColor: transparent
    textColor: '{colors.settings-light-secondary}'
    typography: '{typography.body}'
    rounded: '{rounded.settings-navigation}'
    padding: 10px 12px
  navigation-current-light:
    backgroundColor: '{colors.settings-light-enabled-surface}'
    textColor: '{colors.settings-light-accent}'
  automation-card-light:
    backgroundColor: '{colors.settings-light-surface}'
    rounded: '{rounded.settings-card}'
  automation-card-enabled-light:
    backgroundColor: '{colors.settings-light-enabled-surface}'
  switch-enabled-light:
    backgroundColor: '{colors.settings-light-accent}'
  theme-choice-selected-light:
    backgroundColor: '{colors.settings-light-enabled-surface}'
    textColor: '{colors.settings-light-accent}'
  theme-quick-light:
    backgroundColor: '{colors.settings-light-background}'
    rounded: '{rounded.settings-navigation}'
    padding: 4px
---

# Design System: Cute Island

## Overview

Cute Island is a compact black desktop surface for following local Agent activity. Its visual identity comes from the changing island silhouette, system typography, drawn icons, and restrained state colors. The companion settings window uses bounded functional cards on charcoal dark or gray light canvases, with green enabled controls and current navigation.

This document records the implemented system, the settings theme expansion and the approved October 17 prototype refinement. Preserve the existing focus and managed behaviors, the island's transparent host window, and its compact, expanded, stacked and docked forms when extending the product.

**Key Characteristics:**

- A black floating island paired with settings that support light, dark and system appearance.
- System sans typography with Chinese font fallbacks and compact metadata.
- Color attached to activity state, enabled controls and selected navigation.
- Rounded island silhouettes; bordered functional cards and heading bands in settings.
- Drawn SVG icons and a small three-dot island mark.

Extraction sources: [island.css](src/renderer/src/island.css), [settings.css](src/renderer/src/settings.css), [Settings.tsx](src/renderer/src/Settings.tsx), [ThemePicker.tsx](src/renderer/src/ThemePicker.tsx), [Island.tsx](src/renderer/src/Island.tsx), and the native settings dimensions in [main/index.ts](src/main/index.ts). Token names for literal CSS values describe their existing role; they do not imply that every value is already a CSS custom property. The accompanying [.impeccable/design.json](.impeccable/design.json) stores shadow, motion and breakpoint extensions plus component previews. Its synthesized tonal ramps are panel previews, not additional application colors.

## Colors

The island retains its black identity. Settings use matched dark charcoal and light neutral palettes; the unsuffixed settings color tokens describe the dark palette and `settings-light-*` tokens describe its light overrides. These tokens map directly to the scoped properties in settings.css. Settings mark colors remain shared across themes. State colors provide the main chromatic information.

### Primary

The settings accent uses the existing success green in dark mode and a deeper green in light mode for enabled switches, primary actions, selected theme labels, the current navigation icon and handled history entries. Primary-button ink is dark green in dark mode and white in light mode; each palette supplies its own hover color.

### Secondary

Running blue, thinking lavender, approval amber, success green and error coral retain their existing activity meanings. Settings have their own theme-aware blue focus and link tokens. Warning and error text, surfaces and borders also resolve per settings theme. The stronger island error emphasis appears on error titles, rings and badges. These are semantic colors, not interchangeable decoration.

### Neutral

The island is black with white text and three translucent white supporting roles (.74, .55 and .48). Dark settings step from a near-black sidebar to a charcoal canvas and raised card surface; light settings use a gray canvas, darker gray sidebar and white cards. Both provide distinct text, secondary text, muted descriptions, fields, control borders, dividers, placeholders, selection and scrollbar tones. The enabled automation card adds a pale or dark green surface; selected navigation uses an enabled-tint fill, green label and 2px inset rail. The neutral selected token remains specific to the compact theme selector. Theme-preview miniatures deliberately depict the target appearance and do not change with the surrounding theme.

Agent badges retain their own appearances in the existing badge and SVG sources. The browser island preview has its own blue-gray gradient backdrop; it is not the native desktop background.

## Typography

The inherited font stack is the body token, including system UI and Chinese fallbacks. Settings use its body size and increased line height, with the headline role for the page heading, title for the prominent automation label, label for form labels, and a consistent 14px/650 section-label for card heading bands. Integration headings use the same size and weight via integration-title; the brand and theme-choice labels have their own compact roles. Supporting descriptions and metadata step down without introducing a separate display family.

The island uses denser type: compact titles retain 13.5px with 650 weight, expanded titles are 16px/650, compact Agent names step down to 11.5px with .82 opacity, and most state labels and timing metadata sit between 10px and 12px. Command content uses the command monospace role and remains selectable. Timestamps and progress numbers use tabular numerals. Long compact titles truncate; command blocks and settings help text can wrap.

## Layout

The native island sits inside a transparent host, initially aligned near the top edge. Its content remains within the viewport minus 16px. The rest, idle and compact forms are (92 × 12px), (126 × 36px) and (340 × 40px); expanded width is (380px), stacked width is (400px), and content-dependent heights cap at (520px). Docked forms are (72 × 16px) horizontally or (16 × 72px) vertically. Geometry and attention adjustments remain owned by Island.tsx.

Settings use a sticky sidebar (210px) and a flexible, centered main column capped at (920px), including main padding (40px 44px 48px). The page heading has a bottom divider and bottom padding (24px). Form rows separate copy from controls, with description widths capped at (64ch). Help and informational copy extend to (70–72ch). Functional sections use 20px separation, 20px inline padding and 4px bottom padding. Heading bands reach the card edge with 14px 20px padding and a bottom divider, while form-row dividers remain inset. Prominent switch rows use 24px padding; their footer uses 8px 24px.

At a viewport width of (760px) or less, the sidebar narrows to (165px), the main padding becomes (28px 24px 32px), rows containing selects may wrap, and display-mode choices and remote fields become one column. Theme previews remain three columns with a smaller gap (8px). At (560px) or less, navigation becomes a compact horizontal row above the content, the sidebar footer disappears, the quick theme selector moves beside the brand, and main padding becomes (28px 20px 32px). Header save feedback and action rows wrap. The native settings window opens at (1040 × 800px) and has a minimum of (640 × 540px); the smaller layout supports browser preview rather than a separate mobile application.

## Elevation & Depth

The island floats with a tight contact shadow and wider ambient shadow, a faint white inset edge and a subtle top highlight. Error and approval states replace the inset edge with their attention color. Keyboard focus uses a stronger inset white edge. Exact values are captured in the sidecar.

Settings functional cards use theme-specific border and subtle shadow tokens; separate sidebar, canvas and card tones make their boundaries visible. The automation card shares the same container family and changes border and surface color when enabled. Existing component focus outlines sit outside controls; they are not persistent decorative halos.

## Shapes

The island silhouette changes with its mode, using the corresponding frontmatter radius. Its compact session rows, circular Agent badges and pill buttons echo that form. Expanded capsules use a 32px radius, detail surfaces use 12px, and open stack rows use 20px inside the 28px stack.

Settings buttons, inputs and navigation use the 8px control radius; functional cards, notices, mode choices and theme choices use 12px containers. Pills retain their rounded silhouette. The theme-preview miniature uses small corners for its frame, line marks and action mark; these are illustrative details rather than a new general control scale. The compact selector has its own inner-choice radius, and the small black brand mark retains its rounded silhouette. Dividing lines are thin (1px). Switches have a pill track and a circular thumb. SVG settings icons use a (24 × 24) viewBox, a (1.6px) stroke and round caps and joins, normally rendered at (20px).

## Components

### Buttons and fields

Settings buttons use the secondary variant by default and the green primary variant for Agent integration. Both have a minimum height (38px). Hover changes background and border; disabled buttons, inputs and selects reduce opacity to (.5). Settings interactive elements share a blue focus outline (2px) with offset (3px), including native disclosure summaries. Text inputs use the active theme input surface, a visible border, a green caret and a muted placeholder. Selects retain their native control behavior. Island dismissal buttons remain pills with translucent white fills and their existing white focus treatment.

### Navigation

Current settings navigation is indicated by an enabled-tint background, green 600-weight label and icon, and a curved 2px inset rail. Hover uses the theme hover surface. Labels remain visible alongside icons on desktop and beneath them in the narrow layout. The initial section and page-specific content belong to the [settings surface brief](.impeccable/surfaces/src-renderer-src-settings-tsx.md), rather than a global layout requirement.

### Switches and automation card

The switch retains its semantic switch role, linked label and description. Its circular thumb moves (17px) when checked, with background and transform transitions (150ms ease-out). The automation card combines a prominent labeled switch with a separated status/footer row. Enabled state changes the card surface, border, supporting text and status dot together. Paused state remains an explicit text state.

### Mode choices

Radio choices use bordered, rounded rows with the control at the start. The selected choice gains a green-tinted fill and border. Focus and managed display modes remain distinct from automatic approval.

### Theme selection

General settings expose three labeled native radio choices: 浅色, 深色 and 跟随系统. Each has a drawn CSS preview, visible selected check, green selected label and focus-within outline. The compact version remains available in the sidebar and moves beside the brand in narrow previews; it has accessible text labels and native radio keyboard behavior. Loading and durable-save work disable the controls consistently. Theme previews are code-rendered interface miniatures, not raster assets.

The saved preference defaults to system, including older configuration without a valid theme. System mode listens for media-query changes; an explicit light or dark choice takes precedence. The renderer sets the resolved color scheme, and Electron nativeTheme keeps the settings-window background synchronized at startup, updates and reopen. This appearance setting applies to the configuration page; the black island identity remains unchanged.

### Activity and history

The island's small blue task badge has a compact icon and count; Agent badges preserve identity separately from activity state. Activity colors are accompanied by icons or text. Settings history uses a bordered card containing divided rows with action, Agent, time and a wrapping summary. Empty history uses the same card family with a centered drawn icon, concise explanation and a route to Agent setup. Island progress fills inherit the owning session state, including independently colored expanded stack rows.

### Feedback and motion

Settings show save status in a live region, loading text while fetching configuration, a bordered inline error with a retry action, and a labeled browser-preview notice. Source text distinguishes connected approval channels from log observation and distinguishes an approval or answer from execution success.

The island preserves its geometry spring and state animations. Settings motion remains limited to the switch; changing appearance adds no decorative animation. Reduced-motion handling disables the switch transition and CSS activity/progress animations; the island's geometry and opacity transitions reduce to a near-instant duration. Exact motion values are in the sidecar.

**Original settings verification (2026-10-15):** The finish reviewer marked the standalone settings extension **SHIP**, with no material findings, after inspecting all eight captures in [.impeccable/review](.impeccable/review). The mechanical detector returned an empty finding list. Typecheck, build, 229 tests, native settings smoke/restart and original interaction smoke passed as reported by the implementation session. Transient error, focus, loading and the real browser-preview notice were assessed from source, not rendered captures. Narrow-layout evidence used Electron responsive emulation; macOS/Linux appearance and independent external Agent protocol certification were outside this visual review. No new shipping raster asset or image comp was introduced.

**Theme expansion verification (2026-10-15):** The finish reviewer returned the full five-section **SHIP** disposition with no material fixes after reviewing all 20 light/dark captures listed in the [settings surface brief](.impeccable/surfaces/src-renderer-src-settings-tsx.md). The pre-documentation detector recorded no primary findings and nine advisory type/radius documentation gaps; this merge records the actual sizes and shape roles, without rerunning the detector. The 20 measured text/background pairs in [theme-contrast.json](.impeccable/review/theme-contrast.json) have a minimum ratio of (5.01:1); this is measured-pair evidence, not certification of every state. Implementation-session validation reports 306 tests, typecheck, build, real Electron theme/persistence/system-override/keyboard smoke and original interaction smoke passing. The local v0.1.13 Windows NSIS installer and packaged light/dark-toggle, persistence and interaction smoke also passed with zero renderer errors. The documentation pass inspected source, detector/contrast outputs and selected desktop, 640px and mobile captures; it did not rerun the application or tests. External bot delivery, live model tasks and macOS/Linux appearance are outside this review. No shipping raster assets were added.

**Prototype implementation verification (2026-10-17):** Typecheck, 506 tests across 49 files, build, real Electron settings/restart smoke and interaction smoke passed. Current captures under [.impeccable/review](.impeccable/review) use the `refine-` prefix; the settings matrix covers both themes, all five sections, 640px and 390px layouts, remote fields and empty/history states. Browser text measurements in [refine-contrast.json](.impeccable/review/refine-contrast.json) cover 328 rendered settings pairs with a minimum of 4.68:1, excluding disabled controls. This is scoped evidence, not exhaustive transient-state or native-control certification. The island's subtle ink is .48 rather than the prototype's .40 to retain metadata legibility. The once-run detector reported advisory documentation gaps only. Independent review/documenter agents failed before working because of service transport errors, so review and documentation used the skill's in-thread fallback. External channels, live model work, packaging and macOS/Linux appearance were not checked in this pass.

### Tray and window controls

The tray uses the operating system's native menu styling. Configuration and the current show/hide action form the first group; display mode and session recognition form the second; automatic approval and remote takeover remain direct checkbox shortcuts in the third. Exit is separated at the bottom. The display-mode submenu names its current mode. The tooltip summarizes window visibility, recognition, approval and takeover. Recognition disabled by the launch environment remains unchecked and unavailable; connection testing is named and temporarily disables the takeover switch. Menu caching tracks checked and enabled states even when an error label masks a state transition.

General settings group display mode with startup, then window visibility, position recovery and demonstration into individual rows. Visibility pairs a text status and semantic state dot with one action button. Existing type, theme, border, spacing and control tokens are reused; action groups wrap at the inherited narrow breakpoint. Native show/hide events synchronize settings and tray presentation. Position recovery reveals a hidden window. Remote configuration is reached through the existing settings navigation.

## Do's and Don'ts

### Do

- Do preserve the black island silhouette, paired settings palettes and existing system font stack.
- Do keep state colors attached to their existing meanings and pair status color with text or an icon.
- Do retain visible keyboard focus, linked control labels, disabled feedback and reduced-motion behavior.
- Do preserve focus, managed, attention and docking behaviors when extending island presentation.
- Do reuse the existing drawn icon and Agent badge sources.
- Do use scoped settings semantic tokens for both themes and keep preview miniatures tied to the appearance they depict.

### Don't

- Don't treat automatic approval as a display mode or imply that observing logs establishes an approval connection.
- Don't describe an approved permission or submitted answer as successful tool execution.
- Don't replace the existing visual identity as part of an ordinary settings extension.
- Don't promote synthetic preview data, review screenshots or sidecar tonal ramps into product content or new visual tokens.
