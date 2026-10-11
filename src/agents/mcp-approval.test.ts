import { describe, expect, it } from 'vitest'
import { codexPlugin } from './plugins/codex'
import { createReducer } from './reduce'

const call = (id: string, name: string) => ({ type: 'response_item', payload: {
  type: 'function_call', name, call_id: id, arguments: '{}'
} })
const result = (id: string) => ({ type: 'response_item', payload: {
  type: 'function_call_output', call_id: id, output: '{"ok":true}'
} })
const elicitation = (server: string, id: string | number, callId?: string) => ({ type: 'event_msg', payload: {
  type: 'elicitation_request', server_name: server, id, ...(callId ? { call_id: callId } : {}),
  request: { mode: 'form', message: `Allow ${server}?`, requested_schema: {} }
} })
const done = { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Finished' } }

function transcript() {
  const parse = codexPlugin.createParser!()
  const reducer = createReducer()
  return (...rows: unknown[]) => {
    reducer.push(parse(rows.map((row) => JSON.stringify(row)).join('\n')).events)
    return reducer.snapshot()
  }
}

describe('Codex MCP approval correlation', () => {
  it.each(['gh', 'ctx'])('keeps concurrent approvals on their server when %s returns first', (first) => {
    const push = transcript()
    push(call('gh', 'mcp__github__create_issue'), call('ctx', 'mcp__context7__query_docs'))
    expect(push(elicitation('github', 'e1'))).toMatchObject({
      state: 'approval', detail: 'Allow github?', operation: { name: 'github / create_issue' }
    })
    const next = push(result(first))
    expect(next).toMatchObject(first === 'ctx'
      ? { state: 'approval', operation: { name: 'github / create_issue' } }
      : { state: 'running', operation: { name: 'context7 / query_docs' } })
    expect(push(result(first === 'ctx' ? 'gh' : 'ctx'), done)).toMatchObject({ state: 'success', terminal: true })
  })

  it('uses an explicit call ID to distinguish calls on the same server', () => {
    const push = transcript()
    push(call('a', 'mcp__github__create_issue'), call('b', 'mcp__github__list_issues'))
    expect(push(elicitation('github', 'e1', 'a'))).toMatchObject({
      state: 'approval', operation: { name: 'github / create_issue' }
    })
    expect(push(result('b'))).toMatchObject({ state: 'approval', operation: { name: 'github / create_issue' } })
    expect(push(result('a'))).toMatchObject({ state: 'thinking' })
  })

  it('keeps an ambiguous request independent until all original candidates finish', () => {
    const push = transcript()
    push(call('a', 'mcp__github__create_issue'), call('b', 'mcp__github__list_issues'))
    const request = elicitation('github', 'e1')
    const waiting = push(request)
    expect(waiting).toMatchObject({ state: 'approval', title: 'MCP 授权：github' })
    expect(waiting.steps.map((step) => step.status)).toEqual(['active', 'active', 'waiting'])
    expect(push(request).steps).toHaveLength(3)
    expect(push(result('a'))).toMatchObject({ state: 'approval' })
    push(call('new', 'mcp__github__get_issue'))
    expect(push(result('b'))).toMatchObject({ state: 'running', operation: { name: 'github / get_issue' } })
    expect(push(request)).toMatchObject({ state: 'running', operation: { name: 'github / get_issue' } })
  })

  it('does not attach an unmatched server request to another server', () => {
    const push = transcript()
    push(call('a', 'mcp__github_enterprise__list_issues'))
    expect(push(elicitation('github', 'e1'))).toMatchObject({ state: 'approval', title: 'MCP 授权：github' })
    expect(push(result('a'))).toMatchObject({ state: 'approval' })
    expect(push(done)).toMatchObject({ state: 'success', terminal: true })
  })

  it('waits for a yielded MCP script to finish before settling an ambiguous approval', () => {
    const push = transcript()
    push({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'functions.exec', call_id: 'a',
      input: 'await tools.mcp__github__create_issue({})' } }, call('b', 'mcp__github__list_issues'), elicitation('github', 'e1'))
    push({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a', output: 'Script running with cell ID 42' } })
    expect(push(result('b'))).toMatchObject({ state: 'approval' })
    push({ type: 'response_item', payload: { type: 'function_call', name: 'functions.wait', call_id: 'poll', arguments: '{"cell_id":"42"}' } })
    expect(push({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'poll', output: 'Script completed' } }))
      .toMatchObject({ state: 'thinking' })
  })

  it('preserves an error when the last candidate fails', () => {
    const push = transcript()
    push(call('a', 'mcp__github__create_issue'), call('b', 'mcp__github__list_issues'), elicitation('github', 'e1'), result('a'))
    expect(push({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'b', is_error: true, output: 'Failed' } }))
      .toMatchObject({ state: 'error', terminal: true })
  })

  it.each(['missing', 'other'])('does not replace an invalid explicit owner (%s) with a different call', (id) => {
    const push = transcript()
    push(call('a', 'mcp__github__create_issue'), call('other', 'mcp__context7__query_docs'))
    expect(push(elicitation('github', 'e1', id))).toMatchObject({ state: 'approval', title: 'MCP 授权：github' })
    expect(push(result('a'), result('other'))).toMatchObject({ state: 'approval' })
  })

  it('scopes request IDs by server and deduplicates completed requests', () => {
    const push = transcript()
    push(call('a', 'mcp__github__create_issue'), elicitation('github', 1))
    push(call('b', 'mcp__context7__query_docs'), elicitation('context7', 1))
    expect(push(result('a'))).toMatchObject({ state: 'approval', operation: { name: 'context7 / query_docs' } })
    expect(push(result('b'))).toMatchObject({ state: 'thinking' })
    expect(push(elicitation('github', 1), elicitation('context7', 1))).toMatchObject({ state: 'thinking' })
  })

  it('discards independent approvals and request identities on a new user turn', () => {
    const push = transcript()
    push(elicitation('github', 'e1'))
    expect(push({ type: 'event_msg', payload: { type: 'user_message', message: 'Try again' } })).toMatchObject({ state: 'waiting', steps: [] })
    expect(push(call('a', 'mcp__github__create_issue'), elicitation('github', 'e1'))).toMatchObject({
      state: 'approval', operation: { name: 'github / create_issue' }
    })
    expect(push(result('a'))).toMatchObject({ state: 'thinking' })
  })
})
