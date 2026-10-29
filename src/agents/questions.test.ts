import { describe, expect, it } from 'vitest'
import { codexPlugin } from './plugins/codex'
import { createReducer } from './reduce'

const ask = (id: string) => ({ type: 'response_item', payload: {
  type: 'function_call', name: 'functions.request_user_input_async', call_id: id,
  arguments: JSON.stringify({ questions: [{ title: `Question ${id}?` }] })
} })
const result = (id: string, output: unknown) => ({ type: 'response_item', payload: {
  type: 'function_call_output', call_id: id, output: JSON.stringify(output)
} })
const event = (payload: Record<string, unknown>) => ({ type: 'event_msg', payload })
const done = event({ type: 'task_complete', last_agent_message: 'Finished' })
const answer = (id: string) => result(id, { answers: { [id]: { answers: ['Yes'] } } })

function transcript() {
  const parse = codexPlugin.createParser!()
  const reducer = createReducer()
  return (...rows: unknown[]) => {
    reducer.push(parse(rows.map((row) => JSON.stringify(row)).join('\n')).events)
    return reducer.snapshot()
  }
}

describe('pending human questions', () => {
  it('keeps multiple async questions open through completion, until every answer arrives', () => {
    const push = transcript()
    const pending = push(ask('a'), result('a', { accepted: true }), ask('b'), result('b', { accepted: true }), done)
    expect(pending).toMatchObject({ state: 'running', title: 'Question a?', terminal: false })
    expect(pending.endedAt).toBeUndefined()
    expect(pending.steps.map((step) => step.status)).toEqual(['active', 'active'])

    const partial = push(answer('a'), done)
    expect(partial).toMatchObject({ state: 'running', title: 'Question b?', terminal: false })
    expect(partial.steps.map((step) => step.status)).toEqual(['done', 'active'])

    const answered = push(answer('b'))
    expect(answered).toMatchObject({ state: 'thinking', terminal: false })
    expect(answered.operation).toBeUndefined()
    const finished = push({ ...done, timestamp: '2026-10-11T01:00:00Z' })
    expect(finished).toMatchObject({ state: 'success', terminal: true, endedAt: Date.parse('2026-10-11T01:00:00Z') })
    expect(finished.steps.every((step) => step.status === 'done')).toBe(true)
  })

  it('preserves questions when commentary and final answers arrive', () => {
    const push = transcript()
    push(ask('a'), ask('b'))
    const view = push({ type: 'response_item', payload: {
      type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Waiting for your answers' }]
    } })
    expect(view).toMatchObject({ state: 'running', title: 'Question a?', terminal: false, operation: { name: 'request_user_input_async' } })
  })

  it('retains all unresolved questions beyond the visible step limit', () => {
    const push = transcript()
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    push(...ids.map(ask), done)
    for (const id of ids.slice(0, -1)) push(answer(id))
    expect(push(done)).toMatchObject({ state: 'running', title: 'Question f?', terminal: false })
    expect(push(answer('f'), done)).toMatchObject({ state: 'success', terminal: true })
  })

  it('lets active commands take priority, then returns to the pending questions', () => {
    const push = transcript()
    push(ask('a'), ask('b'))
    const running = push({ type: 'response_item', payload: {
      type: 'function_call', name: 'exec_command', call_id: 'cmd', arguments: '{"cmd":"npm test"}'
    } })
    expect(running).toMatchObject({ state: 'running', operation: { kind: 'command', command: 'npm test' } })
    expect(push(result('cmd', 'Process exited with code 0'))).toMatchObject({
      state: 'running', title: 'Question a?', terminal: false, operation: { name: 'request_user_input_async' }
    })
  })

  it('keeps command approvals ahead of pending questions', () => {
    const push = transcript()
    push(ask('a'), ask('b'))
    const approval = push(event({ type: 'exec_approval_request', call_id: 'cmd', command: 'npm install' }))
    expect(approval).toMatchObject({ state: 'approval', operation: { kind: 'command', command: 'npm install' } })
    expect(push(result('cmd', 'Process exited with code 0'))).toMatchObject({ state: 'running', title: 'Question a?', terminal: false })
  })

  it('clears pending questions when a new user turn starts', () => {
    const push = transcript()
    push(ask('a'), ask('b'), done)
    const view = push(event({ type: 'user_message', message: 'Use the defaults' }))
    expect(view).toMatchObject({ state: 'waiting', terminal: false, steps: [] })
    expect(view.operation).toBeUndefined()
    expect(push(done)).toMatchObject({ state: 'success', terminal: true })
  })

  it('keeps an explicit abort terminal even with multiple unanswered questions', () => {
    const push = transcript()
    push(ask('a'), ask('b'), done)
    const view = push(event({ type: 'turn_aborted', reason: 'interrupted' }))
    expect(view).toMatchObject({ state: 'stopped', title: '已中断', terminal: true })
    expect(view.steps.every((step) => step.status === 'error')).toBe(true)
  })
})
