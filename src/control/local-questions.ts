import { activityId, AGENT_LABEL } from '../agents/parse'
import type { QuestionRequest } from '../shared/question-request'
import { ACTIVE_STATUSES, type ControlState } from './types'

export function localQuestions(state: ControlState): QuestionRequest[] {
  const sessions = new Map(state.sessions.map(session => [session.id, session]))
  return state.requests.flatMap(request => {
    const session = sessions.get(request.sessionId)
    if (!session || request.origin === 'observation' || request.kind !== 'input' || !request.questions.length ||
        !request.actions.includes('answer') || ![...ACTIVE_STATUSES, 'uncertain'].includes(request.status)) return []
    return [{ id: request.id, activityId: activityId(session.agent, session.nativeId), agent: AGENT_LABEL[session.agent], label: session.label,
      revision: request.revision, status: request.status, questions: request.questions, createdAt: request.createdAt, expiresAt: request.expiresAt,
      connected: session.connected, decision: request.decision }]
  })
}
