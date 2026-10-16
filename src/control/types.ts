export type AgentKind = 'claude' | 'codex' | 'gemini' | 'cursor'
export type InterventionKind = 'approval' | 'plan' | 'input' | 'error' | 'authentication' | 'terminal'
export type ControlAction = 'approve' | 'deny' | 'cancel' | 'answer' | 'ack' | 'resume'
export type RequestStatus = 'pending' | 'queued' | 'submitted' | 'resolved' | 'cancelled' | 'expired' | 'uncertain'
export interface Question {
  id: string
  text: string
  options: string[]
  descriptions?: string[]
  multi: boolean
  freeText: boolean
  valueType?: 'string' | 'boolean'
}
export interface Decision {
  action: ControlAction
  answers?: Record<string, string[]>
}
export interface InterventionRequest {
  id: string
  sourceKey: string
  sessionId: string
  turnId?: string
  nativeRequestId?: string | number
  toolKey?: string
  origin: 'observation' | 'hook' | 'codex'
  kind: InterventionKind
  title: string
  detail: string
  questions: Question[]
  actions: ControlAction[]
  status: RequestStatus
  createdAt: number
  expiresAt: number
  revision: number
  decision?: Decision
  decidedBy?: string
  released?: boolean
  failureStartedAt?: number
}
export type RequestInput = Omit<InterventionRequest, 'id' | 'status' | 'createdAt' | 'revision' | 'decision' | 'decidedBy'>
export interface ControlSession {
  id: string
  agent: AgentKind
  nativeId: string
  label: string
  adapter: 'hook' | 'codex' | 'observation'
  capabilities: ('approve' | 'answer' | 'message' | 'interrupt')[]
  connected: boolean
  lastSeenAt: number
  turnId?: string
  cwd?: string
  connectionId?: string
}
export interface SessionResumer {
  available(session: ControlSession): boolean
  prepare(session: ControlSession, text: string, request: InterventionRequest): Promise<() => Promise<void>>
  close(): void
}
export interface Guidance {
  id: string
  sessionId: string
  text: string
  status: 'queued' | 'submitted' | 'resolved' | 'cancelled' | 'uncertain' | 'expired'
  createdAt: number
  by: string
}
export interface Delivery { messageId?: string; revision: number; attempts: number; retryAt: number }
export interface ControlState {
  version: 1
  sessions: ControlSession[]
  requests: InterventionRequest[]
  guidance: Guidance[]
  deliveries: Record<string, Delivery>
  cursors: Record<string, number>
  seen: string[]
  answerDrafts?: Record<string, { revision: number; answers: Record<string, string[]> }>
}
export interface AgentControlAdapter {
  respond(request: InterventionRequest): Promise<void>
  sendMessage(message: Guidance): Promise<void>
  interrupt(session: ControlSession): Promise<void>
  close(): void
}
export interface RemoteMessage {
  eventId: string
  sender: string
  chat: string
  text?: string
  replyTo?: string
  action?: { requestId: string; revision: number; decision: Decision }
  selection?: { requestId: string; revision: number; question: number; option: number }
  submitAnswers?: { requestId: string; revision: number }
}
export interface ChannelAdapter {
  id: string
  destination: string
  allowedUsers: string[]
  start(receive: (message: RemoteMessage) => Promise<string>): Promise<void>
  send(text: string, request?: InterventionRequest, session?: ControlSession): Promise<string>
  update(messageId: string, text: string, request: InterventionRequest, session?: ControlSession): Promise<void>
  close(): void
}
export const ACTIVE_STATUSES: RequestStatus[] = ['pending', 'queued', 'submitted']
export const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: '等待处理', queued: '回复已收到，等待 Agent 领取', submitted: '已提交 Agent，等待确认',
  resolved: '已处理', cancelled: '已取消', expired: '已过期', uncertain: '结果待确认'
}
