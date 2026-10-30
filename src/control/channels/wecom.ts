import type { ChannelTransport } from '../proxy'
import AiBot from '@wecom/aibot-node-sdk'
import type { ChannelAdapter, ControlSession, InterventionRequest, RemoteMessage } from '../types'
import { redact, textChunks } from '../notification'
import { wecomActionCard, wecomRequest } from './request-format'

export class WecomChannel implements ChannelAdapter {
  private ws: InstanceType<typeof AiBot.WSClient>
  constructor(readonly id: string, readonly destination: string, readonly allowedUsers: string[], botId: string, secret: string, transport?: ChannelTransport) {
    this.ws = new AiBot.WSClient({ botId, secret, wsOptions: { agent: transport?.agent }, maxReconnectAttempts: -1, logger: { debug() {}, info() {}, warn() {}, error() {} } })
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
  async send(text: string, r?: InterventionRequest, session?: ControlSession): Promise<string> {
    const pages = r ? wecomRequest(r, session) : textChunks(redact(text).replace(/<@/g, '< @'), 3500, true)
    let id = ''
    for (const content of pages) {
      const result = await this.ws.sendMessage(this.destination, { msgtype: 'markdown', markdown: { content } })
      id ||= String(result.headers.req_id)
    }
    if (r?.status === 'pending' && r.actions.some(a => a !== 'answer')) {
      const result = await this.ws.sendMessage(this.destination, { msgtype: 'template_card', template_card: wecomActionCard(r, session) })
      id = String(result.headers.req_id)
    }
    return id
  }
  async update(_messageId: string, text: string, request: InterventionRequest, session?: ControlSession): Promise<void> {
    // WeCom edits require a live callback frame; unsolicited status changes are follow-ups.
    await this.send(text, request, session)
  }
  close(): void { this.ws.disconnect() }
}
