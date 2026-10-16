import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { CONNECTION_TEST_MESSAGE, testRemoteConnection } from './connectivity'
import type { ChannelConfig } from './config'

const channel = (type: ChannelConfig['type'] = 'telegram'): ChannelConfig => ({
  id: 'test-channel', type, destination: 'target', allowedUsers: ['owner'],
  ...(type === 'feishu' || type === 'wecom' ? { appId: 'app', secretEnv: 'TEST_SECRET' } : { tokenEnv: 'TEST_TOKEN' })
})
const env = { TEST_TOKEN: 'test-token-value', TEST_SECRET: 'test-secret-value' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function websocket(handler: (message: any, peer: WebSocket) => void) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => server.once('listening', resolve))
  server.on('connection', peer => peer.on('message', bytes => handler(JSON.parse(bytes.toString()), peer)))
  cleanup.push(() => new Promise<void>(resolve => { for (const peer of server.clients) peer.terminate(); server.close(() => resolve()) }))
  return { server, url: `ws://127.0.0.1:${(server.address() as { port: number }).port}` }
}
const codex = (url: string, threads = ['live-thread']) => ({ kind: 'codex', config: { id: 'codex', url, threads } })

it('validates each draft and credential before making any network request', async () => {
  const fetchImpl = vi.fn<typeof fetch>()
  expect((await testRemoteConnection({ kind: 'channel', config: { ...channel(), allowedUsers: [] } }, { env, fetchImpl })).message).toContain('用户 ID')
  expect((await testRemoteConnection({ kind: 'channel', config: channel() }, { env: {}, fetchImpl })).message).toContain('TEST_TOKEN')
  expect((await testRemoteConnection({ kind: 'channel', config: { ...channel(), tokenEnv: 'actual-token:123' } }, { env, fetchImpl })).message).toContain('环境变量名称')
  expect((await testRemoteConnection(codex('ws://example.com'), { env, fetchImpl })).message).toContain('本机 ws')
  expect(fetchImpl).not.toHaveBeenCalled()
})

it('tests an unsaved Telegram draft by delivering one message without polling updates', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async url => json(String(url).endsWith('getWebhookInfo') ? { ok: true, result: { url: '' } } : { ok: true, result: { message_id: 7 } }))
  const result = await testRemoteConnection({ kind: 'channel', config: channel() }, { env, fetchImpl })
  expect(result).toEqual({ ok: true, message: '测试消息已发送到目标会话。' })
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  const [url, options] = fetchImpl.mock.calls[1]
  expect(String(url)).toContain('/sendMessage')
  expect(JSON.parse(options!.body as string)).toMatchObject({ chat_id: 'target', text: CONNECTION_TEST_MESSAGE })
  expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('getUpdates'))).toBe(false)
})

it('reports an existing Telegram webhook without deleting it or sending a message', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => json({ ok: true, result: { url: 'https://existing.example' } }))
  const result = await testRemoteConnection({ kind: 'channel', config: channel() }, { env, fetchImpl })
  expect(result.ok).toBe(false)
  expect(result.message).toContain('Webhook')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('reports Telegram target failures and never treats a malformed acknowledgement as delivery', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async url => json(String(url).endsWith('getWebhookInfo') ? { ok: true, result: {} } : { ok: false, error_code: 400 }))
  const result = await testRemoteConnection({ kind: 'channel', config: channel() }, { env, fetchImpl })
  expect(result.ok).toBe(false)
  expect(result.message).toContain('目标会话 ID')
  fetchImpl.mockImplementation(async url => json(String(url).endsWith('getWebhookInfo') ? { ok: true, result: {} } : { ok: true, result: {} }))
  expect((await testRemoteConnection({ kind: 'channel', config: channel() }, { env, fetchImpl })).ok).toBe(false)
})

it('authenticates a Feishu application and sends to the selected chat without starting a receiver', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async url => json(String(url).includes('/auth/') ? { code: 0, tenant_access_token: 'tenant-secret' } : { code: 0, data: { message_id: 'sent' } }))
  expect((await testRemoteConnection({ kind: 'channel', config: channel('feishu') }, { env, fetchImpl })).ok).toBe(true)
  expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({ app_id: 'app', app_secret: env.TEST_SECRET })
  const options = fetchImpl.mock.calls[1][1]!
  expect(options.headers).toMatchObject({ authorization: 'Bearer tenant-secret' })
  expect(JSON.parse(options.body as string)).toMatchObject({ receive_id: 'target', msg_type: 'text', content: JSON.stringify({ text: CONNECTION_TEST_MESSAGE }) })
})

