import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { ControlStore } from './store'
import { ControlHub } from './hub'
import { CodexAdapter } from './codex'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
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
