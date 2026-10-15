import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { ActivityStore } from '../shared/activity'
import { startStatusServer } from '../main/server'
import { initRemoteConfig, readRemoteConfig, saveRemoteEnabled } from './config'
import { runRemoteCli } from './cli'
import { createControlRuntime } from './runtime'
import { ControlStore } from './store'
import { ControlHub } from './hub'
import type { ChannelAdapter, RemoteMessage } from './types'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function configFile() {
  const dir = mkdtempSync(path.join(tmpdir(), 'island-toggle-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'remote.json')
  initRemoteConfig(file)
  return file
}
async function setup(enabled = false) {
  const file = configFile()
  saveRemoteEnabled(file, enabled)
  const activities = new ActivityStore()
  cleanup.push(() => activities.dispose())
  // Bind first so the configured port and the actual port agree for hot reload.
  let runtime: ReturnType<typeof createControlRuntime> | undefined
  const server = await startStatusServer(activities, { port: 0, control: () => runtime })
  cleanup.push(() => server.close())
  const config = { ...JSON.parse(readFileSync(file, 'utf8')), port: server.port }
  writeFileSync(file, JSON.stringify(config))
  runtime = createControlRuntime(readRemoteConfig(file)!, activities, { configFile: file })
  cleanup.push(() => runtime!.close())
  await runtime.start()
  const url = `http://127.0.0.1:${server.port}`
  const api = (endpoint: string, body?: unknown, token = config.controlToken) => fetch(`${url}/v1/control${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { file, config, activities, runtime, api, url }
}
const event = { session_id: 'native', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } }

describe('persistent takeover switch', () => {
  it('initializes off, preserves all configuration on toggle, and supports legacy opt-in files', () => {
    const file = configFile()
    expect(readRemoteConfig(file)?.enabled).toBe(false)
    expect(() => initRemoteConfig(file)).toThrow()
    const original = { ...JSON.parse(readFileSync(file, 'utf8')), futureSetting: { keep: 'value' } }
    writeFileSync(file, JSON.stringify(original))
    saveRemoteEnabled(file, true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...original, enabled: true })
    delete original.enabled
    writeFileSync(file, JSON.stringify(original))
    expect(readRemoteConfig(file)?.enabled).toBe(true)
    writeFileSync(file, JSON.stringify({ ...original, enabled: 'false' }))
    expect(() => readRemoteConfig(file)).toThrow('布尔值')
  })

  it('switches without restarting HTTP, enforces authentication, and leaves activity observation intact', async () => {
    const { runtime, api, file, url, activities } = await setup()
    expect(runtime.status()).toEqual({ enabled: false, running: false })
    activities.upsert({ id: 'observed', state: 'error', title: '需要处理' })
    expect(runtime.hub.store.snapshot().requests).toHaveLength(0)
    expect((await api('/enabled', { enabled: true }, 'wrong')).status).toBe(401)
    expect((await api('/enabled', { enabled: 'true' })).status).toBe(400)
    expect(await (await api('/enabled', { enabled: true })).json()).toEqual({ enabled: true, running: true })
    expect(readRemoteConfig(file)?.enabled).toBe(true)
    expect(runtime.hub.store.snapshot().requests).toHaveLength(1)
    expect(await (await api('/enabled', { enabled: false })).json()).toEqual({ enabled: false, running: false })
    expect(readRemoteConfig(file)?.enabled).toBe(false)
    expect((await fetch(`${url}/v1/activities`)).status).toBe(200)
    expect((await (await api('')).json()).control).toEqual({ enabled: false, running: false })
    const hook = await (await api('/hook', { agent: 'claude', invocationId: 'off', event })).json()
    expect(hook).toEqual({ output: {} })
    expect(runtime.hub.store.snapshot().requests.filter(r => r.origin === 'hook')).toHaveLength(0)
    expect((await api('/messages', { sessionId: 'anything', text: '旧指导' })).status).toBe(409)
  })

  it('releases in-flight Hooks, cancels unsent guidance, and rejects stale replies after fast re-enable', async () => {
    const { file, runtime, api } = await setup(true)
    const stdout = vi.fn()
    const run = runRemoteCli(['hook', '--agent', 'claude', '--config', file], {
      stdout, stderr: vi.fn(), stdin: async () => JSON.stringify(event)
    })
    await vi.waitFor(() => expect(runtime.hub.store.snapshot().requests).toHaveLength(1))
    const r = runtime.hub.store.snapshot().requests[0]
    await runtime.hub.respond(r.id, r.revision, { action: 'approve' }, 'owner')
    const guidance = await runtime.hub.send(r.sessionId, '不要在下次开启时执行', 'owner')
    runtime.setEnabled(false)
    runtime.setEnabled(true)
    expect(await run).toBe(0)
    expect(JSON.parse(stdout.mock.calls[0][0])).toEqual({})
    expect(runtime.hub.store.get(r.id)).toMatchObject({ status: 'cancelled', released: true })
    expect(runtime.hub.store.snapshot().guidance.find(m => m.id === guidance.id)?.status).toBe('cancelled')
    expect((await api(`/requests/${r.id}/respond`, { revision: r.revision, decision: { action: 'approve' } })).status).toBe(409)
    const next = runtime.hooks.handle({ agent: 'claude', invocationId: 'new', event })
    expect(next.requestId).not.toBe(r.id)
    const context = runtime.hooks.handle({ agent: 'claude', invocationId: 'post', event: { ...event, hook_event_name: 'PostToolUse' } })
    expect(context.output).toEqual({})
  })

  it('keeps already-submitted results uncertain and persists a disabled restart', async () => {
    const { file, runtime, activities } = await setup(true)
    const r = runtime.hooks.handle({ agent: 'claude', invocationId: 'submitted', event })
    await runtime.hub.respond(r.requestId!, 1, { action: 'approve' }, 'owner')
    runtime.hooks.poll(r.requestId!, 'submitted')
    runtime.setEnabled(false)
    expect(runtime.hub.store.get(r.requestId!).status).toBe('uncertain')
    runtime.close()
    const restarted = createControlRuntime(readRemoteConfig(file)!, activities, { configFile: file })
    cleanup.push(() => restarted.close())
    await restarted.start()
    expect(restarted.status()).toEqual({ enabled: false, running: false })
    expect(restarted.hub.store.snapshot().sessions.every(s => !s.connected)).toBe(true)
    expect(restarted.hooks.poll(r.requestId!, 'submitted')).toEqual({ status: 'uncertain', released: true })
  })

  it('can disable after failed startup and retry after correcting connection configuration', async () => {
    const { file, runtime } = await setup()
    const config = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...config, codex: [{ id: 'bad', url: 'http://invalid', threads: ['t'] }] }))
    expect(() => runtime.setEnabled(true)).toThrow('接管启动失败')
    expect(runtime.status()).toMatchObject({ enabled: true, running: false, error: expect.any(String) })
    expect(runtime.setEnabled(false)).toEqual({ enabled: false, running: false })
    writeFileSync(file, JSON.stringify(config))
    expect(runtime.setEnabled(true)).toEqual({ enabled: true, running: true })
  })

  it('keeps the public status API available even when lazy control loading fails', async () => {
    const activities = new ActivityStore()
    cleanup.push(() => activities.dispose())
    const server = await startStatusServer(activities, { port: 0, control: () => { throw new Error('invalid remote config') } })
    cleanup.push(() => server.close())
    expect((await fetch(`http://127.0.0.1:${server.port}/v1/activities`)).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${server.port}/v1/control`)).status).toBe(500)
  })

  it('disconnects Codex without interrupting its turn and reconnects without reviving old requests', async () => {
    const ws = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>(resolve => ws.once('listening', resolve))
    cleanup.push(() => new Promise<void>(resolve => { for (const client of ws.clients) client.terminate(); ws.close(() => resolve()) }))
    const received: { method?: string; result?: unknown }[] = []
    let connections = 0
    ws.on('connection', socket => {
      const generation = ++connections
      socket.on('message', bytes => {
        const message = JSON.parse(bytes.toString())
        received.push(message)
        if (!message.method || message.id === undefined) return
        socket.send(JSON.stringify({ id: message.id, result: message.method === 'thread/loaded/list' ? { data: ['native'] }
          : message.method === 'thread/resume' ? { thread: { turns: [{ id: 'active-turn', status: 'inProgress' }] } } : {} }))
        if (message.method === 'thread/resume') socket.send(JSON.stringify({ id: `approval-${generation}`, method: 'item/commandExecution/requestApproval',
          params: { threadId: 'native', turnId: 'active-turn', command: 'npm test' } }))
      })
    })
    const { runtime, file, config } = await setup()
    writeFileSync(file, JSON.stringify({ ...config, codex: [{ id: 'local', url: `ws://127.0.0.1:${(ws.address() as { port: number }).port}`, threads: ['native'] }] }))
    runtime.setEnabled(true)
    await vi.waitFor(() => expect(runtime.hub.store.snapshot().requests).toHaveLength(1))
    const original = runtime.hub.store.snapshot().requests[0]
    runtime.setEnabled(false)
    expect(runtime.hub.store.get(original.id).status).toBe('cancelled')
    expect(runtime.hub.store.snapshot().sessions[0].connected).toBe(false)
    runtime.setEnabled(true)
    await vi.waitFor(() => expect(runtime.hub.store.snapshot().requests).toHaveLength(2))
    expect(connections).toBe(2)
    expect(runtime.hub.store.snapshot().sessions[0].connected).toBe(true)
    expect(runtime.hub.store.get(original.id).status).toBe('cancelled')
    expect(runtime.hub.store.snapshot().requests[1].status).toBe('pending')
    expect(received.some(m => m.method === 'turn/interrupt' || m.method === 'thread/start' || m.result)).toBe(false)
  })
})

