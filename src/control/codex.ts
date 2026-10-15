import WebSocket from 'ws'
import { createHash } from 'node:crypto'
import { check, uid } from './store'
import type { ControlHub } from './hub'
import { ACTIVE_STATUSES, type AgentControlAdapter, type ControlSession, type Guidance, type InterventionRequest, type Question } from './types'
import { formAnswers, formQuestions } from './forms'

export interface CodexConnection { id: string; url: string; threads: string[]; token?: string }
interface NativeRequest { method: string; params: Record<string, any> }
export class CodexAdapter implements AgentControlAdapter {
  private socket?: WebSocket
  private closed = false
  private timer?: ReturnType<typeof setTimeout>
  private generation = ''
  private sequence = 0
  private sessions = new Map<string, string>()
  private native = new Map<string, NativeRequest>()
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  constructor(private readonly hub: ControlHub, private readonly config: CodexConnection) {
    const url = new URL(config.url)
    check(url.protocol === 'wss:' || url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Codex 仅允许本机 ws 或远程 wss')
    check(!url.username && !url.password, 'Codex 认证请通过 tokenEnv 配置')
  }
  start(): void {
    if (this.closed) return
    const socket = new WebSocket(this.config.url, { headers: this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}, handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024 })
    this.socket = socket
    this.generation = uid()
    socket.on('error', () => {})
    socket.on('close', () => {
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
      try { this.onMessage(JSON.parse(bytes.toString())) } catch { /* Malformed or unsupported events never grant access. */ }
    })
    socket.on('open', () => { void this.initialize().catch(() => socket.close()) })
  }
  private async initialize(): Promise<void> {
    await this.rpc('initialize', { clientInfo: { name: 'cute-island', title: 'Cute Island 接管', version: '0.1.11' }, capabilities: { experimentalApi: true } })
    await this.write({ method: 'initialized' })
    const loaded = await this.rpc('thread/loaded/list', {})
    for (const thread of this.config.threads) {
      if (this.closed) return
      // Only subscribe to threads already loaded on THIS instance. Never create a second runner.
      if (!loaded.data?.includes(thread)) continue
      const id = `codex-${createHash('sha256').update(`${this.config.id}:${thread}`).digest('hex').slice(0, 24)}`
      this.sessions.set(thread, id)
      this.hub.store.session({ id, agent: 'codex', nativeId: thread, adapter: 'codex', label: thread.slice(0, 12), connected: true, capabilities: ['approve', 'answer', 'message', 'interrupt'] })
      this.hub.attach(id, this)
      const result = await this.rpc('thread/resume', { threadId: thread })
      if (this.closed) return
      const native = result.thread
      const active = native.turns?.findLast((turn: any) => turn.status === 'inProgress')
      this.hub.store.change(state => { const s = state.sessions.find(s => s.id === id)!; s.label = native.name || s.label; s.turnId = active?.id ?? s.turnId })
    }
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
    const sessionId = this.sessions.get(params.threadId)
    if (!sessionId) return
    if (message.method === 'turn/started') {
      this.hub.store.settleSession(sessionId, 'cancelled', true)
      this.hub.store.change(state => { const s = state.sessions.find(s => s.id === sessionId)!; s.turnId = params.turn.id; s.lastSeenAt = this.hub.store.now() })
    }
    if (message.method === 'turn/completed') {
      this.hub.store.settleSession(sessionId)
      this.hub.store.change(state => { state.sessions.find(s => s.id === sessionId)!.turnId = undefined })
      if (params.turn.status === 'failed') this.hub.store.create({ sourceKey: `codex-error:${this.config.id}:${params.threadId}:${params.turn.id}`, sessionId,
        origin: 'observation', kind: 'error', title: 'Codex 执行失败', detail: params.turn.error?.message ?? '请检查原会话', questions: [], actions: ['ack'], expiresAt: this.hub.store.now() + 86400000 })
    }
    if (message.method === 'serverRequest/resolved') {
      for (const r of this.hub.store.snapshot().requests) if (r.sessionId === sessionId && r.nativeRequestId === params.requestId && this.native.has(r.id) && ACTIVE_STATUSES.includes(r.status)) {
        this.hub.store.mark(r.id, r.decision ? 'resolved' : 'cancelled'); this.native.delete(r.id)
      }
    }
    if (message.id === undefined || !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput', 'mcpServer/elicitation/request'].includes(message.method)) return
    if (params.turnId) this.hub.store.change(state => { state.sessions.find(s => s.id === sessionId)!.turnId = params.turnId })
    const input = /requestUserInput$/.test(message.method)
    const elicitation = message.method === 'mcpServer/elicitation/request'
    const questions: Question[] = input && Array.isArray(params.questions) ? params.questions.map((q: any) => ({ id: q.id, text: q.question, options: (q.options ?? []).map((o: any) => o.label), multi: false, freeText: q.isOther !== false })) : elicitation && params.mode !== 'url' ? formQuestions(params.requestedSchema) ?? [] : []
    const available = params.availableDecisions as unknown[] | undefined
    const actions: InterventionRequest['actions'] = input ? ['answer'] : elicitation ? questions.length ? ['answer', 'cancel'] : ['cancel'] : [
      ...(!available || available.includes('accept') ? ['approve' as const] : []),
      ...(!available || available.includes('decline') ? ['deny' as const] : []),
      ...(!available || available.includes('cancel') ? ['cancel' as const] : [])
    ]
    const detail = JSON.stringify(params, null, 2)
    const tooLarge = detail.length > 48000
    const r = this.hub.store.create({ sourceKey: `codex:${this.config.id}:${this.generation}:${message.id}`, sessionId, turnId: params.turnId, nativeRequestId: message.id,
      origin: 'codex', kind: input || elicitation && questions.length ? 'input' : elicitation ? 'authentication' : 'approval',
      title: input ? 'Codex 需要你回答' : elicitation ? questions.length ? 'MCP 表单需要你回答' : 'MCP 请求，请通过原生界面完成' : 'Codex 请求审批',
      detail: tooLarge ? `内容过长，请通过原生界面处理；下方仅为摘要。\n${detail.slice(0, 47000)}` : detail,
      questions, actions: tooLarge ? actions.filter(a => a !== 'approve' && a !== 'answer') : actions,
      expiresAt: this.hub.store.now() + Math.min(typeof params.autoResolutionMs === 'number' ? Math.max(0, params.autoResolutionMs) : 600000, 600000) })
    this.native.set(r.id, { method: message.method, params })
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
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex 接管已停止')) }
    this.pending.clear()
    this.sessions.clear(); this.native.clear()
    this.socket?.terminate()
  }
}
