import { beforeEach, expect, it, vi } from 'vitest'
import { FeishuChannel } from './feishu'
import { WecomChannel } from './wecom'
import { ControlStore } from '../store'
import { createChannelTransport } from '../proxy'

const mocks = vi.hoisted(() => ({
  feishuHandlers: {} as Record<string, (data: any) => Promise<any>>,
  wecomHandlers: {} as Record<string, (frame: any) => void>,
  create: vi.fn(), patch: vi.fn(), push: vi.fn(), updateCard: vi.fn(), larkHttp: vi.fn(), larkWs: vi.fn(), wecomWs: vi.fn()
}))
vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { error: 'error' },
  Client: class { constructor(options: unknown) { mocks.larkHttp(options) } im = { message: { create: mocks.create, patch: mocks.patch } } },
  WSClient: class { constructor(options: unknown) { mocks.larkWs(options) } async start() {} close() {} },
  EventDispatcher: class { register(handlers: typeof mocks.feishuHandlers) { mocks.feishuHandlers = handlers; return this } }
}))
vi.mock('@wecom/aibot-node-sdk', () => ({ default: { WSClient: class {
  constructor(options: unknown) { mocks.wecomWs(options) }
  on(name: string, callback: (frame: any) => void) { mocks.wecomHandlers[name] = callback }
  connect() {} disconnect() {}
  sendMessage = mocks.push
  updateTemplateCard = mocks.updateCard
} } }))

it('supplies the selected proxy to both Feishu clients and the WeCom WebSocket', () => {
  const transport = createChannelTransport({ mode: 'custom', url: 'http://127.0.0.1:7890' })
  const feishu = new FeishuChannel('fs', 'chat', ['owner'], 'app', 'secret', transport)
  const wecom = new WecomChannel('wc', 'chat', ['owner'], 'bot', 'secret', transport)
  expect(mocks.larkHttp).toHaveBeenCalledWith(expect.objectContaining({ httpInstance: transport.http }))
  expect(mocks.larkWs).toHaveBeenCalledWith(expect.objectContaining({ httpInstance: transport.http, agent: transport.agent }))
  expect(mocks.wecomWs).toHaveBeenCalledWith(expect.objectContaining({ wsOptions: { agent: transport.agent } }))
  feishu.close(); wecom.close(); transport.close()
})
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
    if (body.template_card) {
      expect(body.template_card.task_id).toMatch(/^[A-Za-z0-9_@-]+$/)
      expect(Buffer.byteLength(body.template_card.task_id)).toBeLessThanOrEqual(128)
    }
    return { headers: { req_id: 'wm' } }
  })
  try {
    await channel.send('确认运行测试', request)
    await channel.send('更新后的请求', { ...request, revision: request.revision + 1 })
    const [first, second] = mocks.push.mock.calls.filter(call => call[1].template_card).map(call => call[1].template_card)
    expect(first.task_id).not.toBe(second.task_id)
    expect(first.button_list[0].key).toBe(`${request.id}:${request.revision}:approve`)
  } finally { channel.close() }
})

it('delivers the same type and file comparison through Feishu cards and WeCom detail messages', async () => {
  const store = new ControlStore()
  const session = store.session({ id: 's', nativeId: 'native', agent: 'claude', adapter: 'hook', label: 'Cute Island', cwd: 'D:/project', connected: true, capabilities: ['approve'] })
  const request = store.create({ sessionId: 's', sourceKey: 'source', origin: 'hook', kind: 'approval', title: '修改文件', detail: JSON.stringify({
    file_path: 'src/login.ts', old_string: 'return false', new_string: 'return true', command: '🧪'.repeat(3000)
  }), questions: [], actions: ['approve', 'deny'], expiresAt: Date.now() + 60000 })
  const feishu = new FeishuChannel('fs', 'chat', ['owner'], 'app', 'secret')
  const wecom = new WecomChannel('wc', 'chat', ['owner'], 'bot', 'secret')
  try {
    await feishu.send('摘要', request, session)
    await wecom.send('摘要', request, session)
    const card = JSON.parse(mocks.create.mock.calls[0][0].data.content)
    expect(card.header.title.content).toBe('审批请求 · 待审批')
    const pages = mocks.push.mock.calls.filter(call => call[1].markdown).map(call => call[1].markdown.content)
    for (const output of [JSON.stringify(card), pages.join('\n')]) for (const value of ['D:/project', '目标文件', 'src/login.ts', '变更前', 'return false', '变更后', 'return true']) expect(output).toContain(value)
    for (const page of pages) { expect(Buffer.byteLength(page)).toBeLessThanOrEqual(3500); expect(Buffer.from(page).toString('utf8')).toBe(page) }
    const actionCard = mocks.push.mock.calls.at(-1)![1].template_card
    expect(actionCard.main_title.title).toBe(card.header.title.content)
    expect(actionCard.button_list[0].key).toBe(`${request.id}:1:approve`)
    store.mark(request.id, 'resolved')
    mocks.push.mockClear()
    await feishu.update('fm', '', store.get(request.id), session)
    await wecom.update('wm', '', store.get(request.id), session)
    expect(JSON.parse(mocks.patch.mock.calls[0][0].data.content).header.title.content).toContain('已处理')
    expect(mocks.push.mock.calls.every(call => call[1].msgtype === 'markdown')).toBe(true)
    expect(mocks.push.mock.calls.map(call => call[1].markdown.content).join('\n')).toContain('审批请求 · 已处理')
  } finally { feishu.close(); wecom.close() }
})
