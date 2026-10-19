import { expect, it } from 'vitest'
import { normalizePreferences, patchPreferences } from './preferences'
import { canAutoRouteCodex, codexLaunchArguments, codexLaunchRoute, inspectCodexLaunch } from './codex-launch'

const url = 'ws://127.0.0.1:4500'
it('routes takeover to the managed service without a separate connection configuration', () => {
  const preferences = patchPreferences(normalizePreferences(undefined), { codexServer: { enabled: true } })
  const channels = [{ id: 'phone', type: 'telegram' as const, destination: 'chat', allowedUsers: ['owner'], tokenEnv: 'TEST_TOKEN' }]
  expect(codexLaunchRoute(preferences, url, { channels, codex: [] }, true)).toEqual({ enabled: true, url, managed: true })
  expect(codexLaunchRoute(preferences, url, { channels, codex: [{ id: 'other', url: 'wss://other.test', threads: [] }] }, true)).toEqual({ enabled: true, url, managed: true })
  expect(codexLaunchRoute(preferences, url, { codex: [] }, false)).toEqual({ enabled: false })
})
it('routes automation and takeover independently and restores default launch when both are off', () => {
  let preferences = patchPreferences(normalizePreferences(undefined), { automation: { enabled: true, codexUrl: url } })
  expect(codexLaunchRoute(preferences, '')).toEqual({ enabled: true, url })
  const remote = { codex: [{ id: 'phone', url: 'wss://example.test', threads: [], tokenEnv: 'CODEX_TOKEN' }] }
  expect(codexLaunchRoute(preferences, '', remote, true)).toEqual({ enabled: true, url: 'wss://example.test', tokenEnv: 'CODEX_TOKEN' })
  expect(codexLaunchRoute(preferences, '', { codex: [{ ...remote.codex[0], threads: ['pinned'] }] }, true)).toEqual({ enabled: false })
  preferences = patchPreferences(preferences, { automation: { enabled: false } })
  expect(codexLaunchRoute(preferences, '', remote, true).enabled).toBe(true)
  expect(codexLaunchRoute(preferences, '', remote, false)).toEqual({ enabled: false })
  preferences = patchPreferences(preferences, { automation: { enabled: true }, codexServer: { enabled: true } })
  expect(codexLaunchRoute(preferences, '')).toEqual({ enabled: true, url: '', managed: true })
  expect(codexLaunchRoute(preferences, url)).toEqual({ enabled: true, url, managed: true })
})

it.each([
  { args: [] }, { args: ['修复包含空格的文件'] }, { args: ['resume', '--last'] },
  { args: ['fork', 'thread-1'] }, { args: ['-c', 'model="login"', 'agents'] }, { args: ['-m', '-pmodel'] },
  { args: ['--', '--remote is literal prompt text'] }, { args: ['--', '-p', 'luna'] }
])('preserves native argument values while routing $args', ({ args }) => {
  expect(canAutoRouteCodex(args)).toBe(true)
  expect(codexLaunchArguments(args, { enabled: true, url })).toEqual(['--remote', url, ...args])
  expect(codexLaunchArguments(args, { enabled: false })).toEqual(args)
})

it.each([
  { args: ['exec', '修复问题'] }, { args: ['-p', 'agentrouter', 'login'] }, { args: ['review'] }, { args: ['app-server', '--listen', url] },
  { args: ['--remote', 'wss://user.test'] }, { args: ['hello', '--remote=wss://user.test'] },
  { args: ['--no-daemon'] }, { args: ['--help'] }, { args: ['-V'] }, { args: ['--worktree'] }, { args: ['resume', '--help'] },
  // A profile can only use a service that explicitly loaded that profile.
  { args: ['-p', 'luna', '修复包含空格的文件'] }, { args: ['--profile=agentrouter', 'fork', 'thread-1'] },
  { args: ['--profile', 'luna', 'resume', '--last'] }, { args: ['-pluna'] }, { args: ['-p', '--no-daemon'] }
])('leaves explicit routes and unsupported modes unchanged: $args', ({ args }) => {
  expect(canAutoRouteCodex(args)).toBe(false)
  expect(codexLaunchArguments(args, { enabled: true, url })).toEqual(args)
})

it.each([
  ['-p', 'agentrouter'], ['--profile', 'agentrouter'], ['--profile=agentrouter'], ['-pagentrouter'], ['-p=agentrouter'],
  ['resume', '--last', '-p', 'agentrouter'], ['-m', '-pmodel', '-p', 'agentrouter']
])('routes a matching profile without removing native flags: %j', (...args) => {
  expect(canAutoRouteCodex(args, 'agentrouter')).toBe(true)
  expect(codexLaunchArguments(args, { enabled: true, url, profile: 'agentrouter' })).toEqual(['--remote', url, ...args])
  expect(codexLaunchArguments(args, { enabled: true, url, profile: 'other' })).toEqual(args)
  expect(codexLaunchArguments(args, { enabled: false, profile: 'agentrouter' })).toEqual(args)
})

it.each([['-p'], ['-p', ''], ['--profile='], ['-p', '../outside'], ['-p', 'agentrouter', '--profile', 'other'], ['-p', 'agentrouter', '--help']])('retains malformed or explicit profile launches: %j', (...args) => {
  expect(codexLaunchArguments(args, { enabled: true, url, profile: 'agentrouter' })).toEqual(args)
})

it('keeps plain codex on defaults and never injects a profile into literal prompt arguments', () => {
  const args = ['--', '-p', 'literal-prompt']
  expect(codexLaunchArguments(args, { enabled: true, url })).toEqual(['--remote', url, ...args])
})

it('extracts server overrides and cwd without treating option values or prompt text as flags', () => {
  expect(inspectCodexLaunch(['-p', 'agentrouter', '-c', 'model_provider="custom"', '--config=model_providers.custom.base_url="http://127.0.0.1:1"',
    '-C', 'project path', '--enable', 'feature', '-cmodel="x"', '--', '-c', 'literal']))
    .toEqual({ profile: 'agentrouter', directory: 'project path', overrides: ['model_provider="custom"', 'model_providers.custom.base_url="http://127.0.0.1:1"', 'features.feature=true', 'model="x"'] })
  expect(inspectCodexLaunch(['-m', '-cnot-config', '--disable=feature', '--cd=project', '-i', '-pnot-profile']))
    .toEqual({ directory: 'project', overrides: ['features.feature=false'] })
})
