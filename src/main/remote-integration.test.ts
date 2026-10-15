import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { remoteIntegrationStatus, setRemoteIntegration, type HookAgent } from './remote-integration'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(agent: HookAgent) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'island-hook-install-')); directories.push(dir)
  return { file: path.join(dir, 'settings.json'), agent, config: path.join(dir, 'remote.json'), runner: [path.join(dir, 'cute-island-remote-hook.cmd')] }
}
it.each(['claude', 'cursor', 'gemini'] as const)('installs %s hooks idempotently and preserves unrelated hooks/settings on removal', agent => {
  const options = fixture(agent)
  const ownEvent = agent === 'cursor' ? 'beforeShellExecution' : agent === 'claude' ? 'PermissionRequest' : 'BeforeTool'
  const original = { custom: { keep: true }, hooks: { [ownEvent]: agent === 'cursor' ? [{ command: 'my-existing-hook' }] : [{ matcher: '*', hooks: [{ type: 'command', command: 'my-existing-hook' }] }] } }
  const text = JSON.stringify(original); writeFileSync(options.file, text)
  expect(remoteIntegrationStatus(options).installed).toBe(false)
  setRemoteIntegration(options, true)
  const first = readFileSync(options.file, 'utf8')
  expect(remoteIntegrationStatus(options).installed).toBe(true)
  setRemoteIntegration(options, true)
  expect(readFileSync(options.file, 'utf8')).toBe(first)
  setRemoteIntegration(options, false)
  const restored = JSON.parse(readFileSync(options.file, 'utf8'))
  expect(restored.custom).toEqual(original.custom)
  expect(restored.hooks[ownEvent]).toEqual(original.hooks[ownEvent])
  expect(JSON.stringify(restored)).not.toContain('cute-island-remote-hook')
  expect(remoteIntegrationStatus(options).installed).toBe(false)
  const backups = readdirSync(path.dirname(options.file)).filter(name => name.includes('backup'))
  expect(backups.some(name => readFileSync(path.join(path.dirname(options.file), name), 'utf8') === text)).toBe(true)
})
it('does not overwrite malformed settings or expose their contents', () => {
  const options = fixture('gemini'); const original = '{"token":"keep-secret",'
  writeFileSync(options.file, original)
  expect(() => setRemoteIntegration(options, true)).toThrow('未修改')
  expect(readFileSync(options.file, 'utf8')).toBe(original)
  expect(JSON.stringify(remoteIntegrationStatus(options))).not.toContain('keep-secret')
})
it('migrates a legacy CLI Hook for the same config without removing other integrations', () => {
  const options = fixture('cursor')
  const legacy = `"node" "${path.join(path.dirname(options.file), 'out', 'cli.cjs')}" remote hook --agent cursor --config "${options.config}" --event beforeShellExecution`
  const other = legacy.replace(options.config, `${options.config}.other`)
  writeFileSync(options.file, JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: legacy }, { command: other }] } }))
  setRemoteIntegration(options, true)
  const commands = JSON.parse(readFileSync(options.file, 'utf8')).hooks.beforeShellExecution.map((hook: { command: string }) => hook.command)
  expect(commands).toHaveLength(2); expect(commands).not.toContain(legacy); expect(commands).toContain(other)
})
