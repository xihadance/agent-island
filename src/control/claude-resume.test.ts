import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { checkClaudeRecovery, ClaudeRecoveryRunner } from './claude-resume'
import { listProcessSnapshot } from '../agents/processes'
import type { ControlSession } from './types'

vi.mock('../agents/processes', async (original) => ({ ...(await original<object>()), listProcessSnapshot: vi.fn(async () => ({ running: new Set(), processes: [] })) }))
const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).reverse().forEach(close => close()); vi.clearAllMocks() })
const session: ControlSession = { id: 's', nativeId: '01234567-89ab-cdef-0123-456789abcdef', agent: 'claude', adapter: 'hook', connected: false, label: '项目', lastSeenAt: 1, capabilities: [], cwd: path.resolve('原项目') }
function processFixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 456, kill: vi.fn() })
  const launch = vi.fn(() => child as unknown as ChildProcess)
  const failed = vi.fn()
  const runner = new ClaudeRecoveryRunner(failed, launch)
  cleanup.push(() => runner.close())
  return { child, launch, failed, runner }
}

it('resumes the exact Claude ID in its original directory and sends unicode text over stdin without a shell', async () => {
  const { child, launch, runner } = processFixture()
  const text = '继续 🧪\n"引号" $HOME `whoami` & echo secret'
  const result = runner.start(session, text, { executable: 'claude.exe', args: [] })
  let stdin = ''
  child.stdin.on('data', chunk => { stdin += chunk.toString() })
  child.emit('spawn')
  expect(launch).toHaveBeenCalledWith('claude.exe', expect.arrayContaining(['--resume', session.nativeId, '--print', '--replay-user-messages']), expect.objectContaining({ cwd: session.cwd, shell: false, windowsHide: true }))
  expect(launch.mock.calls[0]).not.toContain(text)
  expect(JSON.parse(stdin)).toMatchObject({ session_id: session.nativeId, message: { role: 'user', content: text } })
  expect(runner.isRunning(session.nativeId)).toBe(true)
  const output = Buffer.from(JSON.stringify({ type: 'user', session_id: session.nativeId, message: { content: [{ type: 'text', text }] } }) + '\n')
  const split = output.indexOf(Buffer.from('🧪')) + 1
  child.stdout.write(output.subarray(0, split))
  child.stdout.write(output.subarray(split))
  await result
  child.emit('close', 0)
  expect(runner.isRunning(session.nativeId)).toBe(false)
})

it('requires native acknowledgement and reports a later process failure as another recoverable event', async () => {
  const { child, runner, failed } = processFixture()
  const result = runner.start(session, '继续', { executable: 'claude.exe', args: [] })
  const accepted = vi.fn()
  void result.then(accepted)
  child.stdout.write('null\nnot-json\n')
  child.stdout.write(JSON.stringify({ type: 'user', session_id: session.nativeId, message: { content: [null] } }) + '\n')
  child.stdout.write(JSON.stringify({ type: 'user', session_id: 'other', message: { content: '继续' } }) + '\n')
  child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: session.nativeId }) + '\n')
  await Promise.resolve()
  expect(accepted).not.toHaveBeenCalled()
  child.stdout.write(JSON.stringify({ type: 'user', session_id: session.nativeId, message: { content: '继续' } }) + '\n')
  await result
  child.emit('close', 1)
  expect(failed).toHaveBeenCalledWith(session, expect.stringContaining('456:'), expect.stringContaining('退出码：1'))
})

it('retains native failure reasons from a final JSON row without a newline and a bounded stderr tail', async () => {
  const { child, runner, failed } = processFixture()
  const result = runner.start(session, '继续', { executable: 'claude.exe', args: [] })
  child.stdout.write(JSON.stringify({ type: 'user', session_id: session.nativeId, message: { content: '继续' } }) + '\n')
  await result
  child.stderr.write('x'.repeat(20000) + '\n代理连接失败 🧪')
  child.stdout.write(JSON.stringify({ type: 'result', session_id: session.nativeId, is_error: true, errors: ['认证已失效', '重试失败'] }))
  child.emit('close', 0)
  expect(failed).toHaveBeenCalledOnce()
  const detail = failed.mock.calls[0][2] as string
  expect(detail).toContain('认证已失效')
  expect(detail).toContain('重试失败')
  expect(detail).toContain('代理连接失败 🧪')
  expect(detail.length).toBeLessThan(16000)
})

it('rejects a child that exits before acknowledgement and closes only its own recovery processes', async () => {
  const { child, runner, failed } = processFixture()
  const result = runner.start(session, '继续', { executable: 'claude.exe', args: [] })
  const rejection = expect(result).rejects.toThrow('已停止')
  runner.close()
  await rejection
  child.emit('close', 1)
  expect(child.kill).toHaveBeenCalledTimes(1)
  expect(failed).not.toHaveBeenCalled()
})

function transcriptFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'island-claude-resume-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const root = path.join(dir, '.claude')
  const project = path.join(root, 'projects', 'project')
  mkdirSync(project, { recursive: true })
  const file = path.join(project, `${session.nativeId}.jsonl`)
  const local = { ...session, cwd: dir }
  const configFile = path.join(dir, 'remote.json')
  writeFileSync(file, [
    { type: 'user', sessionId: session.nativeId, cwd: dir, message: { role: 'user', content: '实现功能' } },
    { type: 'assistant', sessionId: session.nativeId, cwd: dir, isApiErrorMessage: true, message: { role: 'assistant', content: 'API 请求失败' } }
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ hooks: Object.fromEntries(['PreToolUse', 'PermissionRequest'].map(event => [event, [{ hooks: [{ type: 'command', command: `"cute-island-remote-hook.cmd" --config "${configFile}"` }] }]])) }))
  return { root, file, local, configFile, env: { ...process.env, CLAUDE_CONFIG_DIR: root } }
}

