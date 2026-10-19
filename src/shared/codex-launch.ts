import type { Preferences } from './preferences'
import type { RemoteConfig } from '../control/config'
import { isCodexProfile } from './codex-profile'

export interface CodexLaunchRoute { enabled: boolean; url?: string; tokenEnv?: string; managed?: boolean; profile?: string; notice?: string }
export interface CodexLaunchRequest { profile?: string; cwd: string; overrides: string[]; env: Record<string, string> }
export interface CodexCommandStatus { installed: boolean; profiles: string[]; shell: string; error?: string }

/** Remote takeover has priority; scoped connections cannot take over a newly created thread. */
export function codexLaunchRoute(preferences: Preferences, hostedUrl: string, remote?: Pick<RemoteConfig, 'codex'> & Partial<Pick<RemoteConfig, 'channels'>>, takeover = false): CodexLaunchRoute {
  if (takeover) {
    if (preferences.codexServer.enabled && remote?.channels?.length) return { enabled: true, url: hostedUrl, managed: true }
    const connections = remote?.codex.filter(c => !c.threads.length) ?? []
    const connection = connections.find(c => c.url === hostedUrl) ?? connections[0]
    return connection ? { enabled: true, url: connection.url, tokenEnv: connection.tokenEnv,
      ...(preferences.codexServer.enabled && connection.url === hostedUrl ? { managed: true } : {}) } : { enabled: false }
  }
  const url = preferences.codexServer.enabled ? hostedUrl : preferences.automation.codexUrl
  return preferences.automation.enabled && (url || preferences.codexServer.enabled) ? { enabled: true, url, ...(preferences.codexServer.enabled ? { managed: true } : {}) } : { enabled: false }
}

const remoteCommands = new Set(['agents', 'queue', 'resume', 'fork', 'archive', 'delete', 'unarchive'])
const commands = new Set([...remoteCommands, 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'migrate-rollouts', 'cloud', 'exec-server', 'features', 'help'])
const valuedOptions = new Set(['-c', '--config', '--enable', '--disable', '-i', '--image', '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval'])

/** Inspect option names, never prompt text or option values. Explicit user routing always wins. */
export function inspectCodexLaunch(args: readonly string[]): { profile?: string; directory?: string; overrides: string[] } | undefined {
  let command: string | undefined
  let positional = false
  let profile: string | undefined
  let directory: string | undefined
  const overrides: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') break
    const option = arg.split('=', 1)[0]
    if (['--remote', '--remote-auth-token-env', '--no-daemon', '--help', '-h', '--version', '-V', '--worktree'].includes(option)) return
    if (option === '-p' || option === '--profile' || /^-p./.test(arg)) {
      const name = arg === '-p' || arg === '--profile' ? args[++i] : arg.startsWith('--profile=') ? arg.slice('--profile='.length) : arg.slice(2).replace(/^=/, '')
      if (profile !== undefined || !name || name.startsWith('-') || !isCodexProfile(name)) return
      profile = name
      continue
    }
    const configFlag = ['-c', '--config', '-C', '--cd', '--enable', '--disable'].includes(option) ? option
      : /^-[cC].+/.test(arg) ? arg.slice(0, 2) : undefined
    if (configFlag) {
      const value = arg === configFlag ? args[++i] : arg.startsWith(`${configFlag}=`) ? arg.slice(configFlag.length + 1) : arg.slice(configFlag.length)
      if (!value) return
      if (configFlag === '-C' || configFlag === '--cd') directory = value
      else if (configFlag === '--enable' || configFlag === '--disable') {
        if (!/^[a-zA-Z0-9_]+$/.test(value)) return
        overrides.push(`features.${value}=${configFlag === '--enable'}`)
      } else overrides.push(value)
      continue
    }
    if (valuedOptions.has(arg)) { i++; continue }
    if (/^-(?:c|i|m|p|s|C|a).+/.test(arg) || arg.startsWith('-')) continue
    if (!positional) {
      positional = true
      if (commands.has(arg)) {
        command = arg
        if (!remoteCommands.has(command)) return
      }
    }
  }
  return { profile, directory, overrides }
}

export function codexLaunchProfile(args: readonly string[]): string | undefined {
  return inspectCodexLaunch(args)?.profile
}

export function canAutoRouteCodex(args: readonly string[], hostedProfile?: string): boolean {
  const launch = inspectCodexLaunch(args)
  return !!launch && (!launch.profile || launch.profile === hostedProfile)
}

export function codexLaunchArguments(args: readonly string[], route: CodexLaunchRoute): string[] {
  if (!route.enabled || !route.url || !canAutoRouteCodex(args, route.profile)) return [...args]
  return ['--remote', route.url, ...(route.tokenEnv ? ['--remote-auth-token-env', route.tokenEnv] : []), ...args]
}
