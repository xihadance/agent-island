import type { InterventionRequest, Question, RequestStatus } from '../control/types'
import { priorityRank, type Activity } from './activity'

export interface QuestionRequest {
  id: string
  activityId: string
  agent: string
  label: string
  revision: number
  status: RequestStatus
  questions: Question[]
  createdAt: number
  expiresAt: number
  connected: boolean
  decision?: InterventionRequest['decision']
}

/** Native control evidence augments presentation without rewriting observed logs. */
export function withQuestionRequests(activities: Activity[], requests: QuestionRequest[]): Activity[] {
  const latest = new Map<string, QuestionRequest>()
  for (const request of requests) {
    const previous = latest.get(request.activityId)
    // A submitted sibling must not hide a question that still needs an answer.
    if (previous?.status === 'pending' && request.status !== 'pending') continue
    if (!previous || request.status === 'pending' && previous.status !== 'pending' || previous.createdAt <= request.createdAt) latest.set(request.activityId, request)
  }
  const result = activities.map(activity => {
    const request = latest.get(activity.id)
    latest.delete(activity.id)
    return request ? withQuestion(activity, request) : activity
  })
  for (const request of latest.values()) result.push(withQuestion({ id: request.activityId, agent: request.agent, state: 'waiting',
    title: request.label, steps: [], startedAt: request.createdAt, updatedAt: request.createdAt }, request))
  return result.sort((a, b) => priorityRank(b.state) - priorityRank(a.state) || b.updatedAt - a.updatedAt)
}

function withQuestion(activity: Activity, request: QuestionRequest): Activity {
  if (request.status !== 'pending') return { ...activity, questionRequest: request }
  return { ...activity, state: 'waiting', title: request.questions[0]?.text ?? '需要你回答', stale: false,
    operation: { kind: 'tool', name: 'request_user_input' }, questionRequest: request }
}

export function selectedAnswers(questions: Question[], selections: Record<string, string[]>, texts: Record<string, string>): Record<string, string[]> | undefined {
  const answers: Record<string, string[]> = Object.create(null)
  for (const question of questions) {
    const values = (selections[question.id] ?? []).filter(value => question.options.includes(value))
    const text = question.freeText ? texts[question.id]?.trim() : ''
    const chosen = text ? question.multi ? [...values, text] : [text] : values
    if (!chosen.length || (!question.multi && chosen.length !== 1)) return
    answers[question.id] = [...new Set(chosen)]
  }
  return questions.length ? answers : undefined
}
