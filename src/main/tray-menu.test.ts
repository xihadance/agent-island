import { expect, it, vi } from 'vitest'
import type { KeyboardEvent, MenuItem, MenuItemConstructorOptions } from 'electron'
import { trayMenu, trayPresentation, type TrayActions, type TrayState } from './tray-menu'

const initial: TrayState = {
  mode: 'focus', visible: true, watchSessions: true, watchDisabledByEnvironment: false, automationEnabled: false,
  remote: { configured: true, enabled: false, unavailable: false, error: false, testing: false }
}

function actions(): TrayActions {
  return { openSettings: vi.fn(), setVisible: vi.fn(), setMode: vi.fn(), setWatchSessions: vi.fn(),
    setAutomationEnabled: vi.fn(), setRemoteEnabled: vi.fn(), quit: vi.fn() }
}

function click(item: MenuItemConstructorOptions, checked = false): void {
  item.click?.({ checked } as MenuItem, undefined, {} as KeyboardEvent)
}

it('keeps approval and takeover switches directly accessible and moves low-frequency actions to settings', () => {
  const handlers = actions()
  const menu = trayMenu(initial, handlers)
  expect(menu.find(item => item.id === 'automation-toggle')?.type).toBe('checkbox')
  expect(menu.find(item => item.id === 'remote-toggle')?.type).toBe('checkbox')
  expect(menu.filter(item => ['配置远程接管…', '恢复顶部居中', '播放演示'].includes(item.label ?? ''))).toEqual([])
  click(menu.find(item => item.id === 'tray-settings')!)
  expect(handlers.openSettings).toHaveBeenCalledOnce()
})

it.each([true, false])('toggles window visibility from the current state: %s', visible => {
  const handlers = actions()
  const item = trayMenu({ ...initial, visible }, handlers).find(item => item.id === 'toggle-visibility')!
  expect(item.label).toBe(visible ? '隐藏灵动岛' : '显示灵动岛')
  click(item)
  expect(handlers.setVisible).toHaveBeenCalledWith(!visible)
  expect(trayPresentation({ ...initial, visible: !visible }).signature).not.toBe(trayPresentation({ ...initial, visible }).signature)
})

it('never starts recognition when the launch environment disables it', () => {
  const handlers = actions()
  const blocked = { ...initial, watchDisabledByEnvironment: true }
  const item = trayMenu(blocked, handlers).find(item => item.id === 'watch-sessions')!
  expect(item.checked).toBe(false)
  expect(item.enabled).toBe(false)
  click(item, true)
  expect(handlers.setWatchSessions).not.toHaveBeenCalled()
  expect(trayPresentation({ ...blocked, watchSessions: false })).toEqual(trayPresentation(blocked))
})

it('passes the new checkbox value to the native control actions independently of display mode', () => {
  const handlers = actions()
  const menu = trayMenu({ ...initial, mode: 'managed' }, handlers)
  click(menu.find(item => item.id === 'watch-sessions')!, false)
  click(menu.find(item => item.id === 'automation-toggle')!, true)
  click(menu.find(item => item.id === 'remote-toggle')!, true)
  expect(handlers.setWatchSessions).toHaveBeenCalledWith(false)
  expect(handlers.setAutomationEnabled).toHaveBeenCalledWith(true)
  expect(handlers.setRemoteEnabled).toHaveBeenCalledWith(true)
  expect(handlers.setMode).not.toHaveBeenCalled()
})

it.each(['error', 'unavailable'] as const)('refreshes the remote checkbox when its %s label masks an enabled-state change', flag => {
  const disabled = { ...initial, remote: { ...initial.remote, [flag]: true } }
  const enabled = { ...disabled, remote: { ...disabled.remote, enabled: true } }
  expect(trayPresentation(disabled).tooltip).toBe(trayPresentation(enabled).tooltip)
  expect(trayPresentation(disabled).signature).not.toBe(trayPresentation(enabled).signature)
})

it('shows connection testing and prevents toggling takeover until it finishes', () => {
  const testing = { ...initial, remote: { ...initial.remote, testing: true } }
  const item = trayMenu(testing, actions()).find(item => item.id === 'remote-toggle')!
  expect(item.enabled).toBe(false)
  expect(item.label).toContain('连接测试中')
  expect(trayPresentation(testing).signature).not.toBe(trayPresentation(initial).signature)
})
