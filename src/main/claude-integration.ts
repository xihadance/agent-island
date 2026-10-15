import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { record } from '../shared/preferences'

function load(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude Code 配置不是有效的 JSON 对象')
  return value as Record<string, unknown>
}

function isIslandHook(value: unknown): boolean {
  const hook = record(value)
  if (hook.type !== 'http' || typeof hook.url !== 'string') return false
  try {
    const url = new URL(hook.url)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/v1/hooks/claude'
  } catch { return false }
}

export function hasClaudeIntegration(file: string, port: number): boolean {
  try {
    const hooks = record(load(file).hooks)
    return ['PreToolUse', 'PermissionRequest'].every(event => Array.isArray(hooks[event]) && hooks[event].some(value => {
      const group = record(value)
      return (event !== 'PreToolUse' || group.matcher === 'AskUserQuestion') && Array.isArray(group.hooks) &&
        group.hooks.some(hook => isIslandHook(hook) && record(hook).url === `http://127.0.0.1:${port}/v1/hooks/claude`)
    }))
  } catch { return false }
}

/** Change only our HTTP hooks; preserve every unrelated hook and setting. */
export function setClaudeIntegration(file: string, installed: boolean, port: number, token?: string): void {
  const original = load(file)
  if ('hooks' in original && (!original.hooks || typeof original.hooks !== 'object' || Array.isArray(original.hooks))) throw new Error('Claude Code hooks 配置无效，未修改文件')
  const hooks = { ...record(original.hooks) }
  for (const event of ['PreToolUse', 'PermissionRequest']) {
    if (event in hooks && !Array.isArray(hooks[event])) throw new Error(`Claude Code ${event} 配置无效，未修改文件`)
    const groups: unknown[] = Array.isArray(hooks[event]) ? hooks[event] : []
    hooks[event] = groups.flatMap(raw => {
      const group = record(raw)
      if (!Array.isArray(group.hooks)) return [raw]
      const remaining = group.hooks.filter(hook => !isIslandHook(hook))
      return remaining.length || !group.hooks.length ? [{ ...group, hooks: remaining }] : []
    })
    if (installed) (hooks[event] as unknown[]).push({
      matcher: event === 'PreToolUse' ? 'AskUserQuestion' : '*',
      hooks: [{ type: 'http', url: `http://127.0.0.1:${port}/v1/hooks/claude`, timeout: 3,
        ...(token?.trim() ? { headers: { Authorization: `Bearer ${token.trim()}` } } : {}) }]
    })
  }
  mkdirSync(path.dirname(file), { recursive: true })
  if (existsSync(file)) writeFileSync(`${file}.cute-island-backup-${Date.now()}-${randomUUID().slice(0, 8)}`, readFileSync(file), { flag: 'wx' })
  const temporary = `${file}.cute-island.tmp`
  writeFileSync(temporary, JSON.stringify({ ...original, hooks }, null, 2), 'utf8')
  renameSync(temporary, file)
}
