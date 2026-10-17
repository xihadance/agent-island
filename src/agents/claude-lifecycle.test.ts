import { describe, expect, it } from 'vitest'
import { parseTranscript } from './parse'
import { claudePlugin } from './plugins/claude'
import { createReducer } from './reduce'
import { presentSession } from './watch'

const START = Date.parse('2026-10-10T02:40:00.000Z')
const END = Date.parse('2026-10-10T02:44:54.591Z')
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n')
const request = { type: 'user', timestamp: START, message: { content: '继续检查' } }
const failure = {
  type: 'assistant', timestamp: END, isApiErrorMessage: true, error: 'model_not_found',
  message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence',
    content: [{ type: 'text', text: 'The selected model does not exist or is not accessible.' }] }
}
/** Written by the CLI as it shuts down. Real rows carry no timestamp. */
const costState = { type: 'cost-state', sessionId: 'session', totalCostUSD: 0, totalDuration: 114443, startTime: START, modelUsage: {} }

describe('Claude interactive lifecycle', () => {
  it.each(['stop_sequence', 'end_turn', null])('treats a native API failure with %s as an error', (stopReason) => {
    const view = parseTranscript('claude', 'session', jsonl([
      request,
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }] } },
      { ...failure, message: { ...failure.message, stop_reason: stopReason } }
    ]))
    expect(view).toMatchObject({ state: 'error', terminal: true, title: failure.message.content[0].text,
      startedAt: START, endedAt: END })
    expect(view?.steps[0].status).toBe('error')
  })

  it('keeps the error and its timing through a local command split across appends', () => {
    const parse = claudePlugin.createParser!()
    const reducer = createReducer()
    reducer.push(parse(jsonl([request, failure, {
      type: 'user', isMeta: true, uuid: 'caveat', promptId: 'local-prompt', timestamp: END + 1000,
      message: { content: '<local-command-caveat>This command was run locally.</local-command-caveat>' }
    }])).events)
    reducer.push(parse(jsonl([
      { type: 'user', parentUuid: 'caveat', promptId: 'local-prompt', timestamp: END + 2000,
        message: { content: '<command-name>/list-agents</command-name>\n<command-message>list-agents</command-message>' } },
      { type: 'system', subtype: 'local_command', timestamp: END + 3000,
        content: '<local-command-stdout>This session: ...</local-command-stdout>' }
    ])).events)
    expect(reducer.snapshot()).toMatchObject({ state: 'error', terminal: true, turn: 1, startedAt: START, endedAt: END })
    reducer.push(parse(jsonl([{ ...request, timestamp: END + 4000 }])).events)
    expect(reducer.snapshot()).toMatchObject({ state: 'waiting', terminal: false, turn: 2, startedAt: END + 4000 })
    expect(reducer.snapshot().endedAt).toBeUndefined()
  })

  it('preserves real slash prompts and ordinary assistant explanations of API errors', () => {
    const view = parseTranscript('claude', 'session', jsonl([request, failure,
      { type: 'user', timestamp: END + 1000, promptId: 'real-prompt',
        message: { content: '<command-name>/review</command-name>' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Investigating model_not_found in the application.' }] } }
    ]))
    expect(view).toMatchObject({ state: 'thinking', terminal: false, turn: 2, startedAt: END + 1000 })
  })

  it.each(['[Request interrupted by user]', '[Request interrupted by user for tool use]'])('recognizes %s as an interruption, not a new request', (content) => {
    expect(parseTranscript('claude', 'session', jsonl([request,
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '检查中' }] } },
      { type: 'user', timestamp: END, message: { content: [{ type: 'text', text: content }] } }
    ]))).toMatchObject({ state: 'error', title: '已中断', terminal: true, turn: 1, startedAt: START, endedAt: END })
  })
})

