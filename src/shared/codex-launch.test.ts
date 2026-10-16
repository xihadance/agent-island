import { expect, it } from 'vitest'
import { normalizePreferences, patchPreferences } from './preferences'
import { canAutoRouteCodex, codexLaunchArguments, codexLaunchRoute } from './codex-launch'

const url = 'ws://127.0.0.1:4500'
it('routes takeover to the managed service without a separate connection configuration', () => {
  const preferences = patchPreferences(normalizePreferences(undefined), { codexServer: { enabled: true } })
  const channels = [{ id: 'phone', type: 'telegram' as const, destination: 'chat', allowedUsers: ['owner'], tokenEnv: 'TEST_TOKEN' }]
  expect(codexLaunchRoute(preferences, url, { channels, codex: [] }, true)).toEqual({ enabled: true, url })
  expect(codexLaunchRoute(preferences, url, { channels, codex: [{ id: 'other', url: 'wss://other.test', threads: [] }] }, true)).toEqual({ enabled: true, url })
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
  expect(codexLaunchRoute(preferences, '').enabled).toBe(false)
  expect(codexLaunchRoute(preferences, url)).toEqual({ enabled: true, url })
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
  // app-server cannot apply a client-side profile layer, so profiles must launch natively.
  { args: ['-p', 'luna', '修复包含空格的文件'] }, { args: ['--profile=agentrouter', 'fork', 'thread-1'] },
  { args: ['--profile', 'luna', 'resume', '--last'] }, { args: ['-pluna'] }, { args: ['-p', '--no-daemon'] }
])('leaves explicit routes and unsupported modes unchanged: $args', ({ args }) => {
  expect(canAutoRouteCodex(args)).toBe(false)
  expect(codexLaunchArguments(args, { enabled: true, url })).toEqual(args)
})
