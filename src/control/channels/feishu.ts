import * as Lark from '@larksuiteoapi/node-sdk'
import type { ChannelAdapter, InterventionRequest, RemoteMessage } from '../types'

export class FeishuChannel implements ChannelAdapter {
  private client: Lark.Client
  private ws: Lark.WSClient
  constructor(readonly id: string, readonly destination: string, readonly allowedUsers: string[], appId: string, appSecret: string) {
    this.client = new Lark.Client({ appId, appSecret, loggerLevel: Lark.LoggerLevel.error })
    this.ws = new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.error })
  }
  async start(receive: (message: RemoteMessage) => Promise<string>): Promise<void> {
    await this.ws.start({ eventDispatcher: new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async data => {
        if (data.message.message_type !== 'text') return
        const reply = await receive({ eventId: data.message.message_id, chat: data.message.chat_id, sender: data.sender.sender_id?.open_id ?? '',
          text: JSON.parse(data.message.content).text, replyTo: data.message.parent_id })
        if (reply) await this.send(reply)
      },
      'card.action.trigger': async (data: { token: string; action?: { value?: Record<string, unknown> }; operator?: { open_id?: string }; context?: { open_chat_id?: string } }) => {
        const value = data.action?.value
        if (!value) return {}
        void receive({ eventId: data.token, sender: data.operator?.open_id ?? '', chat: data.context?.open_chat_id ?? '', action: {
          requestId: String(value.requestId), revision: Number(value.revision), decision: { action: value.action as 'approve' }
        } }).then(async reply => { if (reply) await this.send(reply) }).catch(() => {})
        return { toast: { type: 'info', content: '已收到，处理结果将发送到会话' } }
      }
    }) })
  }
  async send(text: string, request?: InterventionRequest): Promise<string> {
    if (!request && text.length > 10000) {
      let id = ''
      for (let i = 0; i < text.length; i += 10000) { const next = await this.send(text.slice(i, i + 10000)); id ||= next }
      return id
    }
    const response = await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: {
      receive_id: this.destination, msg_type: 'interactive', content: card(text, request)
    } })
    if (response.code || !response.data?.message_id) throw new Error('飞书发送失败')
    return response.data.message_id
  }
  async update(messageId: string, text: string, request: InterventionRequest): Promise<void> {
    const response = await this.client.im.message.patch({ path: { message_id: messageId }, data: { content: card(text, request) } })
    if (response.code) throw new Error('飞书更新失败')
  }
  close(): void { this.ws.close({ force: true }) }
}
function card(text: string, r?: InterventionRequest): string {
  const actions = r?.status === 'pending' ? r.actions.filter(a => a !== 'answer').map(action => ({ tag: 'button', text: { tag: 'plain_text', content: { approve: '批准一次', deny: '拒绝', cancel: '取消', ack: '知道了' }[action] }, value: { requestId: r.id, revision: r.revision, action } })) : []
  return JSON.stringify({ config: { wide_screen_mode: true }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: text.slice(0, 12000) } }, ...(actions.length ? [{ tag: 'action', actions }] : [])] })
}
