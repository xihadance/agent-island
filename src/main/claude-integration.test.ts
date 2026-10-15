import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { hasClaudeIntegration, setClaudeIntegration } from './claude-integration'

it('installs and removes only its hooks, preserves existing settings, and backs up the original', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'island-hooks-'))
  const file = path.join(directory, 'settings.json')
  const ownHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'check' }] }
  const original = { env: { CUSTOM: '1' }, permissions: { deny: ['Bash(rm *)'] }, hooks: { PreToolUse: [ownHook] } }
  try {
    writeFileSync(file, JSON.stringify(original))
    setClaudeIntegration(file, true, 17321, 'secret')
    expect(hasClaudeIntegration(file, 17321)).toBe(true)
    expect(hasClaudeIntegration(file, 17322)).toBe(false)
    const current = JSON.parse(readFileSync(file, 'utf8'))
    expect(current).toMatchObject({ env: original.env, permissions: original.permissions })
    expect(current.hooks.PreToolUse[0]).toEqual(ownHook)
    const backups = readdirSync(directory).filter(name => name.includes('backup'))
    expect(backups.length).toBe(1)
    expect(JSON.parse(readFileSync(path.join(directory, backups[0]), 'utf8'))).toEqual(original)
    setClaudeIntegration(file, true, 17322)
    const installed = JSON.parse(readFileSync(file, 'utf8'))
    expect(installed.hooks.PreToolUse).toHaveLength(2)
    expect(installed.hooks.PermissionRequest).toHaveLength(1)
    expect(installed.hooks.PermissionRequest[0].hooks[0]).toEqual({ type: 'http', url: 'http://127.0.0.1:17322/v1/hooks/claude', timeout: 3 })
    setClaudeIntegration(file, false, 17322)
    expect(hasClaudeIntegration(file, 17322)).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse).toEqual([ownHook])
    writeFileSync(file, '{broken')
    expect(() => setClaudeIntegration(file, true, 17321)).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('{broken')
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('island-hooks-')) throw new Error('Unexpected temporary path')
    rmSync(directory, { recursive: true, force: true })
  }
})
