import { priorityRank, type Activity, type ActivityOperation } from './activity'

export interface NativeApproval {
  id: string
  activityId: string
  agent: string
  title: string
  operation: ActivityOperation
  createdAt: number
}

/** Pending native permissions overlay logs; accepting permission never means tool success. */
export function withNativeApprovals(activities: Activity[], requests: readonly NativeApproval[]): Activity[] {
  const pending = new Map<string, NativeApproval[]>()
  for (const request of requests) pending.set(request.activityId, [...(pending.get(request.activityId) ?? []), request])
  const result = [...activities]
  for (const [id, approvals] of pending) {
    const request = approvals[0]
    const index = result.findIndex(activity => activity.id === id)
    const activity = result[index] ?? { id, agent: request.agent, state: 'running', title: request.title,
      steps: [], updatedAt: request.createdAt, startedAt: request.createdAt }
    // While the native prompt is pending, logged waiting steps describe the same prompt catching up.
    // Keeping them would change the alert identity and reopen an acknowledged prompt.
    const steps = activity.steps.filter(step => step.status !== 'waiting')
    const overlaid: Activity = { ...activity, state: 'approval', stale: false, endedAt: undefined, title: request.title,
      operation: request.operation, steps: [...steps, ...approvals.map(approval => ({ id: approval.id,
        label: approval.title, kind: approval.operation.kind, status: 'waiting' as const }))] }
    if (index < 0) result.push(overlaid)
    else result[index] = overlaid
  }
  return result.sort((a, b) => priorityRank(b.state) - priorityRank(a.state) || b.updatedAt - a.updatedAt)
}
