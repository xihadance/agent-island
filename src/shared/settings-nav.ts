export type SettingsPage = 'home' | 'claude' | 'codex' | 'cursor' | 'gemini' | 'rules' | 'remote' | 'history' | 'island' | 'general'

export const SETTINGS_PAGES: readonly SettingsPage[] = ['home', 'claude', 'codex', 'cursor', 'gemini', 'rules', 'remote', 'history', 'island', 'general']

// Earlier builds, tray actions and saved bookmarks used these section names.
const LEGACY: Record<string, SettingsPage> = { automation: 'rules', connections: 'codex' }

/** Returns undefined for anything unknown, so a stray hash never moves the user. */
export function settingsPageFromHash(hash: string): SettingsPage | undefined {
  const match = /^#?settings(?:\/([a-z-]*))?$/.exec(hash.trim())
  if (!match) return undefined
  const slug = match[1] ?? ''
  if (!slug) return 'home'
  if ((SETTINGS_PAGES as readonly string[]).includes(slug)) return slug as SettingsPage
  return LEGACY[slug]
}

export function settingsHash(page: SettingsPage): string {
  return page === 'home' ? 'settings' : `settings/${page}`
}
