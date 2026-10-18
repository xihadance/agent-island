import { createHash } from 'node:crypto'
import { check, record, string } from './store'
import type { ControlHub } from './hub'
import { ACTIVE_STATUSES, type AgentKind, type InterventionRequest, type Question } from './types'
import { formAnswers, formQuestions } from './forms'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
export interface HookReply { requestId?: string; deadline?: number; output?: Record<string, unknown>; guidanceIds?: string[]; handled?: string }
/**
 * Local automation's answer for one hook event, consulted before anything is sent
 * out. `undefined` means it declined, so the request escalates to the channels.
 */
export type HookAutomation = (agent: AgentKind, event: Record<string, unknown>) => { output: Record<string, unknown>; summary: string } | undefined
export class HookController {
  constructor(private readonly hub: ControlHub, private readonly automate?: HookAutomation) {}
  handle(body: unknown): HookReply {
    const input = record(body)
    const agent = string(input.agent, 'agent') as AgentKind
    check(['claude', 'cursor', 'gemini'].includes(agent), '不支持的 Hook Agent')
    const invocation = string(input.invocationId, 'invocationId', 80)
    const event = record(input.event)
    const nativeId = string(event.session_id ?? event.conversation_id, '原生会话 ID', 250)
    const eventName = string(event.hook_event_name, 'hook_event_name', 80)
    const id = `hook-${agent}-${digest(nativeId)}`
    const name = typeof event.tool_name === 'string' ? event.tool_name : eventName === 'beforeShellExecution' ? 'Shell' : ''
    const args = typeof event.tool_input === 'string' ? record(JSON.parse(event.tool_input)) : event.tool_input && typeof event.tool_input === 'object' ? record(event.tool_input) : event
    const originalArgs = { ...args }
    delete originalArgs.answers
    const toolKey = digest([name, originalArgs.command ?? originalArgs, event.cwd ?? originalArgs.cwd ?? originalArgs.working_directory ?? ''])
    const store = this.hub.store
    store.expire()
    const sessionEnd = ['SessionEnd', 'sessionEnd'].includes(eventName)
    store.session({ id, agent, nativeId, label: typeof event.cwd === 'string' ? event.cwd.split(/[/\\]/).filter(Boolean).at(-1)! : nativeId.slice(0, 16), adapter: 'hook',
      capabilities: agent === 'claude' ? ['approve', 'answer', 'message'] : ['approve', 'message'], connected: !sessionEnd,
      cwd: typeof event.cwd === 'string' ? event.cwd : store.snapshot().sessions.find(s => s.id === id)?.cwd })
    if (sessionEnd) { store.settleSession(id); return { output: {} } }
    if (['SessionStart', 'sessionStart', 'UserPromptSubmit', 'BeforeAgent', 'beforeSubmitPrompt'].includes(eventName)) store.settleSession(id, 'cancelled', true)
    if (['PostToolUse', 'PostToolUseFailure', 'AfterTool', 'postToolUse', 'postToolUseFailure', 'afterShellExecution', 'afterMCPExecution'].includes(eventName)) {
      const matching = store.snapshot().requests.filter(r => r.sessionId === id && r.toolKey === toolKey && ACTIVE_STATUSES.includes(r.status))
      // PermissionRequest has no tool_use_id. An ambiguous completion must not settle a sibling.
      if (matching.length === 1) store.mark(matching[0].id, 'resolved')
    }
    let kind: InterventionRequest['kind'] | undefined
    let questions: Question[] = []
    if (agent === 'claude' && eventName === 'Elicitation' && event.mode !== 'url') {
      questions = formQuestions(event.requested_schema) ?? []
      if (questions.length) kind = 'input'
    } else if (agent === 'claude' && ['PreToolUse', 'PermissionRequest'].includes(eventName) && name === 'AskUserQuestion') {
      kind = 'input'
      check(Array.isArray(args.questions) && args.questions.length > 0 && args.questions.length <= 4, '问题列表无效')
      questions = args.questions.map((q: unknown, i: number) => {
        const value = record(q)
        check(Array.isArray(value.options), '问题选项无效')
        return { id: `q${i + 1}`, text: string(value.question, '问题'), multi: value.multiSelect === true, freeText: true,
          options: value.options.map((o: unknown) => string(record(o).label, '选项', 1000)),
          descriptions: value.options.map((o: unknown) => typeof record(o).description === 'string' ? String(record(o).description).slice(0, 2000) : '') }
      })
    } else if (agent === 'claude' && ['PreToolUse', 'PermissionRequest'].includes(eventName) && name === 'ExitPlanMode') kind = 'plan'
    else if (agent === 'claude' && eventName === 'PermissionRequest') kind = 'approval'
    else if (agent === 'cursor' && ['beforeShellExecution', 'beforeMCPExecution'].includes(eventName)) kind = 'approval'
    else if (agent === 'gemini' && eventName === 'BeforeTool') kind = 'approval'
    if (kind) {
      const detail = JSON.stringify(args, null, 2)
      check(detail.length <= 48000, '请求内容过长，请在原 Agent 中处理')
      const sourceKey = `hook:${agent}:${invocation}`
      const fingerprint = digest(event)
      check(!store.wasAutomated(sourceKey, fingerprint), '自动处理结果已提交或待确认，请在原 Agent 中处理', 409)
      const existing = store.snapshot().requests.find(r => r.sourceKey === sourceKey)
      if (existing) {
        check(existing.sessionId === id && existing.toolKey === toolKey, 'Hook 标识已绑定其他操作', 409)
        return { requestId: existing.id, deadline: existing.expiresAt }
      }
      // Local automation decides first. Escalating only what it declines keeps a
      // channel notification from ever arriving for an already-settled request.
      const automated = this.automate?.(agent, event)
      if (automated) {
        // A lost response must never replay an approval after a restart or rule change.
        store.recordAutomation(sourceKey, fingerprint)
        return { output: automated.output, handled: automated.summary }
      }
      const request = store.create({ sourceKey: `hook:${agent}:${invocation}`, sessionId: id, nativeRequestId: invocation,
        origin: 'hook', kind, toolKey, title: kind === 'input' ? '需要你回答' : kind === 'plan' ? '确认执行方案' : `确认 ${name || '工具调用'}`,
        detail, questions,
        actions: kind === 'input' ? ['answer', 'cancel'] : ['approve', 'deny', 'cancel'], expiresAt: store.now() + 300000 })
      return { requestId: request.id, deadline: request.expiresAt }
    }
    const failed = ['PostToolUseFailure', 'postToolUseFailure', 'StopFailure'].includes(eventName) || eventName === 'Notification'
    if (failed) store.create({ sourceKey: `hook:${agent}:${invocation}:notice`, sessionId: id, origin: 'observation', kind: 'error', title: eventName === 'Notification' ? 'Agent 通知' : '执行异常',
      detail: JSON.stringify(event).slice(0, 16000), questions: [], actions: eventName === 'StopFailure' ? this.hub.recoveryActions(id) : ['ack'], expiresAt: store.now() + 86400000 })
    const contextEvents = agent === 'claude' ? ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop'] : agent === 'gemini' ? ['BeforeAgent', 'AfterTool'] : ['postToolUse', 'postToolUseFailure', 'stop']
    if (!contextEvents.includes(eventName)) return { output: {} }
    let length = 0
    const messages = store.snapshot().guidance.filter(m => {
      if (m.sessionId !== id || m.status !== 'queued' || length + m.text.length > 24000) return false
      length += m.text.length
      return true
    })
    if (!messages.length) return { output: {} }
    const text = messages.map(m => `[用户远程指导 ${m.id}]\n${m.text}`).join('\n\n')
    store.change(state => { for (const message of messages) state.guidance.find(m => m.id === message.id)!.status = 'submitted' })
    const output = agent === 'claude' ? eventName === 'Stop' ? { decision: 'block', reason: text } : { hookSpecificOutput: { hookEventName: eventName, additionalContext: text } }
      : agent === 'gemini' ? { hookSpecificOutput: { additionalContext: text } }
        : eventName === 'stop' ? { followup_message: text } : { additional_context: text }
    return { output, guidanceIds: messages.map(m => m.id) }
  }
  poll(id: string, invocation: string): { status: string; released?: boolean; decision?: InterventionRequest['decision']; questions?: Question[] } {
    this.hub.store.expire()
    const r = this.hub.store.get(id)
    check(r.origin === 'hook' && r.nativeRequestId === invocation, '请求不属于此 Hook', 403)
    if (r.released) return { status: r.status, released: true }
    if (r.status === 'queued') this.hub.store.mark(id, 'submitted')
    return { status: this.hub.store.get(id).status, ...(r.status === 'queued' || r.status === 'submitted' ? { decision: r.decision, questions: r.questions } : {}) }
  }
}

