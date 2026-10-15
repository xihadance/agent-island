import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { hookConfig } from '../control/cli'
import { record } from '../shared/preferences'

export type HookAgent = 'claude' | 'cursor' | 'gemini'
export interface HookInstallation { file: string; agent: HookAgent; config: string; runner: string[] }

/** Use Electron's bundled Node runtime: GUI-mode Electron consumes stdin on Windows. */
export function writeHookLauncher(file: string, executable: string, cli: string): void {
  if (/[\r\n"`$%!]/.test(file + executable + cli)) throw new Error('应用路径含有不支持的 Shell 字符')
  const source = process.platform === 'win32'
    ? `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${executable}" "${cli}" remote hook %*\r\nexit /b %errorlevel%\r\n`
    : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${executable}" "${cli}" remote hook "$@"\n`
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, source, { mode: 0o700 })
}

function load(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch { throw new Error('Agent 配置不是有效的 JSON 对象，请修正原配置后重试；文件未修改') }
}
function ours(value: unknown, options: HookInstallation): boolean {
  const hook = record(value)
  if (typeof hook.command !== 'string') return false
  return /[\\/]cute-island-remote-hook\.(?:cmd|sh)"/.test(hook.command) ||
    /[\\/]out[\\/]cli\.cjs"/.test(hook.command) && /\bremote"?\s+"?hook\b/.test(hook.command) &&
    hook.command.includes(`--agent ${options.agent}`) && hook.command.includes(`--config "${options.config}"`)
}
function generated(options: HookInstallation): Record<string, any> { return record(hookConfig(options.agent, options.config, '', options.runner)) }

export function remoteIntegrationStatus(options: HookInstallation): { installed: boolean; file: string; error?: string } {
  try {
    const hooks = record(load(options.file).hooks)
    const expected = record(generated(options).hooks)
    const installed = Object.entries(expected).every(([event, groups]) => Array.isArray(hooks[event]) && (groups as unknown[]).every(group =>
      (hooks[event] as unknown[]).some(existing => JSON.stringify(existing) === JSON.stringify(group))))
    return { installed, file: options.file }
  } catch (error) { return { installed: false, file: options.file, error: error instanceof Error ? error.message : '读取接入配置失败' } }
}

/** Merge only this application's marked hooks, backing up the original bytes first. */
export function setRemoteIntegration(options: HookInstallation, installed: boolean): void {
  const original = load(options.file)
  if ('hooks' in original && (!original.hooks || typeof original.hooks !== 'object' || Array.isArray(original.hooks))) throw new Error('Agent hooks 配置无效，未修改文件')
  if (options.agent === 'cursor' && original.version !== undefined && original.version !== 1) throw new Error('Cursor hooks 配置版本不受支持，未修改文件')
  const expected = generated(options)
  const hooks: Record<string, unknown> = { ...record(original.hooks) }
  for (const [event, raw] of Object.entries(hooks)) {
    // Gemini also permits hooks.disabled as a string list; preserve it as-is.
    if (!Array.isArray(raw)) { if (event in expected.hooks) throw new Error('Agent Hook 事件配置无效，未修改文件'); continue }
    hooks[event] = raw.flatMap(value => {
      if (ours(value, options)) return []
      const group = record(value)
      if (!Array.isArray(group.hooks)) return [value]
      const kept = group.hooks.filter(hook => !ours(hook, options))
      return kept.length === group.hooks.length ? [value] : kept.length ? [{ ...group, hooks: kept }] : []
    })
  }
  if (installed) for (const [event, groups] of Object.entries(expected.hooks)) hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), ...(groups as unknown[])]
  const next = { ...original, ...(options.agent === 'cursor' ? { version: 1 } : {}), hooks }
  mkdirSync(path.dirname(options.file), { recursive: true })
  if (existsSync(options.file)) writeFileSync(`${options.file}.cute-island-backup-${Date.now()}-${randomUUID().slice(0, 8)}`, readFileSync(options.file), { flag: 'wx', mode: 0o600 })
  const temporary = `${options.file}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, options.file) }
  finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