it('runs the actual hidden subprocess transport with literal arguments and a simulated native acknowledgement', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "island-resume 空格 '"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const script = path.join(dir, 'native.cjs')
  writeFileSync(script, `const assert = require('node:assert/strict')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => input += chunk)
process.stdin.on('end', () => {
  const row = JSON.parse(input)
  assert.equal(process.argv[process.argv.indexOf('--resume') + 1], row.session_id)
  assert.equal(process.argv.includes('--dangerously-skip-permissions'), false)
  process.stdout.write(JSON.stringify(row) + '\\n')
})
`)
  const runner = new ClaudeRecoveryRunner(vi.fn())
  cleanup.push(() => runner.close())
  await runner.start({ ...session, cwd: dir }, '继续 "引号" 🧪\n$(whoami) `cmd` & echo', { executable: process.execPath, args: [script] })
  await vi.waitFor(() => expect(runner.isRunning(session.nativeId)).toBe(false))
})

it('validates the original Claude transcript, directory and configured native Hooks before spawning', async () => {
  const { local, env, configFile } = transcriptFixture()
  await expect(checkClaudeRecovery(local, configFile, env)).resolves.toBeUndefined()
  await expect(checkClaudeRecovery(local, 'different-config', env)).rejects.toThrow('Hook')
  await expect(checkClaudeRecovery({ ...local, nativeId: '../../other' }, configFile, env)).rejects.toThrow('ID 无效')
  await expect(checkClaudeRecovery({ ...local, cwd: path.join(local.cwd!, 'missing') }, configFile, env)).rejects.toThrow('工作目录不存在')
})

it('ignores recycled PIDs and idle registrations but still blocks a busy session', async () => {
  const { root, local, configFile, env } = transcriptFixture()
  mkdirSync(path.join(root, 'sessions'), { recursive: true })
  const registration = path.join(root, 'sessions', `${process.pid}.json`)
  writeFileSync(registration, JSON.stringify({ pid: process.pid, sessionId: session.nativeId, status: 'idle' }))
  const recycled = { pid: process.pid, parentPid: 1, name: 'pwsh.exe', commandLine: 'pwsh.exe -NoProfile', createdAt: Date.now() + 600000 }
  vi.mocked(listProcessSnapshot).mockResolvedValueOnce({ running: new Set(), processes: [recycled] })
  await expect(checkClaudeRecovery(local, configFile, env)).resolves.toBeUndefined()
  // A closed VS Code conversation leaves an idle peer whose command line still carries the resume id.
  const idlePeer = { pid: process.pid, parentPid: 1, name: 'claude.exe', commandLine: `claude.exe --output-format stream-json --resume=${session.nativeId}`, createdAt: Date.now() - 600000 }
  vi.mocked(listProcessSnapshot).mockResolvedValueOnce({ running: new Set(['claude']), processes: [idlePeer] })
  await expect(checkClaudeRecovery(local, configFile, env)).resolves.toBeUndefined()
  writeFileSync(registration, JSON.stringify({ pid: process.pid, sessionId: session.nativeId, status: 'busy' }))
  vi.mocked(listProcessSnapshot).mockResolvedValueOnce({ running: new Set(['claude']), processes: [idlePeer] })
  await expect(checkClaudeRecovery(local, configFile, env)).rejects.toThrow('正在运行中')
})

it('blocks a competing agent process but ignores unrelated processes that merely mention the id', async () => {
  const { local, configFile, env } = transcriptFixture()
  vi.mocked(listProcessSnapshot).mockResolvedValueOnce({ running: new Set(), processes: [{ pid: 999, parentPid: 1, name: 'Code.exe', commandLine: `Code.exe C:\\logs\\${session.nativeId}.jsonl`, createdAt: Date.now() - 1000 }] })
  await expect(checkClaudeRecovery(local, configFile, env)).resolves.toBeUndefined()
  vi.mocked(listProcessSnapshot).mockResolvedValueOnce({ running: new Set(['claude']), processes: [{ pid: 999, parentPid: 1, name: 'claude.exe', commandLine: `claude.exe --resume ${session.nativeId}`, createdAt: Date.now() - 1000 }] })
  await expect(checkClaudeRecovery(local, configFile, env)).rejects.toThrow('请勿重复恢复')
})

it('rejects a live process or a transcript that has already continued', async () => {
  const { local, file, configFile, env } = transcriptFixture()
  vi.mocked(listProcessSnapshot).mockResolvedValueOnce({ running: new Set(['claude']), processes: [{ pid: 123, parentPid: 1, name: 'claude', commandLine: `claude --resume ${session.nativeId}` }] })
  await expect(checkClaudeRecovery(local, configFile, env)).rejects.toThrow('仍在运行')
  writeFileSync(file, JSON.stringify({ type: 'user', sessionId: session.nativeId, cwd: local.cwd, message: { role: 'user', content: '已经继续了' } }) + '\n')
  await expect(checkClaudeRecovery(local, configFile, env)).rejects.toThrow('已继续')
})

it('accepts a turn that went silent without a live process, but not one that just continued', async () => {
  const { local, file, configFile, env } = transcriptFixture()
  writeFileSync(file, JSON.stringify({ type: 'user', sessionId: session.nativeId, cwd: local.cwd, message: { role: 'user', content: '[Your previous response had no visible output. Please continue and produce a user-visible response.]' } }) + '\n')
  await expect(checkClaudeRecovery(local, configFile, env)).rejects.toThrow('中断状态')
  const past = new Date(Date.now() - 120000)
  utimesSync(file, past, past)
  await expect(checkClaudeRecovery(local, configFile, env)).resolves.toBeUndefined()
})
