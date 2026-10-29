import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexAdapter } from './codex'
import { ControlHub } from './hub'
import { ControlStore } from './store'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(close => close()))

async function fixture(subscription?: { turns: { id: string; status: string }[]; notifications: Record<string, unknown>[] }) {
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
      if (message.method === 'thread/resume') for (const notification of subscription?.notifications ?? []) socket.send(JSON.stringify(notification))
      socket.send(JSON.stringify({ id: message.id, result: message.method === 'thread/loaded/list' ? { data: ['thread'] }
        : message.method === 'thread/resume' ? { thread: { name: '测试', turns: subscription?.turns ?? [] } } : {} }))
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
  const request = (id: number, turnId: string) => peer.send(JSON.stringify({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId } }))
  const rpc = adapter as unknown as { rpc(method: string, params: unknown): Promise<unknown> }
  const barrier = () => rpc.rpc('fixture/barrier', {})
  return { store, hub, adapter, send, request, barrier, received }
}

it('keeps a newly started turn authoritative over an older subscription snapshot', async () => {
  const f = await fixture({ turns: [{ id: 'old-turn', status: 'inProgress' }], notifications: [
    { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'new-turn' } } }
  ] })
  expect(f.store.sessions()[0].turnId).toBe('new-turn')
  f.send('turn/completed', { turn: { id: 'old-turn', status: 'failed', error: { message: '旧错误' } } })
  f.send('turn/completed', { turn: { id: 'new-turn', status: 'failed', error: { message: '本轮错误' } } })
  await f.barrier()
  expect(f.store.requests()).toHaveLength(1)
  expect(f.store.requests()[0]).toMatchObject({ turnId: 'new-turn', actions: ['resume', 'ack'] })
})

it('does not reactivate a turn completed while its subscription snapshot was in flight', async () => {
  const f = await fixture({ turns: [{ id: 'turn', status: 'inProgress' }], notifications: [
    { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } }
  ] })
  expect(f.store.sessions()[0].turnId).toBeUndefined()
  f.request(100, 'turn')
  await f.barrier()
  expect(f.store.requests()).toEqual([])
})

it('keeps a native gate received during subscription associated with its live turn', async () => {
  const f = await fixture({ turns: [{ id: 'old-turn', status: 'completed' }], notifications: [
    { id: 100, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'new-turn' } }
  ] })
  expect(f.store.sessions()[0].turnId).toBe('new-turn')
  f.request(101, 'old-turn')
  f.send('turn/completed', { turn: { id: 'new-turn', status: 'completed' } })
  await f.barrier()
  expect(f.store.requests()).toHaveLength(1)
  expect(f.store.requests()[0].status).toBe('cancelled')
  expect(f.store.sessions()[0].turnId).toBeUndefined()
})

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
  expect(f.store.requests()).toEqual([])
})

it('never announces a late error after this turn has successfully completed', async () => {
  const f = await fixture()
  f.send('turn/started', { turn: { id: 'turn' } })
  f.send('turn/completed', { turn: { id: 'turn', status: 'completed' } })
  f.send('error', { turnId: 'turn', willRetry: false, error: { message: '迟到的错误' } })
  f.send('turn/completed', { turn: { id: 'turn', status: 'failed', error: { message: '迟到的失败通知' } } })
  f.request(100, 'turn')
  await f.barrier()
  expect(f.store.requests()).toEqual([])
  expect(f.received.some(message => message.id === 100)).toBe(false)
})

it('keeps an explicit interruption without a failure quiet', async () => {
  const f = await fixture()
  f.send('turn/started', { turn: { id: 'turn' } })
  f.send('turn/completed', { turn: { id: 'turn', status: 'interrupted' } })
  await f.barrier()
  expect(f.store.requests()).toEqual([])
})

it('retires a provisional error when the same turn later completes successfully', async () => {
  const f = await fixture()
  f.send('turn/started', { turn: { id: 'turn' } })
  f.send('error', { turnId: 'turn', willRetry: false, error: { message: '已恢复的错误' } })
  await f.barrier()
  const request = f.store.requests()[0]
  f.send('turn/completed', { turn: { id: 'turn', status: 'completed' } })
  f.send('error', { turnId: 'turn', willRetry: false, error: { message: '已恢复的错误' } })
  await f.barrier()
  expect(f.store.get(request.id).status).toBe('cancelled')
  expect(f.store.requests()).toHaveLength(1)
})
