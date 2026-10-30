import type { ControlStore } from '../store'
import type { ChannelAdapter, ControlSession, InterventionRequest, RemoteMessage } from '../types'
import { telegramReply, telegramRequest } from './telegram-format'
import { ACTION_LABEL, redact } from '../notification'

export class TelegramChannel implements ChannelAdapter {
  private abort = new AbortController()
  private stopped = false
  constructor(readonly id: string, readonly destination: string, readonly allowedUsers: string[], private readonly token: string,
    private readonly store: ControlStore, private readonly fetchImpl: typeof fetch = fetch, private readonly base = 'https://api.telegram.org') {}
  async start(receive: (message: RemoteMessage) => Promise<string>): Promise<void> {
    // Never silently delete an existing webhook or compete with a different application.
    const info = await this.api('getWebhookInfo', {})
    if (info.url) throw new Error('Telegram Bot 已设置 Webhook，请使用专用 Bot 或先明确移除 Webhook')
    void this.poll(receive)
  }
  private async api(method: string, data: unknown): Promise<any> {
    const response = await this.fetchImpl(`${this.base}/bot${this.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(35000)]) })
    const result = await response.json() as { ok: boolean; result: unknown; error_code?: number; description?: string }
    if (!result.ok) {
      if (method === 'editMessageText' && result.description?.includes('message is not modified')) return {}
      // A callback acknowledgement only dismisses Telegram's spinner. Expired
      // queries must not pin the polling offset and starve subsequent updates.
      if (method === 'answerCallbackQuery' && result.error_code === 400 && /query is too old|query (?:id|ID) is invalid|QUERY_ID_INVALID/i.test(result.description ?? '')) return {}
      throw new Error(`Telegram API 请求失败 (${result.error_code ?? response.status})`)
    }
    return result.result
  }
  async send(text: string, request?: InterventionRequest, session?: ControlSession): Promise<string> {
    const pages = request ? [telegramRequest(request, session)] : telegramReply(text)
    let id = ''
    for (const page of pages) {
      const result = await this.api('sendMessage', { chat_id: this.destination, text: page, parse_mode: 'HTML', reply_markup: keyboard(request, this.draft(request)), link_preview_options: { is_disabled: true } })
      id ||= String(result.message_id)
    }
    return id
  }
  async update(messageId: string, _text: string, request: InterventionRequest, session?: ControlSession): Promise<void> {
    await this.api('editMessageText', { chat_id: this.destination, message_id: Number(messageId), text: telegramRequest(request, session), parse_mode: 'HTML', reply_markup: keyboard(request, this.draft(request)), link_preview_options: { is_disabled: true } })
  }
  private draft(request?: InterventionRequest): Record<string, string[]> {
    const draft = request && this.store.snapshot().answerDrafts?.[`${this.id}/${request.id}`]
    return draft && draft.revision === request?.revision ? draft.answers : {}
  }
  private async poll(receive: (message: RemoteMessage) => Promise<string>): Promise<void> {
    let delay = 1000
    while (!this.stopped) {
      try {
        const updates = await this.api('getUpdates', { offset: this.store.snapshot().cursors[this.id] ?? 0, timeout: 25, allowed_updates: ['message', 'callback_query'] })
        for (const update of updates) {
          if (this.stopped) return
          const callback = update.callback_query
          const message = callback?.message ?? update.message
          const sender = String(callback?.from?.id ?? message?.from?.id ?? '')
          const chat = String(message?.chat?.id ?? '')
          if (callback) await this.api('answerCallbackQuery', { callback_query_id: callback.id })
          if (this.stopped) return
          if (sender && chat && (callback || message?.text)) {
            let action: RemoteMessage['action']
            let selection: RemoteMessage['selection']
            let submitAnswers: RemoteMessage['submitAnswers']
            let text = message.text
            if (callback?.data) {
              const [requestId, rev, command, option, choice] = String(callback.data).split(':')
              const r = this.store.snapshot().requests.find(r => r.id === requestId)
              if (command === 'detail') text = `/detail ${requestId}`
              else if (command === 'choose') selection = { requestId, revision: Number(rev), question: Number(option), option: Number(choice) }
              else if (command === 'submit') submitAnswers = { requestId, revision: Number(rev) }
              else if (r && command === 'pick' && r.questions.length === 1) action = { requestId, revision: Number(rev), decision: { action: 'answer', answers: { [r.questions[0].id]: [r.questions[0].options[Number(option)]] } } }
              else action = { requestId, revision: Number(rev), decision: { action: command as 'approve' } }
            }
            const reply = await receive({ eventId: String(update.update_id), sender, chat, text, replyTo: message.reply_to_message ? String(message.reply_to_message.message_id) : undefined, action,
              ...(selection ? { selection } : {}), ...(submitAnswers ? { submitAnswers } : {}) })
            if (this.stopped) return
            if ((selection || submitAnswers) && chat === this.destination && this.allowedUsers.includes(sender)) {
              const state = this.store.snapshot()
              const requestId = (selection ?? submitAnswers)!.requestId
              const request = state.requests.find(r => r.id === requestId)
              const delivery = state.deliveries[`${this.id}/${requestId}`]
              if (request && delivery?.messageId) await this.update(delivery.messageId, '', request, state.sessions.find(s => s.id === request.sessionId))
            }
            if (reply) for (const page of telegramReply(reply, text)) await this.api('sendMessage', { chat_id: chat, text: page, parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
          }
          this.store.change(state => { state.cursors[this.id] = update.update_id + 1 })
        }
        delay = 1000
      } catch {
        if (this.stopped) return
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve() }
          const timer = setTimeout(done, delay)
          this.abort.signal.addEventListener('abort', done, { once: true })
        })
        delay = Math.min(delay * 2, 30000)
      }
    }
  }
  close(): void { this.stopped = true; this.abort.abort() }
}
export function keyboard(request?: InterventionRequest, answers: Record<string, string[]> = {}): { inline_keyboard: unknown[][] } {
  if (!request) return { inline_keyboard: [] }
  const details = [{ text: '查看详情', callback_data: `${request.id}:${request.revision}:detail` }]
  if (request.status !== 'pending') return { inline_keyboard: [details] }
  const rows: unknown[][] = [request.actions.filter(a => a !== 'answer').map(action => ({ text: ACTION_LABEL[action], callback_data: `${request.id}:${request.revision}:${action}` }))]
  const q = request.questions[0]
  if (request.actions.includes('answer') && request.questions.length === 1 && !q.multi) q.options.forEach((option, i) => rows.push([{ text: Array.from(redact(option)).slice(0, 60).join(''), callback_data: `${request.id}:${request.revision}:pick:${i}` }]))
  else if (request.actions.includes('answer')) {
    request.questions.forEach((question, questionIndex) => question.options.forEach((option, optionIndex) => rows.push([{
      text: Array.from(`${answers[question.id]?.includes(option) ? '已选 · ' : ''}${questionIndex + 1}.${optionIndex + 1} ${redact(option)}`).slice(0, 60).join(''),
      callback_data: `${request.id}:${request.revision}:choose:${questionIndex}:${optionIndex}`
    }])))
    if (request.questions.some(question => question.options.length)) rows.push([{ text: '提交回答', callback_data: `${request.id}:${request.revision}:submit` }])
  }
  return { inline_keyboard: [...rows.filter(r => r.length), details] }
}
