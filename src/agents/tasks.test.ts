import { describe, expect, it } from 'vitest'
import { parseTranscript } from './parse'
import { unwrapExec } from './plugins/codex'

const jsonl = (rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n')

describe('Codex background work', () => {
  it.each(['SubAgentActivity', 'subAgentActivity'])('settles a native %s completion without needing a separate child transcript', type => {
    const activity = (kind: string, at: number) => ({ type: 'event_msg', timestamp: at, payload: { type: 'item_completed',
      item: { type, kind, agent_thread_id: 'child', agentThreadId: 'child', agent_path: '/root/review', agentPath: '/root/review' } } })
    const view = parseTranscript('codex', 'parent', jsonl([activity('started', 1000),
      { type: 'event_msg', timestamp: 1500, payload: { type: 'task_complete', last_agent_message: '等待结果' } }, activity('completed', 2000)]))
    expect(view).toMatchObject({ state: 'success', tasks: [{ id: 'child', status: 'done', endedAt: 2000 }] })
  })

  it('does not settle a child when its close request failed', () => {
    const collab = (tool: string, status: string) => ({ type: 'event_msg', payload: { type: 'item_completed',
      item: { type: 'CollabAgentToolCall', tool, status, receiver_thread_ids: ['child'] } } })
    expect(parseTranscript('codex', 'parent', jsonl([collab('spawn_agent', 'completed'), collab('close_agent', 'failed')]))?.tasks[0].status).toBe('active')
  })

  it('reads native camel-case collab states without treating a wait tool completion as child completion', () => {
    const collab = (item: Record<string, unknown>) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'collabAgentToolCall', ...item } } })
    const spawn = collab({ tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['child'] })
    const wait = (status: string) => collab({ tool: 'wait', status: 'completed', agentsStates: { child: { status, message: '检查测试' } } })
    expect(parseTranscript('codex', 'parent', jsonl([spawn, wait('running')]))?.tasks[0].status).toBe('active')
    expect(parseTranscript('codex', 'parent', jsonl([spawn, wait('completed')]))?.tasks[0]).toMatchObject({ status: 'done', detail: '检查测试' })
  })

  const exec = (id: string, source: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: id, input: source } })
  const output = (id: string, text: string, type = 'custom_tool_call_output') => ({ type: 'response_item', payload: { type, call_id: id, output: text } })
  const wait = (id: string, cell: string) => ({ type: 'response_item', payload: { type: 'function_call', name: 'wait', call_id: id, arguments: JSON.stringify({ cell_id: cell }) } })
  const shell = 'const r = await tools.shell_command({"command":"npm test","workdir":"D:\\\\app"}); text(r)'

  it('keeps a yielded script running until a wait observes its end', () => {
    const rows = [exec('run', shell), output('run', 'Script running with cell ID 3\nWall time 10.0 seconds\nOutput:\n')]
    const yielded = parseTranscript('codex', 'bg', jsonl(rows))
    expect(yielded).toMatchObject({ state: 'running', title: 'npm test', operation: { kind: 'command', command: 'npm test', cwd: 'D:\\app' } })
    expect(yielded?.steps.map((step) => step.status)).toEqual(['active'])
    expect(yielded?.tasks).toEqual([{ id: 'cell-3', kind: 'command', label: 'npm test', status: 'active' }])

    const polling = parseTranscript('codex', 'bg', jsonl([...rows, wait('w1', '3'), output('w1', 'Script running with cell ID 3\nWall time 30.0 seconds', 'function_call_output')]))
    expect(polling?.tasks?.[0].status).toBe('active')
    expect(polling?.steps.map((step) => step.status)).toEqual(['active', 'done'])

    const finished = parseTranscript('codex', 'bg', jsonl([...rows, wait('w2', '3'), output('w2', 'Script failed\nWall time 3.0 seconds', 'function_call_output')]))
    expect(finished?.tasks?.[0]).toMatchObject({ id: 'cell-3', status: 'error' })
    expect(finished?.steps.map((step) => step.status)).toEqual(['done', 'done'])
  })

  it('forgets yielded commands when the turn ends, since their fate is never recorded', () => {
    const view = parseTranscript('codex', 'bg', jsonl([
      exec('run', shell), output('run', 'Script running with cell ID 3'),
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '测试在后台运行' } }
    ]))
    expect(view).toMatchObject({ state: 'success', title: '测试在后台运行', tasks: [] })
  })

  it('tracks unified exec sessions through write_stdin', () => {
    const start = { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'dev', arguments: JSON.stringify({ cmd: 'npm run dev' }) } }
    const poll = { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: 'poll', arguments: JSON.stringify({ session_id: 42, chars: '' }) } }
    const rows = [start, output('dev', 'Chunk ID: a\nWall time: 10 seconds\nProcess running with session ID 42\n', 'function_call_output')]
    expect(parseTranscript('codex', 'proc', jsonl(rows))?.tasks).toMatchObject([{ id: 'proc-42', status: 'active', label: 'npm run dev' }])
    const exited = parseTranscript('codex', 'proc', jsonl([...rows, poll, output('poll', 'Chunk ID: b\nProcess exited with code 1\n', 'function_call_output')]))
    expect(exited?.tasks?.[0]).toMatchObject({ status: 'error' })
    expect(exited?.steps.every((step) => step.status === 'done')).toBe(true)
  })

  it('shows spawned sub-agents and stays running after the parent turn completes', () => {
    const collab = (item: Record<string, unknown>) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CollabAgentToolCall', ...item } } })
    const rows = [
      collab({ tool: 'spawn_agent', status: 'completed', receiver_thread_ids: ['t-1'], receiver_agents: [{ thread_id: 't-1', agent_nickname: 'Dirac' }], prompt: '校订 EP04' }),
      collab({ tool: 'spawn_agent', status: 'completed', receiver_thread_ids: ['t-2'], receiver_agents: [{ thread_id: 't-2', agent_nickname: 'Newton' }], prompt: '校订 EP05' }),
      collab({ tool: 'wait', status: 'completed', receiver_thread_ids: ['t-1'], agents_states: { 't-1': { completed: 'EP04 已校订' } } }),
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '一个子代理已返回' } }
    ]
    const background = parseTranscript('codex', 'collab', jsonl(rows))
    expect(background).toMatchObject({ state: 'running', title: '子 Agent Newton 进行中', terminal: false })
    expect(background?.tasks).toEqual([
      { id: 't-1', kind: 'agent', label: 'Dirac', status: 'done', detail: 'EP04 已校订' },
      { id: 't-2', kind: 'agent', label: 'Newton', status: 'active', detail: '校订 EP05' }
    ])

    const notice = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text',
      text: '<subagent_notification>\n{"agent_path":"t-2","status":{"completed":"EP05 已校订"}}\n</subagent_notification>' }] } }
    const settled = parseTranscript('codex', 'collab', jsonl([...rows, notice]))
    // The notification is not a new prompt: the finished turn and its tasks stay.
    expect(settled).toMatchObject({ state: 'success', title: '一个子代理已返回', terminal: true })
    expect(settled?.tasks?.map((task) => task.status)).toEqual(['done', 'done'])
  })

  it('keeps an unanswered question instead of treating silence or a final message as an interruption', () => {
    const ask = { type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'q',
      arguments: JSON.stringify({ questions: [{ id: 'scope', header: '范围', question: '要改哪些文件？' }] }) } }
    const waiting = parseTranscript('codex', 'ask', jsonl([
      ask,
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '等你选择' }] } }
    ]))
    expect(waiting).toMatchObject({ state: 'running', title: '要改哪些文件？', terminal: false, operation: { kind: 'tool', name: 'request_user_input' } })

    const asyncAsk = parseTranscript('codex', 'ask', jsonl([
      { type: 'response_item', payload: { type: 'function_call', name: 'functions.request_user_input_async', call_id: 'q',
        arguments: JSON.stringify({ questions: [{ title: '文档用哪种风格？', options: ['简洁', '详细'] }] }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'q', output: '{"accepted":true}' } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'q', phase: 'final_answer', delivery: 'async',
        questions: [{ title: '文档用哪种风格？' }] } } },
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '先确认风格' } }
    ]))
    expect(asyncAsk).toMatchObject({ state: 'running', title: '文档用哪种风格？', terminal: false, operation: { name: 'request_user_input_async' } })

    const eventOnly = parseTranscript('codex', 'ask', jsonl([
      { type: 'event_msg', payload: { type: 'request_user_input', call_id: 'q', questions: [{ question: '继续吗？' }] } }
    ]))
    expect(eventOnly).toMatchObject({ state: 'running', title: '继续吗？', terminal: false })
  })

  it('clears a pending question once the user answers, and still records a real interrupt', () => {
    const ask = { type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'q',
      arguments: JSON.stringify({ questions: [{ question: '继续吗？' }] }) } }
    const answered = parseTranscript('codex', 'ask', jsonl([
      ask,
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'q', output: '{"answers":{"q":{"answers":["继续"]}}}' } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'q', questions: [{ title: '继续吗？' }] } } }
    ]))
    expect(answered).toMatchObject({ state: 'thinking', title: '正在处理结果', terminal: false })
    expect(answered?.operation).toBeUndefined()

    const aborted = parseTranscript('codex', 'ask', jsonl([
      ask,
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>\nThe user interrupted\n</turn_aborted>' }] } },
      { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }
    ]))
    expect(aborted).toMatchObject({ state: 'stopped', title: '已中断', terminal: true })
  })

  it('keeps unanswered Claude, Gemini, and Cursor questions pending', () => {
    const claude = parseTranscript('claude', 'ask', jsonl([
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [
        { type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [{ question: '用哪种方案？' }] } }
      ] } }
    ]))
    expect(claude).toMatchObject({ state: 'running', title: '用哪种方案？', terminal: false, operation: { name: 'AskUserQuestion' } })

    const gemini = parseTranscript('gemini', 'ask', JSON.stringify({ messages: [
      { type: 'gemini', toolCalls: [{ id: 'q', name: 'ask_user', args: { questions: [{ question: '继续发布吗？' }] }, status: 'awaiting_approval' }] }
    ] }))
    expect(gemini).toMatchObject({ state: 'running', title: '继续发布吗？', terminal: false, operation: { name: 'ask_user' } })
    expect(gemini?.state).not.toBe('approval')

    const cursor = parseTranscript('cursor', 'ask', jsonl([
      { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskQuestion', input: { questions: [{ prompt: '要写文档还是直接改代码？' }] } }] } }
    ]))
    expect(cursor).toMatchObject({ state: 'running', title: '要写文档还是直接改代码？', terminal: false, operation: { name: 'AskQuestion' } })
  })

  it('shows MCP tool authorization as an approval and clears it once answered', () => {
    const call = { type: 'response_item', payload: { type: 'function_call', name: 'mcp__github__create_issue', call_id: 'm1',
      arguments: JSON.stringify({ title: '修复登录' }) } }
    const approval = { type: 'event_msg', payload: { type: 'request_user_input', call_id: 'm1', questions: [
      { id: 'mcp', header: 'Approve app tool call?', question: 'Allow the github MCP server to run tool "create_issue"?' }] } }
    const waiting = parseTranscript('codex', 'mcp', jsonl([call, approval]))
    expect(waiting).toMatchObject({ state: 'approval', title: '调用 github / create_issue',
      detail: 'Allow the github MCP server to run tool "create_issue"?', operation: { kind: 'mcp', name: 'github / create_issue' } })
    expect(waiting?.steps[0].status).toBe('waiting')

    const answered = parseTranscript('codex', 'mcp', jsonl([call, approval,
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'm1', output: '{"created":true}' } }]))
    expect(answered).toMatchObject({ state: 'thinking', title: '正在处理结果' })
    expect(answered?.steps[0].status).toBe('done')
  })

  it('shows MCP authorization requested through elicitation', () => {
    const call = { type: 'response_item', payload: { type: 'function_call', name: 'mcp__github__create_issue', call_id: 'm1',
      arguments: JSON.stringify({ title: '修复登录' }) } }
    const elicitation = { type: 'event_msg', payload: { type: 'elicitation_request', server_name: 'github', id: 'e1',
      request: { mode: 'form', message: 'Allow the github MCP server to run tool "create_issue"?', requested_schema: {} } } }
    const waiting = parseTranscript('codex', 'mcp', jsonl([call, elicitation]))
    expect(waiting).toMatchObject({ state: 'approval', title: '调用 github / create_issue',
      detail: 'Allow the github MCP server to run tool "create_issue"?' })
    const resolved = parseTranscript('codex', 'mcp', jsonl([call, elicitation,
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'm1', output: '{"created":true}' } }]))
    expect(resolved?.state).not.toBe('approval')
  })

  it('shows Codex permission requests as approvals', () => {
    const rows = [
      { type: 'response_item', payload: { type: 'function_call', name: 'request_permissions', call_id: 'p1',
        arguments: JSON.stringify({ reason: '需要写入 build 目录' }) } },
      { type: 'event_msg', payload: { type: 'request_permissions', call_id: 'p1', reason: '需要写入 build 目录' } }
    ]
    expect(parseTranscript('codex', 'perm', jsonl(rows))).toMatchObject({ state: 'approval', title: '申请权限', detail: '需要写入 build 目录' })
  })

  it('does not treat injected user-role messages as prompts', () => {
    const view = parseTranscript('codex', 'aborted', jsonl([
      exec('run', shell),
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>\nThe user interrupted\n</turn_aborted>' }] } },
      { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }
    ]))
    expect(view).toMatchObject({ state: 'stopped', title: '已中断' })
    expect(view?.steps).toHaveLength(1)
  })

  it('unwraps code-mode tool calls without evaluating them', () => {
    expect(unwrapExec('const r = await tools.multi_agent_v1__wait_agent({"targets":["a"]})')).toEqual({ name: 'wait_agent', input: { targets: ['a'] } })
    expect(unwrapExec('await tools.shell_command({command: "x"})')).toEqual({ name: 'shell_command', input: { command: 'x' } })
    expect(unwrapExec('text(1 + 1)')).toBeNull()
  })

  it.each(['write_stdin', 'functions.write_stdin'])('settles a process through %s', (name) => {
    const view = parseTranscript('codex', 'namespace', jsonl([
      { type: 'response_item', payload: { type: 'function_call', name: 'functions.exec_command', call_id: 'cmd', arguments: '{"cmd":"npm test"}' } },
      output('cmd', 'Process running with session ID 42', 'function_call_output'),
      { type: 'response_item', payload: { type: 'function_call', name, call_id: 'poll', arguments: '{"session_id":42}' } },
      output('poll', 'Process exited with code 0', 'function_call_output')
    ]))
    expect(view?.tasks).toMatchObject([{ id: 'proc-42', status: 'done' }])
    expect(view?.steps.every((step) => step.status === 'done')).toBe(true)
  })

  it('settles a script through functions.wait', () => {
    const view = parseTranscript('codex', 'namespace', jsonl([
      exec('cmd', shell), output('cmd', 'Script running with cell ID 42'),
      { type: 'response_item', payload: { type: 'function_call', name: 'functions.wait', call_id: 'poll', arguments: '{"cell_id":"42"}' } },
      output('poll', 'Script completed', 'function_call_output')
    ]))
    expect(view?.tasks).toMatchObject([{ id: 'cell-42', status: 'done' }])
  })

  it('preserves Skill and approval arguments in ordinary JavaScript object literals', () => {
    const skill = parseTranscript('codex', 'skill', jsonl([exec('s', "text(await tools.exec_command({cmd: 'Get-Content /skills/frontend-design/SKILL.md', workdir: '/project',}));")]))
    expect(skill?.operation).toMatchObject({ kind: 'skill', name: 'frontend-design', cwd: '/project' })
    const approval = parseTranscript('codex', 'approval', jsonl([exec('a', "text(await tools.exec_command({cmd: 'npm install', sandbox_permissions: 'require_escalated', justification: '访问网络'}));")]))
    expect(approval).toMatchObject({ state: 'approval', detail: '访问网络', operation: { command: 'npm install' } })
  })

  it('reads literals without executing code or matching tool names in comments and strings', () => {
    const source = '// tools.fake({})\nconst sample = "tools.other({})"; await tools.exec_command({cmd: `npm test`, workdir: dangerous(), yield_time_ms: 1000, /* comment */});'
    expect(unwrapExec(source)).toEqual({ name: 'exec_command', input: { cmd: 'npm test', yield_time_ms: 1000 } })
    expect(unwrapExec('await tools.exec_command({cmd: "old", ...options, shell: "cmd"})'))
      .toEqual({ name: 'exec_command', input: { shell: 'cmd' } })
  })
})

