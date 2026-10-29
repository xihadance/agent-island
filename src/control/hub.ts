import { createHash } from 'node:crypto'
import { activityId } from '../agents/parse'
import type { Activity, SessionSource } from '../shared/activity'
import { attentionIssues } from '../shared/island-behavior'
import { check, ControlStore, string, uid } from './store'
import { ACTIVE_STATUSES, STATUS_LABEL, type AgentControlAdapter, type ChannelAdapter, type ControlSession, type Decision, type Guidance, type InterventionRequest, type RemoteMessage, type SessionResumer } from './types'

export const RESUME_PROMPT = '请继续上次异常中断的任务。先核对已有进度和执行结果，避免重复已完成的操作，再完成剩余工作。'

export function recoveryHint(r: InterventionRequest, session?: ControlSession): string {
  if (!r.actions.includes('resume')) return ''
  if (r.status !== 'pending' && r.decision?.action !== 'resume') return '已关闭提醒。'
  const status = r.status === 'pending' ? '选择“继续会话”恢复原会话并继续未完成的任务；“知道了”只关闭提醒。'
    : r.status === 'resolved' ? '已确认接收继续指令，不代表任务已完成。'
      : r.status === 'submitted' ? '已提交恢复请求，等待原生确认。'
        : '恢复结果待确认，请检查会话日志；系统不会自动重试。'
  if (session?.agent !== 'claude') return status
  if (session.terminal) return `${status}\n继续指令通过原生 Channels 发送到当前终端；收到 Agent 确认后更新状态。`
  return `${status}\nClaude Code 在后台延续同一会话，原终端不会同步显示。请在灵动岛查看进度；后台执行结束后，可在本机使用 claude --resume ${session.nativeId} 查看会话。`
}

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
  r.questions.forEach(q => text.push(`${q.id}: ${q.text}${q.multi ? '（多选）' : ''}`, ...q.options.map((s, i) => `  ${i + 1}. ${s}${q.descriptions?.[i] ? `：${q.descriptions[i]}` : ''}`)))
  if (r.decision?.answers) text.push('已提交回答：', ...r.questions.map(q => `${q.id}: ${r.decision!.answers![q.id]?.join('、') ?? ''}`))
  text.push(recoveryHint(r, session))
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
  private terminals = new Map<string, AgentControlAdapter>()
  private channels: ChannelAdapter[] = []
  private startingChannels = new Set<ChannelAdapter>()
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  private flushing = false
  private inbound: Promise<unknown> = Promise.resolve()
  private resumer?: SessionResumer
  private resuming = new Set<string>()
  private source: (id: string) => SessionSource | undefined = () => undefined
  constructor(readonly store: ControlStore, private readonly log: (message: string) => void = console.error) {}
  attach(sessionId: string, adapter: AgentControlAdapter): void { this.adapters.set(sessionId, adapter) }
  attachTerminal(sessionId: string, adapter: AgentControlAdapter): void {
    check(!this.closed && !this.terminals.has(sessionId), '此会话已有终端接入，请勿重复连接', 409)
    this.terminals.set(sessionId, adapter)
  }
  detachTerminal(sessionId: string, adapter: AgentControlAdapter): void {
    if (this.terminals.get(sessionId) !== adapter) return
    this.terminals.delete(sessionId)
    this.store.change(state => { const session = state.sessions.find(session => session.id === sessionId); if (session) session.connected = false })
  }
  terminal(sessionId: string): AgentControlAdapter | undefined { return this.terminals.get(sessionId) }
  setResumer(resumer: SessionResumer, source: (id: string) => SessionSource | undefined = () => undefined): void { this.resumer = resumer; this.source = source }
  recoveryActions(sessionId: string, sessions = this.store.sessions()): InterventionRequest['actions'] {
    const session = sessions.find(s => s.id === sessionId)
    return session && this.resumer?.available(session) ? ['resume', 'ack'] : ['ack']
  }
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
    this.resumer?.close()
    clearTimeout(this.timer)
    for (const channel of this.startingChannels) channel.close()
    for (const channel of this.channels) channel.close()
    for (const adapter of new Set(this.adapters.values())) adapter.close()
    for (const terminal of this.terminals.values()) terminal.close()
    this.terminals.clear()
  }
  async respond(id: string, revision: number, decision: Decision, by: string): Promise<InterventionRequest> {
    check(!this.closed, '远程接管已停用', 409)
    if (decision.action === 'resume') return this.resume(id, revision, by)
    const request = this.store.get(id)
    const session = this.store.sessions().find(s => s.id === request.sessionId)
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
  async resume(id: string, revision: number, by: string, text = RESUME_PROMPT): Promise<InterventionRequest> {
    check(!this.closed, '远程接管已停用', 409)
    string(text, '继续指令', 16000)
    const request = this.store.get(id)
    const session = this.store.sessions().find(s => s.id === request.sessionId)
    check(request.kind === 'error' && request.actions.includes('resume') && session && this.resumer, '此通知不支持恢复会话', 409)
    check(request.status === 'pending' && request.revision === revision && request.expiresAt > this.store.now(), '请求已处理、已失效或版本已变化', 409)
    const key = `${session.agent}:${session.nativeId}`
    check(!this.resuming.has(key), '此会话正在恢复，请勿重复操作', 409)
    this.resuming.add(key)
    let submitted = false
    try {
      // Preparation is read-only. Revalidate the notification after awaiting native liveness checks.
      const run = await this.resumer.prepare(session, text, request)
      check(!this.closed, '远程接管已停用', 409)
      this.store.decide(id, revision, { action: 'resume' }, by)
      this.store.change(state => {
        const current = state.requests.find(r => r.id === id)!
        current.status = 'submitted'; current.revision++
        current.detail += `\n继续指令：${text}`
        const aliases = new Set(state.sessions.filter(s => s.agent === session.agent && s.nativeId === session.nativeId).map(s => s.id))
        for (const other of state.requests) if (other.id !== id && aliases.has(other.sessionId) && other.actions.includes('resume') && other.status === 'pending') {
          other.status = 'resolved'; other.revision++
        }
      })
      submitted = true
      // Return promptly so this channel can approve tools while the resumed CLI starts.
      void Promise.resolve().then(run).then(() => {
        if (!this.closed) this.store.mark(id, 'resolved')
      }, error => {
        if (!this.closed) this.store.change(state => {
          const current = state.requests.find(r => r.id === id)!
          current.status = 'uncertain'; current.revision++
          current.detail += `\n恢复结果待确认，请检查原会话；系统不会自动重试。${error instanceof Error ? error.message : ''}`
        })
      }).catch(() => this.log('恢复结果记录失败，请检查原会话和状态文件')).finally(() => this.resuming.delete(key))
      return this.store.get(id)
    } finally { if (!submitted) this.resuming.delete(key) }
  }
  async send(sessionId: string, text: string, by: string): Promise<Guidance> {
    check(!this.closed, '远程接管已停用', 409)
    const session = this.store.sessions().find(s => s.id === sessionId)
    check(session?.connected && session.capabilities.includes('message'), '该会话尚未接管或不支持追加指令', 409)
    const terminal = this.terminals.get(sessionId)
    check(!session.terminal || terminal, '原生终端接入已断开，请重新连接', 409)
    string(text, '消息', 16000)
    check(this.store.snapshot().guidance.filter(m => m.status === 'queued').length < 100, '指导消息队列已满', 429)
    const message = this.store.change(state => {
      const m: Guidance = { id: uid(), sessionId, text, by, createdAt: this.store.now(), status: 'queued' }
      state.guidance.push(m)
      state.guidance = [...state.guidance.filter(x => ['queued', 'submitted', 'uncertain'].includes(x.status)), ...state.guidance.filter(x => ['resolved', 'cancelled'].includes(x.status)).slice(-500)]
      return m
    })
    if (session.adapter === 'codex' || terminal) {
      this.store.change(state => { state.guidance.find(m => m.id === message.id)!.status = 'submitted' })
      if (terminal) {
        // Agent confirmation may require a remote approval. Keep the channel free to answer it.
        void Promise.resolve().then(() => terminal.sendMessage(message)).catch(() => {
          if (!this.closed) this.store.change(state => { state.guidance.find(m => m.id === message.id)!.status = 'uncertain' })
        }).catch(() => this.log('原生终端接收结果记录失败，请检查原会话'))
        return this.store.snapshot().guidance.find(m => m.id === message.id)!
      }
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
      if (message.selection || message.submitAnswers) {
        const action = message.selection ?? message.submitAnswers!
        const state = this.store.snapshot()
        const deliveryKey = `${channel.id}/${action.requestId}`
        check(state.deliveries[deliveryKey]?.messageId, '此请求未发送到当前渠道', 403)
        const request = this.store.get(action.requestId)
        check(request.status === 'pending' && request.revision === action.revision && request.expiresAt > this.store.now(), '请求已处理、已失效或版本已变化', 409)
        check(request.kind === 'input' && request.actions.includes('answer'), '此请求不支持选择回答')
        const draft = state.answerDrafts?.[deliveryKey]
        const answers: Record<string, string[]> = draft?.revision === request.revision ? draft.answers : Object.create(null)
        if (message.selection) {
          const { question: index, option: optionIndex } = message.selection
          const question = request.questions[index]
          check(Number.isInteger(index) && Number.isInteger(optionIndex) && question && question.options[optionIndex] !== undefined, '问题选项无效')
          const option = question.options[optionIndex]
          const selected = answers[question.id] ?? []
          answers[question.id] = question.multi ? selected.includes(option) ? selected.filter(value => value !== option) : [...selected, option] : [option]
          this.store.change(next => { next.answerDrafts ??= {}; next.answerDrafts[deliveryKey] = { revision: request.revision, answers } })
          return ''
        }
        return STATUS_LABEL[(await this.respond(request.id, request.revision, { action: 'answer', answers }, by)).status]
      }
      if (message.action) {
        const delivery = this.store.snapshot().deliveries[`${channel.id}/${message.action.requestId}`]
        check(delivery?.messageId, '此请求未发送到当前渠道', 403)
        return STATUS_LABEL[(await this.respond(message.action.requestId, message.action.revision, message.action.decision, by)).status]
      }
      const text = message.text?.trim() ?? ''
      const match = /^\/(\w+)(?:@\w+)?(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(text)
      if (match) {
        const [, command, id, tail] = match
        if (command === 'sessions') return redact(this.store.snapshot().sessions.map(s => `${s.id}\n${s.agent} · ${s.label} · ${s.connected && s.adapter !== 'observation' ? '已接管' : '观察/离线'}${s.terminal ? '（原生终端接入）' : s.adapter === 'hook' ? '（指令在 Hook 处理点接收）' : ''}\n原生会话：${s.nativeId}`).join('\n\n')) || '暂无会话'
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
        if (command === 'resume') {
          const state = this.store.snapshot()
          const matches = state.requests.filter(r => r.actions.includes('resume') && r.status === 'pending' && (r.id === id || state.sessions.some(s => s.id === r.sessionId && s.nativeId === id)))
          check(matches.length === 1, '请使用异常通知中的请求 ID；原生会话 ID 必须唯一对应一条待处理通知')
          const r = await this.resume(matches[0].id, matches[0].revision, by, tail || RESUME_PROMPT)
          return `#${r.id} · ${STATUS_LABEL[r.status]} · 正在恢复原会话，请查看通知中的处理结果`
        }
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
        return '命令：/sessions /pending /detail ID /status ID /approve ID /deny ID /cancel ID /ack ID /answer ID 答案 /send 会话ID 内容 /resume 异常请求ID [继续指令] /interrupt 会话ID'
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
      // Recheck before each send: earlier channel calls may outlive the issue being reported.
      const snapshot = this.store.snapshot()
      const sessions = new Map(snapshot.sessions.map(session => [session.id, session]))
      for (const channel of this.channels) for (const entry of snapshot.requests) {
        if (this.closed) return
        const request = this.store.request(entry.id)
        if (!request) continue
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
    // One read per scan instead of one per activity: this runs on every store emit,
    // and a full snapshot clones the whole seen/automated history with it. Only our
    // own writes below can invalidate it, so each of them re-reads explicitly.
    let state = { sessions: this.store.sessions(), requests: this.store.requests() }
    const reread = (): void => { state = { sessions: this.store.sessions(), requests: this.store.requests() } }
    for (const activity of activities) {
      const controlled = state.sessions.find(s => s.adapter !== 'observation' && activityId(s.agent, s.nativeId) === activity.id)
      const issues = attentionIssues(activity).filter(issue => {
        // Connected Claude/Codex native gates own these requests. A delayed log
        // must not announce a second, observation-only request after automation replied.
        const nativeApproval = controlled?.connected && ['claude', 'codex'].includes(controlled.agent)
        const tool = activity.operation?.name?.split(/[.:]/).pop()?.toLowerCase()
        const nativeInput = controlled?.connected && (controlled.agent === 'claude' && tool === 'askuserquestion' ||
          controlled.agent === 'codex' && tool === 'request_user_input')
        const nativePending = controlled?.connected && state.requests.some(request => request.sessionId === controlled.id &&
          ACTIVE_STATUSES.includes(request.status) && (request.kind === issue.kind || issue.kind === 'approval' && request.kind === 'plan'))
        if (issue.kind === 'approval') return !nativeApproval && !nativePending
        if (issue.kind === 'input') return !nativeInput && !nativePending && !activity.questionRequest
        return true
      })
      for (const issue of issues) {
        const fingerprint = createHash('sha256').update(JSON.stringify([activity.id, issue.key])).digest('hex')
        found.add(fingerprint)
        const failure = issue.kind === 'error' || issue.kind === 'task-error'
        if (state.requests.some(r => r.origin === 'observation' && r.toolKey === fingerprint && (failure || r.status !== 'cancelled'))) continue
        const source = this.source(activity.id)
        if (source?.cwd && controlled && !controlled.cwd) { this.store.change(next => { next.sessions.find(s => s.id === controlled.id)!.cwd = source.cwd }); reread() }
        const sessionId = controlled?.id ?? `observe:${source ? `${source.agent}:${source.nativeId}` : activity.id}`
        if (issue.kind === 'error' && state.requests.some(r => r.sessionId === sessionId && r.kind === 'error' && !r.toolKey && r.createdAt >= activity.startedAt && r.expiresAt > this.store.now())) continue
        if (!controlled && !state.sessions.some(s => s.id === sessionId)) { this.store.session({ id: sessionId, nativeId: source?.nativeId ?? activity.id, cwd: source?.cwd, agent: inferAgent(source?.agent ?? activity.agent), adapter: 'observation', label: activity.agent, capabilities: [], connected: false }); reread() }
        const actions = issue.kind === 'error' && (source || controlled) ? this.recoveryActions(sessionId, state.sessions) : ['ack' as const]
        const kind = issue.kind === 'task-error' ? 'error' : issue.kind === 'task-approval' ? 'approval' : issue.kind === 'task-input' ? 'input' : issue.kind
        this.store.create({ sourceKey: `observe:${uid()}`, sessionId, origin: 'observation', kind, title: issue.title, failureStartedAt: activity.startedAt, detail: actions.includes('resume') ? issue.detail : `${issue.detail}\n仅通知；此事件没有可用的原生控制请求。`, toolKey: fingerprint, questions: [], actions, expiresAt: this.store.now() + 24 * 3600000 })
        reread()
      }
    }
    for (const r of this.store.requests()) if (r.origin === 'observation' && r.toolKey && !found.has(r.toolKey) && r.decision?.action !== 'resume' && !['resolved', 'cancelled', 'expired'].includes(r.status)) this.store.mark(r.id, 'cancelled')
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
