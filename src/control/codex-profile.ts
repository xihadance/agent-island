import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse, TomlDate, type TomlValue } from 'smol-toml'
import { isCodexProfile } from '../shared/codex-profile'

export function readCodexProfile(name: string, directory = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): { args: string[]; fingerprint: string } {
  if (!isCodexProfile(name)) throw new Error('Codex profile 名称无效，请填写配置名称，不含路径或扩展名')
  const file = path.join(directory, `${name}.config.toml`)
  let config: Record<string, TomlValue>
  try {
    const baseFile = path.join(directory, 'config.toml')
    const base = existsSync(baseFile) ? parse(readFileSync(baseFile, 'utf8'), { integersAsBigInt: 'asNeeded' }) : {}
    const selected = existsSync(file) ? parse(readFileSync(file, 'utf8'), { integersAsBigInt: 'asNeeded' })
      : (base.profiles as Record<string, Record<string, TomlValue>> | undefined)?.[name] ?? {}
    config = Object.fromEntries(Object.entries(selected).map(([key, value]) => [key, merge(base[key], value)]))
  } catch { throw new Error('无法读取 Codex profile，请检查文件权限和 TOML 格式') }
  if (!Object.keys(config).length) throw new Error(`未找到非空的 Codex profile「${name}」，请检查 ${name}.config.toml 或 config.toml 中的 profiles 配置`)
  // Native app-server has no --profile. Explicit overrides keep its own CODEX_HOME and native channels.
  // Never put inline credentials into a process command line; native env references remain references.
  assertNoCredentials(config)
  if (Object.keys(config).some(key => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key))) throw new Error('Codex profile 包含不支持的顶层配置名称')
  const args = Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${inlineToml(value)}`])
  if (args.join(' ').length > 24000) throw new Error('Codex profile 过大，无法作为服务启动参数；请精简配置后重试')
  return { args, fingerprint: createHash('sha256').update(JSON.stringify(args)).digest('hex') }
}

function table(value: TomlValue | undefined): value is Record<string, TomlValue> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof TomlDate)
}

function merge(base: TomlValue | undefined, selected: TomlValue): TomlValue {
  if (!table(base) || !table(selected)) return selected
  // An explicitly selected env credential must not carry a base provider's unrelated inline fallback into argv.
  const keys = [...new Set([...Object.keys(base), ...Object.keys(selected)])].filter(key =>
    key !== 'experimental_bearer_token' || Object.hasOwn(selected, key) || typeof selected.env_key !== 'string' || !selected.env_key)
  return Object.fromEntries(keys.map(key =>
    [key, Object.hasOwn(selected, key) ? merge(base[key], selected[key]) : base[key]]))
}

function inlineToml(value: TomlValue): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (typeof value === 'number') return Number.isNaN(value) ? 'nan' : value === Infinity ? 'inf' : value === -Infinity ? '-inf' : String(value)
  if (value instanceof TomlDate) return value.toISOString()
  if (Array.isArray(value)) return `[${value.map(inlineToml).join(', ')}]`
  return `{ ${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)} = ${inlineToml(entry)}`).join(', ')} }`
}

function assertNoCredentials(value: TomlValue, parent = ''): void {
  if (Array.isArray(value)) { for (const entry of value) assertNoCredentials(entry, parent); return }
  if (!value || typeof value !== 'object' || value instanceof TomlDate) return
  for (const [key, entry] of Object.entries(value)) {
    if (parent !== 'env_http_headers' && typeof entry === 'string' && entry && /(?:^|_)(?:token|password|secret|api_key)$|^authorization$/i.test(key.replace(/-/g, '_'))) {
      throw new Error('Codex profile 含内联凭据或环境变量值，请改用 env_key、env_http_headers 或继承进程环境后再启动服务')
    }
    assertNoCredentials(entry, key)
  }
}
