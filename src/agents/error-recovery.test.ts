import { expect, it } from 'vitest'
import { claudePlugin } from './plugins/claude'
import { createReducer } from './reduce'
import { parseTranscript } from './parse'

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

it.each(['authentication_failed', 'rate_limit', 'unknown_future_error'])('recognizes Claude assistant.error %s before its stop reason', error => {
  const view = parseTranscript('claude', 'session', jsonl([
    { type: 'user', message: { content: '执行任务' } },
    { type: 'assistant', error, message: { content: [{ type: 'text', text: '模型请求失败' }], stop_reason: 'stop_sequence' } }
  ]))
  expect(view).toMatchObject({ state: 'error', terminal: true, title: '模型请求失败' })
  expect(view?.detail).toContain(error)
})

it('preserves all Claude result error reasons without mistaking an empty marker for failure', () => {
  const failure = parseTranscript('claude', 'session', jsonl([
    { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['连接中断', '重试次数已用完'] }
  ]))
  expect(failure).toMatchObject({ state: 'error', terminal: true })
  expect(`${failure?.title} ${failure?.detail}`).toContain('连接中断')
  expect(failure?.detail).toContain('重试次数已用完')
  expect(parseTranscript('claude', 'session', jsonl([
    { type: 'assistant', error: null, message: { content: '已完成', stop_reason: 'end_turn' } }
  ]))).toMatchObject({ state: 'success' })
})

it('keeps parallel work and approval alive when a tool fails, then accepts the repair', () => {
  const parse = claudePlugin.createParser!()
  const reducer = createReducer()
  const push = (...rows: unknown[]) => { reducer.push(parse(jsonl(rows)).events); return reducer.snapshot() }
  push({ type: 'user', message: { content: '修复测试' } },
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'test', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: 'app.ts' } }
    ] } })
  const failed = push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'test', is_error: true, content: '测试不通过' }] } })
  expect(failed).toMatchObject({ state: 'running', terminal: false })
  expect(failed.steps).toMatchObject([{ status: 'error' }, { status: 'active' }])
  expect(push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: '已修复' }] } })).toMatchObject({ state: 'thinking', terminal: false })
  expect(push({ type: 'assistant', message: { content: '修复完成', stop_reason: 'end_turn' } })).toMatchObject({ state: 'success', terminal: true })
})

it('retains a genuine turn failure when a delayed tool result arrives', () => {
  expect(parseTranscript('claude', 'session', jsonl([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'test', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'assistant', error: 'server_error', message: { content: '服务异常' } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'test', is_error: true, content: '测试失败' }] } }
  ]))).toMatchObject({ state: 'error', title: '服务异常', terminal: true })
})
