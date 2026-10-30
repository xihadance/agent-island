import { beforeEach, expect, it, vi } from 'vitest'
import { ControlHub, formatRequest, redact } from '../hub'
import { ControlStore } from '../store'
import { DiscordChannel } from './discord'

const mocks = vi.hoisted(() => ({ handlers: {} as Record<string, (event: any) => void>, send: vi.fn(), edit: vi.fn() }))
vi.mock('discord.js', async importOriginal => {
  const actual = await importOriginal<typeof import('discord.js')>()
  return { ...actual, Client: class {
    channels = { fetch: async () => ({ isSendable: () => true, send: mocks.send, messages: { edit: mocks.edit } }) }
    on(name: string, handler: (event: any) => void) { mocks.handlers[name] = handler }
    async login() {}
    destroy() {}
  } }
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.send.mockResolvedValue({ id: 'notification' })
  mocks.edit.mockResolvedValue({})
})

it('delivers native embeds, authorizes full detail buttons, and settles approvals through the real hub', async () => {
  const store = new ControlStore()
  const hub = new ControlHub(store)
  const session = store.session({ id: 's', nativeId: 'native', agent: 'codex', label: 'Cute Island', cwd: 'D:/project', adapter: 'codex', connected: true, capabilities: ['approve'] })
  const request = store.create({ sessionId: 's', sourceKey: 'source', origin: 'codex', kind: 'approval', title: '执行测试', detail: 'npm test\n'.repeat(900), questions: [], actions: ['approve', 'deny'], expiresAt: Date.now() + 60000 })
  const respond = vi.fn(async () => {})
  hub.attach('s', { respond, sendMessage: vi.fn(), interrupt: vi.fn(), close() {} })
  const channel = new DiscordChannel('dc', 'chat', ['owner'], 'test-token')
  try {
    await hub.addChannel(channel)
    await hub.flush()
    const payload = mocks.send.mock.calls[0][0]
    expect(payload.embeds[0].title).toBe('审批请求 · 待审批')
    expect(JSON.stringify(payload.embeds)).toContain('D:/project')
    expect(payload.components.flatMap((row: any) => row.toJSON().components).map((button: any) => button.custom_id)).toEqual([
      `${request.id}:1:approve`, `${request.id}:1:deny`, `${request.id}:1:detail`
    ])
    const interaction = { isButton: () => true, id: 'detail-event', channelId: 'chat', user: { id: 'stranger' }, customId: `${request.id}:1:detail`,
      deferReply: vi.fn(async () => {}), editReply: vi.fn(async () => {}), followUp: vi.fn(async () => {}) }
    mocks.handlers.interactionCreate(interaction)
    await Promise.resolve()
    expect(interaction.deferReply).not.toHaveBeenCalled()
    interaction.user.id = 'owner'
    mocks.handlers.interactionCreate(interaction)
    await vi.waitFor(() => expect(interaction.followUp).toHaveBeenCalled())
    const detail = [interaction.editReply.mock.calls[0], ...interaction.followUp.mock.calls].map((call: any) => call[0].content).join('')
    expect(detail).toBe(`#${request.id}\n${request.title}\n${request.detail}`)
    for (const call of interaction.followUp.mock.calls as any[]) { expect(call[0].content.length).toBeLessThanOrEqual(2000); expect(call[0].flags).toBe(64) }
    expect(respond).not.toHaveBeenCalled()
    expect(store.get(request.id).status).toBe('pending')
    interaction.id = 'approve-event'
    interaction.customId = `${request.id}:1:approve`
    mocks.handlers.interactionCreate(interaction)
    await vi.waitFor(() => expect(store.get(request.id).status).toBe('submitted'))
    expect(respond).toHaveBeenCalledOnce()
    await channel.update('notification', '', store.get(request.id), session)
    expect(mocks.edit.mock.calls.at(-1)![1].embeds[0].title).toContain('已提交 Agent，等待确认')
    store.mark(request.id, 'resolved')
    const closed = store.get(request.id)
    await channel.update('notification', formatRequest(closed, session), closed, session)
    const updated = mocks.edit.mock.calls.at(-1)![1]
    expect(updated.embeds[0].title).toContain('已处理')
    expect(updated.components.flatMap((row: any) => row.toJSON().components).map((button: any) => button.label)).toEqual(['查看详情'])
    expect(updated.allowedMentions.parse).toEqual([])
  } finally { hub.close() }
})

it('sends long replies intact with redaction before pagination and without broken emoji', async () => {
  const channel = new DiscordChannel('dc', 'chat', ['owner'], 'test-token')
  const text = '🧪'.repeat(2500) + '\nAuthorization: Bearer hidden-credential'
  try {
    expect(await channel.send(text)).toBe('notification')
    const pages = mocks.send.mock.calls.map(call => call[0].content)
    expect(pages.join('')).toBe(redact(text))
    for (const page of pages) { expect(page.length).toBeLessThanOrEqual(2000); expect(Buffer.from(page).toString('utf8')).toBe(page) }
  } finally { channel.close() }
})