describe('Claude background work', () => {
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
  const result = (id: string, toolUseResult: Record<string, unknown>) => ({
    type: 'user', toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }
  })
  const notify = (body: string) => ({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: `<task-notification>\n${body}\n</task-notification>` } })

  it('does not count a teammate as running after its native idle notification', () => {
    const view = parseTranscript('claude', 's', jsonl([
      use('agent-1', 'Agent', { name: 'reviewer', description: '检查测试', subagent_type: 'general-purpose' }),
      result('agent-1', { status: 'teammate_spawned', agentId: 'a-reviewer-123', name: 'reviewer' }),
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '等待检查结果' }] } },
      { type: 'user', message: { content: '<teammate-message teammate_id="reviewer" color="blue">\n{"type":"idle_notification","from":"reviewer","timestamp":"2026-10-30T10:00:00Z","idleReason":"available"}\n</teammate-message>' } }
    ]))
    expect(view?.tasks.find(task => task.id === 'agent-1')?.status).not.toBe('active')
    expect(view?.state).not.toBe('running')
  })

  it('does not replay completed sub-agent spawns from diagnostic API request blobs', () => {
    const spawn = use('agent-1', 'Agent', { description: '检查测试' })
    const view = parseTranscript('claude', 's', jsonl([
      spawn, result('agent-1', { status: 'completed', agentId: 'a123' }),
      { ...spawn, type: 'api-request-blob' }
    ]))
    expect(view?.tasks.find(task => task.id === 'agent-1')?.status).toBe('done')
  })

  it('tracks an async agent from launch to its notification, across turns', () => {
    const rows = [
      { type: 'user', message: { content: '调研一下' } },
      use('agent-1', 'Agent', { description: '调研 MCP', subagent_type: 'general-purpose', run_in_background: true }),
      result('agent-1', { isAsync: true, status: 'async_launched', agentId: 'a123' }),
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '已派出调研' }] } }
    ]
    const running = parseTranscript('claude', 's', jsonl(rows))
    expect(running).toMatchObject({ state: 'running', title: '子 Agent 调研 MCP 进行中', terminal: false })
    expect(running?.tasks).toEqual([{ id: 'agent-1', kind: 'agent', label: '调研 MCP', status: 'active' }])

    // Resolved through the agent id even when the notice omits the tool-use id.
    const done = parseTranscript('claude', 's', jsonl([...rows, notify('<task-id>a123</task-id>\n<status>completed</status>\n<summary>Agent "调研 MCP" finished</summary>')]))
    expect(done?.tasks?.[0]).toMatchObject({ status: 'done', detail: 'Agent "调研 MCP" finished' })
    expect(done).toMatchObject({ state: 'success', title: '已派出调研' })
  })

  it('settles a foreground agent with its tool result', () => {
    const view = parseTranscript('claude', 's', jsonl([
      use('agent-1', 'Task', { description: '检查测试' }),
      result('agent-1', { status: 'completed', agentId: 'a1', content: [{ type: 'text', text: '全部通过' }] })
    ]))
    expect(view?.tasks).toEqual([{ id: 'agent-1', kind: 'agent', label: '检查测试', status: 'done', detail: '全部通过' }])
  })

  it('tracks background shell commands and queued notifications', () => {
    const rows = [
      use('bash-1', 'Bash', { command: 'npm run build', description: '构建项目', run_in_background: true }),
      result('bash-1', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bk1' })
    ]
    expect(parseTranscript('claude', 's', jsonl(rows))?.tasks).toEqual([{ id: 'bash-1', kind: 'command', label: '构建项目', status: 'active' }])
    const queued = { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>\n<task-id>bk1</task-id>\n<status>failed</status>\n</task-notification>' }
    expect(parseTranscript('claude', 's', jsonl([...rows, queued]))?.tasks?.[0].status).toBe('error')
  })

  it('stops every sub-agent on a bulk stop notice and ignores injected rows', () => {
    const view = parseTranscript('claude', 's', jsonl([
      use('a', 'Agent', { description: '一号' }), result('a', { status: 'async_launched', agentId: 'x' }),
      use('b', 'Agent', { description: '二号' }), result('b', { status: 'teammate_spawned', agentId: 'y' }),
      { type: 'user', isMeta: true, message: { content: '# skill instructions' } },
      { type: 'user', message: { content: '<system-reminder>\nreminder\n</system-reminder>' } },
      { type: 'user', origin: { kind: 'task-notification' }, message: { content: '2 background agents were stopped by the user: "一号", "二号".' } }
    ]))
    expect(view?.tasks?.map((task) => task.status)).toEqual(['stopped', 'stopped'])
    expect(view?.steps).toHaveLength(2)
  })
})
