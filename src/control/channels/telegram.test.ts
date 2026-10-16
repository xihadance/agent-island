import { expect, it, vi } from 'vitest'
import { ControlStore } from '../store'
import { ControlHub, formatRequest } from '../hub'
import { TelegramChannel } from './telegram'

it('sends and edits HTML notifications, preserving identity and removing settled decision buttons', async () => {
  const store = new ControlStore()
  const session = store.session({ id: 's', nativeId: 'native', agent: 'codex', adapter: 'codex', connected: true, label: 'Codex', capabilities: ['approve', 'message'] })
  const r = store.create({ sessionId: 's', sourceKey: 'source', origin: 'codex', kind: 'approval', title: '执行命令', detail: 'echo "<test>" && pwd', actions: ['approve', 'deny'], questions: [], expiresAt: Date.now() + 60000 })
  const bodies: any[] = []
  const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ ok: true, result: { message_id: 12 } }))
  })
  const channel = new TelegramChannel('tg', '99', ['42'], 'test-token', store, fetchImpl)
  try {
    expect(await channel.send(formatRequest(r, session), r, session)).toBe('12')
    store.mark(r.id, 'cancelled')
    const closed = store.get(r.id)
    await channel.update('12', formatRequest(closed, session), closed, session)
    expect(bodies.every(body => body.parse_mode === 'HTML' && body.link_preview_options.is_disabled)).toBe(true)
    expect(bodies[0].text).toContain('&lt;test&gt;')
    expect(bodies[0].reply_markup.inline_keyboard.flat().map((button: any) => button.callback_data)).toEqual([`${r.id}:1:approve`, `${r.id}:1:deny`, `${r.id}:1:detail`])
    expect(bodies[1].message_id).toBe(12)
    expect(bodies[1].text).toContain('已取消')
    expect(bodies[1].reply_markup.inline_keyboard).toEqual([[{ text: '查看详情', callback_data: `${r.id}:2:detail` }]])
  } finally { channel.close() }
})

it('routes detail buttons through hub authorization and sends complete HTML pages without making decisions', async () => {
  const store = new ControlStore()
  store.session({ id: 's', nativeId: 'native', agent: 'codex', adapter: 'observation', connected: false, label: 'Codex', capabilities: [] })
  const r = store.create({ sessionId: 's', sourceKey: 'source', origin: 'observation', kind: 'approval', title: '查看命令', detail: '<test>🧪\n'.repeat(1800), actions: ['ack'], questions: [], expiresAt: Date.now() + 60000 })
  const calls: { method: string; body: any }[] = []
  let polls = 0
  const fetchImpl: typeof fetch = vi.fn(async (url, init) => {
    const method = String(url).split('/').at(-1)!
    calls.push({ method, body: JSON.parse(String(init?.body)) })
    let result: unknown = {}
    if (method === 'getUpdates') {
      if (polls++) return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      result = [
        { update_id: 7, callback_query: { id: 'unauthorized', from: { id: 10 }, message: { chat: { id: 99 } }, data: `${r.id}:1:detail` } },
        { update_id: 8, callback_query: { id: 'details', from: { id: 42 }, message: { chat: { id: 99 } }, data: `${r.id}:1:detail` } }
      ]
    }
    return new Response(JSON.stringify({ ok: true, result }))
  })
  const hub = new ControlHub(store)
  const channel = new TelegramChannel('tg', '99', ['42'], 'test-token', store, fetchImpl)
  try {
    await channel.start(message => hub.receive(channel, message))
    await vi.waitFor(() => expect(store.snapshot().cursors.tg).toBe(9))
    const replies = calls.filter(call => call.method === 'sendMessage')
    expect(replies.length).toBeGreaterThan(1)
    expect(replies.every(call => call.body.parse_mode === 'HTML')).toBe(true)
    expect(calls.findIndex(call => call.method === 'sendMessage')).toBeGreaterThan(calls.findIndex(call => call.method === 'answerCallbackQuery' && call.body.callback_query_id === 'details'))
    expect(replies.map(call => call.body.text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')).join('')).toBe(`查看命令\n请求 ${r.id}\n\n${r.detail}`)
    expect(store.get(r.id).status).toBe('pending')
    expect(store.get(r.id).decision).toBeUndefined()
  } finally { channel.close(); hub.close() }
})

it('persists polling offsets, acknowledges callbacks and delivers the original request identity', async () => {
  const store = new ControlStore()
  const calls: { method: string; body: any }[] = []
  let polls = 0
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!
    const body = JSON.parse(String(init?.body))
    calls.push({ method, body })
    let result: unknown = {}
    if (method === 'getUpdates') {
      if (polls++) return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      result = [{ update_id: 7, callback_query: { id: 'cb', from: { id: 42 }, message: { message_id: 12, chat: { id: 99 } }, data: 'request123:1:approve' } }]
    }
    if (method === 'sendMessage') result = { message_id: 13 }
    return new Response(JSON.stringify({ ok: true, result }))
  }) as typeof fetch
  const channel = new TelegramChannel('tg', '99', ['42'], 'test-token', store, fetchImpl)
  const receive = vi.fn(async () => '已提交')
  try {
    await channel.start(receive)
    await vi.waitFor(() => expect(store.snapshot().cursors.tg).toBe(8))
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ sender: '42', chat: '99', action: { requestId: 'request123', revision: 1, decision: { action: 'approve' } } }))
    expect(calls.findIndex(c => c.method === 'answerCallbackQuery')).toBeLessThan(calls.findIndex(c => c.method === 'sendMessage'))
    expect(calls.filter(c => c.method === 'getUpdates')[1].body.offset).toBe(8)
  } finally { channel.close() }
})

