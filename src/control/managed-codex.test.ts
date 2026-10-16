import { afterEach, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { ActivityStore } from '../shared/activity'
import { createControlRuntime, managedCodexConnections } from './runtime'
import { TelegramChannel } from './channels/telegram'
import type { RemoteConfig } from './config'
import type { InterventionRequest, RemoteMessage } from './types'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('forwards managed approvals to configured messaging channels while keeping the terminal subscribed', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => server.once('listening', resolve))
  cleanup.push(() => { for (const peer of server.clients) peer.terminate(); server.close() })
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`
  const subscribers = new Set<WebSocket>()
  const replies: unknown[] = []
  server.on('connection', peer => {
    peer.on('close', () => subscribers.delete(peer))
    peer.on('message', bytes => {
      const message = JSON.parse(bytes.toString())
      if (!message.method) {
        replies.push(message)
        for (const subscriber of subscribers) subscriber.send(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'native', requestId: message.id } }))
        return
      }
      if (message.id === undefined) return
      if (message.method === 'thread/resume') subscribers.add(peer)
      peer.send(JSON.stringify({ id: message.id, result: message.method === 'thread/loaded/list' ? { data: ['native'] }
        : message.method === 'thread/resume' ? { thread: { name: '工作区', turns: [{ id: 'turn', status: 'inProgress' }] } } : {} }))
    })
  })
  const terminal = new WebSocket(url)
  cleanup.push(() => terminal.terminate())
  await new Promise<void>(resolve => terminal.once('open', resolve))
  terminal.send(JSON.stringify({ id: 'terminal-init', method: 'initialize', params: {} }))
  terminal.send(JSON.stringify({ id: 'terminal-resume', method: 'thread/resume', params: { threadId: 'native' } }))
  const terminalRequests: Record<string, any>[] = []
  terminal.on('message', bytes => { const message = JSON.parse(bytes.toString()); if (message.method) terminalRequests.push(message) })

  let receive!: (message: RemoteMessage) => Promise<string>
  vi.stubEnv('ISLAND_MANAGED_TEST_TOKEN', 'synthetic-token')
  vi.spyOn(TelegramChannel.prototype, 'start').mockImplementation(async callback => { receive = callback })
  const sent: InterventionRequest[] = []
  vi.spyOn(TelegramChannel.prototype, 'send').mockImplementation(async (_text, request) => { if (request) sent.push(request); return `message-${request?.id}` })
  const updated = vi.spyOn(TelegramChannel.prototype, 'update').mockResolvedValue()
  const config: RemoteConfig = { mode: 'takeover', enabled: true, controlToken: 'test', port: 17321, stateFile: '',
    channels: [{ id: 'phone', type: 'telegram', destination: 'chat', allowedUsers: ['owner'], tokenEnv: 'ISLAND_MANAGED_TEST_TOKEN' }], codex: [] }
  const activities = new ActivityStore()
  cleanup.push(() => activities.dispose())
  let hostedUrl = ''
  const runtime = createControlRuntime(config, activities, { managedCodexUrl: () => hostedUrl })
  cleanup.push(() => runtime.close())
  await runtime.start()
  await vi.waitFor(() => expect(receive).toBeTypeOf('function'))
  expect(subscribers.size).toBe(1)
  hostedUrl = url
  runtime.syncManagedCodex()
  await vi.waitFor(() => expect(subscribers.size).toBe(2))
  runtime.syncManagedCodex()
  expect(subscribers.size).toBe(2)

  const broadcast = (id: number) => {
    for (const peer of subscribers) peer.send(JSON.stringify({ id, method: 'item/commandExecution/requestApproval',
      params: { threadId: 'native', turnId: 'turn', itemId: `tool-${id}`, command: 'npm test', availableDecisions: ['accept', 'decline'] } }))
  }
  activities.upsert({ id: 'codex-native', agent: 'Codex', state: 'approval', title: '执行测试', operation: { kind: 'command', command: 'npm test' } })
  broadcast(900)
  await vi.waitFor(() => expect(sent.some(request => request.nativeRequestId === 900)).toBe(true))
  const remote = sent.find(request => request.nativeRequestId === 900)!
  expect(remote).toMatchObject({ origin: 'codex', actions: ['approve', 'deny'], status: 'pending' })
  expect(terminalRequests).toContainEqual(expect.objectContaining({ id: 900, method: 'item/commandExecution/requestApproval' }))
  expect(runtime.hub.store.snapshot().requests.filter(request => request.origin === 'observation' && request.kind === 'approval').every(request => request.status === 'cancelled')).toBe(true)
  expect(replies).toEqual([])
  await receive({ eventId: 'phone-approve', sender: 'owner', chat: 'chat', action: { requestId: remote.id, revision: remote.revision, decision: { action: 'approve' } } })
  await vi.waitFor(() => expect(runtime.hub.store.get(remote.id).status).toBe('resolved'))
  expect(replies).toEqual([{ id: 900, result: { decision: 'accept' } }])
  expect(terminalRequests).toContainEqual({ method: 'serverRequest/resolved', params: { threadId: 'native', requestId: 900 } })

  broadcast(901)
  await vi.waitFor(() => expect(sent.some(request => request.nativeRequestId === 901)).toBe(true))
  const next = sent.find(request => request.nativeRequestId === 901)!
  terminal.send(JSON.stringify({ id: 901, result: { decision: 'decline' } }))
  await vi.waitFor(() => expect(runtime.hub.store.get(next.id).status).toBe('cancelled'))
  await runtime.hub.flush()
  expect(updated).toHaveBeenCalledWith(`message-${next.id}`, expect.any(String), expect.objectContaining({ id: next.id, status: 'cancelled' }), expect.anything())
  expect(await receive({ eventId: 'late-approve', sender: 'owner', chat: 'chat', action: { requestId: next.id, revision: next.revision, decision: { action: 'approve' } } })).toContain('已处理')
  expect(replies).toHaveLength(2)
  hostedUrl = ''
  runtime.syncManagedCodex()
  await vi.waitFor(() => expect(subscribers.size).toBe(1))
  expect(terminal.readyState).toBe(WebSocket.OPEN)
  hostedUrl = url
  runtime.syncManagedCodex()
  await vi.waitFor(() => expect(subscribers.size).toBe(2))
  runtime.setEnabled(false)
  await vi.waitFor(() => expect(subscribers.size).toBe(1))
  runtime.setEnabled(true)
  await vi.waitFor(() => expect(subscribers.size).toBe(2))
  expect(config.codex).toEqual([])
})

it('reuses a legacy hosted entry once and preserves connections to other servers', () => {
  const configured = [{ id: 'local', url: 'ws://localhost:4500', threads: ['old-scope'] },
    { id: 'other', url: 'wss://other.test', threads: ['pinned'] }]
  expect(managedCodexConnections(configured, 'ws://127.0.0.1:4500')).toEqual([
    configured[1], { id: 'local', url: 'ws://127.0.0.1:4500', threads: [], proxy: { mode: 'direct' } }
  ])
  expect(configured[0].threads).toEqual(['old-scope'])
  expect(managedCodexConnections(configured, '')).toEqual(configured)
})
