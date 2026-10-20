import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { ControlStore } from './store'
import { ControlHub } from './hub'
import { CodexAdapter } from './codex'
import { decideCodex } from '../shared/automation'
import { DEFAULT_PREFERENCES, type Preferences } from '../shared/preferences'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers() })

async function automationFixture(rules: Partial<Preferences['automation']> = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => server.once('listening', resolve))
  cleanup.push(() => { for (const client of server.clients) client.terminate(); server.close() })
  let peer: WebSocket
  const received: Record<string, any>[] = []
  server.on('connection', socket => {
    peer = socket
    socket.on('message', bytes => {
      const m = JSON.parse(bytes.toString())
      received.push(m)
      if (m.method && m.id !== undefined) socket.send(JSON.stringify({ id: m.id, result:
        m.method === 'thread/loaded/list' ? { data: ['t'] } : m.method === 'thread/resume' ? { thread: { turns: [] } } : {} }))
    })
  })
  const store = new ControlStore()
  const hub = new ControlHub(store)
  const channel = { id: 'test', destination: 'chat', allowedUsers: ['owner'], start: vi.fn(), send: vi.fn(async () => 'msg'), update: vi.fn(), close: vi.fn() }
  await hub.addChannel(channel)
  const preferences = { ...DEFAULT_PREFERENCES, automation: { ...DEFAULT_PREFERENCES.automation, enabled: true, fallback: 'manual' as const, ...rules } }
  const report = vi.fn()
  const connect = () => new CodexAdapter(hub, { id: 'local', url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, threads: ['t'] },
    () => {}, (method, params) => decideCodex(method, params, preferences), report)
  const adapter = connect()
  cleanup.unshift(() => hub.close())
  adapter.start()
  await vi.waitFor(() => expect(received.some(m => m.method === 'thread/resume')).toBe(true))
  const send = (method: string, params: Record<string, unknown>, id: string | number = 'request') => peer!.send(JSON.stringify({ id, method, params: { threadId: 't', turnId: 'turn', ...params } }))
  const reconnect = async () => {
    adapter.close()
    const next = connect()
    cleanup.unshift(() => next.close())
    next.start()
    await vi.waitFor(() => expect(received.filter(m => m.method === 'thread/resume')).toHaveLength(2))
  }
  return { store, hub, channel, received, report, send, preferences, adapter, reconnect }
}

it('does not replay an automatic native request after reconnecting, but accepts a new turn', async () => {
  const f = await automationFixture()
  const method = 'item/commandExecution/requestApproval'
  f.send(method, {})
  await vi.waitFor(() => expect(f.report).toHaveBeenCalledOnce())
  await f.reconnect()
  f.send(method, {})
  f.send(method, {}, 'barrier')
  await vi.waitFor(() => expect(f.report).toHaveBeenCalledTimes(2))
  expect(f.received.filter(m => m.id === 'request' && !m.method)).toHaveLength(1)
  f.send(method, { turnId: 'next-turn' })
  await vi.waitFor(() => expect(f.report).toHaveBeenCalledTimes(3))
  expect(f.received.filter(m => m.id === 'request' && !m.method)).toHaveLength(2)
  expect(f.store.snapshot().requests).toHaveLength(0)
})

it.each([
  ['item/commandExecution/requestApproval', { command: 'npm test', availableDecisions: ['accept', 'decline'] }, { decision: 'accept' }],
  ['item/fileChange/requestApproval', { availableDecisions: ['accept', 'decline'] }, { decision: 'accept' }],
  ['item/permissions/requestApproval', { permissions: { network: { enabled: true } } }, { permissions: { network: { enabled: true } }, scope: 'turn' }],
  ['item/tool/requestUserInput', { questions: [{ id: 'q', question: '哪种方案？', options: [{ label: 'A（推荐）' }, { label: 'B' }] }] }, { answers: { q: { answers: ['A（推荐）'] } } }],
  ['tool/requestUserInput', { questions: [{ id: 'q', question: '哪种方案？', options: [{ label: 'A（推荐）' }, { label: 'B' }] }] }, { answers: { q: { answers: ['A（推荐）'] } } }]
])('automates %s through the native connection without notifying channels or replaying', async (method, params, result) => {
  const f = await automationFixture()
  f.send(method, params)
  f.send(method, params)
  await vi.waitFor(() => expect(f.report).toHaveBeenCalledOnce())
  expect(f.received.filter(m => m.id === 'request' && !m.method)).toEqual([{ id: 'request', result }])
  expect(f.store.snapshot().requests).toHaveLength(0)
  f.hub.observe([{ id: 'codex-t', agent: 'Codex', state: method.includes('requestUserInput') ? 'waiting' : 'approval',
    title: '测试请求', operation: { kind: 'tool', name: method.includes('requestUserInput') ? 'request_user_input' : 'exec_command' },
    steps: [], startedAt: 1, updatedAt: 2 }])
  await f.hub.flush()
  expect(f.channel.send).not.toHaveBeenCalled()
  f.preferences.automation.enabled = false
  f.send(method, params)
  f.send('item/commandExecution/requestApproval', { command: 'next' }, 'next')
  await vi.waitFor(() => expect(f.store.snapshot().requests).toHaveLength(1))
  expect(f.store.snapshot().requests[0].nativeRequestId).toBe('next')
  expect(f.report).toHaveBeenCalledOnce()
})

