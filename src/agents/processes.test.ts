import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { ResidentShell, clientForProcess, processSnapshotFrom, residentScript, type ProcessInfo } from './processes'

const proc = (pid: number, parentPid: number, name: string, commandLine = ''): ProcessInfo => ({ pid, parentPid, name, commandLine })

/** A stand-in for the resident PowerShell: records prompts, emits replies on demand. */
function fakeShell() {
  const spawns: Array<{ args: string[]; prompts: number; child: EventEmitter & Partial<ChildProcess>; say: (text: string) => void }> = []
  const launch = (_command: string, args: string[]): ChildProcess => {
    const child = new EventEmitter() as EventEmitter & Partial<ChildProcess>
    const stdout = new EventEmitter()
    const entry = { args, prompts: 0, child, say: (text: string) => stdout.emit('data', text) }
    Object.assign(child, {
      stdout: Object.assign(stdout, { setEncoding() {} }),
      stderr: Object.assign(new EventEmitter(), { resume() {} }),
      stdin: { write: () => { entry.prompts += 1; return true }, end() {} },
      exitCode: null,
      killed: false,
      kill: () => { Object.assign(child, { killed: true }); child.emit('exit', 0); return true }
    })
    spawns.push(entry)
    return child as ChildProcess
  }
  return { spawns, launch }
}

