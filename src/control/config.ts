import { parseProxy, type ProxySettings, type ProxyOverride } from '../shared/proxy'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { check, record, string } from './store'

export interface ChannelConfig {
  proxy?: ProxyOverride
  id: string
  type: 'telegram' | 'feishu' | 'wecom' | 'discord'
  destination: string
  allowedUsers: string[]
  tokenEnv?: string
  appId?: string
  secretEnv?: string
}
export interface RemoteConfig {
  proxy?: ProxySettings
  mode: 'takeover'
  enabled?: boolean
  controlToken: string
  port: number
  stateFile: string
  channels: ChannelConfig[]
  codex: { id: string; url: string; threads: string[]; tokenEnv?: string; proxy?: ProxyOverride }[]
}
export function readRemoteConfig(file: string): RemoteConfig | undefined {
  if (!existsSync(file)) return undefined
  return parseRemoteConfig(JSON.parse(readFileSync(file, 'utf8')), file)
}
export function parseRemoteConfig(input: unknown, file: string): RemoteConfig {
  const value = record(input)
  check(value.mode === 'takeover', 'remote config.mode 必须是 takeover')
  check(value.enabled === undefined || typeof value.enabled === 'boolean', 'remote config.enabled 必须是布尔值')
  const token = string(value.controlToken, 'controlToken', 256)
  check(token.length >= 32, '接管令牌至少需要 32 个字符')
  const port = value.port ?? 17321
  check(Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535, '接管端口无效')
  check(Array.isArray(value.channels), 'channels 必须是数组')
  const ids = new Set<string>()
  const bots = new Set<string>()
  const channels = value.channels.map(raw => {
    const c = record(raw)
    const id = string(c.id, '渠道 ID', 40)
    check(/^[\w-]+$/.test(id) && !ids.has(id), '渠道 ID 无效或重复')
    ids.add(id)
    check(['telegram', 'feishu', 'wecom', 'discord'].includes(String(c.type)), '渠道类型无效')
    const botKey = `${c.type}:${c.appId ?? c.tokenEnv}`
    check(!bots.has(botKey), '同一 Bot 只能配置一个接收端')
    bots.add(botKey)
    if (c.type === 'feishu' || c.type === 'wecom') string(c.appId, 'appId / botId', 200)
    string(c.type === 'feishu' || c.type === 'wecom' ? c.secretEnv : c.tokenEnv, '凭据环境变量', 100)
    check(Array.isArray(c.allowedUsers) && c.allowedUsers.length > 0, '请配置允许操作的用户 ID')
    return { id, proxy: parseProxy(c.proxy, true), type: c.type as ChannelConfig['type'], destination: string(c.destination, '目标会话', 160),
      allowedUsers: c.allowedUsers.map(v => string(v, '用户 ID', 160)),
      tokenEnv: c.tokenEnv === undefined ? undefined : string(c.tokenEnv, 'tokenEnv', 100),
      appId: c.appId === undefined ? undefined : string(c.appId, 'appId', 200),
      secretEnv: c.secretEnv === undefined ? undefined : string(c.secretEnv, 'secretEnv', 100) }
  })
  check(value.codex === undefined || Array.isArray(value.codex), 'codex 必须是数组')
  const codex = ((value.codex ?? []) as unknown[]).map(raw => {
    const c = record(raw)
    check(c.threads === undefined || Array.isArray(c.threads), 'Codex threads 必须是数组，留空可自动接管已加载会话')
    const id = string(c.id, 'Codex 连接 ID', 80)
    check(!ids.has(id), '连接 ID 重复'); ids.add(id)
    return { id, proxy: parseProxy(c.proxy, true), url: string(c.url, 'Codex URL', 1000), threads: ((c.threads ?? []) as unknown[]).map(t => string(t, 'thread ID', 250)), tokenEnv: c.tokenEnv === undefined ? undefined : string(c.tokenEnv, 'tokenEnv', 100) }
  })
  return { mode: 'takeover', proxy: parseProxy(value.proxy) as ProxySettings | undefined, enabled: value.enabled !== false, controlToken: token, port: Number(port), stateFile: path.resolve(path.dirname(file), typeof value.stateFile === 'string' ? value.stateFile : 'remote-state.json'), channels, codex }
}
export function initRemoteConfig(file: string, port = 17321): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ mode: 'takeover', enabled: false, controlToken: randomBytes(32).toString('hex'), port,
    stateFile: 'remote-state.json', channels: [], codex: [] }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
}
/** Preserve credentials, channel settings and unknown fields when toggling. */
export function saveRemoteEnabled(file: string, enabled: boolean): void {
  const value = record(JSON.parse(readFileSync(file, 'utf8')))
  check(value.mode === 'takeover', 'remote config.mode 必须是 takeover')
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({ ...value, enabled }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}

/** Only an explicit, valid off flag permits Hooks to defer without a live service. */
export function remoteExplicitlyDisabled(file: string): boolean {
  try {
    const value = record(JSON.parse(readFileSync(file, 'utf8')))
    return value.mode === 'takeover' && value.enabled === false
  } catch { return false }
}
export function secret(name: string | undefined, env = process.env): string {
  check(name && env[name]?.trim(), `请设置渠道凭据环境变量 ${name ?? '(未配置)'}`)
  return env[name]!
}

export function validateCredentialName(name: string | undefined): void {
  check(name === undefined || /^[A-Za-z_][A-Za-z0-9_]*$/.test(name), '凭据填写环境变量名称，例如 CUTE_ISLAND_TELEGRAM_TOKEN')
}

export function validateCodexUrl(value: string): void {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Codex WebSocket 地址无效') }
  check((url.protocol === 'wss:' || url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) && !url.username && !url.password && !url.search && !url.hash,
    'Codex 仅支持本机 ws 或远程 wss；认证请填写环境变量名称')
}
