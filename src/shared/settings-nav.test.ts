import { expect, it } from 'vitest'
import { SETTINGS_PAGES, settingsHash, settingsPageFromHash } from './settings-nav'

it.each([
  { hash: '#settings', page: 'home' }, { hash: 'settings', page: 'home' }, { hash: '#settings/', page: 'home' },
  { hash: '#settings/claude', page: 'claude' }, { hash: '#settings/remote', page: 'remote' }, { hash: '#settings/general', page: 'general' },
  { hash: '#settings/automation', page: 'rules' }, { hash: '#settings/connections', page: 'codex' }
])('opens $hash as $page', ({ hash, page }) => {
  expect(settingsPageFromHash(hash)).toBe(page)
})

it.each(['', '#', '#island', '#settings/unknown', '#settings/remote/extra', '#settingsx', '#settings/Remote'])('ignores %j', hash => {
  expect(settingsPageFromHash(hash)).toBeUndefined()
})

it('round-trips every page through its hash', () => {
  for (const page of SETTINGS_PAGES) expect(settingsPageFromHash(`#${settingsHash(page)}`)).toBe(page)
  expect(settingsHash('home')).toBe('settings')
})
