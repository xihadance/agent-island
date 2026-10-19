import WebSocket from 'ws'
import type { Agent } from 'node:http'
import { createHash } from 'node:crypto'
import { check, uid } from './store'
import type { ControlHub } from './hub'
import { ACTIVE_STATUSES, type AgentControlAdapter, type ControlSession, type Guidance, type InterventionRequest, type Question } from './types'
import { formAnswers, formQuestions } from './forms'
import type { Decision } from '../shared/automation'

export interface CodexConnection { id: string; url: string; threads: string[]; token?: string; agent?: Agent }
export type CodexDecision = (method: string, params: Record<string, unknown>) => Decision
interface NativeRequest { method: string; params: Record<string, any> }
export class CodexAdapter implements AgentControlAdapter {
  private socket?: WebSocket
  private closed = false
  private timer?: ReturnType<typeof setTimeout>
  private poll?: ReturnType<typeof setInterval>
  private scanning?: WebSocket
  private generation = ''
  private sequence = 0
  private initialized = false
  private recovering = new Set<string>()
  private sessions = new Map<string, string>()
  private native = new Map<string, NativeRequest>()
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  get connected(): boolean { return !this.closed && this.initialized && this.socket?.readyState === WebSocket.OPEN }
  constructor(private readonly hub: ControlHub, private readonly config: CodexConnection, private readonly requestsChanged: (created: boolean) => void = () => {},
    private readonly automate?: CodexDecision, private readonly report: (decision: Decision) => void = () => {}) {
    const url = new URL(config.url)
    check(url.protocol === 'wss:' || url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Codex 仅允许本机 ws 或远程 wss')
    check(!url.username && !url.password, 'Codex 认证请通过 tokenEnv 配置')
  }
  start(): void {
    if (this.closed || this.socket) return
    const socket = new WebSocket(this.config.url, { agent: this.config.agent, headers: this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}, handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024 })
    this.socket = socket
    this.generation = uid()
    socket.on('error', () => {})
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.initialized = false
      clearInterval(this.poll)
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex 控制连接断开')) }
      this.pending.clear()
      if (this.closed) return
      for (const id of this.sessions.values()) {
        this.hub.store.change(state => { const s = state.sessions.find(s => s.id === id); if (s) s.connected = false })
        this.hub.store.settleSession(id, 'uncertain')
      }
      this.sessions.clear(); this.native.clear()
      if (!this.closed) this.timer = setTimeout(() => this.start(), 5000)
    })
    socket.on('message', bytes => {
      if (this.socket !== socket) return
      try { this.onMessage(JSON.parse(bytes.toString())) } catch { /* Malformed or unsupported events never grant access. */ }
    })
    socket.on('open', () => { void this.initialize(socket).catch(() => socket.close()) })
  }
  private async initialize(socket: WebSocket): Promise<void> {
    await this.rpc('initialize', { clientInfo: { name: 'cute-island', title: 'Cute Island 接管', version: '0.1.11' }, capabilities: { experimentalApi: true } })
    if (this.closed || this.socket !== socket) return
    await this.write({ method: 'initialized' })
    this.initialized = true
    await this.discover(socket)
    if (!this.closed && this.socket === socket) this.poll = setInterval(() => { void this.discover(socket).catch(() => socket.close()) }, 5000)
  }
  private async discover(socket: WebSocket): Promise<void> {
    if (this.closed || this.socket !== socket || this.scanning === socket) return
    this.scanning = socket
    try { await this.scan(socket) }
    finally { if (this.scanning === socket) this.scanning = undefined }
  }
  private async scan(socket: WebSocket): Promise<void> {
    const loaded = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      const result = await this.rpc('thread/loaded/list', { limit: 100, cursor })
      if (this.closed || this.socket !== socket) return
      check(Array.isArray(result.data) && result.data.every((id: unknown) => typeof id === 'string'), 'Codex 返回了无效会话列表')
      for (const id of result.data) loaded.add(id)
      cursor = result.nextCursor ?? null
      check(cursor === null || typeof cursor === 'string', 'Codex 返回了无效分页信息')
      if (!cursor) break
      check(!cursors.has(cursor), 'Codex 返回了重复的会话分页')
      cursors.add(cursor)
    }
    check(!cursor, 'Codex 已加载会话过多，无法完成接管扫描')
    for (const thread of this.sessions.keys()) if (!loaded.has(thread) && !this.recovering.has(thread)) this.detach(thread)
    const targets = this.config.threads.length ? this.config.threads : loaded
    for (const thread of targets) {
      if (this.closed || this.socket !== socket) return
      // Only subscribe to threads already loaded on THIS instance. Never create a second runner.
      if (!loaded.has(thread) || this.sessions.has(thread) || this.recovering.has(thread)) continue
      const id = `codex-${createHash('sha256').update(`${this.config.id}:${thread}`).digest('hex').slice(0, 24)}`
      this.sessions.set(thread, id)
      this.hub.store.session({ id, agent: 'codex', nativeId: thread, connectionId: this.config.id, adapter: 'codex', label: thread.slice(0, 12), connected: true, capabilities: ['approve', 'answer', 'message', 'interrupt'] })
      this.hub.attach(id, this)
      let result: any
      try { result = await this.rpc('thread/resume', { threadId: thread }) }
      catch {
        if (this.closed || this.socket !== socket) return
        // A thread may unload between listing and subscription. Retry on the next scan.
        this.detach(thread)
        continue
      }
      if (this.closed || this.socket !== socket) return
      const native = result.thread
      const active = native.turns?.findLast((turn: any) => turn.status === 'inProgress')
      this.hub.store.change(state => { const s = state.sessions.find(s => s.id === id)!; s.label = native.name || s.label; s.turnId = active?.id ?? s.turnId })
    }
  }
  private detach(thread: string, settle = true): void {
    const id = this.sessions.get(thread)
    if (!id) return
    this.sessions.delete(thread)
    this.hub.store.change(state => { const session = state.sessions.find(s => s.id === id); if (session) { session.connected = false; session.turnId = undefined } })
    if (settle) this.hub.store.settleSession(id, 'uncertain')
    for (const [requestId, request] of this.native) if (request.params.threadId === thread) this.native.delete(requestId)
  }
  private onMessage(message: Record<string, any>): void {
    if (this.closed) return
    if (!message.method && typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(message.id)
      if (message.error) pending.reject(new Error('Codex 拒绝了控制请求'))
      else pending.resolve(message.result)
      return
    }
    const params = message.params ?? {}
    if (message.method === 'thread/started' && this.socket && this.initialized) {
      void this.discover(this.socket).catch(() => this.socket?.close())
      return
    }
    const sessionId = this.sessions.get(params.threadId)
    if (!sessionId) return
    if (message.method === 'thread/closed') { this.detach(params.threadId); return }
    if (message.method === 'turn/started') {
      this.hub.store.settleSession(sessionId, 'cancelled', true)
      this.hub.store.change(state => { const s = state.sessions.find(s => s.id === sessionId)!; s.turnId = params.turn.id; s.lastSeenAt = this.hub.store.now() })
    }
    if (message.method === 'turn/completed') {
      this.hub.store.settleSession(sessionId)
      this.hub.store.change(state => { state.sessions.find(s => s.id === sessionId)!.turnId = undefined })
      if (['failed', 'interrupted'].includes(params.turn.status)) this.hub.store.create({ sourceKey: `codex-error:${this.config.id}:${params.threadId}:${params.turn.id}`, sessionId, turnId: params.turn.id,
        origin: 'observation', kind: 'error', title: 'Codex 执行失败', detail: params.turn.error?.message ?? '请检查原会话', questions: [], actions: this.hub.recoveryActions(sessionId), expiresAt: this.hub.store.now() + 86400000 })
    }
    if (message.method === 'serverRequest/resolved') {
      for (const r of this.hub.store.snapshot().requests) if (r.sessionId === sessionId && r.nativeRequestId === params.requestId && this.native.has(r.id) && ACTIVE_STATUSES.includes(r.status)) {
        this.hub.store.mark(r.id, r.decision ? 'resolved' : 'cancelled'); this.native.delete(r.id)
      }
      this.requestsChanged(false)
    }
    if (message.id === undefined || !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput', 'mcpServer/elicitation/request'].includes(message.method)) return
    if (params.turnId) this.hub.store.change(state => { state.sessions.find(s => s.id === sessionId)!.turnId = params.turnId })
    const input = /requestUserInput$/.test(message.method)
    const elicitation = message.method === 'mcpServer/elicitation/request'
    const questions: Question[] = input && Array.isArray(params.questions) ? params.questions.map((q: any) => ({ id: q.id, text: q.question, options: (q.options ?? []).map((o: any) => o.label), descriptions: (q.options ?? []).map((o: any) => typeof o.description === 'string' ? o.description.slice(0, 2000) : ''), multi: false, freeText: q.isOther !== false })) : elicitation && params.mode !== 'url' ? formQuestions(params.requestedSchema) ?? [] : []
    const available = params.availableDecisions as unknown[] | undefined
    const actions: InterventionRequest['actions'] = input ? ['answer'] : elicitation ? questions.length ? ['answer', 'cancel'] : ['cancel'] : [
      ...(!available || available.includes('accept') ? ['approve' as const] : []),
      ...(!available || available.includes('decline') ? ['deny' as const] : []),
      ...(!available || available.includes('cancel') ? ['cancel' as const] : [])
    ]
    const detail = JSON.stringify(params, null, 2)
    const tooLarge = detail.length > 48000
    const sourceKey = `codex:${this.config.id}:${this.generation}:${message.id}`
    // Native turn/request identity survives reconnects; socket generations do not.
    const automaticKey = `codex-auto:${createHash('sha256').update(JSON.stringify([
      this.config.id, this.config.url, params.threadId, params.turnId ?? this.generation, message.id
    ])).digest('hex')}`
    const fingerprint = createHash('sha256').update(JSON.stringify([message.method, params])).digest('hex')
    if (this.hub.store.wasAutomated(automaticKey, fingerprint) || this.hub.store.snapshot().requests.some(r => r.sourceKey === sourceKey)) return
    const decision = tooLarge ? undefined : this.automate?.(message.method, params)
    if (decision?.response) {
      // Record before sending. An ambiguous socket failure must not trigger a retry or escalation.
      this.hub.store.recordAutomation(automaticKey, fingerprint)
      void this.write({ id: message.id, result: decision.response }).then(() => this.report(decision), () => {
        this.report({ action: 'manual', summary: '回复发送失败，结果待确认，请在原客户端处理' })
      })
      return
    }
    const r = this.hub.store.create({ sourceKey, sessionId, turnId: params.turnId, nativeRequestId: message.id,
      origin: 'codex', kind: input || elicitation && questions.length ? 'input' : elicitation ? 'authentication' : 'approval',
      title: input ? 'Codex 需要你回答' : elicitation ? questions.length ? 'MCP 表单需要你回答' : 'MCP 请求，请通过原生界面完成' : 'Codex 请求审批',
      detail: tooLarge ? `内容过长，请通过原生界面处理；下方仅为摘要。\n${detail.slice(0, 47000)}` : detail,
      questions, actions: tooLarge ? actions.filter(a => a !== 'approve' && a !== 'answer') : actions,
      expiresAt: this.hub.store.now() + Math.min(typeof params.autoResolutionMs === 'number' ? Math.max(0, params.autoResolutionMs) : 600000, 600000) })
    this.native.set(r.id, { method: message.method, params })
    this.requestsChanged(true)
  }
  async respond(request: InterventionRequest): Promise<void> {
    const native = this.native.get(request.id)
    check(native && request.decision, '原生请求已经失效', 409)
    const d = request.decision
    let result: unknown
    if (/requestUserInput$/.test(native.method)) result = { answers: Object.fromEntries(Object.entries(d.answers ?? {}).map(([key, value]) => [key, { answers: value }])) }
    else if (native.method === 'item/permissions/requestApproval') result = { permissions: d.action === 'approve' ? native.params.permissions : {}, scope: 'turn' }
    else if (native.method === 'mcpServer/elicitation/request') result = d.action === 'answer' ? { action: 'accept', content: formAnswers(request.questions, d.answers!) } : { action: 'cancel', content: null }
    else result = { decision: d.action === 'approve' ? 'accept' : d.action === 'deny' ? 'decline' : 'cancel' }
    await this.write({ id: request.nativeRequestId, result })
  }
  async sendMessage(message: Guidance): Promise<void> {
    const session = this.hub.store.snapshot().sessions.find(s => s.id === message.sessionId)!
    const input = [{ type: 'text', text: message.text }]
    if (session.turnId) await this.rpc('turn/steer', { threadId: session.nativeId, expectedTurnId: session.turnId, input })
    else await this.rpc('turn/start', { threadId: session.nativeId, input })
    if (this.closed) return
    this.hub.store.change(state => { state.guidance.find(m => m.id === message.id)!.status = 'resolved' })
  }
  async interrupt(session: ControlSession): Promise<void> {
    check(session.turnId, '当前没有活动轮次')
    await this.rpc('turn/interrupt', { threadId: session.nativeId, turnId: session.turnId })
  }
  acceptsRecovery(session: ControlSession): boolean {
    if (session.agent !== 'codex' || this.config.threads.length && !this.config.threads.includes(session.nativeId)) return false
    if (session.connectionId) return session.connectionId === this.config.id
    // A locally observed transcript must never be loaded on an unrelated remote host.
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(this.config.url).hostname)
  }
  async prepareResume(session: ControlSession, text: string, failedTurnId?: string): Promise<() => Promise<void>> {
    check(this.acceptsRecovery(session), '此 Codex 连接不允许恢复该会话')
    check(this.initialized && !this.closed, 'Codex 服务未连接，请先启动原服务', 409)
    const socket = this.socket
    const result = await this.rpc('thread/read', { threadId: session.nativeId, includeTurns: true })
    check(result.thread?.id === session.nativeId, 'Codex 返回了不同的原生会话')
    checkFailedThread(result.thread)
    check(!failedTurnId || result.thread.turns.at(-1)?.id === failedTurnId, '原会话已进入新一轮，异常通知已失效', 409)
    return async () => {
      check(!this.closed && this.socket === socket, 'Codex 连接已变化，请检查原会话', 409)
      const thread = session.nativeId
      this.recovering.add(thread)
      const id = `codex-${createHash('sha256').update(`${this.config.id}:${thread}`).digest('hex').slice(0, 24)}`
      this.sessions.set(thread, id)
      this.hub.store.session({ id, agent: 'codex', nativeId: thread, connectionId: this.config.id, cwd: session.cwd,
        adapter: 'codex', label: session.label, connected: true, capabilities: ['approve', 'answer', 'message', 'interrupt'] })
      this.hub.attach(id, this)
      try {
        const resumed = await this.rpc('thread/resume', { threadId: thread })
        check(resumed.thread?.id === thread, 'Codex 未确认恢复原会话')
        checkFailedThread(resumed.thread)
        check(resumed.thread.turns.at(-1)?.id === result.thread.turns.at(-1)?.id, '原会话已变化，未提交继续指令', 409)
        check(!this.hub.store.snapshot().sessions.find(s => s.id === id)?.turnId, '原会话已开始执行，未提交重复指令', 409)
        check(!this.closed && this.socket === socket, 'Codex 接管已停止')
        const started = await this.rpc('turn/start', { threadId: thread, input: [{ type: 'text', text }] })
        check(typeof started.turn?.id === 'string' && started.turn.status !== 'failed', 'Codex 未确认接收继续指令')
      } finally { this.recovering.delete(thread) }
    }
  }
  private write(value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed || this.socket?.readyState !== WebSocket.OPEN) return reject(new Error('Codex 尚未连接'))
      this.socket.send(JSON.stringify(value), error => error ? reject(error) : resolve())
    })
  }
  private rpc(method: string, params: unknown): Promise<any> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 控制请求超时')) }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      void this.write({ id, method, params }).catch(error => { clearTimeout(timer); this.pending.delete(id); reject(error) })
    })
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    clearInterval(this.poll)
    // The runtime settles unsent and submitted work separately when takeover is disabled.
    for (const thread of this.sessions.keys()) this.detach(thread, false)
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex 接管已停止')) }
    this.pending.clear()
    this.sessions.clear(); this.native.clear()
    this.socket?.terminate()
  }
}

function checkFailedThread(thread: Record<string, any>): void {
  const turns = thread.turns
  check(Array.isArray(turns) && turns.length > 0, '无法确认原会话的中断状态', 409)
  check(!turns.some((turn: any) => turn.status === 'inProgress') && thread.status?.type !== 'active', '原会话仍在执行，请等待或使用追加指令', 409)
  check(['failed', 'interrupted'].includes(turns.at(-1)?.status), '原会话已继续或已完成，异常通知已失效', 409)
}
