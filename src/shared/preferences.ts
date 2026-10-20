import { isIslandMode, type IslandMode } from './island-behavior'
import type { LaunchAtLoginStatus } from './launch-at-login'
import type { RemoteSettings } from './remote-settings'
import type { CodexCommandStatus } from './codex-launch'
import type { UpdateState } from './update'

export type Theme = 'system' | 'light' | 'dark'
export function isTheme(value: unknown): value is Theme { return value === 'system' || value === 'light' || value === 'dark' }

export interface Preferences {
  theme: Theme
  codexServer: { enabled: boolean; port: number; executable: string }
  mode: IslandMode
  watchSessions: boolean
  launchAtLogin: boolean
  automation: {
    enabled: boolean
    approvePermissions: boolean
    answerQuestions: boolean
    blacklist: string[]
    fallback: 'manual' | 'first'
    codexUrl: string
  }
  update: {
    enabled: boolean
    skippedVersion: string
    /** Written by the main process only, so a restart does not re-query the feed. */
    lastCheckedAt: number
  }
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  codexServer: { enabled: false, port: 4500, executable: '' },
  mode: 'focus',
  watchSessions: true,
  launchAtLogin: false,
  automation:{ enabled: false, approvePermissions: true, answerQuestions: true, blacklist: [], fallback: 'manual', codexUrl: '' },
  update: { enabled: true, skippedVersion: '', lastCheckedAt: 0 }
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isBlacklist(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

export function normalizeBlacklist(value: unknown): string[] {
  if (!isBlacklist(value)) return []
  const seen = new Set<string>()
  return value.flatMap(entry => entry.split(/\r?\n/)).map(entry => entry.trim()).filter(entry => {
    const key = entry.toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function isLocalCodexUrl(value: string): boolean {
  if (!value) return true
  try {
    const url = new URL(value)
    return url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
  } catch { return false }
}

/** Restore older files field by field. A malformed value never enables automation. */
export function normalizePreferences(value: unknown): Preferences {
  const source = record(value)
  const automation = record(source.automation)
  const server = record(source.codexServer)
  const update = record(source.update)
  return {
    theme: isTheme(source.theme) ? source.theme : 'system',
    codexServer: { enabled: server.enabled === true, port: Number.isInteger(server.port) && Number(server.port) > 0 && Number(server.port) <= 65535 ? Number(server.port) : 4500,
      executable: typeof server.executable === 'string' ? server.executable.trim() : '' },
    mode: isIslandMode(source.mode) ? source.mode : 'focus',
    watchSessions: typeof source.watchSessions === 'boolean' ? source.watchSessions : true,
    launchAtLogin: source.launchAtLogin === true,
    automation: {
      // A damaged exclusion list must not silently turn into unrestricted automation.
      enabled: automation.enabled === true && (!('blacklist' in automation) || isBlacklist(automation.blacklist)),
      approvePermissions: typeof automation.approvePermissions === 'boolean' ? automation.approvePermissions : true,
      answerQuestions: typeof automation.answerQuestions === 'boolean' ? automation.answerQuestions : true,
      blacklist: normalizeBlacklist(automation.blacklist),
      fallback: automation.fallback === 'first' ? 'first' : 'manual',
      codexUrl: typeof automation.codexUrl === 'string' && isLocalCodexUrl(automation.codexUrl) ? automation.codexUrl : ''
    },
    update: {
      enabled: typeof update.enabled === 'boolean' ? update.enabled : true,
      skippedVersion: typeof update.skippedVersion === 'string' ? update.skippedVersion.trim().slice(0, 40) : '',
      lastCheckedAt: Number.isFinite(update.lastCheckedAt) && Number(update.lastCheckedAt) > 0 ? Number(update.lastCheckedAt) : 0
    }
  }
}

export type PreferencesPatch = Partial<Omit<Preferences, 'automation' | 'codexServer' | 'update'>> &
  { automation?: Partial<Preferences['automation']>; codexServer?: Partial<Preferences['codexServer']>; update?: Partial<Omit<Preferences['update'], 'lastCheckedAt'>> }

export function patchPreferences(current: Preferences, value: unknown): Preferences {
  const patch = record(value)
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(patch).some(key => !['mode', 'theme', 'watchSessions', 'launchAtLogin', 'automation', 'codexServer', 'update'].includes(key))) throw new Error('无效的配置')
  if ('theme' in patch && !isTheme(patch.theme)) throw new Error('无效的外观主题')
  const server = record(patch.codexServer)
  if ('codexServer' in patch && (patch.codexServer === null || typeof patch.codexServer !== 'object' || Array.isArray(patch.codexServer) ||
      Object.keys(server).some(key => !['enabled', 'port', 'executable'].includes(key)))) throw new Error('无效的 Codex 服务配置')
  if ('enabled' in server && typeof server.enabled !== 'boolean') throw new Error('无效的 Codex 服务开关')
  if ('port' in server && (!Number.isInteger(server.port) || Number(server.port) < 1 || Number(server.port) > 65535)) throw new Error('Codex 服务端口必须为 1–65535')
  if ('executable' in server && (typeof server.executable !== 'string' || /[\r\n\0]/.test(server.executable))) throw new Error('无效的 Codex 程序路径')
  if ('mode' in patch && !isIslandMode(patch.mode)) throw new Error('无效的显示模式')
  if ('watchSessions' in patch && typeof patch.watchSessions !== 'boolean') throw new Error('无效的会话识别设置')
  if ('launchAtLogin' in patch && typeof patch.launchAtLogin !== 'boolean') throw new Error('无效的开机启动设置')
  const auto = record(patch.automation)
  if ('automation' in patch && (patch.automation === null || typeof patch.automation !== 'object' || Array.isArray(patch.automation) ||
      Object.keys(auto).some(key => !['enabled', 'approvePermissions', 'answerQuestions', 'blacklist', 'fallback', 'codexUrl'].includes(key)))) throw new Error('无效的自动审批配置')
  for (const key of ['enabled', 'approvePermissions', 'answerQuestions']) {
    if (key in auto && typeof auto[key] !== 'boolean') throw new Error('自动审批开关必须为布尔值')
  }
  if ('fallback' in auto && auto.fallback !== 'manual' && auto.fallback !== 'first') throw new Error('无效的问题回答规则')
  if ('blacklist' in auto && !isBlacklist(auto.blacklist)) throw new Error('黑名单必须是关键词列表，每项为文本')
  if ('codexUrl' in auto && (typeof auto.codexUrl !== 'string' || !isLocalCodexUrl(auto.codexUrl))) throw new Error('请填写本机 WebSocket 地址，例如 ws://127.0.0.1:4500')
  // lastCheckedAt is main-process bookkeeping. A renderer must not be able to postpone or force checks.
  const update = record(patch.update)
  if ('update' in patch && (patch.update === null || typeof patch.update !== 'object' || Array.isArray(patch.update) ||
      Object.keys(update).some(key => !['enabled', 'skippedVersion'].includes(key)))) throw new Error('无效的更新检查配置')
  if ('enabled' in update && typeof update.enabled !== 'boolean') throw new Error('无效的更新检查开关')
  if ('skippedVersion' in update && (typeof update.skippedVersion !== 'string' || update.skippedVersion.length > 40)) throw new Error('无效的跳过版本')
  return normalizePreferences({ ...current, ...patch, automation: { ...current.automation, ...auto }, codexServer: { ...current.codexServer, ...server },
    update: { ...current.update, ...update } })
}

export interface AutomationEntry {
  id: number
  at: number
  agent: string
  action: 'approved' | 'answered' | 'manual'
  summary: string
}

export interface SettingsSnapshot {
  codexCommand: CodexCommandStatus
  codexServer: { status: 'stopped' | 'starting' | 'running' | 'error'; url: string; detail: string; instances?: number }
  remoteHooks: Record<'claude' | 'cursor' | 'gemini', { installed: boolean; file: string; error?: string }>
  remote: RemoteSettings
  preferences: Preferences
  version: string
  port: number
  watchDisabledByEnvironment: boolean
  claudeInstalled: boolean
  launchAtLogin: LaunchAtLoginStatus
  codexStatus: 'disabled' | 'connecting' | 'connected' | 'error'
  codexDetail: string
  history: AutomationEntry[]
  update: UpdateState
  preview?: boolean
}