it.each([
  ['rule disabled', 'item/commandExecution/requestApproval', {}, { approvePermissions: false }],
  ['automation paused', 'item/commandExecution/requestApproval', {}, { enabled: false }],
  ['blacklisted command', 'item/commandExecution/requestApproval', { command: 'git PUSH origin main' }, { blacklist: ['git push'] }],
  ['blacklisted path', 'item/fileChange/requestApproval', { grantRoot: '/production' }, { blacklist: ['production'] }],
  ['no recommendation', 'item/tool/requestUserInput', { questions: [{ id: 'q', question: '选择', options: [{ label: 'A' }, { label: 'B' }] }] }, {}],
  ['free text', 'item/tool/requestUserInput', { questions: [{ id: 'q', question: '请输入路径' }] }, {}],
  ['unsupported form', 'mcpServer/elicitation/request', { mode: 'url' }, {}],
  ['accept disallowed', 'item/commandExecution/requestApproval', { availableDecisions: ['decline', 'cancel'] }, {}],
  ['oversized content', 'item/commandExecution/requestApproval', { command: 'x'.repeat(49000) }, {}]
])('escalates %s exactly once', async (_label, method, params, rules) => {
  const f = await automationFixture(rules)
  f.send(method, params)
  f.send(method, params)
  await vi.waitFor(() => expect(f.store.snapshot().requests).toHaveLength(1))
  await f.hub.flush()
  expect(f.channel.send).toHaveBeenCalledOnce()
  expect(f.report).not.toHaveBeenCalled()
  expect(f.received.some(m => m.id === 'request' && !m.method)).toBe(false)
  f.preferences.automation.enabled = true
  f.preferences.automation.approvePermissions = true
  f.send(method, params)
  f.send('item/commandExecution/requestApproval', {}, 'barrier')
  await vi.waitFor(() => expect(f.report).toHaveBeenCalledOnce())
  expect(f.received.some(m => m.id === 'request' && !m.method)).toBe(false)
})

it('lets a user explicitly approve a blacklisted request through the remote channel', async () => {
  const f = await automationFixture({ blacklist: ['git push'] })
  f.send('item/commandExecution/requestApproval', { command: 'git push origin main' })
  await vi.waitFor(() => expect(f.store.snapshot().requests).toHaveLength(1))
  const request = f.store.snapshot().requests[0]
  await f.hub.respond(request.id, request.revision, { action: 'approve' }, 'owner')
  await vi.waitFor(() => expect(f.received.some(m => m.id === 'request' && !m.method)).toBe(true))
  expect(f.received.filter(m => m.id === 'request' && !m.method)).toEqual([{ id: 'request', result: { decision: 'accept' } }])
})