it('stops a Feishu test after invalid credentials and explains send permission failures', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => json({ code: 10003 }))
  expect((await testRemoteConnection({ kind: 'channel', config: channel('feishu') }, { env, fetchImpl })).message).toContain('App Secret')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  fetchImpl.mockImplementation(async url => json(String(url).includes('/auth/') ? { code: 0, tenant_access_token: 'tenant-secret' } : { code: 230002 }))
  expect((await testRemoteConnection({ kind: 'channel', config: channel('feishu') }, { env, fetchImpl })).message).toContain('应用发布状态')
})

it('tests Discord delivery using REST with mentions disabled', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => json({ id: 'discord-message' }))
  expect((await testRemoteConnection({ kind: 'channel', config: channel('discord') }, { env, fetchImpl })).ok).toBe(true)
  const [url, options] = fetchImpl.mock.calls[0]
  expect(url).toBe('https://discord.com/api/v10/channels/target/messages')
  expect(options!.headers).toMatchObject({ authorization: `Bot ${env.TEST_TOKEN}` })
  expect(JSON.parse(options!.body as string)).toMatchObject({ allowed_mentions: { parse: [] } })
})

it('reports Discord permission failures without claiming success', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => json({ message: 'Missing Access' }, 403))
  const result = await testRemoteConnection({ kind: 'channel', config: channel('discord') }, { env, fetchImpl })
  expect(result.ok).toBe(false)
  expect(result.message).toContain('HTTP 403')
  expect(result.message).toContain('发送权限')
})

it('redacts both original and URL-encoded credentials from transport errors', async () => {
  const token = 'secret/value+123'
  const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error(`failed ${token} ${encodeURIComponent(token)}`) })
  const result = await testRemoteConnection({ kind: 'channel', config: channel('discord') }, { env: { TEST_TOKEN: token }, fetchImpl })
  expect(result.ok).toBe(false)
  expect(result.message).not.toContain(token)
  expect(result.message).not.toContain(encodeURIComponent(token))
  expect(result.message).toContain('[REDACTED]')
})

it('aborts a stalled HTTP test within the overall deadline', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })))
  const result = await testRemoteConnection({ kind: 'channel', config: channel() }, { env, fetchImpl, timeoutMs: 30 })
  expect(result.ok).toBe(false)
  expect(result.message).toContain('超时')
})

it('redacts proxy authentication from connection errors', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('proxy http://private-user:private-password@localhost:7890 failed: private-password') })
  const result = await testRemoteConnection({ kind: 'channel', config: channel(), proxy: {
    mode: 'custom', url: 'http://private-user:private-password@localhost:7890'
  } }, { env, fetchImpl })
  expect(result.ok).toBe(false)
  expect(result.message).not.toContain('private-user')
  expect(result.message).not.toContain('private-password')
})

it('verifies a Codex handshake and loaded threads without resuming or starting a turn', async () => {
  const received: any[] = []
  const { server, url } = await websocket((message, peer) => {
    received.push(message)
    if (message.id) peer.send(JSON.stringify({ id: message.id, result: message.method === 'thread/loaded/list' ? { data: ['live-thread'] } : {} }))
  })
  let authorization: string | undefined
  server.on('connection', (_peer, request) => { authorization = request.headers.authorization })
  const result = await testRemoteConnection({ kind: 'codex', config: { ...codex(url).config, tokenEnv: 'TEST_TOKEN' } }, { env })
  expect(result.ok).toBe(true)
  expect(authorization).toBe(`Bearer ${env.TEST_TOKEN}`)
  expect(received.map(message => message.method)).toEqual(['initialize', 'initialized', 'thread/loaded/list'])
  await vi.waitFor(() => expect(server.clients.size).toBe(0))
})

it('identifies Codex threads that are not loaded on the selected server', async () => {
  const { url } = await websocket((message, peer) => { if (message.id) peer.send(JSON.stringify({ id: message.id, result: message.method === 'thread/loaded/list' ? { data: ['other-thread'] } : {} })) })
  const result = await testRemoteConnection(codex(url))
  expect(result.ok).toBe(false)
  expect(result.message).toContain('live-thread')
  expect(result.message).toContain('尚未加载')
})