const END = '@@CUTE_ISLAND_PROCESSES_END@@'
const FAILED = '@@CUTE_ISLAND_PROCESSES_FAILED@@'
/** Queries are queued, so the shell starts on a later microtask than the call. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('resident process query shell', () => {
  it('backs off repeated shell crashes and ignores late output from the replaced process', async () => {
    const { spawns, launch } = fakeShell()
    const now = vi.fn(() => 1000)
    const shell = new ResidentShell(launch, now)
    const first = shell.ask('Q')
    const rejected = expect(first).rejects.toThrow('已退出')
    await settled()
    spawns[0].child.emit('exit', 1)
    await rejected
    await expect(shell.ask('Q')).rejects.toThrow('稍后重试')
    expect(spawns).toHaveLength(1)
    now.mockReturnValue(4000)
    const next = shell.ask('Q')
    await settled()
    expect(spawns).toHaveLength(2)
    spawns[0].say('old' + END + '\n')
    spawns[0].child.emit('exit', 1)
    spawns[1].say('new' + END + '\n')
    expect(await next).toBe('new')
    shell.dispose()
  })
  it('reuses one shell across queries and reassembles answers split across chunks', async () => {
    const { spawns, launch } = fakeShell()
    const shell = new ResidentShell(launch, () => 1000)
    const first = shell.ask('Q')
    await settled()
    expect(spawns).toHaveLength(1)
    // A chunk boundary may fall anywhere, including inside the sentinel.
    spawns[0].say('[{"pid":1}')
    spawns[0].say(']' + END.slice(0, 5))
    spawns[0].say(END.slice(5) + '\n')
    expect(await first).toBe('[{"pid":1}]')
    const second = shell.ask('Q')
    await settled()
    spawns[0].say('[{"pid":2}]' + END + '\n')
    expect(await second).toBe('[{"pid":2}]')
    // Still the same console host: no second spawn.
    expect(spawns).toHaveLength(1)
    expect(spawns[0].prompts).toBe(2)
    shell.dispose()
  })

  it('starts a new shell after the old one dies, and rejects what was in flight', async () => {
    const { spawns, launch } = fakeShell()
    let now = 1000
    const shell = new ResidentShell(launch, () => now)
    const pending = shell.ask('Q')
    await settled()
    spawns[0].child.emit('exit', 1)
    await expect(pending).rejects.toThrow('已退出')
    now += 3000
    const next = shell.ask('Q')
    await settled()
    expect(spawns).toHaveLength(2)
    spawns[1].say('[{"pid":2}]' + END + '\n')
    expect(await next).toBe('[{"pid":2}]')
    shell.dispose()
    await expect(shell.ask('Q')).rejects.toThrow('已停止')
  })

  it('wraps a query in a read-answer-mark loop that survives a failing query', () => {
    const script = residentScript('Get-Thing')
    expect(script).toContain('while ($null -ne [Console]::In.ReadLine())')
    // A throwing query must still print the sentinel, or the reader waits forever.
    expect(script).toContain(`try { Get-Thing } catch { '${FAILED}' }`)
    expect(script).not.toContain("catch { '[]' }")
    expect(script.indexOf(END)).toBeGreaterThan(script.indexOf('Get-Thing'))
  })

  it('rejects a failed query without reporting an empty process table or replacing the shell', async () => {
    const { spawns, launch } = fakeShell()
    const shell = new ResidentShell(launch, () => 1000)
    const failed = shell.ask('Q')
    await settled()
    spawns[0].say(FAILED + '\r\n' + END + '\n')
    await expect(failed).rejects.toThrow('进程查询失败')
    // A hung WMI ends inside the shell; the console host stays, and the next query is answered at once.
    const next = shell.ask('Q')
    await settled()
    spawns[0].say('[{"pid":3}]' + END + '\n')
    expect(await next).toBe('[{"pid":3}]')
    expect(spawns).toHaveLength(1)
    shell.dispose()
  })
})

describe('session client process evidence', () => {
  it('detects desktop Cursor without treating arbitrary command arguments as a host', () => {
    expect(processSnapshotFrom(JSON.stringify([proc(11, 0, 'Cursor.exe')]), 'win32').running.has('cursor')).toBe(true)
    expect(processSnapshotFrom(' 11 1 "/Applications/Cursor.app/Contents/MacOS/Cursor"\n', 'darwin').running.has('cursor')).toBe(true)
    expect(processSnapshotFrom(' 11 1 node unrelated.js Cursor.exe\n', 'linux').running.has('cursor')).toBe(false)
  })
  it('keeps simultaneous hosts of the same agent separate and prefers the host over its shell', () => {
    const processes = [proc(1, 2, 'claude.exe'), proc(2, 3, 'pwsh.exe'), proc(3, 0, 'WindowsTerminal.exe'),
      proc(4, 5, 'claude.exe'), proc(5, 0, 'Code.exe'), proc(6, 7, 'claude.exe'), proc(7, 0, 'Cursor.exe'),
      proc(8, 9, 'codex.exe'), proc(9, 0, 'powershell.exe'), proc(10, 0, 'claude.exe')]
    expect([1, 4, 6, 8, 10].map((pid) => clientForProcess(pid, processes)))
      .toEqual(['Windows Terminal', 'VS Code', 'Cursor', 'PowerShell', undefined])
    expect(clientForProcess(999, processes)).toBeUndefined()
  })

  it('rejects recycled parent PIDs and terminates cyclic ancestry', () => {
    expect(clientForProcess(1, [{ ...proc(1, 2, 'claude.exe'), createdAt: 100 }, { ...proc(2, 0, 'Code.exe'), createdAt: 200 }])).toBeUndefined()
    expect(clientForProcess(1, [proc(1, 2, 'claude.exe'), proc(2, 1, 'unknown.exe')])).toBeUndefined()
  })

  it('reads Windows CIM snapshots and preserves executable fallback when command lines are unavailable', () => {
    const rows = [proc(1, 2, 'claude.exe'), proc(2, 0, 'Code.exe'),
      proc(3, 0, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"')]
    const snapshot = processSnapshotFrom('\uFEFF' + JSON.stringify(rows), 'win32')
    expect([...snapshot.running].sort()).toEqual(['claude', 'codex'])
    expect(clientForProcess(1, snapshot.processes)).toBe('VS Code')
    expect(processSnapshotFrom(JSON.stringify(rows[0]), 'win32').processes).toHaveLength(1)
    expect(processSnapshotFrom('null', 'win32').processes).toEqual([])
  })

  it('reads Unix process ancestry without using command arguments as client names', () => {
    const snapshot = processSnapshotFrom('  10 20 /usr/bin/claude\n 20 30 /bin/bash\n 30 1 /usr/bin/konsole\n 40 1 node unrelated.js Code.exe\n', 'linux')
    expect([...snapshot.running]).toEqual(['claude'])
    expect(clientForProcess(10, snapshot.processes)).toBe('Konsole')
    expect(clientForProcess(40, snapshot.processes)).toBeUndefined()
  })
})
