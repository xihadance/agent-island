import { activityId, AGENT_LABEL } from '../agents/parse'
import { describeOperation } from '../agents/operation'
import { parseMaybeRecord } from '../agents/events'
import type { NativeApproval } from '../shared/native-approval'
import type { ControlState } from './types'

export function localApprovals(state: Pick<ControlState, 'sessions' | 'requests'>): NativeApproval[] {
  const sessions = new Map(state.sessions.map(session => [session.id, session]))
  return state.requests.flatMap(request => {
    const session = sessions.get(request.sessionId)
    if (!session || request.origin === 'observation' || !['approval', 'authentication'].includes(request.kind) || request.status !== 'pending') return []
    const name = request.title.replace(/^确认 /, '')
    const params = parseMaybeRecord(request.detail)
    return [{ id: request.id, activityId: activityId(session.agent, session.nativeId), agent: AGENT_LABEL[session.agent],
      title: request.title, operation: request.kind === 'authentication' ? { kind: 'mcp' as const, name: String(params.serverName ?? 'MCP') }
        : describeOperation(name, params), createdAt: request.createdAt }]
  })
}
