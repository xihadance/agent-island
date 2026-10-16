import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { CodexCommandStatus } from '../shared/codex-launch'
import type { CodexLaunchConfig } from '../control/codex-launch'

const BEGIN = '# >>> Cute Island Codex >>>'
const END = '# <<< Cute Island Codex <<<'
const blockPattern = /(?:\r?\n)?# >>> Cute Island Codex >>>\r?\n[\s\S]*?# <<< Cute Island Codex <<<\r?\n?/g

export interface CodexCommandOptions {
  directory: string
  runner: [string, string]
  platform?: NodeJS.Platform
  profiles?: string[]
  executable?: string
  env?: NodeJS.ProcessEnv
}

function files(options: CodexCommandOptions) {
  return { manifest: path.join(options.directory, 'installation.json'), config: path.join(options.directory, 'launch.json'),
    script: path.join(options.directory, (options.platform ?? process.platform) === 'win32' ? 'codex.ps1' : 'codex.sh') }
}

/** Keep the original npm/standalone entrypoint so CLI package upgrades remain effective. */
export function findCodexCommand(env = process.env, platform = process.platform): string {
  const names = platform === 'win32' ? ['codex.ps1', 'codex.exe', 'codex.cmd'] : ['codex']
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) for (const name of names) {
    const candidate = path.resolve(directory, name)
    if (existsSync(candidate)) return candidate
  }
  throw new Error('未找到 Codex 命令，请先安装 Codex CLI')
}

function profilePaths(options: CodexCommandOptions): string[] {
  if (options.profiles) return options.profiles
  const env = options.env ?? process.env
  if ((options.platform ?? process.platform) !== 'win32') {
    const home = os.homedir()
    return [path.join(home, '.bashrc'), path.join(env.ZDOTDIR || home, '.zshrc')]
  }
  const documents = env.CUTE_ISLAND_POWERSHELL_DOCUMENTS || execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('MyDocuments')"], { encoding: 'utf8', windowsHide: true }).trim()
  if (!path.isAbsolute(documents)) throw new Error('无法确定 PowerShell 用户配置目录')
  return [path.join(documents, 'PowerShell', 'profile.ps1'), path.join(documents, 'WindowsPowerShell', 'profile.ps1')]
}

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`
const shQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`

function readProfile(bytes: Buffer) {
  if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) throw new Error('Shell 配置为 UTF-16 BE，请先转换为 UTF-8 或 UTF-16 LE')
  const encoding = bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ? 'utf16le' : 'utf8'
  const bomLength = encoding === 'utf16le' ? 2 : bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0
  return { encoding: encoding as BufferEncoding, bom: bytes.subarray(0, bomLength), text: bytes.subarray(bomLength).toString(encoding) }
}

function sourceLine(script: string, windows: boolean): string { return `. ${windows ? psQuote(script) : shQuote(script)}` }

function commandScript(options: CodexCommandOptions, executable: string): string {
  const file = files(options)
  const [runtime, cli] = options.runner
  if ((options.platform ?? process.platform) !== 'win32') return `codex() {
  if [ -f ${shQuote(file.manifest)} ] && [ -f ${shQuote(file.config)} ] && [ -f ${shQuote(runtime)} ] && [ -f ${shQuote(cli)} ]; then
    CUTE_ISLAND_CODEX_ORIGINAL_RUN_AS_NODE="${'${ELECTRON_RUN_AS_NODE-}'}" CUTE_ISLAND_CODEX_RUN_AS_NODE_SET="${'${ELECTRON_RUN_AS_NODE+x}'}" ELECTRON_RUN_AS_NODE=1 ${shQuote(runtime)} ${shQuote(cli)} codex-launch run --config ${shQuote(file.config)} -- "$@"
  else
    ${shQuote(executable)} "$@"
  fi
}
`
  return `function global:codex {
  [string[]]$islandCodexArguments = @($args)
  $islandPreviousRunAsNode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', 'Process')
  try {
    if ((Test-Path -LiteralPath ${psQuote(file.manifest)}) -and (Test-Path -LiteralPath ${psQuote(file.config)})) {
      $env:ELECTRON_RUN_AS_NODE = '1'
      # Windows PowerShell native argument quoting loses embedded quotes and empty values.
      $islandEncodedArguments = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $islandCodexArguments -Compress)))
      # Piping also waits for GUI executables such as the bundled Electron runtime.
      $islandPlanOutput = & ${psQuote(runtime)} ${psQuote(cli)} codex-launch plan --config ${psQuote(file.config)} --args-base64 $islandEncodedArguments | Out-String
      if ($LASTEXITCODE -eq 0) {
        $islandPlan = ($islandPlanOutput -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
        if ($null -ne $islandPlan.args) { $islandCodexArguments = @($islandPlan.args) }
      }
    }
  } catch {
    # An unavailable app or launcher falls back to the original Codex command.
  } finally {
    [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $islandPreviousRunAsNode, 'Process')
  }
  if ($MyInvocation.ExpectingInput) {
    $input | & ${psQuote(executable)} @islandCodexArguments
  } else {
    & ${psQuote(executable)} @islandCodexArguments
  }
  $global:LASTEXITCODE = $LASTEXITCODE
}
`
}

