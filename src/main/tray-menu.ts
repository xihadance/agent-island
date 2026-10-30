import type { MenuItemConstructorOptions } from 'electron'
import type { IslandMode } from '../shared/island-behavior'

export interface TrayState {
  mode: IslandMode
  visible: boolean
  watchSessions: boolean
  watchDisabledByEnvironment: boolean
  automationEnabled: boolean
  remote: { configured: boolean; enabled: boolean; unavailable: boolean; error: boolean; testing: boolean }
}

export interface TrayActions {
  openSettings(): void
  setVisible(visible: boolean): void
  setMode(mode: IslandMode): void
  setWatchSessions(enabled: boolean): void
  setAutomationEnabled(enabled: boolean): void
  setRemoteEnabled(enabled: boolean): void
  quit(): void
}

function remoteLabel(state: TrayState): string {
  const remote = state.remote
  return remote.unavailable ? '不可用，请检查配置' : remote.testing ? '连接测试中' : remote.error ? '启动或清理失败' : remote.enabled ? '已开启' : remote.configured ? '已关闭' : '请先配置'
}

export function trayPresentation(state: TrayState): { tooltip: string; signature: string } {
  const watch = state.watchDisabledByEnvironment ? '环境已关闭' : state.watchSessions ? '已开启' : '已暂停'
  const tooltip = `Cute Island · ${state.mode === 'managed' ? '托管模式' : '关注模式'}\n${state.visible ? '已显示' : '已隐藏'} · 会话识别${watch}\n自动审批${state.automationEnabled ? '已开启' : '已关闭'} · 远程接管${remoteLabel(state)}`
  // Only visible presentation belongs in the cache, never session or delivery progress.
  return { tooltip, signature: JSON.stringify([tooltip, state.remote.enabled, state.remote.configured && !state.remote.testing]) }
}

export function trayMenu(state: TrayState, actions: TrayActions): MenuItemConstructorOptions[] {
  return [
    { id: 'tray-settings', label: '打开配置…', accelerator: 'CmdOrCtrl+,', click: () => actions.openSettings() },
    { id: 'toggle-visibility', label: state.visible ? '隐藏灵动岛' : '显示灵动岛', click: () => actions.setVisible(!state.visible) },
    { type: 'separator' },
    { id: 'display-mode', label: `显示模式（${state.mode === 'focus' ? '关注' : '托管'}）`, submenu: [
      { id: 'mode-focus', label: '关注模式', type: 'radio', checked: state.mode === 'focus', click: () => actions.setMode('focus') },
      { id: 'mode-managed', label: '托管模式', type: 'radio', checked: state.mode === 'managed', click: () => actions.setMode('managed') }
    ] },
    { id: 'watch-sessions', label: state.watchDisabledByEnvironment ? '会话识别（环境已关闭）' : '会话识别', type: 'checkbox',
      checked: state.watchSessions && !state.watchDisabledByEnvironment, enabled: !state.watchDisabledByEnvironment,
      click: item => { if (!state.watchDisabledByEnvironment) actions.setWatchSessions(item.checked) } },
    { type: 'separator' },
    { id: 'automation-toggle', label: '自动审批', type: 'checkbox', checked: state.automationEnabled, click: item => actions.setAutomationEnabled(item.checked) },
    { id: 'remote-toggle', label: `远程接管（${remoteLabel(state)}）`, type: 'checkbox', checked: state.remote.enabled,
      enabled: state.remote.configured && !state.remote.testing, click: item => actions.setRemoteEnabled(item.checked) },
    { type: 'separator' },
    { id: 'tray-quit', label: '退出', click: () => actions.quit() }
  ]
}
