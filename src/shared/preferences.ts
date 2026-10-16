import { isIslandMode, type IslandMode } from './island-behavior'
import type { RemoteSettings } from './remote-settings'
import type { CodexCommandStatus } from './codex-launch'

export type Theme = 'system' | 'light' | 'dark'
export function isTheme(value: unknown): value is Theme { return value === 'system' || value === 'light' || value === 'dark' }

export interface Preferences {
  theme: Theme
  codexServer: { enabled: boolean; port: number; executable: string }
  mode: IslandMode
  watchSessions: boolean
  automation: {
    enabled: boolean
    approvePermissions: boolean
    answerQuestions: boolean
    fallback: 'manual' | 'first'
    codexUrl: string
  }
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  codexServer: { enabled: false, port: 4500, executable: '' },
  mode: 'focus',
  watchSessions: true,
  automation: { enabled: false, approvePermissions: true, answerQuestions: true, fallback: 'manual', codexUrl: '' }
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
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
  return {
    theme: isTheme(source.theme) ? source.theme : 'system',
    codexServer: { enabled: server.enabled === true, port: Number.isInteger(server.port) && Number(server.port) > 0 && Number(server.port) <= 65535 ? Number(server.port) : 4500,
      executable: typeof server.executable === 'string' ? server.executable.trim() : '' },
    mode: isIslandMode(source.mode) ? source.mode : 'focus',
    watchSessions: typeof source.watchSessions === 'boolean' ? source.watchSessions : true,
    automation: {
      enabled: automation.enabled === true,
      approvePermissions: typeof automation.approvePermissions === 'boolean' ? automation.approvePermissions : true,
      answerQuestions: typeof automation.answerQuestions === 'boolean' ? automation.answerQuestions : true,
      fallback: automation.fallback === 'first' ? 'first' : 'manual',
      codexUrl: typeof automation.codexUrl === 'string' && isLocalCodexUrl(automation.codexUrl) ? automation.codexUrl : ''
    }
  }
}

export type PreferencesPatch = Partial<Omit<Preferences, 'automation' | 'codexServer'>> & { automation?: Partial<Preferences['automation']>; codexServer?: Partial<Preferences['codexServer']> }

export function patchPreferences(current: Preferences, value: unknown): Preferences {
  const patch = record(value)
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(patch).some(key => !['mode', 'theme', 'watchSessions', 'automation', 'codexServer'].includes(key))) throw new Error('无效的配置')
  if ('theme' in patch && !isTheme(patch.theme)) throw new Error('无效的外观主题')
  const server = record(patch.codexServer)
  if ('codexServer' in patch && (patch.codexServer === null || typeof patch.codexServer !== 'object' || Array.isArray(patch.codexServer) ||
      Object.keys(server).some(key => !['enabled', 'port', 'executable'].includes(key)))) throw new Error('无效的 Codex 服务配置')
  if ('enabled' in server && typeof server.enabled !== 'boolean') throw new Error('无效的 Codex 服务开关')
  if ('port' in server && (!Number.isInteger(server.port) || Number(server.port) < 1 || Number(server.port) > 65535)) throw new Error('Codex 服务端口必须为 1–65535')
  if ('executable' in server && (typeof server.executable !== 'string' || /[\r\n\0]/.test(server.executable))) throw new Error('无效的 Codex 程序路径')
  if ('mode' in patch && !isIslandMode(patch.mode)) throw new Error('无效的显示模式')
  if ('watchSessions' in patch && typeof patch.watchSessions !== 'boolean') throw new Error('无效的会话识别设置')
  const auto = record(patch.automation)
  if ('automation' in patch && (patch.automation === null || typeof patch.automation !== 'object' || Array.isArray(patch.automation) ||
      Object.keys(auto).some(key => !['enabled', 'approvePermissions', 'answerQuestions', 'fallback', 'codexUrl'].includes(key)))) throw new Error('无效的自动审批配置')
  for (const key of ['enabled', 'approvePermissions', 'answerQuestions']) {
    if (key in auto && typeof auto[key] !== 'boolean') throw new Error('自动审批开关必须为布尔值')
  }
  if ('fallback' in auto && auto.fallback !== 'manual' && auto.fallback !== 'first') throw new Error('无效的问题回答规则')
  if ('codexUrl' in auto && (typeof auto.codexUrl !== 'string' || !isLocalCodexUrl(auto.codexUrl))) throw new Error('请填写本机 WebSocket 地址，例如 ws://127.0.0.1:4500')
  return normalizePreferences({ ...current, ...patch, automation: { ...current.automation, ...auto }, codexServer: { ...current.codexServer, ...server } })
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
  codexServer: { status: 'stopped' | 'starting' | 'running' | 'error'; url: string; detail: string }
  remoteHooks: Record<'claude' | 'cursor' | 'gemini', { installed: boolean; file: string; error?: string }>
  remote: RemoteSettings
  preferences: Preferences
  version: string
  port: number
  watchDisabledByEnvironment: boolean
  claudeInstalled: boolean
  codexStatus: 'disabled' | 'connecting' | 'connected' | 'error'
  codexDetail: string
  history: AutomationEntry[]
  preview?: boolean
}
