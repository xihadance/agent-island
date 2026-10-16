import { expect, it } from 'vitest'
import { ControlStore } from './store'
import { ControlHub } from './hub'
import { HookController, hookDecision } from './hooks'
import { localQuestions } from './local-questions'
import { withQuestionRequests, selectedAnswers } from '../shared/question-request'
import { AttentionTracker } from '../shared/island-behavior'
import type { QuestionRequest } from '../shared/question-request'

it('presents native Claude options without requiring a transcript and shares local answers with the Hook', async () => {
  const store = new ControlStore()
  const hub = new ControlHub(store)
  const hooks = new HookController(hub)
  const event = { session_id: 'local-question', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: {
    questions: [{ question: '选择环境', options: [{ label: '开发', description: '仅本机运行' }, { label: '生产' }], multiSelect: false }], keep: 'original'
  } }
  let changes = 0
  const stop = store.subscribe(() => changes++)
  const reply = hooks.handle({ agent: 'claude', invocationId: 'choice', event })
  const requests = localQuestions(store.snapshot())
  expect(requests[0]).toMatchObject({ activityId: 'claude-local-question', status: 'pending', connected: true,
    questions: [{ options: ['开发', '生产'], descriptions: ['仅本机运行', ''] }] })
  const activity = withQuestionRequests([], requests)[0]
  expect(activity.state).toBe('waiting')
  const tracker = new AttentionTracker()
  tracker.update([activity])
  expect(tracker.pendingIds()).toEqual([activity.id])
  tracker.acknowledge(activity.id)
  tracker.update(withQuestionRequests([{ ...activity, updatedAt: Date.now() }], requests))
  expect(tracker.pendingIds()).toEqual([])
  const request = store.get(reply.requestId!)
  await hub.respond(request.id, request.revision, { action: 'answer', answers: { q1: ['开发'] } }, 'local')
  const queued = withQuestionRequests([], localQuestions(store.snapshot()))[0]
  tracker.update([queued])
  expect(tracker.pendingIds()).toEqual([])
  expect(queued.questionRequest?.decision?.answers).toEqual({ q1: ['开发'] })
  expect(hookDecision('claude', event, hooks.poll(request.id, 'choice').decision, request.questions)).toMatchObject({
    hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { ...event.tool_input, answers: { '选择环境': '开发' } } }
  })
  await expect(hub.respond(request.id, request.revision, { action: 'answer', answers: { q1: ['生产'] } }, 'tg:owner')).rejects.toThrow('已处理')
  expect(changes).toBeGreaterThan(0)
  stop()
  hub.close()
})

it('does not promote observation-only questions to native controls and releases stopped requests', () => {
  const store = new ControlStore()
  store.session({ id: 's', agent: 'claude', nativeId: 'native', adapter: 'observation', label: 'Claude', connected: false, capabilities: [] })
  store.create({ sourceKey: 'observation', sessionId: 's', origin: 'observation', kind: 'input', title: '提示', detail: '', questions: [], actions: ['ack'], expiresAt: Date.now() + 10000 })
  expect(localQuestions(store.snapshot())).toEqual([])
  new HookController(new ControlHub(store)).handle({ agent: 'claude', invocationId: 'native', event: {
    session_id: 'active', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '问题', options: [{ label: 'A' }] }] }
  } })
  expect(localQuestions(store.snapshot())).toHaveLength(1)
  store.releaseControl()
  expect(localQuestions(store.snapshot())).toEqual([])
})

it('requires every answer and preserves multiselect and free text cardinality', () => {
  const questions = [{ id: 'q1', text: '环境', options: ['A', 'B'], multi: false, freeText: true },
    { id: 'q2', text: '模块', options: ['C', 'D'], multi: true, freeText: true }]
  expect(selectedAnswers(questions, { q1: ['A'] }, {})).toBeUndefined()
  expect(selectedAnswers(questions, { q1: ['A', 'B'], q2: ['C'] }, {})).toBeUndefined()
  expect(selectedAnswers(questions, { q1: ['A'], q2: ['C', 'D'] }, { q1: ' 自定义 ', q2: '其他' })).toEqual({ q1: ['自定义'], q2: ['C', 'D', '其他'] })
})

it.each([false, true])('keeps pending siblings visible after a newer question is answered (reverse: %s)', reverse => {
  const pending: QuestionRequest = { id: 'older', activityId: 'claude-native', agent: 'Claude Code', label: '工作区',
    revision: 1, status: 'pending', questions: [{ id: 'q1', text: '仍需回答', options: ['A'], multi: false, freeText: true }],
    createdAt: 1, expiresAt: Date.now() + 60000, connected: true }
  const submitted: QuestionRequest = { ...pending, id: 'newer', status: 'submitted', createdAt: 2, decision: { action: 'answer', answers: { q1: ['A'] } } }
  const requests = reverse ? [submitted, pending] : [pending, submitted]
  expect(withQuestionRequests([], requests)[0].questionRequest?.id).toBe('older')
  expect(withQuestionRequests([], [{ ...pending, status: 'submitted' }, submitted])[0].questionRequest?.id).toBe('newer')
})
