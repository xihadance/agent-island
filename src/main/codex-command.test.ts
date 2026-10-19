import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexCommandStatus, setCodexCommandIntegration, writeCodexLaunchConfig, type CodexCommandOptions } from './codex-command'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(platform: NodeJS.Platform = 'win32') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'island-codex-command-')); directories.push(dir)
  const profiles = [path.join(dir, 'profile.ps1'), path.join(dir, 'profile-other.ps1')]
  const executable = path.join(dir, platform === 'win32' ? 'original-codex.ps1' : 'original-codex')
  writeFileSync(executable, 'placeholder')
  const options: CodexCommandOptions = { directory: path.join(dir, 'command'), runner: [process.execPath, path.join(dir, 'launcher.cjs')], profiles, executable, platform }
  return { dir, options, executable, profiles }
}

it.each([{ platform: 'win32' as const }, { platform: 'linux' as const }])('installs idempotently, preserves profile bytes, and removes only owned blocks on $platform', ({ platform }) => {
  const f = fixture(platform)
  const original = Buffer.from('\uFEFF# existing user settings\r\n$custom = "保留"')
  writeFileSync(f.profiles[0], original)
  setCodexCommandIntegration(f.options, true)
  expect(codexCommandStatus(f.options).installed).toBe(true)
  const installed = readFileSync(f.profiles[0])
  setCodexCommandIntegration(f.options, true)
  expect(readFileSync(f.profiles[0])).toEqual(installed)
  expect(readdirSync(f.dir).some(p => p.includes('backup'))).toBe(true)
  setCodexCommandIntegration(f.options, false)
  expect(readFileSync(f.profiles[0])).toEqual(original)
  expect(codexCommandStatus(f.options).installed).toBe(false)
  expect(existsSync(path.join(f.options.directory, 'installation.json'))).toBe(false)
  expect(readFileSync(f.executable, 'utf8')).toBe('placeholder')
})

it('validates all profiles before replacing user-defined Codex functions', () => {
  const f = fixture()
  const original = 'function codex { Write-Output "my own command" }\n'
  writeFileSync(f.profiles[1], original)
  expect(() => setCodexCommandIntegration(f.options, true)).toThrow('未覆盖')
  expect(existsSync(f.profiles[0])).toBe(false)
  expect(readFileSync(f.profiles[1], 'utf8')).toBe(original)
})

it('preserves Windows PowerShell UTF-16 profiles and user edits made after installation', () => {
  const f = fixture()
  const original = Buffer.from('\uFEFF# 用户配置\r\n$setting = 1\r\n', 'utf16le')
  writeFileSync(f.profiles[0], original)
  setCodexCommandIntegration(f.options, true)
  expect(codexCommandStatus(f.options).installed).toBe(true)
  const edit = Buffer.from('# 后续编辑\r\n', 'utf16le')
  writeFileSync(f.profiles[0], Buffer.concat([readFileSync(f.profiles[0]), edit]))
  setCodexCommandIntegration(f.options, false)
  expect(readFileSync(f.profiles[0])).toEqual(Buffer.concat([original, edit]))
})

it('refreshes its runtime after an application update without changing profiles or the CLI entrypoint', () => {
  const f = fixture()
  setCodexCommandIntegration(f.options, true)
  const profile = readFileSync(f.profiles[0])
  const updated = { ...f.options, runner: [path.join(f.dir, 'updated-runtime.exe'), path.join(f.dir, 'updated-cli.cjs')] as [string, string] }
  writeCodexLaunchConfig(updated, 'http://127.0.0.1:17321/v1/codex/launch', 'private-local-token-'.repeat(3))
  expect(readFileSync(f.profiles[0])).toEqual(profile)
  expect(readFileSync(path.join(f.options.directory, 'codex.ps1'), 'utf8')).toContain('updated-runtime.exe')
  expect(JSON.parse(readFileSync(path.join(f.options.directory, 'launch.json'), 'utf8')).executable).toBe(f.executable)
})

it.skipIf(process.platform !== 'win32')('uses the same PowerShell session for dynamic routing, exact args, CLI updates and removal fallback', async () => {
  const f = fixture()
  const enabled = path.join(f.dir, 'enabled.txt')
  writeFileSync(enabled, 'on')
  writeFileSync(f.options.runner[1], `if(process.env.CUTE_ISLAND_CODEX_RUN_AS_NODE_SET!=='x'||process.env.CUTE_ISLAND_CODEX_ORIGINAL_RUN_AS_NODE!=='original-value')process.exit(2); const fs=require('node:fs'); const args=JSON.parse(Buffer.from(process.argv[process.argv.indexOf('--args-base64')+1],'base64').toString('utf8')); console.log(JSON.stringify({args:fs.readFileSync(${JSON.stringify(enabled)},'utf8')==='on'?['--remote','ws://127.0.0.1:4500',...args]:args}));`)
  const original = (version: number) => `$value = @{version=${version};args=@($args);runtime=$env:ELECTRON_RUN_AS_NODE;input=@($input)}; ConvertTo-Json -InputObject $value -Compress; exit 7\n`
  writeFileSync(f.executable, original(1))
  setCodexCommandIntegration(f.options, true)
  writeCodexLaunchConfig(f.options, 'http://127.0.0.1:17321/v1/codex/launch', 'local-token-'.repeat(4))
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`
  const shell = path.join(f.dir, 'test-session.ps1')
  const manifest = path.join(f.options.directory, 'installation.json')
  writeFileSync(shell, `\uFEFF
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:ELECTRON_RUN_AS_NODE = 'original-value'
. ${quote(f.profiles[0])}
codex -p agentrouter '保持空格 $() \`literal 和 "引号"' ''
Write-Output "EXIT:$LASTEXITCODE"
'pipeline input' | codex -p agentrouter
[IO.File]::WriteAllText(${quote(enabled)}, 'off')
codex -p agentrouter
[IO.File]::WriteAllText(${quote(f.executable)}, ${quote(original(2))})
codex -p agentrouter
[IO.File]::WriteAllText(${quote(enabled)}, 'on')
[IO.File]::Delete(${quote(manifest)})
codex -p agentrouter
`, { encoding: 'utf8' })
  const result = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', shell], { windowsHide: true, timeout: 20000 })
  const lines = result.stdout.split(/\r?\n/).filter(Boolean)
  expect(JSON.parse(lines[0])).toMatchObject({ version: 1, args: ['--remote', 'ws://127.0.0.1:4500', '-p', 'agentrouter', '保持空格 $() \`literal 和 "引号"', ''], runtime: 'original-value' })
  expect(lines[1]).toBe('EXIT:7')
  expect(JSON.parse(lines[2])).toMatchObject({ args: ['--remote', 'ws://127.0.0.1:4500', '-p', 'agentrouter'], input: ['pipeline input'] })
  expect(JSON.parse(lines[3])).toMatchObject({ version: 1, args: ['-p', 'agentrouter'] })
  expect(JSON.parse(lines[4])).toMatchObject({ version: 2, args: ['-p', 'agentrouter'] })
  expect(JSON.parse(lines[5])).toMatchObject({ version: 2, args: ['-p', 'agentrouter'] })
}, 30000)
