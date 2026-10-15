import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initRemoteConfig } from '../control/config'
import { remoteSettings, saveRemoteSettings } from './remote-settings'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs() })
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'island-remote-settings-')); directories.push(dir)
  const file = path.join(dir, 'remote.json'); initRemoteConfig(file)
  return file
}
const channel = { id: 'telegram-main', type: 'telegram', destination: '123', allowedUsers: ['456'], tokenEnv: 'ISLAND_FIXTURE_BOT_TOKEN' }

it('edits existing channels without replacing control credentials, custom fields or state location', () => {
  const file = fixture()
  const original = { ...JSON.parse(readFileSync(file, 'utf8')), stateFile: 'custom-state.json', futureSetting: { keep: true }, channels: [{ ...channel, custom: 'preserved' }] }
  writeFileSync(file, JSON.stringify(original))
  vi.stubEnv('ISLAND_FIXTURE_BOT_TOKEN', 'secret-do-not-expose')
  const snapshot = remoteSettings(file)
  expect(JSON.stringify(snapshot)).not.toContain('secret-do-not-expose')
  expect(JSON.stringify(snapshot)).not.toContain(original.controlToken)
  expect(snapshot.missingCredentials).toEqual([])
  saveRemoteSettings(file, { channels: [{ ...channel, destination: '789' }], codex: [] }, snapshot.revision, 17321)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...original, channels: [{ ...channel, custom: 'preserved', destination: '789' }], codex: [] })
})

it('rejects stale drafts and invalid edits before modifying the file', () => {
  const file = fixture(); const snapshot = remoteSettings(file)
  expect(() => saveRemoteSettings(file, { channels: [{ ...channel, allowedUsers: [] }], codex: [] }, snapshot.revision, 17321)).toThrow('用户 ID')
  expect(remoteSettings(file).revision).toBe(snapshot.revision)
  const text = readFileSync(file, 'utf8') + '\n'; writeFileSync(file, text)
  expect(() => saveRemoteSettings(file, { channels: [channel], codex: [] }, snapshot.revision, 17321)).toThrow('其他位置修改')
  expect(readFileSync(file, 'utf8')).toBe(text)
  expect(() => saveRemoteSettings(file, { channels: [], codex: [{ id: 'codex', url: 'ws://example.com', threads: ['t'] }] }, remoteSettings(file).revision, 17321)).toThrow('本机 ws')
})

it('preserves legacy enabled behavior and never exposes malformed JSON fragments', () => {
  const file = fixture(); const value = JSON.parse(readFileSync(file, 'utf8')); delete value.enabled
  writeFileSync(file, JSON.stringify(value))
  const snapshot = remoteSettings(file); expect(snapshot.enabled).toBe(true)
  expect(() => saveRemoteSettings(file, { channels: [], codex: [] }, snapshot.revision, 17321)).toThrow('关闭远程接管')
  writeFileSync(file, '{"secret-value":broken')
  expect(JSON.stringify(remoteSettings(file))).not.toContain('secret-value')
  expect(remoteSettings(file).error).toBeTruthy()
})
