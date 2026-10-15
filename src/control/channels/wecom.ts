import AiBot from '@wecom/aibot-node-sdk'
import type { ChannelAdapter, InterventionRequest, RemoteMessage } from '../types'

export class WecomChannel implements ChannelAdapter {
  private ws: InstanceType<typeof AiBot.WSClient>
  constructor(readonly id: string, readonly destination: string, readonly allowedUsers: string[], botId: string, secret: string) {
    this.ws = new AiBot.WSClient({ botId, secret, maxReconnectAttempts: -1, logger: { debug() {}, info() {}, warn() {}, error() {} } })
  }
  async start(receive: (message: RemoteMessage) => Promise<string>): Promise<void> {
    this.ws.on('error', () => {})
    this.ws.on('message.text', frame => {
      const body = frame.body
      if (!body) return
      void receive({ eventId: body.msgid, sender: body.from.userid, chat: body.chatid ?? body.from.userid, text: body.text?.content })
        .then(async reply => { if (reply) await this.send(reply) }).catch(() => {})
    })
    this.ws.on('event.template_card_event', frame => {
      const body = frame.body
      if (!body) return
      if ((body.chatid ?? body.from.userid) !== this.destination || !this.allowedUsers.includes(body.from.userid)) return
      const [requestId, revision, action] = (body.event?.event_key ?? '').split(':')
      void this.ws.updateTemplateCard(frame, { card_type: 'text_notice', main_title: { title: '正在处理，请查看回复' }, task_id: body.event?.task_id }).catch(() => {})
      void receive({ eventId: frame.headers.req_id, sender: body.from.userid, chat: body.chatid ?? body.from.userid,
        action: { requestId, revision: Number(revision), decision: { action: action as 'approve' } }
      }).then(async reply => { if (reply) await this.send(reply) }).catch(() => {})
    })
    this.ws.connect()
  }
  async send(text: string, r?: InterventionRequest): Promise<string> {
    if (!r && Buffer.byteLength(text) > 3500) {
      let id = ''
      for (let i = 0; i < text.length; i += 800) { const next = await this.send(text.slice(i, i + 800)); id ||= next }
      return id
    }
    const actions = r?.status === 'pending' ? r.actions.filter(a => a !== 'answer') : []
    const body = r && actions.length ? { msgtype: 'template_card' as const, template_card: { card_type: 'button_interaction' as const,
      main_title: { title: `#${r.id} ${r.title}`.slice(0, 100), desc: text.slice(0, 2000) }, task_id: `${r.id}@${r.revision}`,
      button_list: actions.map(action => ({ text: { approve: '批准一次', deny: '拒绝', cancel: '取消', ack: '知道了' }[action], key: `${r.id}:${r.revision}:${action}`, style: 1 as const }))
    } } : { msgtype: 'markdown' as const, markdown: { content: (r ? text.slice(0, 800) : text).replace(/<@/g, '< @') } }
    const result = await this.ws.sendMessage(this.destination, body)
    return String(result.headers.req_id)
  }
  async update(_messageId: string, text: string, request: InterventionRequest): Promise<void> {
    // WeCom edits require a live callback frame; unsolicited status changes are follow-ups.
    await this.send(text, request.status === 'pending' ? request : undefined)
  }
  close(): void { this.ws.disconnect() }
}
