import { expect, it, vi } from 'vitest'
import { ControlStore } from '../store'
import { TelegramChannel } from './telegram'

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
