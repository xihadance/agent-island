import { expect, it, vi } from 'vitest'
import { ControlHub, formatRequest } from '../hub'
import { ControlStore } from '../store'
import { TelegramChannel } from './telegram'

it('delivers a recovery card, authorizes the real callback and removes the button after native acknowledgement', async () => {
  const store = new ControlStore()
  const session = store.session({ id: 's', nativeId: 'native', agent: 'codex', adapter: 'codex', connected: false, label: '项目', capabilities: [] })
  const request = store.create({ sourceKey: 'failed', sessionId: 's', origin: 'observation', kind: 'error', title: '会话中断', detail: 'password=private-value', actions: ['resume', 'ack'], questions: [], expiresAt: Date.now() + 60000 })
  const calls: { method: string; body: any }[] = []
  let polled = false
  const fetchImpl: typeof fetch = vi.fn(async (url, init) => {
    const method = String(url).split('/').at(-1)!
    calls.push({ method, body: JSON.parse(String(init?.body)) })
    let result: unknown = { message_id: 12 }
    if (method === 'getUpdates') {
      if (polled) return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('关闭')), { once: true }))
      polled = true
      result = ['stranger', 'owner', 'owner'].map((sender, index) => ({ update_id: index + 1, callback_query: { id: `click${index}`, from: { id: sender }, message: { chat: { id: 'chat' } }, data: `${request.id}:1:resume` } }))
    }
    return new Response(JSON.stringify({ ok: true, result }))
  })
  const channel = new TelegramChannel('tg', 'chat', ['owner'], 'fake', store, fetchImpl)
  const hub = new ControlHub(store)
  const run = vi.fn(async () => {})
  hub.setResumer({ available: () => true, prepare: async () => run, close: () => {} })
  try {
    await channel.send(formatRequest(request, session), request, session)
    store.change(state => { state.deliveries[`tg/${request.id}`] = { messageId: '12', revision: 1, attempts: 0, retryAt: 0 } })
    await hub.addChannel(channel)
    await vi.waitFor(() => expect(store.get(request.id).status).toBe('resolved'))
    expect(run).toHaveBeenCalledTimes(1)
    const card = calls.find(call => call.method === 'sendMessage')!.body
    expect(card.reply_markup.inline_keyboard.flat()).toContainEqual({ text: '继续会话', callback_data: `${request.id}:1:resume` })
    expect(card.text).not.toContain('仅提醒')
    expect(card.text).not.toContain('private-value')
    await hub.flush()
    const update = calls.find(call => call.method === 'editMessageText')!.body
    expect(update.reply_markup.inline_keyboard.flat().some((button: any) => button.text === '继续会话')).toBe(false)
  } finally { hub.close() }
})
