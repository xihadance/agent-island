import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IslandMode } from '../shared/island-behavior'
import { normalizePreferences, type Preferences } from '../shared/preferences'

export function readPreferences(file: string): Preferences {
  try { return normalizePreferences(JSON.parse(readFileSync(file, 'utf8'))) }
  catch { return normalizePreferences(undefined) }
}

export function savePreferences(file: string, preferences: Preferences): void {
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(preferences, null, 2), 'utf8')
  renameSync(temporary, file)
}

export function readIslandMode(file: string): IslandMode { return readPreferences(file).mode }

export function saveIslandMode(file: string, mode: IslandMode): void {
  savePreferences(file, { ...readPreferences(file), mode })
}
