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
    expect(readPreferences(file)).toMatchObject({ theme: 'system', mode: 'managed', automation: { enabled: false, fallback: 'manual' } })
    const preferences = patchPreferences(readPreferences(file), { theme: 'light', automation: { enabled: true, fallback: 'first', codexUrl: 'ws://127.0.0.1:4500' } })
    savePreferences(file, preferences)
    saveIslandMode(file, 'focus')
    expect(readPreferences(file)).toEqual({ ...preferences, mode: 'focus' })
    expect(normalizePreferences({ automation: { enabled: 'true', approvePermissions: false } }).automation).toMatchObject({ enabled: false, approvePermissions: false })
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('island-mode-')) throw new Error('Unexpected temporary path')
    rmSync(directory, { recursive: true, force: true })
  }
})

it('keeps launch at login off unless a stored boolean asks for it', () => {
  expect(normalizePreferences(undefined).launchAtLogin).toBe(false)
  // An older preferences file has no such field, and a malformed one never enables it.
  for (const value of [{}, { launchAtLogin: 'true' }, { launchAtLogin: 1 }, { launchAtLogin: null }]) {
    expect(normalizePreferences(value).launchAtLogin).toBe(false)
  }
  expect(normalizePreferences({ launchAtLogin: true }).launchAtLogin).toBe(true)
  const preferences = normalizePreferences(undefined)
  expect(patchPreferences(preferences, { launchAtLogin: true }).launchAtLogin).toBe(true)
  for (const patch of [{ launchAtLogin: 'yes' }, { launchAtLogin: 1 }, { launchAtLogin: null }]) {
    expect(() => patchPreferences(preferences, patch as never)).toThrow()
  }
})

it('rejects malformed IPC patches without accepting remote or credential-bearing URLs', () => {
  const preferences = normalizePreferences(undefined)
  for (const patch of [null, [], { mode: 'auto' }, { theme: 'sepia' }, { theme: null }, { arbitrary: true }, { automation: null }, { automation: { enabled: 'true' } },
    { automation: { fallback: 'random' } }, { automation: { extra: true } }, { watchSessions: 1 }]) {
    expect(() => patchPreferences(preferences, patch)).toThrow()
  }
  for (const codexUrl of ['https://127.0.0.1:4500', 'ws://example.com', 'ws://localhost@evil.com', 'ws://localhost?token=secret', 'ws://localhost#secret']) {
    expect(() => patchPreferences(preferences, { automation: { codexUrl } })).toThrow()
  }
  expect(patchPreferences(preferences, { automation: { codexUrl: 'ws://[::1]:4500' } }).automation.codexUrl).toBe('ws://[::1]:4500')
})

it('keeps update checking on by default and refuses renderer-owned check bookkeeping', () => {
  const preferences = normalizePreferences(undefined)
  expect(preferences.update).toEqual({ enabled: true, skippedVersion: '', lastCheckedAt: 0 })
  expect(normalizePreferences({ update: { enabled: 'yes', skippedVersion: 7, lastCheckedAt: -5 } }).update).toEqual({ enabled: true, skippedVersion: '', lastCheckedAt: 0 })
  expect(normalizePreferences({ update: { lastCheckedAt: 1_700_000_000_000 } }).update.lastCheckedAt).toBe(1_700_000_000_000)
  expect(patchPreferences(preferences, { update: { enabled: false } }).update.enabled).toBe(false)
  expect(patchPreferences(preferences, { update: { skippedVersion: ' 0.1.18 ' } }).update.skippedVersion).toBe('0.1.18')
  for (const patch of [{ update: null }, { update: [] }, { update: { lastCheckedAt: 1 } }, { update: { enabled: 'true' } },
    { update: { skippedVersion: 1 } }, { update: { skippedVersion: 'v'.repeat(41) } }, { update: { extra: true } }]) {
    expect(() => patchPreferences(preferences, patch as never)).toThrow()
  }
})

it('preserves an existing check timestamp across unrelated patches', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'island-mode-'))
  try {
    const file = path.join(directory, 'preferences.json')
    savePreferences(file, normalizePreferences({ update: { lastCheckedAt: 1_700_000_000_000, skippedVersion: '0.1.18' } }))
    const next = patchPreferences(readPreferences(file), { theme: 'dark' })
    expect(next.update).toEqual({ enabled: true, skippedVersion: '0.1.18', lastCheckedAt: 1_700_000_000_000 })
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('island-mode-')) throw new Error('Unexpected temporary path')
    rmSync(directory, { recursive: true, force: true })
  }
})
