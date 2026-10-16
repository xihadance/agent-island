import { createHash } from 'node:crypto'
import { activityId } from '../agents/parse'
import type { Activity } from '../shared/activity'
import { isUserInputTool } from '../shared/island-behavior'
import { check, ControlStore, string, uid } from './store'
import { ACTIVE_STATUSES, STATUS_LABEL, type AgentControlAdapter, type ChannelAdapter, type ControlSession, type Decision, type Guidance, type InterventionRequest, type RemoteMessage } from './types'

export function redact(text: string): string {
  // An unquoted Authorization header owns the rest of its line (e.g. Digest
  // can contain spaces, commas and quotes). Also handle headers inside JSON.
  return text.replace(/(\b(?:proxy-)?authorization[\t ]*(?:\\?["'])?[\t ]*[:=][\t ]*)(?:\\"(?:(?!\\").)*\\"|"(?:\\.|[^"\\])*"|'[^']*'|[^\r\n]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{16,}|xox[baprs]-[\w-]+|\d{6,}:[\w-]{25,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?-----END [\w ]*PRIVATE KEY-----/g, '[REDACTED]')
}
export function formatRequest(r: InterventionRequest, session?: ControlSession): string {
  const text = [`${session?.agent ?? 'Agent'} · ${session?.label ?? r.sessionId}`, `#${r.id} · ${STATUS_LABEL[r.status]}`, r.title,
    `完整内容：/detail ${r.id}`, r.detail.length > 800 ? `${r.detail.slice(0, 800)}\n…内容较长，请查看完整内容后决定。` : r.detail]
  r.questions.forEach(q => text.push(`${q.id}: ${q.text}${q.multi ? '（多选）' : ''}`, ...q.options.map((s, i) => `  ${i + 1}. ${s}`)))
  if (r.status === 'pending') {
    if (r.actions.includes('answer')) text.push(r.questions.length === 1 ? '引用此消息直接回答；多选请发送 JSON 答案。' : '回答格式：',
      `/answer ${r.id} ${JSON.stringify(Object.fromEntries(r.questions.map(q => [q.id, [q.options[0] ?? '你的回答']])) )}`)
    text.push(...r.actions.filter(a => a !== 'answer').map(a => `/${a} ${r.id}`))
  }
  if (session?.connected && session.capabilities.includes('message')) text.push(`补充指导：/send ${r.sessionId} 内容`)
  return redact(text.filter(Boolean).join('\n'))
}

export class ControlHub {
  private adapters = new Map<string, AgentControlAdapter>()
  private channels: ChannelAdapter[] = []
  private startingChannels = new Set<ChannelAdapter>()
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  private flushing = false
  private inbound: Promise<unknown> = Promise.resolve()
  constructor(readonly store: ControlStore, private readonly log: (message: string) => void = console.error) {}
  attach(sessionId: string, adapter: AgentControlAdapter): void { this.adapters.set(sessionId, adapter) }
  async addChannel(channel: ChannelAdapter): Promise<void> {
    if (this.closed) { channel.close(); return }
    this.startingChannels.add(channel)
    try {
      await channel.start(message => {
        const run = this.inbound.then(() => this.receive(channel, message))
        this.inbound = run.catch(() => {})
        return run
      })
    } finally { this.startingChannels.delete(channel) }
    if (this.closed) { channel.close(); return }
    this.channels.push(channel)
  }
  start(): void {
    const tick = async () => {
      if (this.closed) return
      try { this.store.expire(); await this.flush() } catch { this.log('远程接管状态更新失败；请检查本机状态文件和连接') }
      if (!this.closed) this.timer = setTimeout(tick, 1500)
    }
    void tick()
  }
  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    for (const channel of this.startingChannels) channel.close()
    for (const channel of this.channels) channel.close()
    for (const adapter of new Set(this.adapters.values())) adapter.close()
  }
  async respond(id: string, revision: number, decision: Decision, by: string): Promise<InterventionRequest> {
    check(!this.closed, '远程接管已停用', 409)
    const request = this.store.get(id)
    const session = this.store.snapshot().sessions.find(s => s.id === request.sessionId)
    check(decision.action === 'ack' || session?.connected, '会话未连接，无法提交操作', 409)
    const next = this.store.decide(id, revision, decision, by)
    if (next.origin === 'codex') {
      const adapter = this.adapters.get(next.sessionId)
      if (!adapter) { this.store.mark(id, 'uncertain'); throw new Error('控制连接已断开，操作结果待确认') }
      this.store.mark(id, 'submitted')
      try { await adapter.respond(next) } catch { if (!this.closed) this.store.mark(id, 'uncertain'); throw new Error('提交结果待确认，请检查原会话') }
    }
    return this.store.get(id)
  }
  async send(sessionId: string, text: string, by: string): Promise<Guidance> {
    check(!this.closed, '远程接管已停用', 409)
    const session = this.store.snapshot().sessions.find(s => s.id === sessionId)
    check(session?.connected && session.capabilities.includes('message'), '该会话尚未接管或不支持追加指令', 409)
    string(text, '消息', 16000)
    check(this.store.snapshot().guidance.filter(m => m.status === 'queued').length < 100, '指导消息队列已满', 429)
    const message = this.store.change(state => {
      const m: Guidance = { id: uid(), sessionId, text, by, createdAt: this.store.now(), status: 'queued' }
      state.guidance.push(m)
      state.guidance = [...state.guidance.filter(x => ['queued', 'submitted', 'uncertain'].includes(x.status)), ...state.guidance.filter(x => ['resolved', 'cancelled'].includes(x.status)).slice(-500)]
      return m
    })
    if (session.adapter === 'codex') {
      this.store.change(state => { state.guidance.find(m => m.id === message.id)!.status = 'submitted' })
      try { await this.adapters.get(sessionId)!.sendMessage(message) }
      catch { if (!this.closed) this.store.change(state => { state.guidance.find(m => m.id === message.id)!.status = 'uncertain' }); throw new Error('追加消息结果待确认') }
    }
    return this.store.snapshot().guidance.find(m => m.id === message.id)!
  }
  async receive(channel: ChannelAdapter, message: RemoteMessage): Promise<string> {
    if (this.closed) return ''
    if (message.chat !== channel.destination || !channel.allowedUsers.includes(message.sender)) return ''
    const eventKey = `${channel.id}/${message.eventId}`
    if (this.store.snapshot().seen.includes(eventKey)) return '此消息已处理'
    // Record before acting. On a crash, never replay a potentially committed control action.
    this.store.change(state => { state.seen.push(eventKey); state.seen = state.seen.slice(-10000) })
    try {
      const by = `${channel.id}:${message.sender}`
      if (message.action) {
        const delivery = this.store.snapshot().deliveries[`${channel.id}/${message.action.requestId}`]
        check(delivery?.messageId, '此请求未发送到当前渠道', 403)
        return STATUS_LABEL[(await this.respond(message.action.requestId, message.action.revision, message.action.decision, by)).status]
      }
      const text = message.text?.trim() ?? ''
      const match = /^\/(\w+)(?:@\w+)?(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(text)
      if (match) {
        const [, command, id, tail] = match
        if (command === 'sessions') return this.store.snapshot().sessions.map(s => `${s.id}\n${s.agent} · ${s.label} · ${s.connected && s.adapter !== 'observation' ? '已接管' : '观察/离线'}${s.adapter === 'hook' ? '（指令在 Hook 处理点接收）' : ''}`).join('\n\n') || '暂无会话'
        if (command === 'pending') {
          const state = this.store.snapshot()
          return [...state.requests.filter(r => ACTIVE_STATUSES.includes(r.status) || r.status === 'uncertain').map(r => formatRequest(r)),
            ...state.guidance.filter(m => ['queued', 'submitted', 'uncertain'].includes(m.status)).map(m => `指导 #${m.id} · ${STATUS_LABEL[m.status]} · ${m.sessionId}`)].join('\n\n') || '暂无待办'
        }
        if (command === 'detail') {
          const r = this.store.get(id)
          return redact([`#${r.id}`, r.title, r.detail, ...(r.questions.length ? ['问题与选项：', JSON.stringify(r.questions, null, 2)] : [])].join('\n'))
        }
        if (command === 'status') {
          const state = this.store.snapshot()
          const r = state.requests.find(r => r.id === id)
          const m = state.guidance.find(m => m.id === id)
          return r ? formatRequest(r) : m ? `#${m.id} · ${STATUS_LABEL[m.status]}` : '未找到请求或消息'
        }
        if (command === 'send') { const m = await this.send(id, tail ?? '', by); return `#${m.id} · ${STATUS_LABEL[m.status]}` }
        if (command === 'interrupt') {
          const session = this.store.snapshot().sessions.find(s => s.id === id)
          check(session?.connected && session.capabilities.includes('interrupt'), '该会话不支持远程中断')
          await this.adapters.get(id)!.interrupt(session)
          return '已请求中断；请查看会话结果'
        }
        if (['approve', 'deny', 'cancel', 'ack', 'answer'].includes(command)) {
          const r = this.store.get(id)
          const decision: Decision = command === 'answer' ? answerDecision(r, tail ?? '') : { action: command as Decision['action'] }
          return STATUS_LABEL[(await this.respond(id, r.revision, decision, by)).status]
        }
        return '命令：/sessions /pending /detail ID /status ID /approve ID /deny ID /cancel ID /ack ID /answer ID 答案 /send 会话ID 内容 /interrupt 会话ID'
      }
      if (message.replyTo) {
        const state = this.store.snapshot()
        const entry = Object.entries(state.deliveries).find(([key, d]) => key.startsWith(`${channel.id}/`) && d.messageId === message.replyTo)
        check(entry, '未找到引用消息对应的请求')
        const r = this.store.get(entry[0].split('/').at(-1)!)
        check(r.kind === 'input', '请使用明确的审批命令；补充指令使用 /send 会话ID 内容')
        return STATUS_LABEL[(await this.respond(r.id, r.revision, answerDecision(r, text), by)).status]
      }
      return '请引用问题通知回答，或用 /sessions 选择会话后发送 /send 会话ID 内容。'
    } catch (error) { return redact(error instanceof Error ? error.message : '操作失败') }
  }
  async flush(): Promise<void> {
    if (this.flushing || this.closed || !this.channels.length) return
    this.flushing = true
    try {
      // A scan is one immutable revision of the state. Changes during an awaited
      // send keep their newer revision and are picked up by the next scan.
      const snapshot = this.store.snapshot()
      const sessions = new Map(snapshot.sessions.map(session => [session.id, session]))
      for (const channel of this.channels) for (const request of snapshot.requests) {
        if (this.closed) return
        const key = `${channel.id}/${request.id}`
        const delivery = snapshot.deliveries[key]
        if (delivery?.revision === request.revision || (delivery?.retryAt ?? 0) > this.store.now()) continue
        if (!delivery?.messageId && request.status !== 'pending') continue
        const text = formatRequest(request, sessions.get(request.sessionId))
        try {
          const messageId = delivery?.messageId ?? await channel.send(text, request, sessions.get(request.sessionId))
          if (this.closed) return
          if (delivery?.messageId) await channel.update(messageId, text, request, sessions.get(request.sessionId))
          if (this.closed) return
          this.store.change(state => { state.deliveries[key] = { messageId, revision: request.revision, attempts: 0, retryAt: 0 } })
        } catch {
          if (this.closed) return
          const attempts = (delivery?.attempts ?? 0) + 1
          this.store.change(state => { state.deliveries[key] = { ...delivery, revision: delivery?.revision ?? 0, attempts, retryAt: this.store.now() + Math.min(60000, 1000 * 2 ** Math.min(attempts, 6)) } })
          this.log(`渠道 ${channel.id} 发送失败，稍后重试`)
        }
      }
    } finally { this.flushing = false }
  }
  observe(activities: readonly Activity[]): void {
    if (this.closed) return
    const found = new Set<string>()
    for (const activity of activities) {
      const state = this.store.snapshot()
      const controlled = state.sessions.find(s => s.adapter !== 'observation' && s.connected && activityId(s.agent, s.nativeId) === activity.id)
      const issues: { key: string; kind: 'approval' | 'input' | 'error'; title: string; detail: string }[] = []
      if (!controlled || !state.requests.some(r => r.sessionId === controlled.id && ACTIVE_STATUSES.includes(r.status))) {
        if (activity.state === 'approval') issues.push({ key: 'approval', kind: 'approval', title: activity.title, detail: activity.operation?.command ?? activity.detail ?? '' })
        if (['running', 'waiting'].includes(activity.state) && isUserInputTool(activity.operation?.name)) issues.push({ key: 'input', kind: 'input', title: '需要人工回答（尚未建立问题控制关联）', detail: activity.title })
      }
      if (activity.state === 'error') issues.push({ key: 'error', kind: 'error', title: activity.title, detail: activity.detail ?? '' })
      for (const task of activity.tasks ?? []) if (task.status === 'error' || (task.status === 'active' && task.state === 'approval')) {
        issues.push({ key: `task:${task.id}:${task.startedAt}`, kind: task.status === 'error' ? 'error' : 'approval', title: `子任务：${task.label}`, detail: task.detail ?? '' })
      }
      for (const issue of issues) {
        const fingerprint = createHash('sha256').update(JSON.stringify([activity.id, activity.startedAt, issue.key, issue.kind,
          issue.key === 'approval' ? activity.operation : issue.key === 'error' ? activity.title : null,
          activity.steps.filter(s => s.status === 'waiting' || s.status === 'error').map(s => s.id)])).digest('hex')
        found.add(fingerprint)
        if (state.requests.some(r => r.origin === 'observation' && r.toolKey === fingerprint && r.status !== 'cancelled')) continue
        const sessionId = controlled?.id ?? `observe:${activity.id}`
        if (!controlled && !state.sessions.some(s => s.id === sessionId)) this.store.session({ id: sessionId, nativeId: activity.id, agent: inferAgent(activity.agent), adapter: 'observation', label: activity.agent, capabilities: [], connected: false })
        this.store.create({ sourceKey: `observe:${uid()}`, sessionId, origin: 'observation', kind: issue.kind, title: issue.title, detail: `${issue.detail}\n仅通知；此事件没有可用的原生控制请求。`, toolKey: fingerprint, questions: [], actions: ['ack'], expiresAt: this.store.now() + 24 * 3600000 })
      }
    }
    for (const r of this.store.snapshot().requests) if (r.origin === 'observation' && r.toolKey && !found.has(r.toolKey) && !['cancelled', 'expired'].includes(r.status)) this.store.mark(r.id, 'cancelled')
  }
}
function inferAgent(label: string): ControlSession['agent'] {
  return /claude/i.test(label) ? 'claude' : /gemini/i.test(label) ? 'gemini' : /cursor/i.test(label) ? 'cursor' : 'codex'
}
function answerDecision(r: InterventionRequest, text: string): Decision {
  if (text.startsWith('{')) { try { return { action: 'answer', answers: JSON.parse(text) } } catch { throw new Error('答案 JSON 无效') } }
  check(r.questions.length === 1 && !r.questions[0].multi, '多个问题或多选题请使用 JSON 格式答案')
  return { action: 'answer', answers: { [r.questions[0].id]: [text] } }
}
