import { createHash } from 'node:crypto'
import { record } from '../shared/preferences'
import { toolEvent } from '../agents/events'
import { activityId } from '../agents/parse'
import type { AgentEvent } from '../agents/types'
import type { Decision } from '../shared/automation'
import type { Activity } from '../shared/activity'
import { withNativeApprovals, type NativeApproval } from '../shared/native-approval'

interface PendingPermission extends NativeApproval {
  sessionId: string
  candidates: Set<string>
  callName: string
}

/** HTTP permission hooks return immediately while the native Claude prompt keeps waiting. */
export class ClaudeHookObserver {
  private readonly calls = new Map<string, Map<string, string>>()
  private readonly pending = new Map<string, PendingPermission>()
  private sequence = 0

  constructor(private readonly changed: () => void, private readonly now = Date.now) {}

  hook(payload: unknown, action: Decision['action']): void {
    const event = record(payload)
    if (typeof event.session_id !== 'string' || !event.session_id) return
    const sessionId = event.session_id
    if (['Stop', 'StopFailure', 'SessionEnd', 'UserPromptSubmit'].includes(String(event.hook_event_name))) {
      this.remove(permission => permission.sessionId === sessionId)
      return
    }
    if (typeof event.tool_name !== 'string') return
    const id = `claude-permission-${createHash('sha256').update(JSON.stringify([sessionId, event.tool_name, event.tool_input])).digest('hex').slice(0, 24)}`
    if (['PostToolUse', 'PostToolUseFailure'].includes(String(event.hook_event_name)) || action !== 'manual') {
      if (this.pending.delete(id)) this.changed()
      return
    }
    if (event.hook_event_name !== 'PermissionRequest' || event.tool_name === 'AskUserQuestion' || this.pending.has(id)) return
    const tool = toolEvent(event.tool_name, record(event.tool_input))
    const callName = tool.operation?.name || tool.title
    const candidates = new Set(typeof event.tool_use_id === 'string' ? [event.tool_use_id]
      : [...(this.calls.get(sessionId) ?? [])].filter(([, name]) => name === callName).map(([call]) => call))
    this.pending.set(id, { id: `${id}-${++this.sequence}`, activityId: activityId('claude', sessionId), sessionId, agent: 'Claude Code',
      title: tool.title, operation: tool.operation!, createdAt: this.now(), candidates, callName })
    this.changed()
  }

  transcript(kind: string, sessionId: string, events: readonly AgentEvent[]): void {
    if (kind !== 'claude') return
    const calls = this.calls.get(sessionId) ?? new Map<string, string>()
    for (const event of events) {
      if ((event.kind === 'tool' || event.kind === 'approval') && event.callId) {
        const callName = event.operation?.name || event.title
        calls.set(event.callId, callName)
        for (const permission of this.pending.values()) {
          if (permission.sessionId === sessionId && permission.callName === callName) permission.candidates.add(event.callId)
        }
      } else if (event.kind === 'tool_result' && event.callId) {
        calls.delete(event.callId)
        // A replayed result older than the prompt finished an earlier call to the same tool.
        const current = (permission: PendingPermission) => event.at === undefined || event.at >= permission.createdAt
        this.remove(permission => permission.sessionId === sessionId && permission.candidates.delete(event.callId!) &&
          current(permission) && !permission.candidates.size)
      } else if (['user', 'turn_start', 'done', 'exit', 'error', 'stop'].includes(event.kind)) {
        calls.clear()
        // A final message from parallel work does not answer a permission prompt.
        if (event.kind !== 'done') this.remove(permission => permission.sessionId === sessionId && event.at !== undefined && event.at >= permission.createdAt)
      }
    }
    if (calls.size) this.calls.set(sessionId, calls)
    else this.calls.delete(sessionId)
  }

  present(activities: Activity[]): Activity[] { return withNativeApprovals(activities, [...this.pending.values()]) }

  /** Only transcripts settle a prompt. Without them, forget it rather than show it forever. */
  clear(): void {
    this.calls.clear()
    if (!this.pending.size) return
    this.pending.clear()
    this.changed()
  }

  private remove(matches: (permission: PendingPermission) => boolean): void {
    let changed = false
    for (const [id, permission] of this.pending) if (matches(permission)) { this.pending.delete(id); changed = true }
    if (changed) this.changed()
  }
}