it('does not remove an existing webhook', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { url: 'https://existing.example/hook' } })))
  const channel = new TelegramChannel('tg', '99', ['42'], 'test-token', new ControlStore(), fetchImpl)
  await expect(channel.start(async () => '')).rejects.toThrow('Webhook')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  channel.close()
})

it.each([
  'Bad Request: query is too old and response timeout expired or query ID is invalid',
  'Bad Request: QUERY_ID_INVALID'
])('advances past an expired callback acknowledgement: %s', async description => {
  const store = new ControlStore()
  const calls: { method: string; body: any }[] = []
  let polls = 0
  const fetchImpl: typeof fetch = vi.fn(async (url, init) => {
    const method = String(url).split('/').at(-1)!
    const body = JSON.parse(String(init?.body))
    calls.push({ method, body })
    if (method === 'answerCallbackQuery') return new Response(JSON.stringify({ ok: false, error_code: 400, description }), { status: 400 })
    let result: unknown = {}
    if (method === 'getUpdates') {
      if (polls++) return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      result = [
        { update_id: 7, callback_query: { id: 'expired', from: { id: 42 }, message: { message_id: 12, chat: { id: 99 } }, data: 'request123:1:approve' } },
        { update_id: 8, message: { message_id: 13, from: { id: 42 }, chat: { id: 99 }, text: '/pending' } }
      ]
    }
    return new Response(JSON.stringify({ ok: true, result }))
  })
  const channel = new TelegramChannel('tg', '99', ['42'], 'test-token', store, fetchImpl)
  const receive = vi.fn(async () => '')
  try {
    await channel.start(receive)
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'getUpdates')).toHaveLength(2))
    expect(store.snapshot().cursors.tg).toBe(9)
    expect(calls.filter(c => c.method === 'getUpdates')[1].body.offset).toBe(9)
    expect(receive).toHaveBeenCalledTimes(2)
    expect(receive).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: { requestId: 'request123', revision: 1, decision: { action: 'approve' } } }))
    expect(receive).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: '/pending' }))
  } finally { channel.close() }
})

it('does not silently consume updates when callback acknowledgement fails for another reason', async () => {
  let acknowledged = false
  const store = new ControlStore()
  const fetchImpl: typeof fetch = vi.fn(async url => {
    const method = String(url).split('/').at(-1)!
    if (method === 'answerCallbackQuery') {
      acknowledged = true
      return new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 })
    }
    const result = method === 'getUpdates' ? [{ update_id: 7, callback_query: { id: 'cb', from: { id: 42 }, message: { chat: { id: 99 } }, data: 'r:1:approve' } }] : {}
    return new Response(JSON.stringify({ ok: true, result }))
  })
  const channel = new TelegramChannel('tg', '99', ['42'], 'test-token', store, fetchImpl)
  const receive = vi.fn(async () => '')
  try {
    await channel.start(receive)
    await vi.waitFor(() => expect(acknowledged).toBe(true))
    expect(store.snapshot().cursors.tg).toBeUndefined()
    expect(receive).not.toHaveBeenCalled()
  } finally { channel.close() }
})
