import { isIslandMode, type IslandMode } from './island-behavior'
import type { RemoteSettings } from './remote-settings'

export interface Preferences {
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
  return {
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

export type PreferencesPatch = Partial<Omit<Preferences, 'automation'>> & { automation?: Partial<Preferences['automation']> }

export function patchPreferences(current: Preferences, value: unknown): Preferences {
  const patch = record(value)
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(patch).some(key => !['mode', 'watchSessions', 'automation'].includes(key))) throw new Error('无效的配置')
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
  return normalizePreferences({ ...current, ...patch, automation: { ...current.automation, ...auto } })
}

export interface AutomationEntry {
  id: number
  at: number
  agent: string
  action: 'approved' | 'answered' | 'manual'
  summary: string
}

export interface SettingsSnapshot {
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