describe('CLI and dormant Hooks', () => {
  it.each([
    ['claude', 'PermissionRequest', {}], ['claude', 'PreToolUse', {}], ['claude', 'Elicitation', {}],
    ['cursor', 'beforeShellExecution', { permission: 'allow' }], ['cursor', 'beforeMCPExecution', { permission: 'allow' }],
    ['cursor', 'stop', {}], ['gemini', 'BeforeTool', {}]
  ])('defers %s %s while explicitly off without contacting the server', async (agent, name, output) => {
    const file = configFile()
    const stdout = vi.fn(), fetchImpl = vi.fn()
    await runRemoteCli(['hook', '--agent', String(agent), '--event', String(name), '--config', file], {
      stdout, stderr: vi.fn(), fetchImpl, stdin: async () => JSON.stringify({ session_id: 'native' })
    })
    expect(JSON.parse(stdout.mock.calls[0][0])).toEqual(output)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not treat missing, malformed, or enabled configuration as a deliberate off switch', async () => {
    const file = configFile()
    const unavailable = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    for (const config of ['{broken', '{}', JSON.stringify({ mode: 'takeover', enabled: 'false' }), readFileSync(file, 'utf8').replace('"enabled": false', '"enabled": true')]) {
      writeFileSync(file, config)
      const stdout = vi.fn()
      await runRemoteCli(['hook', '--agent', 'cursor', '--config', file], {
        stdout, stderr: vi.fn(), fetchImpl: unavailable, stdin: async () => JSON.stringify({ hook_event_name: 'beforeShellExecution' })
      })
      expect(JSON.parse(stdout.mock.calls[0][0]).permission).toBe('deny')
    }
  })

  it('uses the live switch and saves an offline preference without claiming the service is running', async () => {
    const { file, runtime } = await setup()
    const stdout = vi.fn(), stderr = vi.fn()
    await runRemoteCli(['enable', '--config', file], { stdout, stderr })
    expect(runtime.status().running).toBe(true)
    await runRemoteCli(['disable', '--config', file], { stdout, stderr })
    expect(runtime.status().running).toBe(false)
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))
    await runRemoteCli(['enable', '--config', file], { stdout, stderr, fetchImpl })
    expect(readRemoteConfig(file)?.enabled).toBe(true)
    expect(JSON.parse(stdout.mock.calls.at(-1)![0]).control).toEqual({ enabled: true, running: false })
    await runRemoteCli(['disable', '--config', file], { stdout, stderr, fetchImpl })
    expect(readRemoteConfig(file)?.enabled).toBe(false)
    const unauthorized = vi.fn(async () => new Response('{"error":"未授权"}', { status: 401 }))
    await expect(runRemoteCli(['enable', '--config', file], { stdout, stderr, fetchImpl: unauthorized })).rejects.toThrow('未授权')
    expect(readRemoteConfig(file)?.enabled).toBe(false)
  })

  it('discards queued guidance on offline disable even if re-enabled before starting the app', async () => {
    const file = configFile()
    const config = readRemoteConfig(file)!
    const store = new ControlStore(config.stateFile)
    store.session({ id: 's', nativeId: 'native', agent: 'claude', label: 'project', adapter: 'hook', connected: true, capabilities: ['message'] })
    await new ControlHub(store).send('s', 'old message', 'owner')
    const io = { stdout: vi.fn(), stderr: vi.fn(), fetchImpl: vi.fn().mockRejectedValue(new TypeError('offline', { cause: { code: 'ECONNREFUSED' } })) }
    await runRemoteCli(['disable', '--config', file], io)
    await runRemoteCli(['enable', '--config', file], io)
    const activities = new ActivityStore()
    cleanup.push(() => activities.dispose())
    const runtime = createControlRuntime(readRemoteConfig(file)!, activities)
    cleanup.push(() => runtime.close())
    await runtime.start()
    expect(runtime.hub.store.snapshot().guidance[0].status).toBe('cancelled')
  })
})