/** Remove only our gate; the Agent's own permission checks still apply. */
export function hookPassthrough(agent: string, event: Record<string, unknown>): Record<string, unknown> {
  return agent === 'cursor' && ['beforeShellExecution', 'beforeMCPExecution'].includes(String(event.hook_event_name)) ? { permission: 'allow' } : {}
}

/** Only this invocation retains the raw tool input. Remote decisions cannot rewrite commands. */
export function hookDecision(agent: string, event: Record<string, unknown>, decision: InterventionRequest['decision'], questions: Question[] = []): Record<string, unknown> {
  if (typeof event.hook_event_name === 'string' && !['PermissionRequest', 'PreToolUse', 'Elicitation', 'beforeShellExecution', 'beforeMCPExecution', 'BeforeTool'].includes(event.hook_event_name)) return {}
  const approved = decision?.action === 'approve' || decision?.action === 'answer'
  if (agent === 'claude') {
    if (event.hook_event_name === 'Elicitation') return { hookSpecificOutput: { hookEventName: 'Elicitation', action: decision?.action === 'answer' ? 'accept' : 'cancel', ...(decision?.answers ? { content: formAnswers(questions, decision.answers) } : {}) } }
    const original = record(event.tool_input ?? {})
    const updatedInput = decision?.action === 'answer' ? { ...original, answers: Object.fromEntries(questions.map(q => [q.text, decision.answers![q.id].join(', ')])) } : original
    if (event.hook_event_name === 'PermissionRequest') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: approved ? 'allow' : 'deny',
      ...(decision?.action === 'answer' ? { updatedInput } : {}), ...(!approved ? { message: '远程拒绝、取消或请求失效' } : {}) } } }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: approved ? 'allow' : 'deny', ...(approved ? { updatedInput } : { permissionDecisionReason: '远程拒绝、取消或请求失效' }) } }
  }
  if (agent === 'cursor') return { permission: approved ? 'allow' : 'deny', user_message: approved ? '远程确认已收到' : '远程请求未获批准' }
  return approved ? {} : { decision: 'deny', reason: '远程请求未获批准' }
}
