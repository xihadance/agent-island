import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexAdapter } from './codex'
import { ControlHub } from './hub'
import { ControlStore } from './store'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(close => close()))

async function fixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  cleanups.push(() => { server.clients.forEach(client => client.terminate()); server.close() })
  let peer!: WebSocket
  const received: Record<string, any>[] = []
  server.on('connection', socket => {
    peer = socket
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString())
      received.push(message)
      if (!message.method || message.id === undefined) return
      if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, error: { code: -32001, message: '会话输入被拒绝', data: { detail: '测试原因' } } }))
        return
      }
      socket.send(JSON.stringify({ id: message.id, result: message.method === 'thread/loaded/list' ? { data: ['thread'] }
        : message.method === 'thread/resume' ? { thread: { name: '测试', turns: [] } } : {} }))
    })
  })
  const store = new ControlStore()
  const hub = new ControlHub(store)
  hub.setResumer({ available: () => true, prepare: async () => async () => {}, close() {} })
  const adapter = new CodexAdapter(hub, { id: 'test', url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, threads: [] })
  cleanups.push(() => { hub.close(); adapter.close() })
  adapter.start()
  await vi.waitFor(() => expect(store.sessions()[0]?.label).toBe('测试'))
  const send = (method: string, params: Record<string, unknown>) => peer.send(JSON.stringify({ method, params: { threadId: 'thread', ...params } }))
  const rpc = adapter as unknown as { rpc(method: string, params: unknown): Promise<unknown> }
  const barrier = () => rpc.rpc('fixture/barrier', {})
  return { store, hub, adapter, send, barrier, received }
}

it('records a non-retrying error, then merges completion into the same recoverable occurrence', async () => {
  const f = await fixture()
  f.send('turn/started', { turn: { id: 'turn' } })
  const error = { message: '连接中断', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } }, additionalDetails: '上游提前关闭' }
  f.send('error', { turnId: 'turn', willRetry: false, error })
  await vi.waitFor(() => expect(f.store.requests()).toHaveLength(1))
  const first = f.store.requests()[0]
  expect(first.actions).toEqual(['ack'])
  expect(first.detail).toContain('502')
  expect(first.detail).toContain('上游提前关闭')
  f.send('turn/completed', { turn: { id: 'turn', status: 'failed', error } })
  await vi.waitFor(() => expect(f.store.get(first.id).actions).toContain('resume'))
  expect(f.store.requests()).toHaveLength(1)
  f.send('turn/completed', { turn: { id: 'turn', status: 'failed', error } })
  await f.barrier()
  expect(f.store.requests()).toHaveLength(1)
  f.send('error', { turnId: 'turn', willRetry: false, error })
  await f.barrier()
  expect(f.store.get(first.id).actions).toContain('resume')
})

it('does not offer recovery while the native error is retrying and never revives an acknowledged error', async () => {
  const f = await fixture()
  f.send('turn/started', { turn: { id: 'turn' } })
  f.send('error', { turnId: 'turn', willRetry: true, error: { message: '正在重试' } })
  await f.barrier()
  expect(f.store.requests()).toHaveLength(0)
  f.send('error', { turnId: 'turn', willRetry: false, error: { message: '已耗尽重试' } })
  await vi.waitFor(() => expect(f.store.requests()).toHaveLength(1))
  const request = f.store.requests()[0]
  await f.hub.respond(request.id, request.revision, { action: 'ack' }, 'owner')
  f.send('turn/completed', { turn: { id: 'turn', status: 'failed', error: { message: '已耗尽重试' } } })
  await f.barrier()
  expect(f.store.get(request.id)).toMatchObject({ status: 'resolved', decision: { action: 'ack' } })
  expect(f.store.requests()).toHaveLength(1)
})

it('keeps the native RPC error code and reason in the failed submission', async () => {
  const f = await fixture()
  const sessionId = f.store.sessions()[0].id
  await expect(f.hub.send(sessionId, '继续执行', 'owner')).rejects.toThrow('待确认')
  expect(f.store.snapshot().guidance[0]?.status).toBe('uncertain')
  // Exercise the same transport directly to inspect the diagnostic without replaying the guidance.
  const rpc = f.adapter as unknown as { rpc(method: string, params: unknown): Promise<unknown> }
  await expect(rpc.rpc('turn/start', { threadId: 'thread', input: [] })).rejects.toThrow('-32001')
  await expect(rpc.rpc('turn/start', { threadId: 'thread', input: [] })).rejects.toThrow('会话输入被拒绝')
})

it('does not let a late old completion settle a new turn or offer stale recovery', async () => {
  const f = await fixture()
  f.send('turn/started', { turn: { id: 'new-turn' } })
  f.send('turn/completed', { turn: { id: 'old-turn', status: 'failed', error: { message: '旧错误' } } })
  await f.barrier()
  expect(f.store.sessions()[0].turnId).toBe('new-turn')
  expect(f.store.requests()[0].actions).toEqual(['ack'])
})
