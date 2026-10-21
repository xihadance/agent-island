import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { spawn, ChildProcess, SpawnOptions } from 'node:child_process'
import WebSocket from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { ActivityStore } from '../shared/activity'
import { startStatusServer } from '../main/server'
import { createControlRuntime } from './runtime'
import { hookSessionId } from './hooks'
import { runClaudeChannel, runClaudeTerminal } from './claude-terminal'
import type { RemoteConfig } from './config'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
const nativeId = '01234567-89ab-cdef-0123-456789abcdef'
const sessionId = hookSessionId('claude', nativeId)
async function fixture() {
  const activities = new ActivityStore()
  cleanups.push(() => activities.dispose())
  const config: RemoteConfig = { mode: 'takeover', enabled: true, port: 17321, stateFile: '', controlToken: 'x'.repeat(32), channels: [], codex: [] }
  const runtime = createControlRuntime(config, activities)
  cleanups.push(() => runtime.close())
  await runtime.start()
  const server = await startStatusServer(activities, { port: 0, token: 'status-only', control: runtime })
  cleanups.push(() => server.close())
  config.port = server.port
  const url = `ws://127.0.0.1:${server.port}/v1/control/terminal?session=${nativeId}&cwd=${encodeURIComponent(process.cwd())}`
  const connect = async (headers = { authorization: `Bearer ${config.controlToken}` }) => {
    const socket = new WebSocket(url, { headers })
    cleanups.push(() => socket.terminate())
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    return socket
  }
  const channel = () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const messages: Record<string, any>[] = []
    let buffer = ''
    stdout.on('data', bytes => {
      buffer += bytes.toString()
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1) }
    })
    const running = runClaudeChannel(config, nativeId, process.cwd(), stdin, stdout)
    cleanups.push(async () => { stdin.end(); await running })
    const rpc = (id: number, method: string, params: unknown) => stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    const initialize = async () => {
      rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })
      await vi.waitFor(() => expect(messages.find(message => message.id === 1)?.result.capabilities.experimental).toEqual({ 'claude/channel': {} }))
      stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      await vi.waitFor(() => expect(runtime.hub.store.sessions()[0]?.connected).toBe(true))
    }
    return { stdin, messages, running, rpc, initialize }
  }
  const hook = (name: string) => runtime.hooks.handle({ agent: 'claude', invocationId: name,
    event: { session_id: nativeId, cwd: process.cwd(), hook_event_name: name, error: 'api_error', error_details: 'fixture' } })
  return { config, runtime, activities, server, connect, channel, hook }
}

it('delivers remote continuation to the same native MCP channel and waits for Agent confirmation', async () => {
  const f = await fixture()
  const c = f.channel()
  await c.initialize()
  f.hook('StopFailure')
  const request = f.runtime.hub.store.requests()[0]
  expect(request.actions).toContain('resume')
  await f.runtime.hub.resume(request.id, request.revision, 'owner', '核对已有结果后继续')
  await vi.waitFor(() => expect(c.messages.some(message => message.method === 'notifications/claude/channel')).toBe(true))
  const notification = c.messages.find(message => message.method === 'notifications/claude/channel')!
  expect(notification.params).toEqual({ content: '核对已有结果后继续', meta: { message_id: request.id } })
  expect(f.runtime.hub.store.get(request.id).status).toBe('submitted')
  c.rpc(2, 'tools/call', { name: 'confirm_receipt', arguments: { message_id: request.id } })
  await vi.waitFor(() => expect(f.runtime.hub.store.get(request.id).status).toBe('resolved'))
  expect(f.runtime.hub.store.sessions()).toHaveLength(1)
  expect(f.runtime.hub.store.sessions()[0]).toMatchObject({ nativeId, terminal: true, turnId: request.id })
  expect(c.messages.find(message => message.id === 2)?.result.isError).not.toBe(true)
})

it('keeps remote approvals available while a native message is waiting for its receipt', async () => {
  const f = await fixture()
  const c = f.channel()
  await c.initialize()
  const message = await f.runtime.hub.send(sessionId, '执行测试', 'owner')
  expect(message.status).toBe('submitted')
  await vi.waitFor(() => expect(c.messages.some(row => row.method === 'notifications/claude/channel')).toBe(true))
  expect(f.hook('UserPromptSubmit').output).toEqual({})
  expect(f.runtime.hub.store.snapshot().guidance[0].status).toBe('submitted')
  const reply = f.runtime.hooks.handle({ agent: 'claude', invocationId: 'approval', event: {
    session_id: nativeId, cwd: process.cwd(), hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' }
  } })
  const approval = f.runtime.hub.store.get(reply.requestId!)
  await f.runtime.hub.respond(approval.id, approval.revision, { action: 'approve' }, 'owner')
  expect(f.runtime.hooks.poll(approval.id, 'approval').decision).toEqual({ action: 'approve' })
  c.rpc(3, 'tools/call', { name: 'confirm_receipt', arguments: { message_id: message.id } })
  await vi.waitFor(() => expect(f.runtime.hub.store.snapshot().guidance[0].status).toBe('resolved'))
})

