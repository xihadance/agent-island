/// <reference types="vite/client" />
import type { RemoteDraft, RemoteConnectionTest, RemoteConnectionTestResult } from '../../shared/remote-settings'

import type { Activity } from '../../shared/activity'
import type { DockState } from '../../shared/window-position'
import type { IslandBehavior, IslandMode } from '../../shared/island-behavior'
import type { PreferencesPatch, SettingsSnapshot } from '../../shared/preferences'

export interface PointerSample {
  x: number
  y: number
  overWindow: boolean
  overIsland: boolean
}

export interface IslandHit {
  expanded: boolean
  x: number
  y: number
  width: number
  height: number
}

export interface IslandApi {
  openSettings: () => Promise<void>
  saveRemote: (draft: RemoteDraft, revision: string) => Promise<SettingsSnapshot>
  testRemoteConnection: (target: RemoteConnectionTest) => Promise<RemoteConnectionTestResult>
  setRemoteEnabled: (enabled: boolean) => Promise<SettingsSnapshot>
  setRemoteIntegration: (agent: 'claude' | 'cursor' | 'gemini', installed: boolean) => Promise<SettingsSnapshot>
  getSettings: () => Promise<SettingsSnapshot>
  updateSettings: (patch: PreferencesPatch) => Promise<SettingsSnapshot>
  onSettings: (callback: (snapshot: SettingsSnapshot) => void) => () => void
  setClaudeIntegration: (installed: boolean) => Promise<SettingsSnapshot>
  setCodexCommandIntegration: (installed: boolean) => Promise<SettingsSnapshot>
  settingsAction: (action: 'show' | 'hide' | 'reset-position' | 'clear-history' | 'remote-file' | 'remote-docs') => Promise<void>
  getBehavior: () => Promise<IslandBehavior>
  onBehavior: (callback: (behavior: IslandBehavior) => void) => () => void
  setMode: (mode: IslandMode) => void
  acknowledge: (id: string) => void
  getDock?: () => Promise<DockState>
  onDock?: (callback: (dock: DockState) => void) => () => void
  setDockExpanded?: (expanded: boolean) => void
  dragWindow?: (phase: 'start' | 'move' | 'end') => void
  setIgnoreMouse: (ignore: boolean) => void
  getActivities: () => Promise<Activity[]>
  answerQuestion: (id: string, revision: number, answers: Record<string, string[]>) => Promise<void>
  dismiss: (id: string) => Promise<void>
  playDemo: () => Promise<void>
  onActivities: (callback: (activities: Activity[]) => void) => () => void
  setInteraction?: (hit: IslandHit) => void
  onPointer?: (callback: (sample: PointerSample) => void) => () => void
  simulateError?: () => void
  simulateAgents?: () => void
  simulateSessions?: () => void
  simulateCapabilities?: () => void
  simulateTasks?: () => void
  simulateApproval?: () => void
  clear?: () => void
}

declare global {
  interface Window {
    island?: IslandApi
  }
}

export {}
