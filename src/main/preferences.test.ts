import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { readIslandMode, readPreferences, saveIslandMode, savePreferences } from './preferences'
import { normalizePreferences, patchPreferences } from '../shared/preferences'

it('defaults to focus and restores a valid mode independently of window position', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'island-mode-'))
  try {
    const file = path.join(directory, 'preferences.json')
    expect(readIslandMode(file)).toBe('focus')
    saveIslandMode(file, 'managed')
    expect(readIslandMode(file)).toBe('managed')
    saveIslandMode(file, 'focus')
    expect(readIslandMode(file)).toBe('focus')
    for (const invalid of ['{broken', 'null', '{"mode":"unknown"}', '{}']) {
      writeFileSync(file, invalid)
      expect(readIslandMode(file)).toBe('focus')
    }
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('island-mode-')) throw new Error('Unexpected temporary path')
    rmSync(directory, { recursive: true, force: true })
  }
})

it('migrates old files and preserves automation when the tray switches modes', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'island-mode-'))
  try {
    const file = path.join(directory, 'preferences.json')
    writeFileSync(file, '{"mode":"managed"}')
    expect(readPreferences(file)).toMatchObject({ mode: 'managed', automation: { enabled: false, fallback: 'manual' } })
    const preferences = patchPreferences(readPreferences(file), { automation: { enabled: true, fallback: 'first', codexUrl: 'ws://127.0.0.1:4500' } })
    savePreferences(file, preferences)
    saveIslandMode(file, 'focus')
    expect(readPreferences(file)).toEqual({ ...preferences, mode: 'focus' })
    expect(normalizePreferences({ automation: { enabled: 'true', approvePermissions: false } }).automation).toMatchObject({ enabled: false, approvePermissions: false })
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('island-mode-')) throw new Error('Unexpected temporary path')
    rmSync(directory, { recursive: true, force: true })
  }
})

it('rejects malformed IPC patches without accepting remote or credential-bearing URLs', () => {
  const preferences = normalizePreferences(undefined)
  for (const patch of [null, [], { mode: 'auto' }, { arbitrary: true }, { automation: null }, { automation: { enabled: 'true' } },
    { automation: { fallback: 'random' } }, { automation: { extra: true } }, { watchSessions: 1 }]) {
    expect(() => patchPreferences(preferences, patch)).toThrow()
  }
  for (const codexUrl of ['https://127.0.0.1:4500', 'ws://example.com', 'ws://localhost@evil.com', 'ws://localhost?token=secret', 'ws://localhost#secret']) {
    expect(() => patchPreferences(preferences, { automation: { codexUrl } })).toThrow()
  }
  expect(patchPreferences(preferences, { automation: { codexUrl: 'ws://[::1]:4500' } }).automation.codexUrl).toBe('ws://[::1]:4500')
})
