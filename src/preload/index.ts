import type { RemoteDraft } from '../shared/remote-settings'
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Activity } from '../shared/activity'
import type { DockState } from '../shared/window-position'
import type { IslandBehavior, IslandMode } from '../shared/island-behavior'
import type { PreferencesPatch, SettingsSnapshot } from '../shared/preferences'

const island = {
  openSettings(): Promise<void> { return ipcRenderer.invoke('island:open-settings') },
  saveRemote(draft: RemoteDraft, revision: string): Promise<SettingsSnapshot> { return ipcRenderer.invoke('island:save-remote', draft, revision) },
  setRemoteEnabled(enabled: boolean): Promise<SettingsSnapshot> { return ipcRenderer.invoke('island:remote-enabled', enabled) },
  setRemoteIntegration(agent: 'claude' | 'cursor' | 'gemini', installed: boolean): Promise<SettingsSnapshot> { return ipcRenderer.invoke('island:remote-integration', agent, installed) },
  getSettings(): Promise<SettingsSnapshot> { return ipcRenderer.invoke('island:get-settings') },
  updateSettings(patch: PreferencesPatch): Promise<SettingsSnapshot> { return ipcRenderer.invoke('island:update-settings', patch) },
  setClaudeIntegration(installed: boolean): Promise<SettingsSnapshot> { return ipcRenderer.invoke('island:claude-integration', installed) },
  settingsAction(action: 'show' | 'hide' | 'reset-position' | 'clear-history' | 'remote-file' | 'remote-docs'): Promise<void> { return ipcRenderer.invoke('island:settings-action', action) },
  onSettings(callback: (snapshot: SettingsSnapshot) => void): () => void {
    const listener = (_event: IpcRendererEvent, snapshot: SettingsSnapshot): void => callback(snapshot)
    ipcRenderer.on('island:settings', listener)
    return () => { ipcRenderer.removeListener('island:settings', listener) }
  },
  getBehavior(): Promise<IslandBehavior> {
    return ipcRenderer.invoke('island:get-behavior')
  },
  setMode(mode: IslandMode): void {
    ipcRenderer.send('island:set-mode', mode)
  },
  acknowledge(id: string): void {
    ipcRenderer.send('island:acknowledge', id)
  },
  onBehavior(callback: (behavior: IslandBehavior) => void): () => void {
    const listener = (_event: IpcRendererEvent, behavior: IslandBehavior): void => callback(behavior)
    ipcRenderer.on('island:behavior', listener)
    return () => { ipcRenderer.removeListener('island:behavior', listener) }
  },
  getDock(): Promise<DockState> {
    return ipcRenderer.invoke('island:get-dock')
  },
  setDockExpanded(expanded: boolean): void {
    ipcRenderer.send('island:set-dock-expanded', expanded)
  },
  onDock(callback: (dock: DockState) => void): () => void {
    const listener = (_event: IpcRendererEvent, dock: DockState): void => callback(dock)
    ipcRenderer.on('island:dock', listener)
    return () => { ipcRenderer.removeListener('island:dock', listener) }
  },
  dragWindow(phase: 'start' | 'move' | 'end'): void {
    ipcRenderer.send('island:drag', phase)
  },
  setIgnoreMouse(ignore: boolean): void {
    ipcRenderer.send('island:set-ignore-mouse', ignore)
  },
  getActivities(): Promise<Activity[]> {
    return ipcRenderer.invoke('island:get-activities')
  },
  dismiss(id: string): Promise<void> {
    return ipcRenderer.invoke('island:dismiss', id)
  },
  playDemo(): Promise<void> {
    return ipcRenderer.invoke('island:play-demo')
  },
  onActivities(callback: (activities: Activity[]) => void): () => void {
    const listener = (_event: IpcRendererEvent, activities: Activity[]): void => {
      callback(activities)
    }
    ipcRenderer.on('island:activities', listener)
    return () => {
      ipcRenderer.removeListener('island:activities', listener)
    }
  },
  setInteraction(hit: { expanded: boolean; x: number; y: number; width: number; height: number }): void {
    ipcRenderer.send('island:interaction', hit)
  },
  onPointer(callback: (sample: { x: number; y: number; overWindow: boolean; overIsland: boolean }) => void): () => void {
    const listener = (_event: IpcRendererEvent, sample: { x: number; y: number; overWindow: boolean; overIsland: boolean }): void => {
      callback(sample)
    }
    ipcRenderer.on('island:pointer', listener)
    return () => {
      ipcRenderer.removeListener('island:pointer', listener)
    }
  }
}

contextBridge.exposeInMainWorld('island', island)