it('closes a channel still starting and ignores its late callbacks', async () => {
  const store = new ControlStore()
  const hub = new ControlHub(store)
  let finish!: () => void
  let receive!: (message: RemoteMessage) => Promise<string>
  const channel: ChannelAdapter = { id: 'test', destination: 'chat', allowedUsers: ['owner'],
    start: fn => { receive = fn; return new Promise(resolve => { finish = resolve }) },
    send: vi.fn(async () => 'message'), update: vi.fn(), close: vi.fn() }
  const starting = hub.addChannel(channel)
  hub.close()
  expect(channel.close).toHaveBeenCalled()
  finish(); await starting
  expect(await receive({ eventId: 'late', sender: 'owner', chat: 'chat', text: '/sessions' })).toBe('')
  expect(store.snapshot().seen).toHaveLength(0)
  await hub.flush()
  expect(channel.send).not.toHaveBeenCalled()
})

it('does not let an in-flight delivery write stale state after disabling', async () => {
  const store = new ControlStore()
  store.session({ id: 's', agent: 'claude', nativeId: 'native', label: 'project', adapter: 'hook', capabilities: ['approve'], connected: true })
  const request = store.create({ sessionId: 's', sourceKey: 'r', origin: 'hook', kind: 'approval', title: 'confirm', detail: '', questions: [], actions: ['approve'], expiresAt: Date.now() + 60000 })
  const hub = new ControlHub(store)
  let delivered!: (id: string) => void
  const channel: ChannelAdapter = { id: 'test', destination: 'chat', allowedUsers: ['owner'],
    start: vi.fn(), send: () => new Promise(resolve => { delivered = resolve }), update: vi.fn(), close: vi.fn() }
  await hub.addChannel(channel)
  const flush = hub.flush()
  hub.close(); store.releaseControl()
  delivered('old-message'); await flush
  expect(store.get(request.id).status).toBe('cancelled')
  expect(store.snapshot().deliveries).toEqual({})
})