it.each([{ loaded: [] }, { loaded: ['live-thread'] }])('accepts automatic discovery with loaded threads=$loaded without subscribing', async ({ loaded }) => {
  const methods: string[] = []
  const { url } = await websocket((message, peer) => {
    if (message.id === undefined) return
    methods.push(message.method)
    peer.send(JSON.stringify({ id: message.id, result: message.method === 'thread/loaded/list' ? { data: loaded } : {} }))
  })
  const result = await testRemoteConnection(codex(url, []))
  expect(result.ok).toBe(true)
  expect(result.message).toContain(`当前有 ${loaded.length} 个已加载会话`)
  expect(result.message).toContain('自动发现')
  expect(methods).toEqual(['initialize', 'thread/loaded/list'])
})

it('checks all pages of loaded Codex threads', async () => {
  const cursors: unknown[] = []
  const { url } = await websocket((message, peer) => {
    if (!message.id) return
    let result = {}
    if (message.method === 'thread/loaded/list') {
      cursors.push(message.params.cursor)
      result = message.params.cursor ? { data: ['live-thread'], nextCursor: null } : { data: ['other-thread'], nextCursor: 'page-two' }
    }
    peer.send(JSON.stringify({ id: message.id, result }))
  })
  expect((await testRemoteConnection(codex(url))).ok).toBe(true)
  expect(cursors).toEqual([undefined, 'page-two'])
})

it('reports unsupported Codex protocol methods and closes the connection', async () => {
  const { server, url } = await websocket((message, peer) => { if (message.id) peer.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'method not found' } })) })
  const result = await testRemoteConnection(codex(url))
  expect(result.ok).toBe(false)
  expect(result.message).toContain('method not found')
  await vi.waitFor(() => expect(server.clients.size).toBe(0))
})

it('times out and cleans up a silent Codex server', async () => {
  const { server, url } = await websocket(() => {})
  expect((await testRemoteConnection(codex(url), { timeoutMs: 50 })).message).toContain('超时')
  await vi.waitFor(() => expect(server.clients.size).toBe(0))
})

it('authenticates WeCom, waits for delivery acknowledgement, and disconnects', async () => {
  const received: any[] = []
  const { server, url } = await websocket((message, peer) => {
    received.push(message)
    peer.send(JSON.stringify({ headers: message.headers, errcode: 0, errmsg: 'ok' }))
  })
  const result = await testRemoteConnection({ kind: 'channel', config: channel('wecom') }, { env, wecomUrl: url, timeoutMs: 1000 })
  expect(result.ok).toBe(true)
  expect(received.map(message => message.cmd)).toEqual(['aibot_subscribe', 'aibot_send_msg'])
  expect(received[1].body).toMatchObject({ chatid: 'target', msgtype: 'markdown', markdown: { content: CONNECTION_TEST_MESSAGE } })
  await vi.waitFor(() => expect(server.clients.size).toBe(0))
})

it('reports WeCom authentication failure without sending a message or retrying', async () => {
  const received: any[] = []
  const { server, url } = await websocket((message, peer) => { received.push(message); peer.send(JSON.stringify({ headers: message.headers, errcode: 40001, errmsg: 'invalid secret' })) })
  const result = await testRemoteConnection({ kind: 'channel', config: channel('wecom') }, { env, wecomUrl: url, timeoutMs: 1000 })
  expect(result.ok).toBe(false)
  expect(received.map(message => message.cmd)).toEqual(['aibot_subscribe'])
  await vi.waitFor(() => expect(server.clients.size).toBe(0))
})

it('times out WeCom delivery and closes its connection without a background retry', async () => {
  const { server, url } = await websocket((message, peer) => { if (message.cmd === 'aibot_subscribe') peer.send(JSON.stringify({ headers: message.headers, errcode: 0 })) })
  const result = await testRemoteConnection({ kind: 'channel', config: channel('wecom') }, { env, wecomUrl: url, timeoutMs: 50 })
  expect(result.message).toContain('超时')
  await vi.waitFor(() => expect(server.clients.size).toBe(0))
})
