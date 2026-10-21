---
name: Cute Island product website
description: Chinese product introduction extending the desktop island's existing visual identity.
colors:
  site-bg: '#f5f6f3'
  site-surface: '#ecefe8'
  site-text: '#232823'
  site-secondary: '#596158'
  site-line: '#d9ded4'
  site-accent: '#21734b'
  site-accent-soft: '#e1e9dc'
  site-canvas: '#e6ece0'
  site-grid: '#c4ceba'
  site-button: '#232823'
  site-button-ink: '#f5f6f3'
  site-focus: '#2362b0'
  site-dark-bg: '#151816'
  site-dark-surface: '#1c231e'
  site-dark-text: '#eef1ea'
  site-dark-secondary: '#aab6a9'
  site-dark-line: '#364138'
  site-dark-accent: '#78db9c'
  site-dark-accent-soft: '#273b2c'
  site-dark-canvas: '#243227'
  site-dark-grid: '#435d43'
  site-dark-button: '#dbe8d5'
  site-dark-button-ink: '#1c261b'
  site-dark-focus: '#78b9ff'
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif'
    fontSize: 15px
    lineHeight: 1.7
  hero:
    fontSize: clamp(40px, 4.2vw, 58px)
    fontWeight: 700
    lineHeight: 1.32
    letterSpacing: '-.035em'
  heading:
    fontSize: 38px
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: '-.03em'
  supporting:
    fontSize: 13px
    lineHeight: 1.9
  button:
    fontSize: 13px
    fontWeight: 600
rounded:
  control: 8px
  film: 16px
  canvas: 24px
spacing:
  compact: 8px
  supporting: 16px
  grouping: 24px
components:
  button-primary:
    backgroundColor: '{colors.site-button}'
    textColor: '{colors.site-button-ink}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: 12px 22px
  button-primary-dark:
    backgroundColor: '{colors.site-dark-button}'
    textColor: '{colors.site-dark-button-ink}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: 12px 22px
---

# Design System: Cute Island product website

## Overview

This document is scoped to the independent website in this directory. It extends [the desktop design system](../../DESIGN.md); it does not revise the desktop island, settings, or the root design sidecar. Sources are [site.css](site.css), [Website.tsx](Website.tsx), [IslandDemo.tsx](IslandDemo.tsx), [PRODUCT.md](../../PRODUCT.md), and the website surface brief in `.impeccable/surfaces/src-website-website-tsx.md`.

The existing black capsule remains the focal product artifact. Chinese explanations, quiet neutral backgrounds, green interaction accents and thin separators support visitors learning the capabilities and opening the GitHub source.

## Colors

The frontmatter records the light custom properties and their dark overrides. The website follows system appearance until a visitor chooses a theme; the explicit choice is stored under `cute-island-site-theme`.

### Primary

Green marks supporting links, active feature icons and hover states. Primary GitHub actions start with neutral button colors and use the accent on hover. Blue supplies visible keyboard focus.

### Neutral

Background, surface, canvas and soft accent separate explanatory sections from the island demonstration. Text, secondary text and divider roles each have theme overrides. The retained `site-grid` property colors the remote connector; the demo has no decorative grid.

**The Island Identity Rule.** Website themes change the surrounding surface while the imported island retains its established black silhouette and activity colors.

## Typography

System typography and Chinese fallbacks are inherited from the desktop stylesheet. The website adds a larger marketing hierarchy using the same family. The hero uses the frontmatter clamp, becomes (42px) below (1100px), uses `clamp(33px, 6.5vw, 45px)` with (1.4) line height below (767px), and becomes (30px) below (359px). Section and closing headings use the heading role and become (30px) below (767px). Hero supporting copy is (16px) on desktop and (14px) on mobile; metadata ranges from (10px) to (12px).

These sizes belong to this promotional surface. The desktop island and settings retain their compact type hierarchy.

## Layout

Main content is centered at a maximum width of (1200px), with (48px) desktop side gutters. The header has a separate maximum of (1320px). Below (1100px), side gutters become (32px); below (767px), (20px); below (359px), (14px).

The desktop hero pairs copy with the interactive island. Below (767px), the hero, feature section, remote section and FAQ stack; navigation becomes a toggle menu. The supported agents use two columns on mobile. Large section spacing keeps explanations distinct from interactive controls.

The demonstration canvas is (450px) high on desktop and (430px) below (767px). Its caption sits at the bottom; the reviewed mobile approval scene has a (32px) gap above that caption. Keep this separation when changing demo content.

## Elevation & Depth

Most sections use flat backgrounds and thin borders. The demonstration adds a soft shadow: `0 16px 48px rgb(24 44 21 / 7%)` in light mode and `0 16px 48px rgb(0 0 0 / 12%)` in dark mode. The primary action rises (2px) on hover over a (.2s) transition. Entry motion and smooth scrolling respect reduced-motion preferences.

## Shapes

Controls and channel labels use the control radius. The video uses the film radius; the desktop demonstration and closing panel use the canvas radius and become (16px) on mobile. Theme controls are circular. These are website container shapes; imported capsule geometry remains defined by the desktop system.

## Components

The demo imports the actual production `Island` component. Authored synthetic `Activity` objects show multiple sessions, approval and idle states. Tabs support arrows, Home and End; the panel labels its example data. Acknowledgment changes local demo state and does not connect to native approval, logs or remote control.

Navigation, feature expanders and native FAQ details use theme-aware text and borders. Interactive elements expose a (3px) focus outline with (5px) offset; the skip link provides a direct route to main content. The video uses native controls, a poster and a download fallback.

Existing media is reused: the brand icon is [build/icon.png](../../build/icon.png), the film is [media/cute-island-intro.mp4](../../media/cute-island-intro.mp4), and its poster is [media/intro-poster.png](../../media/intro-poster.png). Agent and activity SVGs come from the existing renderer. No generated raster assets were added; Vite bundles the existing imported media with content hashes.

The completed website validation recorded successful typecheck, (663) repository tests and production build. Light and dark captures were inspected at (1440px) and (390px). Mobile Lighthouse checks in both themes scored (100) for accessibility, SEO and best practices.

## Do's and Don'ts

- **Do** use the existing icon and production island when presenting the product.
- **Do** keep example data explicit and preserve space between approval content and its caption.
- **Do** pair light and dark tokens and preserve visible focus and reduced-motion behavior.
- **Don't** apply the marketing heading sizes or website panel radii to desktop UI.
- **Don't** present the demonstration as a connection to a visitor's agents or permissions.

The inherited system display family and marketing type/shape differences are recorded only as scoped implementation facts. They are not promoted to new root rules; the established desktop system remains authoritative.
