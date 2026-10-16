import type { Preferences } from './preferences'
import type { RemoteConfig } from '../control/config'

export interface CodexLaunchRoute { enabled: boolean; url?: string; tokenEnv?: string }
export interface CodexCommandStatus { installed: boolean; profiles: string[]; shell: string; error?: string }

/** Remote takeover has priority; scoped connections cannot take over a newly created thread. */
export function codexLaunchRoute(preferences: Preferences, hostedUrl: string, remote?: Pick<RemoteConfig, 'codex'>, takeover = false): CodexLaunchRoute {
  if (takeover) {
    const connections = remote?.codex.filter(c => !c.threads.length) ?? []
    const connection = connections.find(c => c.url === hostedUrl) ?? connections[0]
    return connection ? { enabled: true, url: connection.url, tokenEnv: connection.tokenEnv } : { enabled: false }
  }
  const url = preferences.codexServer.enabled ? hostedUrl : preferences.automation.codexUrl
  return preferences.automation.enabled && url ? { enabled: true, url } : { enabled: false }
}

const remoteCommands = new Set(['agents', 'queue', 'resume', 'fork', 'archive', 'delete', 'unarchive'])
const commands = new Set([...remoteCommands, 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'migrate-rollouts', 'cloud', 'exec-server', 'features', 'help'])
const valuedOptions = new Set(['-c', '--config', '--enable', '--disable', '-i', '--image', '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval'])

/** Inspect option names, never prompt text or option values. Explicit user routing always wins. */
export function canAutoRouteCodex(args: readonly string[]): boolean {
  let command: string | undefined
  let positional = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') break
    const option = arg.split('=', 1)[0]
    if (['--remote', '--remote-auth-token-env', '--no-daemon', '--help', '-h', '--version', '-V', '--worktree'].includes(option)) return false
    if (valuedOptions.has(arg)) { i++; continue }
    if (/^-(?:c|i|m|p|s|C|a).+/.test(arg) || arg.startsWith('-')) continue
    if (!positional) {
      positional = true
      if (commands.has(arg)) {
        command = arg
        if (!remoteCommands.has(command)) return false
      }
    }
  }
  return true
}

export function codexLaunchArguments(args: readonly string[], route: CodexLaunchRoute): string[] {
  if (!route.enabled || !route.url || !canAutoRouteCodex(args)) return [...args]
  return ['--remote', route.url, ...(route.tokenEnv ? ['--remote-auth-token-env', route.tokenEnv] : []), ...args]
}