describe('Claude shutdown record', () => {
  it('ends an unfinished turn as a recorded exit instead of an interruption', () => {
    const view = parseTranscript('claude', 'session', jsonl([request,
      { type: 'assistant', timestamp: END, message: { content: [{ type: 'thinking', thinking: '检查中' }] } },
      costState
    ]))
    expect(view).toMatchObject({ state: 'stopped', title: '会话已退出', terminal: true, turn: 1, startedAt: START })
    // The shutdown row carries no timestamp; the last recorded event dates it.
    expect(view?.endedAt).toBe(END)
    // Terminal means the watcher reports the exit as-is, never as 会话已中断.
    expect(presentSession(view!, false, 600_000, true)).toBe(view)
  })

  it('keeps the outcome and timing of a turn that already finished', () => {
    expect(parseTranscript('claude', 'session', jsonl([request,
      { type: 'assistant', timestamp: END, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '改完了' }] } },
      costState
    ]))).toMatchObject({ state: 'success', title: '改完了', terminal: true, endedAt: END })
  })

  it('settles sub-agents and background commands that died with the process', () => {
    const view = parseTranscript('claude', 'session', jsonl([request,
      { type: 'assistant', timestamp: START + 1000, message: { content: [{ type: 'tool_use', id: 'spawn', name: 'Agent', input: { description: '查日志' } }] } },
      { type: 'user', timestamp: START + 2000, toolUseResult: { agentId: 'a1', status: 'async_launched' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'spawn', content: '已派生' }] } },
      { ...costState, timestamp: END }
    ]))
    expect(view).toMatchObject({ state: 'stopped', terminal: true })
    expect(view?.tasks).toMatchObject([{ id: 'spawn', status: 'stopped', endedAt: END }])
  })

  it('does not keep waiting on an answer nobody can give anymore', () => {
    const view = parseTranscript('claude', 'session', jsonl([request,
      { type: 'assistant', timestamp: START + 1000, message: { content: [{ type: 'tool_use', id: 'ask', name: 'AskUserQuestion', input: { questions: [{ question: '用哪种方案？' }] } }] } },
      { ...costState, timestamp: END }
    ]))
    expect(view).toMatchObject({ state: 'stopped', title: '会话已退出', terminal: true, endedAt: END })
  })

  it('reopens the session when a resumed run appends turns after the exit', () => {
    const parse = claudePlugin.createParser!()
    const reducer = createReducer()
    reducer.push(parse(jsonl([request, costState])).events)
    expect(reducer.snapshot()).toMatchObject({ state: 'stopped', terminal: true, turn: 1 })
    reducer.push(parse(jsonl([
      { type: 'file-history-snapshot' },
      { type: 'user', timestamp: END, message: { content: '继续' } }
    ])).events)
    expect(reducer.snapshot()).toMatchObject({ state: 'waiting', terminal: false, turn: 2, startedAt: END })
  })

  it('ignores a shutdown record with nothing before it', () => {
    expect(parseTranscript('claude', 'session', jsonl([{ type: 'permission-mode', permissionMode: 'default' }, costState]))).toBeNull()
  })

  it.each(['stdout', 'stderr'])('does not start a turn for local-command-%s output', (stream) => {
    // A /model run writes a caveat, the command, then its output as a separate non-meta user row.
    const view = parseTranscript('claude', 'session', jsonl([request,
      { type: 'assistant', timestamp: END, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '改完了' }] } },
      { type: 'user', isMeta: true, uuid: 'caveat', promptId: 'local', timestamp: END + 1000,
        message: { content: '<local-command-caveat>This command was run locally.</local-command-caveat>' } },
      { type: 'user', parentUuid: 'caveat', promptId: 'local', timestamp: END + 2000,
        message: { content: '<command-name>/model</command-name>\n<command-message>model</command-message>' } },
      { type: 'user', parentUuid: 'cmd', promptId: 'local', timestamp: END + 3000,
        message: { content: `<local-command-${stream}>Set model to \`Opus 5.5\`</local-command-${stream}>` } }
    ]))
    expect(view).toMatchObject({ state: 'success', title: '改完了', terminal: true, turn: 1, endedAt: END })
  })
})
