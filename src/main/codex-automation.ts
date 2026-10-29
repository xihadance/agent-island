import WebSocket from 'ws'
import { decideCodex, type Decision } from '../shared/automation'
import { record, type Preferences, type SettingsSnapshot } from '../shared/preferences'

type PendingRequest = { id: string | number; method: string; params: unknown }

/** A second native app-server client. Only joins threads already loaded by that server. */
export class CodexAutomation {
  private completedTurns = new Set<string>()
  status: SettingsSnapshot['codexStatus'] = 'disabled'
  detail = ''
  private socket?: WebSocket
  private url = ''
  private timer?: ReturnType<typeof setTimeout>
  private poll?: ReturnType<typeof setInterval>
  private sequence = 0
  private scanning?: WebSocket
  private joined = new Set<string>()
  private pending = new Map<string | number, PendingRequest>()
  private handled = new Set<string | number>()
  private calls = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(private preferences: () => Preferences, private changed: () => void, private report: (decision: Decision) => void) {}

  update(): void {
    const auto = this.preferences().automation
    const url = auto.enabled ? auto.codexUrl : ''
    if (url !== this.url) {
      this.stop()
      this.url = url
      if (url) this.connect()
    }
    for (const request of this.pending.values()) this.decide(request)
  }

  stop(): void {
    this.url = ''
    this.completedTurns.clear()
    clearTimeout(this.timer)
    clearInterval(this.poll)
    const socket = this.socket
    this.socket = undefined
    socket?.terminate()
    this.reset()
    this.setStatus('disabled', '')
  }

  private reset(): void {
    this.joined.clear()
    this.pending.clear()
    this.handled.clear()
    for (const call of this.calls.values()) { clearTimeout(call.timer); call.reject(new Error('连接已关闭')) }
    this.calls.clear()
  }

  private setStatus(status: SettingsSnapshot['codexStatus'], detail: string): void {
    this.status = status
    this.detail = detail
    this.changed()
  }

  private connect(): void {
    if (!this.url) return
    this.setStatus('connecting', '正在连接本机 Codex app-server')
    const socket = new WebSocket(this.url, { handshakeTimeout: 5000, maxPayload: 8_000_000 })
    this.socket = socket
    socket.on('open', () => {
      void (async () => {
        await this.request('initialize', { clientInfo: { name: 'cute_island', title: 'Cute Island', version: '0.1.11' }, capabilities: { experimentalApi: true } })
        if (this.socket !== socket) return
        socket.send(JSON.stringify({ method: 'initialized' }))
        this.setStatus('connected', '已连接，自动跟踪此服务中已加载的会话')
        await this.discover()
        if (this.socket === socket) this.poll = setInterval(() => { void this.discover().catch(() => socket.terminate()) }, 5000)
      })().catch(error => {
        if (this.socket !== socket) return
        this.setStatus('error', error instanceof Error ? error.message : '连接失败')
        socket.terminate()
      })
    })
    socket.on('message', data => {
      if (this.socket !== socket) return
      try { this.receive(JSON.parse(data.toString())) } catch { /* Ignore malformed peer messages. */ }
    })
    socket.on('error', () => {
      if (this.socket === socket) this.setStatus('error', '连接失败，请检查 app-server 地址；5 秒后重试')
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      clearInterval(this.poll)
      this.reset()
      if (this.url) {
        this.setStatus('error', '连接已断开，5 秒后重试')
        this.timer = setTimeout(() => this.connect(), 5000)
      }
    })
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = this.socket
      if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error('Codex 尚未连接')); return }
      const id = `island:${++this.sequence}`
      const timer = setTimeout(() => { this.calls.delete(id); reject(new Error(`Codex ${method} 响应超时`)) }, 5000)
      this.calls.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  private async discover(): Promise<void> {
    const socket = this.socket
    if (!socket || this.scanning === socket) return
    this.scanning = socket
    try { await this.scan(socket) }
    finally { if (this.scanning === socket) this.scanning = undefined }
  }

  private async scan(socket: WebSocket): Promise<void> {
    const loaded = new Set<string>()
    let cursor: unknown = null
    // Bound a scan, but honor pagination rather than losing busy sessions after page one.
    for (let page = 0; page < 20; page++) {
      const result = record(await this.request('thread/loaded/list', { limit: 100, cursor }))
      if (this.socket !== socket) return
      if (Array.isArray(result.data)) for (const id of result.data) if (typeof id === 'string') loaded.add(id)
      cursor = result.nextCursor
      if (!cursor) break
    }
    for (const id of this.joined) if (!loaded.has(id)) this.joined.delete(id)
    for (const threadId of loaded) {
      if (this.socket !== socket) return
      if (this.joined.has(threadId)) continue
      // No policy overrides: the user's existing sandbox and approval policy remain authoritative.
      await this.request('thread/resume', { threadId, excludeTurns: true })
      if (this.socket === socket) this.joined.add(threadId)
    }
  }

  private receive(value: unknown): void {
    const message = record(value)
    if (typeof message.id === 'string' && !message.method && this.calls.has(message.id)) {
      const call = this.calls.get(message.id)!
      this.calls.delete(message.id)
      clearTimeout(call.timer)
      if (message.error) call.reject(new Error(String(record(message.error).message ?? 'Codex 请求失败')))
      else call.resolve(message.result)
      return
    }
    if (message.method === 'serverRequest/resolved') {
      const id = record(message.params).requestId
      if ((typeof id === 'number' || typeof id === 'string') && this.pending.has(id)) {
        this.pending.delete(id)
        this.rememberHandled(id)
      }
      return
    }
    if (message.method === 'thread/closed' || message.method === 'turn/completed') {
      const params = record(message.params)
      const turnId = record(params.turn).id
      if (message.method === 'turn/completed' && typeof params.threadId === 'string' && typeof turnId === 'string') {
        this.completedTurns.add(`${params.threadId}:${turnId}`)
        if (this.completedTurns.size > 2048) this.completedTurns.delete(this.completedTurns.values().next().value!)
      }
      for (const [id, request] of this.pending) {
        const requestParams = record(request.params)
        if (requestParams.threadId === params.threadId && (message.method === 'thread/closed' || requestParams.turnId === turnId)) {
          this.pending.delete(id)
          this.rememberHandled(id)
        }
      }
      return
    }
    if ((typeof message.id !== 'number' && typeof message.id !== 'string') || typeof message.method !== 'string') return
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput'].includes(message.method)) return
    const params = record(message.params)
    if (typeof params.threadId === 'string' && typeof params.turnId === 'string' && this.completedTurns.has(`${params.threadId}:${params.turnId}`)) return
    if (this.handled.has(message.id) || this.pending.has(message.id)) return
    const request = { id: message.id, method: message.method, params: message.params }
    if (this.pending.size >= 256) return
    this.pending.set(request.id, request)
    this.decide(request, true)
  }

  private decide(request: PendingRequest, logManual = false): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const decision = decideCodex(request.method, request.params, this.preferences())
    if (!decision.response) { if (logManual) this.report(decision); return }
    this.pending.delete(request.id)
    this.rememberHandled(request.id)
    socket.send(JSON.stringify({ id: request.id, result: decision.response }), error => {
      this.report(error ? { action: 'manual', summary: '回复发送失败，请在原客户端处理' } : decision)
    })
  }

  private rememberHandled(id: string | number): void {
    this.handled.add(id)
    if (this.handled.size > 4096) this.handled.delete(this.handled.values().next().value!)
  }
}
