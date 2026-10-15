import { beforeEach, expect, it, vi } from 'vitest'
import { FeishuChannel } from './feishu'
import { WecomChannel } from './wecom'
import { ControlStore } from '../store'

const mocks = vi.hoisted(() => ({
  feishuHandlers: {} as Record<string, (data: any) => Promise<any>>,
  wecomHandlers: {} as Record<string, (frame: any) => void>,
  create: vi.fn(), patch: vi.fn(), push: vi.fn(), updateCard: vi.fn()
}))
vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { error: 'error' },
  Client: class { im = { message: { create: mocks.create, patch: mocks.patch } } },
  WSClient: class { async start() {} close() {} },
  EventDispatcher: class { register(handlers: typeof mocks.feishuHandlers) { mocks.feishuHandlers = handlers; return this } }
}))
vi.mock('@wecom/aibot-node-sdk', () => ({ default: { WSClient: class {
  on(name: string, callback: (frame: any) => void) { mocks.wecomHandlers[name] = callback }
  connect() {} disconnect() {}
  sendMessage = mocks.push
  updateTemplateCard = mocks.updateCard
} } }))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockResolvedValue({ code: 0, data: { message_id: 'fm' } })
  mocks.patch.mockResolvedValue({ code: 0 })
  mocks.push.mockResolvedValue({ headers: { req_id: 'wm' } })
  mocks.updateCard.mockResolvedValue({})
})

it('receives Feishu messages and actions with stable user, chat and request IDs', async () => {
  const channel = new FeishuChannel('fs', 'chat', ['owner'], 'app', 'secret')
  const receive = vi.fn(async () => '')
  await channel.start(receive)
  await mocks.feishuHandlers['im.message.receive_v1']({ message: { message_id: 'm', chat_id: 'chat', message_type: 'text', content: '{"text":"/sessions"}', parent_id: 'original' }, sender: { sender_id: { open_id: 'owner' } } })
  expect(receive).toHaveBeenLastCalledWith({ eventId: 'm', chat: 'chat', sender: 'owner', text: '/sessions', replyTo: 'original' })
  const result = await mocks.feishuHandlers['card.action.trigger']({ token: 'callback', operator: { open_id: 'owner' }, context: { open_chat_id: 'chat' }, action: { value: { requestId: 'r', revision: 2, action: 'deny' } } })
  expect(result.toast.content).toContain('已收到')
  expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ eventId: 'callback', action: { requestId: 'r', revision: 2, decision: { action: 'deny' } } }))
  await channel.send('x'.repeat(24000))
  expect(mocks.create).toHaveBeenCalledTimes(3)
  channel.close()
})

it('gates WeCom card callbacks before editing, routes valid decisions and sends long details intact', async () => {
  const channel = new WecomChannel('wc', 'chat', ['owner'], 'bot', 'secret')
  const receive = vi.fn(async () => '')
  await channel.start(receive)
  const frame = { headers: { req_id: 'event' }, body: { from: { userid: 'stranger' }, chatid: 'chat', event: { event_key: 'r:3:approve', task_id: 'r@3' } } }
  mocks.wecomHandlers['event.template_card_event'](frame)
  expect(receive).not.toHaveBeenCalled()
  expect(mocks.updateCard).not.toHaveBeenCalled()
  frame.body.from.userid = 'owner'
  mocks.wecomHandlers['event.template_card_event'](frame)
  expect(receive).toHaveBeenCalledWith({ eventId: 'event', sender: 'owner', chat: 'chat', action: { requestId: 'r', revision: 3, decision: { action: 'approve' } } })
  await channel.send('中文详情'.repeat(2000))
  const reconstructed = mocks.push.mock.calls.map(c => c[1].markdown.content).join('')
  expect(reconstructed).toBe('中文详情'.repeat(2000))
  for (const [, body] of mocks.push.mock.calls) expect(Buffer.byteLength(body.markdown.content)).toBeLessThanOrEqual(3500)
  channel.close()
})

it('sends WeCom cards with valid unique task IDs and preserves request routing in button keys', async () => {
  const store = new ControlStore()
  store.session({ id: 's', nativeId: 'native', agent: 'claude', adapter: 'hook', label: 'project', connected: true, capabilities: ['approve'] })
  const request = store.create({ sessionId: 's', sourceKey: 'r', origin: 'hook', kind: 'approval', title: '运行测试', detail: 'npm test', questions: [], actions: ['approve', 'deny'], expiresAt: Date.now() + 60000 })
  const channel = new WecomChannel('wc', 'chat', ['owner'], 'bot', 'secret')
  mocks.push.mockImplementation(async (_destination, body) => {
    // Match the installed SDK's task_id contract, including the byte limit.
    expect(body.template_card.task_id).toMatch(/^[A-Za-z0-9_@-]+$/)
    expect(Buffer.byteLength(body.template_card.task_id)).toBeLessThanOrEqual(128)
    return { headers: { req_id: 'wm' } }
  })
  try {
    await channel.send('确认运行测试', request)
    await channel.send('更新后的请求', { ...request, revision: request.revision + 1 })
    const [first, second] = mocks.push.mock.calls.map(call => call[1].template_card)
    expect(first.task_id).not.toBe(second.task_id)
    expect(first.button_list[0].key).toBe(`${request.id}:${request.revision}:approve`)
  } finally { channel.close() }
})