it('keeps an ambiguous native send failure from escalating or retrying', async () => {
  const f = await automationFixture()
  vi.spyOn(f.adapter as unknown as { write(value: unknown): Promise<void> }, 'write').mockRejectedValue(new Error('连接中断'))
  f.send('item/commandExecution/requestApproval', {})
  await vi.waitFor(() => expect(f.report).toHaveBeenCalledOnce())
  expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ action: 'manual', summary: expect.stringContaining('待确认') }))
  f.send('item/commandExecution/requestApproval', {})
  f.send('item/commandExecution/requestApproval', {}, 'next')
  await vi.waitFor(() => expect(f.report).toHaveBeenCalledTimes(2))
  expect(f.store.snapshot().requests).toHaveLength(0)
  expect(f.received.some(m => m.id === 'request' && !m.method)).toBe(false)
})
it('takes over only loaded threads, captures approvals during subscribe, and sends scoped steering', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => server.once('listening', resolve))
  cleanup.push(() => { for (const client of server.clients) client.terminate(); server.close() })
  const received: Record<string, any>[] = []
  let peer: WebSocket
  server.on('connection', socket => {
    peer = socket
    socket.on('message', bytes => {
      const m = JSON.parse(bytes.toString())
      received.push(m)
      if (!m.method || m.id === undefined) return
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: m.id, result }))
      if (m.method === 'initialize') reply({})
      if (m.method === 'thread/loaded/list') reply({ data: ['thread-live'] })
      if (m.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-live', turnId: 'turn-1', itemId: 'tool-1', command: 'npm test', availableDecisions: ['accept', 'decline'] } }))
        reply({ thread: { id: 'thread-live', turns: [{ id: 'turn-1', status: 'inProgress' }] } })
      }
      if (m.method === 'turn/steer') reply({ turnId: 'turn-1' })
    })
  })
  const store = new ControlStore()
  const hub = new ControlHub(store)
  const adapter = new CodexAdapter(hub, { id: 'local', url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, threads: ['thread-live', 'stored-only'] })
  cleanup.unshift(() => adapter.close())
  adapter.start()
  await vi.waitFor(() => expect(store.snapshot().requests).toHaveLength(1))
  const r = store.snapshot().requests[0]
  expect(r.actions).toEqual(['approve', 'deny'])
  await hub.respond(r.id, r.revision, { action: 'approve' }, 'owner')
  await vi.waitFor(() => expect(received).toContainEqual({ id: 900, result: { decision: 'accept' } }))
  peer!.send(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'thread-live', requestId: 900 } }))
  await vi.waitFor(() => expect(store.get(r.id).status).toBe('resolved'))
  const guidance = await hub.send(r.sessionId, '先修复测试', 'owner')
  expect(guidance.status).toBe('resolved')
  expect(received).toContainEqual(expect.objectContaining({ method: 'turn/steer', params: { threadId: 'thread-live', expectedTurnId: 'turn-1', input: [{ type: 'text', text: '先修复测试' }] } }))
  expect(received.filter(m => m.method === 'thread/resume').map(m => m.params.threadId)).toEqual(['thread-live'])
  expect(received.some(m => m.method === 'thread/start')).toBe(false)
})

it('cancels late answers when the original client resolves the request first', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => server.once('listening', resolve))
  cleanup.push(() => { for (const client of server.clients) client.terminate(); server.close() })
  let peer: WebSocket
  server.on('connection', socket => {
    peer = socket
    socket.on('message', bytes => {
      const m = JSON.parse(bytes.toString())
      if (m.id === undefined || !m.method) return
      socket.send(JSON.stringify({ id: m.id, result: m.method === 'thread/loaded/list' ? { data: ['t'] } : m.method === 'thread/resume' ? { thread: { turns: [] } } : {} }))
    })
  })
  const store = new ControlStore()
  const hub = new ControlHub(store)
  const adapter = new CodexAdapter(hub, { id: 'l', url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, threads: ['t'] })
  cleanup.unshift(() => adapter.close()); adapter.start()
  await vi.waitFor(() => expect(store.snapshot().sessions).toHaveLength(1))
  peer!.send(JSON.stringify({ id: 'question-1', method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 'a', questions: [{ id: 'q1', question: '选择环境', options: [{ label: 'dev' }], isOther: false }] } }))
  await vi.waitFor(() => expect(store.snapshot().requests).toHaveLength(1))
  const r = store.snapshot().requests[0]
  peer!.send(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 't', requestId: 'question-1' } }))
  await vi.waitFor(() => expect(store.get(r.id).status).toBe('cancelled'))
  await expect(hub.respond(r.id, r.revision, { action: 'answer', answers: { q1: ['dev'] } }, 'owner')).rejects.toThrow('失效')
})

