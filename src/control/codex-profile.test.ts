import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parse } from 'smol-toml'
import { readCodexProfile } from './codex-profile'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture(base = '') {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'island-profile-'))
  directories.push(directory)
  writeFileSync(path.join(directory, 'config.toml'), base)
  return directory
}

it('loads profile-v2 and merges provider definitions without changing the source files', () => {
  const directory = fixture('model = "base"\n[model_providers.custom]\nname = "Custom"\nwire_api = "responses"\nbase_url = "http://127.0.0.1:1"\nexperimental_bearer_token = "base-private-value"\n')
  const file = path.join(directory, 'agentrouter.config.toml')
  writeFileSync(file, 'model = "profile-model"\nmodel_reasoning_effort = "high"\n[model_providers.custom]\nbase_url = "http://127.0.0.1:2"\nenv_key = "PROFILE_API_KEY"\n[model_providers.custom.env_http_headers]\nAuthorization = "PROFILE_AUTH"\n')
  const result = readCodexProfile('agentrouter', directory)
  expect(result.args.join(' ')).not.toContain('base-private-value')
  const applied = parse(result.args.filter((_, index) => index % 2 === 1).join('\n'))
  expect(applied).toEqual({ model: 'profile-model', model_reasoning_effort: 'high', model_providers: { custom: {
    name: 'Custom', wire_api: 'responses', base_url: 'http://127.0.0.1:2', env_key: 'PROFILE_API_KEY', env_http_headers: { Authorization: 'PROFILE_AUTH' }
  } } })
  expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(readCodexProfile('agentrouter', directory).fingerprint).toBe(result.fingerprint)
  writeFileSync(file, 'model = "changed"\n')
  expect(readCodexProfile('agentrouter', directory).fingerprint).not.toBe(result.fingerprint)
})

it('supports legacy named profiles and preserves arrays, dotted table keys, Unicode and literal quotes', () => {
  const directory = fixture('[profiles.legacy]\nmodel = "test"\n[profiles.legacy.projects."D:/work/a.b"]\ntrust_level = "trusted"\n[[profiles.legacy.skills.config]]\npath = \'D:/中文/"skill"/SKILL.md\'\nenabled = false\n')
  const result = readCodexProfile('legacy', directory)
  expect(parse(result.args.filter((_, index) => index % 2 === 1).join('\n'))).toEqual({ model: 'test',
    projects: { 'D:/work/a.b': { trust_level: 'trusted' } }, skills: { config: [{ path: 'D:/中文/"skill"/SKILL.md', enabled: false }] } })
})

it.each(['../outside', 'a/b', 'a\\b', '.', '..', 'a\n', 'a:stream'])('rejects profile paths: %j', name => {
  expect(() => readCodexProfile(name, fixture())).toThrow('名称无效')
})

it('fails closed for absent, empty, malformed and credential-bearing profiles without echoing their values', () => {
  const directory = fixture()
  const file = path.join(directory, 'profile.config.toml')
  expect(() => readCodexProfile('profile', directory)).toThrow('未找到')
  for (const content of ['', '[broken', 'experimental_bearer_token = "private-value"', '[mcp_servers.test.env]\nAPI_KEY = "private-value"']) {
    writeFileSync(file, content)
    expect(() => readCodexProfile('profile', directory)).toThrow()
    try { readCodexProfile('profile', directory) } catch (error) { expect(String(error)).not.toContain('private-value') }
  }
})
