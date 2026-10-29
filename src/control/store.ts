import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ActivityError } from '../shared/activity'
import { ACTIVE_STATUSES, type ControlState, type ControlSession, type Decision, type RequestInput, type InterventionRequest, type RequestStatus } from './types'

export const uid = (): string => randomBytes(9).toString('base64url')
export function check(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new ActivityError(status, message)
}
export function record(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), '需要 JSON 对象')
  return value as Record<string, unknown>
}
export function string(value: unknown, name: string, max = 16000): string {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${name} 无效`)
  return value
}

/** Persist before publishing or issuing a side effect. A failed write leaves memory untouched. */
export class ControlStore {
  private state: ControlState
  private listeners = new Set<() => void>()
  constructor(private readonly file?: string, readonly now: () => number = Date.now) {
    this.state = { version: 1, sessions: [], requests: [], guidance: [], deliveries: {}, cursors: {}, seen: [] }
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as ControlState
      check(saved.version === 1 && Array.isArray(saved.requests) && Array.isArray(saved.sessions) && Array.isArray(saved.guidance) &&
        Array.isArray(saved.seen) && saved.deliveries && saved.cursors, '远程接管状态文件损坏，请保留文件后恢复备份', 500)
      this.state = saved
      this.change(state => {
        for (const session of state.sessions) session.connected = false
        for (const request of state.requests) if (ACTIVE_STATUSES.includes(request.status) && (request.origin !== 'observation' || request.decision?.action === 'resume')) {
          request.status = 'uncertain'; request.revision++
        }
        for (const message of state.guidance) if (message.status === 'submitted') message.status = 'uncertain'
      })
    }
  }
  snapshot(): ControlState { return structuredClone(this.state) }
  /**
   * Readers for the hot paths. A full snapshot also clones `seen` (10k entries) and
   * `automated` (4k), which the watcher tick and the observe scan never look at.
   */
  sessions(): ControlSession[] { return structuredClone(this.state.sessions) }
  requests(): InterventionRequest[] { return structuredClone(this.state.requests) }
  request(id: string): InterventionRequest | undefined {
    const request = this.state.requests.find(request => request.id === id)
    return request ? structuredClone(request) : undefined
  }
  wasAutomated(sourceKey: string, fingerprint: string): boolean {
    const previous = this.state.automated?.[sourceKey]
    if (previous === undefined) return false
    check(previous === fingerprint, '自动处理标识已绑定其他操作', 409)
    return true
  }
  recordAutomation(sourceKey: string, fingerprint: string): void {
    check(!this.wasAutomated(sourceKey, fingerprint), '自动处理结果已提交或待确认，请在原 Agent 中处理', 409)
    this.change(state => {
      state.automated ??= {}
      state.automated[sourceKey] = fingerprint
      const keys = Object.keys(state.automated)
      for (const key of keys.slice(0, -4096)) delete state.automated[key]
    })
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  change<T>(fn: (state: ControlState) => T): T {
    const next = structuredClone(this.state)
    const result = fn(next)
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.file)
    }
    this.state = next
    for (const listener of this.listeners) { try { listener() } catch { console.error('本地问题状态更新失败，请重新打开灵动岛') } }
    return structuredClone(result)
  }
  session(input: Omit<ControlSession, 'lastSeenAt'>): ControlSession {
    return this.change(state => {
      const previous = state.sessions.find(s => s.id === input.id)
      if (previous) check(previous.agent === input.agent && previous.nativeId === input.nativeId && previous.adapter === input.adapter, '会话归属冲突', 409)
      const session = { ...input, lastSeenAt: this.now() }
      if (previous) Object.assign(previous, session)
      else state.sessions.push(session)
      return session
    })
  }
  create(input: RequestInput): InterventionRequest {
    check(new Set(input.questions.map(q => q.id)).size === input.questions.length, '问题 ID 不能重复')
    const existing = this.state.requests.find(r => r.sourceKey === input.sourceKey)
    if (existing) {
      check(existing.sessionId === input.sessionId && existing.kind === input.kind && existing.toolKey === input.toolKey && existing.nativeRequestId === input.nativeRequestId, '请求标识已绑定其他操作', 409)
      return structuredClone(existing)
    }
    check(this.state.sessions.some(s => s.id === input.sessionId), '未注册会话', 404)
    check(this.state.requests.filter(r => ACTIVE_STATUSES.includes(r.status)).length < 1000, '介入请求队列已满', 429)
    return this.change(state => {
      const request: InterventionRequest = { ...input, id: uid(), status: 'pending', createdAt: this.now(), revision: 1 }
      state.requests.push(request)
      // Bound history without dropping pending or uncertain operations.
      const removable = state.requests.filter(r => ['resolved', 'cancelled', 'expired'].includes(r.status)).slice(0, -500)
      const ids = new Set(removable.map(r => r.id))
      state.requests = state.requests.filter(r => !ids.has(r.id))
      for (const key of Object.keys(state.deliveries)) if (ids.has(key.split('/').at(-1)!)) delete state.deliveries[key]
      for (const key of Object.keys(state.answerDrafts ?? {})) if (ids.has(key.split('/').at(-1)!)) delete state.answerDrafts![key]
      return request
    })
  }
  get(id: string): InterventionRequest {
    const request = this.state.requests.find(r => r.id === id)
    check(request, '介入请求不存在', 404)
    return structuredClone(request)
  }
  decide(id: string, revision: number, decision: Decision, by: string): InterventionRequest {
    const request = this.get(id)
    check(request.status === 'pending' && request.expiresAt > this.now() && request.revision === revision, '请求已处理、已失效或版本已变化', 409)
    check(request.actions.includes(decision.action), '此请求不支持该操作')
    const normalized: Decision = { action: decision.action }
    if (decision.action === 'answer') {
      const answers = record(decision.answers)
      check(Object.keys(answers).length === request.questions.length, '请回答全部问题')
      normalized.answers = Object.create(null) as Record<string, string[]>
      for (const question of request.questions) {
        const values = answers[question.id]
        check(Array.isArray(values) && values.length > 0 && (question.multi || values.length === 1), `问题 ${question.id} 的答案数量无效`)
        check(new Set(values).size === values.length, '答案不能重复')
        normalized.answers[question.id] = values.map(value => {
          const answer = string(value, '答案', 4000)
          check(question.freeText || question.options.includes(answer), `问题 ${question.id} 的选项无效`)
          return answer
        })
      }
    }
    return this.change(state => {
      const current = state.requests.find(r => r.id === id)!
      current.decision = normalized
      current.decidedBy = by
      current.status = decision.action === 'ack' ? 'resolved' : 'queued'
      current.revision++
      for (const key of Object.keys(state.answerDrafts ?? {})) if (key.endsWith(`/${id}`)) delete state.answerDrafts![key]
      return current
    })
  }
  mark(id: string, status: RequestStatus): void {
    if (this.get(id).status === status) return
    this.change(state => { const r = state.requests.find(r => r.id === id)!; r.status = status; r.revision++ })
  }
  expire(): void {
    const stale = this.state.requests.filter(r => ACTIVE_STATUSES.includes(r.status) && r.expiresAt <= this.now())
    const oldMessages = this.state.guidance.filter(m => ['queued', 'submitted'].includes(m.status) && m.createdAt + 86400000 <= this.now())
    if (stale.length || oldMessages.length) this.change(state => {
      for (const old of stale) { const r = state.requests.find(item => item.id === old.id)!; r.status = r.status === 'submitted' ? 'uncertain' : 'expired'; r.revision++ }
      for (const old of oldMessages) { const m = state.guidance.find(item => item.id === old.id)!; m.status = m.status === 'submitted' ? 'uncertain' : 'expired' }
    })
  }
  settleSession(id: string, status: 'cancelled' | 'uncertain' = 'cancelled', preserveGuidance = false, preserveRequestId?: string): void {
    this.change(state => {
      for (const r of state.requests) if (r.sessionId === id && r.id !== preserveRequestId && ACTIVE_STATUSES.includes(r.status) && r.decision?.action !== 'resume') { r.status = status; r.revision++ }
      if (!preserveGuidance) for (const m of state.guidance) if (m.sessionId === id && ['queued', 'submitted'].includes(m.status)) m.status = status
    })
  }
  releaseControl(): void {
    this.change(state => {
      state.answerDrafts = {}
      for (const session of state.sessions) session.connected = false
      for (const request of state.requests) if (ACTIVE_STATUSES.includes(request.status)) {
        if (request.origin === 'hook') request.released = true
        request.status = request.status === 'submitted' ? 'uncertain' : 'cancelled'
        request.revision++
      }
      for (const message of state.guidance) {
        if (message.status === 'queued') message.status = 'cancelled'
        else if (message.status === 'submitted') message.status = 'uncertain'
      }
    })
  }
}
