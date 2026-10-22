import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { BUILTIN_PLUGINS } from './plugins'
import type { AgentPlugin } from './types'

const execFileAsync = promisify(execFile)
const RUNTIMES = ['node', 'nodejs', 'bun']
/** Marks the end of one query's output on the resident shell's stdout. */
const SENTINEL = '@@CUTE_ISLAND_PROCESSES_END@@'
/** Printed instead of a snapshot when the query itself threw. */
const FAILED = '@@CUTE_ISLAND_PROCESSES_FAILED@@'
const QUERY_TIMEOUT_MS = 8000
/** Below QUERY_TIMEOUT_MS, so a hung WMI fails inside the shell instead of costing a new console. */
const CIM_TIMEOUT_S = 5

/** Kinds of agents with a running process, detected from executables and npm script paths. */
export async function listAgentProcesses(plugins: readonly AgentPlugin[] = BUILTIN_PLUGINS): Promise<Set<string>> {
  try { return (await listProcessSnapshot(plugins)).running } catch { return new Set() }
}

export interface ProcessInfo {
  pid: number
  parentPid: number
  name: string
  commandLine: string
  createdAt?: number
}

export interface ProcessSnapshot {
  running: Set<string>
  processes: ProcessInfo[]
}

/**
 * A long-lived PowerShell that answers repeated process queries.
 *
 * Spawning a fresh powershell.exe allocates and tears down a console host every
 * time, even with windowsHide. That churn steals activation, which closes IME
 * candidate windows and tray flyouts mid-interaction. One resident shell
 * allocates its console once and reuses it, and is ~2x faster per query.
 */
export class ResidentShell {
  private child?: ChildProcess
  private buffer = ''
  private pending?: { resolve: (text: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  private failures = 0
  private retryAt = 0

  constructor(private readonly launch: (command: string, args: string[]) => ChildProcess =
  (command, args) => spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), private readonly now = Date.now) {}

  /** Queries are serialized: one shell, one stdout stream, one answer at a time. */
  ask(script: string): Promise<string> {
    const run = this.queue.then(() => this.exchange(script), () => this.exchange(script))
    this.queue = run.catch(() => {})
    return run
  }

  dispose(): void {
    this.disposed = true
    this.settle(new Error('进程查询已停止'))
    this.kill()
  }

  private exchange(script: string): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('进程查询已停止'))
    if (!this.child && this.now() < this.retryAt) return Promise.reject(new Error('进程查询暂不可用，请稍后重试'))
    const child = this.ensure(script)
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A wedged shell must not stall every later scan; drop it and start over.
        this.failed(new Error('进程查询超时'))
        this.kill()
      }, QUERY_TIMEOUT_MS)
      timer.unref?.()
      this.pending = { resolve, reject, timer }
      try { child.stdin!.write('\n') } catch (error) {
        this.failed(error instanceof Error ? error : new Error('无法向进程查询发送指令'))
        this.kill()
      }
    })
  }

  private ensure(script: string): ChildProcess {
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child
    this.buffer = ''
    let child: ChildProcess
    try { child = this.launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', residentScript(script)]) }
    catch { this.failed(new Error('进程查询进程启动失败')); throw new Error('进程查询进程启动失败') }
    this.child = child
    child.stderr?.resume()
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { if (this.child === child) this.receive(chunk) })
    child.once('error', () => { if (this.child !== child) return; this.failed(new Error('进程查询进程启动失败')); this.kill() })
    child.once('exit', () => {
      if (this.child !== child) return
      this.failed(new Error('进程查询进程已退出'))
      this.child = undefined
    })
    return child
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    const at = this.buffer.indexOf(SENTINEL)
    if (at < 0) {
      // Never let a silent or runaway shell grow without bound.
      if (this.buffer.length > 8 * 1024 * 1024) { this.failed(new Error('进程查询返回内容过大')); this.kill() }
      return
    }
    const payload = this.buffer.slice(0, at)
    this.buffer = this.buffer.slice(at + SENTINEL.length).replace(/^\r?\n/, '')
    const pending = this.pending
    this.pending = undefined
    if (!pending) return
    this.failures = 0; this.retryAt = 0
    clearTimeout(pending.timer)
    // A failed query is not an empty process table; that would read as every agent exiting.
    if (payload.trim() === FAILED) pending.reject(new Error('进程查询失败'))
    else pending.resolve(payload)
  }

  private failed(error: Error): void {
    // A broken PowerShell must not allocate a new console host on every watcher tick.
    this.retryAt = this.now() + Math.min(30000, 3000 * 2 ** Math.min(this.failures++, 4))
    this.settle(error)
  }

  private settle(error: Error): void {
    const pending = this.pending
    this.pending = undefined
    if (!pending) return
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  private kill(): void {
    const child = this.child
    this.child = undefined
    this.buffer = ''
    if (!child) return
    try { child.stdin?.end() } catch { /* Already gone. */ }
    child.kill()
  }
}

/** Wrap a one-shot query in a read-a-line, answer, mark-the-end loop. */
export function residentScript(query: string): string {
  return `$ErrorActionPreference = 'Continue'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; `
    + `while ($null -ne [Console]::In.ReadLine()) { try { ${query} } catch { '${FAILED}' } ; `
    + `[Console]::Out.WriteLine('${SENTINEL}'); [Console]::Out.Flush() }`
}

let windowsShell = new ResidentShell()

/** Release the resident shell. Later queries start a new one. */
export function stopProcessQueries(): void {
  windowsShell.dispose()
  // Observation can be enabled again, and remote recovery also queries processes.
  windowsShell = new ResidentShell()
}

