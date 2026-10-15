import type { ChannelConfig, RemoteConfig } from '../control/config'

export interface RemoteDraft {
  channels: ChannelConfig[]
  codex: RemoteConfig['codex']
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
