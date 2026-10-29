import type { Activity } from './activity'

export type IslandMode = 'focus' | 'managed'
export interface IslandBehavior { mode: IslandMode; attentionIds: string[] }
export type AttentionKind = 'approval' | 'input' | 'error' | 'task-error' | 'task-approval' | 'task-input'
export interface AttentionIssue { key: string; kind: AttentionKind; title: string; detail: string }
type AttentionActivity = Pick<Activity, 'state' | 'title' | 'detail' | 'operation' | 'steps' | 'tasks' | 'endedAt' | 'questionRequest'> & { startedAt?: number }
const ATTENTION_PRIORITY: Record<AttentionKind, number> = { approval: 4, input: 4, 'task-approval': 3, 'task-input': 3, error: 2, 'task-error': 1 }

export function isIslandMode(value: unknown): value is IslandMode {
  return value === 'focus' || value === 'managed'
}

export function isUserInputTool(name: string | undefined): boolean {
  const tool = name?.split(/[.:]/).pop()?.toLowerCase()
  return !!tool && ['askuserquestion', 'askquestion', 'ask_user', 'request_user_input', 'request_user_input_async'].includes(tool)
}

export function attentionKind(activity: Activity): AttentionKind | undefined {
  return attentionIssues(activity)[0]?.kind
}

/** Local alerts and remote observation share evidence, priority and occurrence identity. */
export function attentionIssues(activity: AttentionActivity): AttentionIssue[] {
  if (activity.state === 'success' || activity.state === 'stopped') return []
  const issue = (kind: AttentionKind, identity: unknown, title: string, detail = ''): AttentionIssue => ({
    key: JSON.stringify([activity.startedAt, kind, identity]), kind, title, detail
  })
  // A terminal failure owns its descendants' diagnostics; do not fan it out into more alerts.
  if (activity.state === 'error') return [issue('error', activity.endedAt, activity.title, activity.detail)]
  const issues: AttentionIssue[] = []
  const stepIds = (status: 'active' | 'waiting'): string[] => activity.steps.filter(step => step.status === status).map(step => step.id).sort()
  const operation = activity.operation
  const toolIdentity = (status: 'active' | 'waiting'): unknown => {
    const ids = stepIds(status)
    return ids.length ? ids : [operation?.kind, operation?.name, operation?.command]
  }
  if (activity.state === 'approval') issues.push(issue('approval', toolIdentity('waiting'), activity.title, operation?.command ?? activity.detail))
  if (activity.questionRequest?.status === 'pending') {
    issues.push(issue('input', activity.questionRequest.id, '需要你回答', activity.title))
  }
  // "waiting" also means waiting for an agent's response. Only recorded requests
  // for human input count, not elapsed time or natural-language guesses.
  else if (!activity.questionRequest) {
    const inputs = activity.steps.filter(step => step.status === 'active' && isUserInputTool(step.name))
    for (const step of inputs) issues.push(issue('input', step.id, '需要人工回答（尚未建立问题控制关联）', step.label))
    if (!inputs.length && (activity.state === 'running' || activity.state === 'waiting') &&
        operation?.kind === 'tool' && isUserInputTool(operation.name)) {
      issues.push(issue('input', toolIdentity('active'), '需要人工回答（尚未建立问题控制关联）', activity.title))
    }
  }
  for (const task of activity.tasks ?? []) if (task.status === 'active' && (task.state === 'approval' || task.requestKind === 'approval')) {
    issues.push(issue('task-approval', [task.id, task.startedAt, task.requestId], `子任务：${task.label}`, task.detail))
  }
  for (const task of activity.tasks ?? []) if (task.status === 'active' && task.requestKind === 'input') {
    issues.push(issue('task-input', [task.id, task.startedAt, task.requestId], `子任务需要回答：${task.label}`, task.detail))
  }
  for (const task of activity.tasks ?? []) if (task.status === 'error') {
    issues.push(issue('task-error', [task.id, task.startedAt], `子任务：${task.label}`, task.detail))
  }
  return issues
}

/** Acknowledgments last for this occurrence; metadata refreshes never reopen it. */
export class AttentionTracker {
  private current = new Map<string, AttentionIssue[]>()
  private rounds = new Map<string, number>()
  private order = new Map<string, number>()
  private sequence = 0
  private acknowledged = new Map<string, { round: number; keys: Map<string, AttentionKind> }>()

  update(activities: readonly Activity[]): void {
    this.rounds = new Map(activities.map(activity => [activity.id, activity.startedAt]))
    this.current = new Map(activities.flatMap(activity => {
      const issues = attentionIssues(activity)
      return issues.length ? [[activity.id, issues] as const] : []
    }))
    for (const [id, acknowledgment] of this.acknowledged) {
      if (this.rounds.has(id) && this.rounds.get(id) !== acknowledgment.round) { this.acknowledged.delete(id); continue }
      const live = new Set(this.current.get(id)?.map(issue => issue.key))
      // Cached failures can temporarily leave the visible snapshot; that is not a new failure.
      for (const [key, kind] of acknowledgment.keys) if (!live.has(key) && kind !== 'error' && kind !== 'task-error') acknowledgment.keys.delete(key)
      if (!acknowledgment.keys.size) this.acknowledged.delete(id)
    }
    const pending = new Set(this.pendingEntries().map(entry => entry.id))
    for (const id of this.order.keys()) if (!pending.has(id)) this.order.delete(id)
    for (const id of pending) if (!this.order.has(id)) this.order.set(id, ++this.sequence)
  }

  acknowledge(id: string): void {
    const issues = this.current.get(id)
    const round = this.rounds.get(id)
    if (!issues || round === undefined) return
    const keys = this.acknowledged.get(id)?.keys ?? new Map<string, AttentionKind>()
    for (const issue of issues) keys.set(issue.key, issue.kind)
    this.acknowledged.delete(id)
    this.acknowledged.set(id, { round, keys })
    this.order.delete(id)
    if (this.acknowledged.size > 512) this.acknowledged.delete(this.acknowledged.keys().next().value!)
  }

  pendingIds(): string[] {
    return this.pendingEntries().sort((left, right) => right.priority - left.priority ||
      (this.order.get(left.id) ?? 0) - (this.order.get(right.id) ?? 0)).map(entry => entry.id)
  }

  private pendingEntries(): { id: string; priority: number }[] {
    return [...this.current].flatMap(([id, issues]) => {
      const pending = issues.filter(issue => !this.acknowledged.get(id)?.keys.has(issue.key))
      return pending.length ? [{ id, priority: Math.max(...pending.map(issue => ATTENTION_PRIORITY[issue.kind])) }] : []
    })
  }
}

/** Temporarily reveal actionable sessions without changing the saved edge collapse. */
export function islandAttention(behavior: IslandBehavior, dockCollapsed = false): boolean {
  return behavior.attentionIds.length > 0 && (behavior.mode === 'managed' || dockCollapsed)
}

export function isPassive(behavior: IslandBehavior): boolean {
  return behavior.mode === 'managed' && !islandAttention(behavior)
}

/** Alerts capture only their visible surface; the rest of the desktop stays usable. */
export function shouldIgnoreMouse(behavior: IslandBehavior, overIsland: boolean, expanded: boolean, dragging: boolean, dockCollapsed = false): boolean {
  if (behavior.mode === 'managed' || islandAttention(behavior, dockCollapsed)) return isPassive(behavior) || (!dragging && !overIsland)
  return !dragging && !expanded && !overIsland
}
