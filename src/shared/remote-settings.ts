import type { ChannelConfig, RemoteConfig } from '../control/config'

export interface RemoteDraft {
  proxy?: RemoteConfig['proxy']
  channels: ChannelConfig[]
  codex: RemoteConfig['codex']
}

export type RemoteConnectionTest =
  | { kind: 'channel'; config: RemoteDraft['channels'][number]; proxy?: RemoteConfig['proxy'] }
  | { kind: 'codex'; config: RemoteDraft['codex'][number]; proxy?: RemoteConfig['proxy'] }

export interface RemoteConnectionTestResult {
  ok: boolean
  message: string
}

export interface RemoteSettings extends RemoteDraft {
  configured: boolean
  enabled: boolean
  running: boolean
  configFile: string
  revision: string
  error?: string
  missingCredentials: string[]
}