it.each([{ threads: [] }, { threads: ['page-two-thread', 'late-thread'] }])('discovers later threads across pages and preserves the configured scope $threads', async ({ threads }) => {
  vi.useFakeTimers({ toFake: ['setInterval'] })
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => server.once('listening', resolve))
  cleanup.push(() => { for (const client of server.clients) client.terminate(); server.close() })
  let loaded = ['unselected-thread', 'page-two-thread']
  const received: Record<string, any>[] = []
  let peer: WebSocket
  server.on('connection', socket => {
    peer = socket
    socket.on('message', bytes => {
      const m = JSON.parse(bytes.toString()); received.push(m)
      if (m.id === undefined || !m.method) return
      let result: unknown = {}
      if (m.method === 'thread/loaded/list') result = m.params.cursor ? { data: loaded.slice(1), nextCursor: null } : { data: loaded.slice(0, 1), nextCursor: 'page-two' }
      if (m.method === 'thread/resume') {
        if (m.params.threadId === 'late-thread') socket.send(JSON.stringify({ id: 901, method: 'item/commandExecution/requestApproval', params: { threadId: 'late-thread', turnId: 'late-turn', availableDecisions: ['accept', 'decline'] } }))
        result = { thread: { name: m.params.threadId, turns: [] } }
      }
      socket.send(JSON.stringify({ id: m.id, result }))
    })
  })
  const store = new ControlStore(); const hub = new ControlHub(store)
  const adapter = new CodexAdapter(hub, { id: 'auto', url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, threads })
  cleanup.unshift(() => adapter.close()); adapter.start()
  await vi.waitFor(() => expect(store.snapshot().sessions.filter(s => s.connected)).toHaveLength(threads.length ? 1 : 2))
  expect(received.filter(m => m.method === 'thread/resume').map(m => m.params)).toEqual(threads.length ? [{ threadId: 'page-two-thread' }] : [{ threadId: 'unselected-thread' }, { threadId: 'page-two-thread' }])

  loaded.push('late-thread')
  await vi.advanceTimersByTimeAsync(5000)
  await vi.waitFor(() => expect(store.snapshot().requests).toHaveLength(1))
  const request = store.snapshot().requests[0]
  expect(store.snapshot().sessions.find(s => s.id === request.sessionId)?.turnId).toBe('late-turn')
  expect(received.filter(m => m.method === 'thread/resume' && m.params.threadId === 'late-thread')).toHaveLength(1)

  loaded = loaded.filter(id => id !== 'late-thread')
  await vi.advanceTimersByTimeAsync(5000)
  await vi.waitFor(() => expect(store.snapshot().sessions.find(s => s.id === request.sessionId)?.connected).toBe(false))
  expect(store.get(request.id).status).toBe('uncertain')
  await expect(hub.respond(request.id, request.revision, { action: 'approve' }, 'owner')).rejects.toThrow('未连接')

  loaded.push('late-thread')
  await vi.advanceTimersByTimeAsync(5000)
  await vi.waitFor(() => expect(received.filter(m => m.method === 'thread/resume' && m.params.threadId === 'late-thread')).toHaveLength(2))
  await vi.waitFor(() => expect(store.snapshot().sessions.find(s => s.id === request.sessionId)?.connected).toBe(true))
  peer!.send(JSON.stringify({ method: 'thread/closed', params: { threadId: 'late-thread' } }))
  await vi.waitFor(() => expect(store.snapshot().sessions.find(s => s.id === request.sessionId)?.connected).toBe(false))
  expect(store.snapshot().sessions.filter(s => s.nativeId === 'late-thread')).toHaveLength(1)
  adapter.close()
  const scans = received.filter(m => m.method === 'thread/loaded/list').length
  await vi.advanceTimersByTimeAsync(10000)
  expect(received.filter(m => m.method === 'thread/loaded/list')).toHaveLength(scans)
  expect(received.some(m => m.method === 'thread/start' || m.method === 'turn/start')).toBe(false)
})

it('keeps discovering when one loaded thread fails to subscribe', async () => {
  vi.useFakeTimers({ toFake: ['setInterval'] })
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => server.once('listening', resolve))
  cleanup.push(() => { for (const client of server.clients) client.terminate(); server.close() })
  let retrySucceeds = false
  server.on('connection', socket => socket.on('message', bytes => {
    const m = JSON.parse(bytes.toString())
    if (m.id === undefined || !m.method) return
    if (m.method === 'thread/resume' && m.params.threadId === 'retry-thread' && !retrySucceeds) {
      socket.send(JSON.stringify({ id: m.id, error: { code: -32600, message: 'thread unloaded' } })); return
    }
    socket.send(JSON.stringify({ id: m.id, result: m.method === 'thread/loaded/list' ? { data: ['retry-thread', 'live-thread'] } : m.method === 'thread/resume' ? { thread: { turns: [] } } : {} }))
  }))
  const store = new ControlStore(); const adapter = new CodexAdapter(new ControlHub(store), { id: 'retry', url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, threads: [] })
  cleanup.unshift(() => adapter.close()); adapter.start()
  await vi.waitFor(() => expect(store.snapshot().sessions.find(s => s.nativeId === 'live-thread')?.connected).toBe(true))
  expect(store.snapshot().sessions.find(s => s.nativeId === 'retry-thread')?.connected).toBe(false)
  retrySucceeds = true
  await vi.advanceTimersByTimeAsync(5000)
  await vi.waitFor(() => expect(store.snapshot().sessions.filter(s => s.connected)).toHaveLength(2))
  adapter.close()
  expect(store.snapshot().sessions.every(s => !s.connected)).toBe(true)
})
