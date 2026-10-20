import { expect, it, vi } from 'vitest'
import { ControlHub, formatRequest } from '../hub'
import { ControlStore } from '../store'
import { TelegramChannel } from './telegram'
import { telegramRequest } from './telegram-format'

it('explains background Claude recovery and distinguishes acknowledgement from task completion in every channel', () => {
  const store = new ControlStore()
  const session = store.session({ id: 's', nativeId: '01234567-89ab-cdef-0123-456789abcdef', agent: 'claude', adapter: 'hook', connected: false, label: '项目', capabilities: [] })
  const request = store.create({ sourceKey: 'failed', sessionId: 's', origin: 'observation', kind: 'error', title: '会话中断', detail: '', actions: ['resume', 'ack'], questions: [], expiresAt: Date.now() + 60000 })
  for (const format of [formatRequest, telegramRequest]) {
    expect(format(request, session)).toContain('后台')
    expect(format(request, session)).toContain('原终端不会同步显示')
    expect(format(request, session)).toContain(session.nativeId)
  }
  store.decide(request.id, request.revision, { action: 'resume' }, 'owner')
  store.mark(request.id, 'resolved')
  for (const format of [formatRequest, telegramRequest]) {
    expect(format(store.get(request.id), session)).toContain('已确认接收继续指令')
    expect(format(store.get(request.id), session)).toContain('不代表任务已完成')
    expect(format(store.get(request.id), session)).toContain('原终端不会同步显示')
  }
})

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
