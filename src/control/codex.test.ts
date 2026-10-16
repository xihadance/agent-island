import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { ControlStore } from './store'
import { ControlHub } from './hub'
import { CodexAdapter } from './codex'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers() })
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
