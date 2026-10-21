import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { ActivityStore } from '../shared/activity'
import { CodexAdapter } from './codex'
import { ControlHub } from './hub'
import { NativeSessionResumer } from './resume'
import { ControlStore } from './store'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()))
async function fixture(readStatus = 'failed', resumeStatus = 'failed', liveNotification = false) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  cleanup.push(() => { for (const client of server.clients) client.terminate(); server.close() })
  const received: Record<string, any>[] = []
  const subscribers = new Set<WebSocket>()
  const store = new ControlStore()
  let peer: WebSocket
  server.on('connection', socket => {
    peer = socket
    socket.on('message', bytes => {
      const m = JSON.parse(bytes.toString())
      received.push(m)
      if (!m.method || m.id === undefined) return
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: m.id, result }))
      if (m.method === 'thread/resume' && m.id === 'terminal-subscribe') {
        subscribers.add(socket)
        reply({ thread: { id: 'native', turns: [{ id: 'failed-turn', status: readStatus }] } })
        return
      }
      if (m.method === 'initialize') reply({})
      if (m.method === 'thread/loaded/list') reply({ data: [] })
      if (m.method === 'thread/read') reply({ thread: { id: 'native', turns: [{ id: 'failed-turn', status: readStatus }] } })
      if (m.method === 'thread/resume') {
        subscribers.add(socket)
        expect(store.snapshot().requests[0].status).toBe('submitted')
        if (liveNotification) socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'concurrent-turn' } } }))
        reply({ thread: { id: 'native', turns: [{ id: 'failed-turn', status: resumeStatus }] } })
      }
      if (m.method === 'turn/start') {
        const broadcast = (method: string, params: unknown) => {
          for (const subscriber of subscribers) subscriber.send(JSON.stringify({ method, params }))
        }
        broadcast('turn/started', { threadId: 'native', turn: { id: 'new-turn' } })
        broadcast('item/started', { threadId: 'native', turnId: 'new-turn', item: { id: 'input', type: 'userMessage', content: m.params.input } })
        broadcast('item/agentMessage/delta', { threadId: 'native', turnId: 'new-turn', itemId: 'answer', delta: '继续后的回复' })
        broadcast('item/completed', { threadId: 'native', turnId: 'new-turn', item: { id: 'answer', type: 'agentMessage', text: '继续后的回复' } })
        socket.send(JSON.stringify({ id: 77, method: 'item/commandExecution/requestApproval', params: { threadId: 'native', turnId: 'new-turn', command: 'npm test' } }))
        reply({ turn: { id: 'new-turn', status: 'inProgress' } })
      }
    })
  })
  const activities = new ActivityStore()
  cleanup.push(() => activities.dispose())
  const hub = new ControlHub(store)
  const adapter = new CodexAdapter(hub, { id: 'local', url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, threads: [] })
  hub.setResumer(new NativeSessionResumer(hub, activities, [adapter]))
  cleanup.push(() => { hub.close(); adapter.close() })
  const session = store.session({ id: 'stored', nativeId: 'native', connectionId: 'local', agent: 'codex', adapter: 'codex', connected: false, label: '原项目', capabilities: [] })
  const request = store.create({ sourceKey: 'failed', sessionId: session.id, turnId: 'failed-turn', origin: 'observation', kind: 'error', title: '失败', detail: '', questions: [], actions: ['resume', 'ack'], expiresAt: Date.now() + 60000 })
  adapter.start()
  await vi.waitFor(() => expect(received.some(m => m.method === 'thread/loaded/list')).toBe(true))
  return { hub, store, adapter, session, request, received, url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, peer: () => peer! }
}

