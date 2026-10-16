import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { initRemoteConfig, parseRemoteConfig, validateCodexUrl, validateCredentialName } from '../control/config'
import { check, record } from '../control/store'
import type { ControlStatus } from '../control/runtime'
import type { RemoteSettings } from '../shared/remote-settings'

const revision = (text: string): string => createHash('sha256').update(text).digest('hex')

export function remoteSettings(file: string, status?: ControlStatus, error?: string): RemoteSettings {
  const base: RemoteSettings = { configFile: file, configured: existsSync(file), enabled: status?.enabled ?? false,
    running: status?.running ?? false, revision: '', channels: [], codex: [], missingCredentials: [], error: error ?? status?.error }
  if (!base.configured) return base
  try {
    const text = readFileSync(file, 'utf8')
    const config = parseRemoteConfig(JSON.parse(text), file)
    const names = [...config.channels.map(c => c.type === 'feishu' || c.type === 'wecom' ? c.secretEnv : c.tokenEnv), ...config.codex.map(c => c.tokenEnv)]
    return { ...base, enabled: status?.enabled ?? config.enabled !== false, revision: revision(text), channels: config.channels, codex: config.codex,
      missingCredentials: [...new Set(names.filter((name): name is string => !!name && !process.env[name]?.trim()))] }
  } catch { return { ...base, error: '无法读取远程配置，请打开配置文件修正后重新读取。' } }
}

/** Update only the editable lists, with optimistic concurrency and atomic replacement. */
export function saveRemoteSettings(file: string, input: unknown, expectedRevision: unknown, port: number): void {
  const patch = record(input)
  check(Object.keys(patch).every(key => key === 'channels' || key === 'codex') && Array.isArray(patch.channels) && Array.isArray(patch.codex), '无效的渠道配置')
  const exists = existsSync(file)
  const text = exists ? readFileSync(file, 'utf8') : ''
  check(expectedRevision === (exists ? revision(text) : ''), '配置已在其他位置修改，请重新读取后再保存', 409)
  let value: Record<string, any>
  try { value = exists ? record(JSON.parse(text)) : { mode: 'takeover', enabled: false, controlToken: randomBytes(32).toString('hex'), port, stateFile: 'remote-state.json' } }
  catch { throw new Error('无法读取远程配置，请先修正配置文件') }
  check(value.enabled === false || !exists, '请先关闭远程接管，再编辑渠道和 Agent 连接', 409)
  const merge = (old: unknown, next: unknown[]): unknown[] => next.map(raw => {
    const item = record(raw)
    return { ...(Array.isArray(old) ? old.find(v => record(v).id === item.id) : {}), ...item }
  })
  const next = { ...value, channels: merge(value.channels, patch.channels), codex: merge(value.codex, patch.codex) }
  const validated = parseRemoteConfig(next, file)
  for (const connection of validated.codex) validateCodexUrl(connection.url)
  for (const name of [...validated.channels.flatMap(c => [c.tokenEnv, c.secretEnv]), ...validated.codex.map(c => c.tokenEnv)]) {
    validateCredentialName(name)
  }
  if (!exists) initRemoteConfig(file, port)
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