it('rejects unknown receipt IDs and never marks transport delivery as receipt', async () => {
  const f = await fixture()
  const c = f.channel()
  await c.initialize()
  const message = await f.runtime.hub.send(sessionId, '继续', 'owner')
  c.rpc(2, 'tools/call', { name: 'confirm_receipt', arguments: { message_id: 'unknown' } })
  await vi.waitFor(() => expect(c.messages.find(message => message.id === 2)?.error).toBeDefined())
  expect(f.runtime.hub.store.snapshot().guidance[0]).toMatchObject({ id: message.id, status: 'submitted' })
})

it.each([{ authorization: 'Bearer status-only' }, { authorization: 'Bearer wrong' }, { authorization: `Bearer ${'x'.repeat(32)}`, origin: 'https://example.com' }])('rejects a terminal connection with unauthorized headers %j', async headers => {
  const f = await fixture()
  await expect(f.connect(headers)).rejects.toThrow('403')
  expect(f.runtime.hub.store.sessions()).toHaveLength(0)
})

it('does not replay an uncertain message after disconnect, Hook refresh, or takeover restart', async () => {
  const f = await fixture()
  const c = f.channel()
  await c.initialize()
  await f.runtime.hub.send(sessionId, '执行一次', 'owner')
  await vi.waitFor(() => expect(c.messages.some(message => message.method === 'notifications/claude/channel')).toBe(true))
  c.stdin.end()
  await c.running
  await vi.waitFor(() => expect(f.runtime.hub.store.snapshot().guidance[0].status).toBe('uncertain'))
  f.hook('StopFailure')
  expect(f.runtime.hub.store.sessions()[0]).toMatchObject({ terminal: true, connected: false })
  expect(f.runtime.hub.recoveryActions(sessionId)).toEqual(['ack'])
  f.runtime.setEnabled(false)
  f.runtime.setEnabled(true)
  const second = f.channel()
  await second.initialize()
  second.rpc(2, 'tools/list', {})
  await vi.waitFor(() => expect(second.messages.some(message => message.id === 2)).toBe(true))
  expect(second.messages.some(message => message.method === 'notifications/claude/channel')).toBe(false)
})

it('closes live terminal sockets when the status server stops and refuses duplicate native connections', async () => {
  const f = await fixture()
  const first = await f.connect()
  const duplicate = await f.connect()
  await vi.waitFor(() => expect(duplicate.readyState).toBe(WebSocket.CLOSED))
  expect(f.runtime.hub.store.sessions()).toHaveLength(1)
  await f.server.close()
  await vi.waitFor(() => expect(first.readyState).toBe(WebSocket.CLOSED))
})

function launcherFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'island-native-cli-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code')
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, 'cli.js'), '')
  const file = path.join(dir, 'remote.json')
  writeFileSync(file, JSON.stringify({ mode: 'takeover', enabled: true, port: 17321, controlToken: 'x'.repeat(32), channels: [], codex: [] }))
  const child = new EventEmitter() as ChildProcess
  child.kill = vi.fn(() => true)
  const calls: { args: string[]; options: SpawnOptions }[] = []
  const launch = ((_: string, args: string[], options: SpawnOptions) => {
    calls.push({ args, options })
    queueMicrotask(() => child.emit('exit', 0))
    return child
  }) as typeof spawn
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  return { file, calls, launch, env: { PATH: dir, CUTE_ISLAND_REMOTE_CONFIG: file } }
}

it('launches the original interactive CLI with inherited terminal and a single literal native session ID', async () => {
  const f = launcherFixture()
  expect(await runClaudeTerminal(['--resume', nativeId, '中文 $(literal)'], f.env, f.launch)).toBe(0)
  const { args, options } = f.calls[0]
  expect(args).toContain('--dangerously-load-development-channels')
  expect(args).not.toContain('--print')
  expect(options).toMatchObject({ stdio: 'inherit', shell: false, windowsHide: true })
  const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers['cute-island']
  expect(mcp.args).toContain(nativeId)
  expect(args.indexOf('中文 $(literal)')).toBeLessThan(args.indexOf('--dangerously-load-development-channels'))
  expect(args.slice(-2)).toEqual(['--dangerously-load-development-channels', 'server:cute-island'])
})

it('keeps literal prompt arguments after the option terminator', async () => {
  const f = launcherFixture()
  await runClaudeTerminal(['--', '--print'], f.env, f.launch)
  const args = f.calls[0].args
  expect(args.slice(-2)).toEqual(['--', '--print'])
  expect(args.indexOf('server:cute-island')).toBeLessThan(args.indexOf('--'))
})

it('rejects stale native recovery when a newer local prompt is executing', async () => {
  const f = await fixture()
  const c = f.channel()
  await c.initialize()
  f.hook('StopFailure')
  const request = f.runtime.hub.store.requests()[0]
  f.hook('UserPromptSubmit')
  await expect(f.runtime.hub.resume(request.id, request.revision, 'owner')).rejects.toThrow()
  expect(c.messages.some(message => message.method === 'notifications/claude/channel')).toBe(false)
})

it.each([['--print=prompt'], ['-phello'], ['-cp'], ['--continue'], ['--bg'], ['--fork-session'], ['--resume'], ['-rpartial'], ['--resume', 'last'], ['--session-id', nativeId, '--resume', nativeId]].map(args => ({ args })))('refuses ambiguous or noninteractive native launch $args', async ({ args }) => {
  const f = launcherFixture()
  await expect(runClaudeTerminal(args, f.env, f.launch)).rejects.toThrow()
  expect(f.calls).toHaveLength(0)
})