it('delivers continuation text and streamed answer to an already subscribed terminal on the same server', async () => {
  const { hub, store, request, received, url } = await fixture()
  const terminal = new WebSocket(url)
  cleanup.push(() => terminal.terminate())
  const messages: Record<string, any>[] = []
  terminal.on('message', bytes => messages.push(JSON.parse(bytes.toString())))
  await new Promise<void>((resolve, reject) => { terminal.once('open', resolve); terminal.once('error', reject) })
  terminal.send(JSON.stringify({ id: 'terminal-subscribe', method: 'thread/resume', params: { threadId: 'native' } }))
  await vi.waitFor(() => expect(messages.some(message => message.id === 'terminal-subscribe')).toBe(true))
  await hub.resume(request.id, request.revision, 'owner', '先检查已有进度再继续')
  await vi.waitFor(() => expect(store.get(request.id).status).toBe('resolved'))
  await vi.waitFor(() => expect(messages.some(message => message.method === 'item/completed')).toBe(true))
  expect(messages.filter(message => message.method).map(message => message.method)).toEqual([
    'turn/started', 'item/started', 'item/agentMessage/delta', 'item/completed'
  ])
  expect(messages.find(message => message.method === 'item/started')?.params.item.content).toEqual([{ type: 'text', text: '先检查已有进度再继续' }])
  expect(messages.find(message => message.method === 'item/completed')?.params.item.text).toBe('继续后的回复')
  expect(received.filter(message => message.method === 'turn/start')).toHaveLength(1)
  expect(received.some(message => message.method === 'thread/start')).toBe(false)
})

it('loads only the explicitly selected failed native thread, then starts a turn with the continuation text', async () => {
  const { hub, store, request, received } = await fixture()
  expect(received.some(m => m.method === 'thread/resume')).toBe(false)
  await hub.resume(request.id, 1, 'owner', '检查已有改动再继续')
  await vi.waitFor(() => expect(store.get(request.id).status).toBe('resolved'))
  expect(received.filter(m => ['thread/read', 'thread/resume', 'turn/start'].includes(m.method)).map(m => [m.method, m.params.threadId])).toEqual([
    ['thread/read', 'native'], ['thread/resume', 'native'], ['turn/start', 'native']
  ])
  expect(received.find(m => m.method === 'turn/start')?.params.input).toEqual([{ type: 'text', text: '检查已有改动再继续' }])
  expect(received.some(m => m.method === 'thread/start' || m.method === 'turn/steer')).toBe(false)
  expect(store.snapshot().requests.some(r => r.nativeRequestId === 77)).toBe(true)
})

it.each(['inProgress', 'completed'])('rejects a stale notification when native thread is %s', async state => {
  const { hub, store, request, received } = await fixture(state)
  await expect(hub.resume(request.id, 1, 'owner')).rejects.toThrow(/仍在执行|已完成/)
  expect(store.get(request.id).status).toBe('pending')
  expect(received.some(m => m.method === 'thread/resume' || m.method === 'turn/start')).toBe(false)
})

it('does not send continuation if the thread starts running during recovery', async () => {
  const { hub, store, request, received } = await fixture('failed', 'inProgress')
  await hub.resume(request.id, 1, 'owner')
  await vi.waitFor(() => expect(store.get(request.id).status).toBe('uncertain'))
  expect(received.some(m => m.method === 'turn/start')).toBe(false)
})

it('keeps configured thread scopes and remote host identity during recovery routing', async () => {
  const { hub, session } = await fixture()
  const remote = new CodexAdapter(hub, { id: 'remote', url: 'wss://example.test', threads: ['native'] })
  const scoped = new CodexAdapter(hub, { id: 'local', url: 'ws://127.0.0.1:12345', threads: ['other'] })
  expect(remote.acceptsRecovery(session)).toBe(false)
  expect(remote.acceptsRecovery({ ...session, connectionId: undefined })).toBe(false)
  expect(remote.acceptsRecovery({ ...session, connectionId: 'remote' })).toBe(true)
  expect(scoped.acceptsRecovery(session)).toBe(false)
})

it('honors a live turn notification even when the resume response still contains the failed turn', async () => {
  const { hub, store, request, received } = await fixture('failed', 'failed', true)
  await hub.resume(request.id, 1, 'owner')
  await vi.waitFor(() => expect(store.get(request.id).status).toBe('uncertain'))
  expect(received.some(m => m.method === 'turn/start')).toBe(false)
})

it('offers continuation on a native interrupted turn and retains the failed turn identity', async () => {
  const { hub, store, request, peer } = await fixture()
  await hub.resume(request.id, 1, 'owner')
  await vi.waitFor(() => expect(store.get(request.id).status).toBe('resolved'))
  peer().send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'new-turn', status: 'interrupted' } } }))
  await vi.waitFor(() => expect(store.snapshot().requests.some(r => r.turnId === 'new-turn' && r.kind === 'error' && r.actions.includes('resume'))).toBe(true))
})