/** One query provides both liveness and the ancestry needed for session client labels. */
export async function listProcessSnapshot(plugins: readonly AgentPlugin[] = BUILTIN_PLUGINS): Promise<ProcessSnapshot> {
  if (process.platform !== 'win32') {
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 * 1024 })
    return processSnapshotFrom(stdout, process.platform, plugins)
  }
  const script = windowsSnapshotScript(plugins)
  // A failed query is not exit evidence. The watcher retains its previous snapshot;
  // allocating a fallback console here steals focus from terminal IME composition.
  const stdout = await windowsShell.ask(script)
  return processSnapshotFrom(stdout, process.platform, plugins)
}

function windowsSnapshotScript(plugins: readonly AgentPlugin[]): string {
  const names = [...new Set([...plugins.flatMap((plugin) => plugin.executables), ...RUNTIMES])]
  const pattern = `^(${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(\\.exe)?$`
  return `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process -OperationTimeoutSec ${CIM_TIMEOUT_S} | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; name = $_.Name; commandLine = $(if ($_.Name -match '${pattern.replace(/'/g, "''")}') { $_.CommandLine } else { '' }); createdAt = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }) } }) | ConvertTo-Json -Compress`
}

export function processSnapshotFrom(output: string, platform: string, plugins: readonly AgentPlugin[] = BUILTIN_PLUGINS): ProcessSnapshot {
  let processes: ProcessInfo[]
  if (platform === 'win32') {
    const data: unknown = JSON.parse(output.replace(/^\uFEFF/, '') || '[]')
    processes = (Array.isArray(data) ? data : [data]).flatMap((row) => {
      if (!row || !Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.parentPid) || typeof row.name !== 'string') return []
      const createdAt = typeof row.createdAt === 'string' ? Date.parse(row.createdAt) : NaN
      return [{ pid: row.pid, parentPid: row.parentPid, name: row.name, commandLine: typeof row.commandLine === 'string' ? row.commandLine : '',
        ...(Number.isFinite(createdAt) ? { createdAt } : {}) }]
    })
  } else {
    processes = output.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
      if (!match) return []
      const commandLine = match[3]
      const name = (commandLine.match(/^"([^"]+)"|^(\S+)/)?.slice(1).find(Boolean) ?? '').split('/').pop() ?? ''
      return [{ pid: Number(match[1]), parentPid: Number(match[2]), name, commandLine }]
    })
  }
  return { processes, running: matchAgentProcesses(processes.map((row) => row.commandLine || row.name).join('\n'), plugins) }
}

const CLIENT_PROCESSES: Record<string, string> = {
  code: 'VS Code', 'code - insiders': 'VS Code Insiders', cursor: 'Cursor', windsurf: 'Windsurf',
  windowsterminal: 'Windows Terminal', wezterm: 'WezTerm', 'wezterm-gui': 'WezTerm',
  alacritty: 'Alacritty', kitty: 'kitty', 'gnome-terminal-server': 'GNOME Terminal', konsole: 'Konsole',
  terminal: 'Terminal', iterm2: 'iTerm2', warp: 'Warp'
}
const SHELL_PROCESSES: Record<string, string> = { pwsh: 'PowerShell', powershell: 'PowerShell', cmd: 'cmd', bash: 'Bash', zsh: 'Zsh', fish: 'Fish' }

/** Only call with a PID bound to this particular native session. */
export function clientForProcess(pid: number, processes: readonly ProcessInfo[], byPid: ReadonlyMap<number, ProcessInfo> = new Map(processes.map((row) => [row.pid, row]))): string | undefined {
  const visited = new Set<number>()
  let current = byPid.get(pid)
  let shell: string | undefined
  while (current && visited.size < 32 && !visited.has(current.pid)) {
    visited.add(current.pid)
    const name = current.name.replace(/\.exe$/i, '').toLowerCase()
    if (CLIENT_PROCESSES[name]) return CLIENT_PROCESSES[name]
    shell ??= SHELL_PROCESSES[name]
    const parent = byPid.get(current.parentPid)
    // A recycled parent PID is not a client relationship.
    if (parent?.createdAt !== undefined && current.createdAt !== undefined && parent.createdAt > current.createdAt) break
    current = parent
  }
  return shell
}

/**
 * A session registration proves liveness only while its PID is still that same agent process.
 * A crashed CLI leaves its registration behind and the OS recycles PIDs, so the file alone is not evidence.
 */
export function registrationMatchesProcess(byPid: ReadonlyMap<number, ProcessInfo>, plugin: AgentPlugin, pid: number, updatedAt?: number): boolean {
  const info = byPid.get(pid)
  return !!info && !(updatedAt !== undefined && info.createdAt !== undefined && info.createdAt > updatedAt)
    && matchAgentProcesses(info.commandLine || info.name, [plugin]).has(plugin.kind)
}

export function matchAgentProcesses(output: string, plugins: readonly AgentPlugin[] = BUILTIN_PLUGINS): Set<string> {
  const found = new Set<string>()
  const executables = new Map(plugins.flatMap((plugin) => plugin.executables.map((name) => [name, plugin.kind] as const)))
  for (const line of output.split(/\r?\n/)) {
    const tokens = line.trim().match(/"[^"]*"|'[^']*'|[^\s,]+/g) ?? []
    const command = (tokens[0] ?? '').replace(/^["']|["']$/g, '')
    const executable = command.split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase() ?? ''
    const direct = executables.get(executable)
    if (direct) found.add(direct)
    if (!RUNTIMES.includes(executable)) continue
    // Inspect only the script argument, never task text that happens to mention an agent.
    const script = tokens.slice(1).find((token) => !token.startsWith('-'))?.replace(/^["']|["']$/g, '').replace(/\\/g, '/') ?? ''
    for (const plugin of plugins) {
      if (plugin.scripts?.some((scriptPattern) => scriptPattern.test(script))) found.add(plugin.kind)
    }
  }
  return found
}