export function codexCommandStatus(options: CodexCommandOptions): CodexCommandStatus {
  const windows = (options.platform ?? process.platform) === 'win32'
  const shell = windows ? 'PowerShell' : 'Bash / Zsh'
  try {
    const file = files(options)
    if (!existsSync(file.manifest)) return { installed: false, profiles: [], shell }
    const manifest = JSON.parse(readFileSync(file.manifest, 'utf8'))
    const profiles: string[] = manifest.profiles
    if (!Array.isArray(profiles) || !profiles.length || !profiles.every(p => typeof p === 'string' && path.isAbsolute(p))) throw new Error('命令接入记录无效')
    const installed = existsSync(file.script) && profiles.every(profile => existsSync(profile) && readProfile(readFileSync(profile)).text.replace(/\r\n/g, '\n').includes(`${BEGIN}\n${sourceLine(file.script, windows)}\n${END}`))
    return { installed, profiles, shell, ...(!installed ? { error: '命令接入配置已变化，请重新安装接入' } : {}) }
  } catch (error) { return { installed: false, profiles: [], shell, error: error instanceof Error ? error.message : '无法读取命令接入状态' } }
}

function writeAtomic(file: string, data: string | Buffer, mode = 0o600): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, data, { flag: 'wx', mode }); renameSync(temporary, file) }
  finally { if (existsSync(temporary)) unlinkSync(temporary) }
}

export function writeCodexLaunchConfig(options: CodexCommandOptions, statusUrl: string, token: string): void {
  const file = files(options)
  if (!existsSync(file.manifest)) return
  const executable = JSON.parse(readFileSync(file.manifest, 'utf8')).executable
  const config: CodexLaunchConfig = { version: 1, executable, statusUrl, token }
  writeAtomic(file.config, JSON.stringify(config, null, 2) + '\n')
  // Application updates may move the Electron runner; refresh our script without editing profiles.
  const script = Buffer.from(commandScript(options, executable))
  writeAtomic(file.script, (options.platform ?? process.platform) === 'win32' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), script]) : script, 0o700)
}

/** Only marked source blocks are changed; other profile contents survive install and removal. */
export function setCodexCommandIntegration(options: CodexCommandOptions, installed: boolean): void {
  const file = files(options)
  const windows = (options.platform ?? process.platform) === 'win32'
  const manifest = existsSync(file.manifest) ? JSON.parse(readFileSync(file.manifest, 'utf8')) : undefined
  const profiles: string[] = manifest?.profiles ?? profilePaths(options)
  const executable = installed ? options.executable ?? findCodexCommand(options.env, options.platform) : manifest?.executable
  if (installed && (!path.isAbsolute(executable) || !existsSync(executable))) throw new Error('Codex 原命令路径无效')
  const changes = profiles.map(profile => {
    const bytes = existsSync(profile) ? readFileSync(profile) : Buffer.alloc(0)
    const { bom, encoding, text: original } = readProfile(bytes)
    if (original.includes(BEGIN) !== original.includes(END)) throw new Error('Shell 配置中的灵动岛接入标记不完整，请修正后重试')
    const stripped = original.replace(blockPattern, '')
    if (installed && (windows ? /(?:function\s+(?:global:)?codex\b|(?:Set-Alias|New-Alias)\s+(?:-Name\s+)?codex\b)/i : /(?:function\s+codex\b|\bcodex\s*\(\)|\balias\s+codex=)/).test(stripped)) throw new Error('Shell 配置已定义自有 codex 命令，未覆盖；请先调整该命令')
    const next = installed ? `${stripped}\n${BEGIN}\n${sourceLine(file.script, windows)}\n${END}\n` : stripped
    return { profile, bytes, next: Buffer.concat([bom, Buffer.from(next, encoding)]) }
  })
  if (installed) {
    const script = Buffer.from(commandScript(options, executable))
    writeAtomic(file.script, windows ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), script]) : script, 0o700)
  }
  for (const change of changes) {
    if (change.bytes.equals(change.next)) continue
    if (existsSync(change.profile)) writeFileSync(`${change.profile}.cute-island-backup-${Date.now()}-${randomUUID().slice(0, 8)}`, change.bytes, { flag: 'wx', mode: 0o600 })
    writeAtomic(change.profile, change.next)
  }
  if (installed) writeAtomic(file.manifest, JSON.stringify({ version: 1, executable, profiles }, null, 2) + '\n')
  else for (const owned of [file.manifest, file.script, file.config]) if (existsSync(owned)) unlinkSync(owned)
}
