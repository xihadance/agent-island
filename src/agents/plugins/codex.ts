import { open } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { isUserInputTool } from '../../shared/island-behavior'
import { commandText, describeOperation } from '../operation'
import { cleanText, contentEvents, eventTimestamp, isRecord, jsonlRows, messageEvents, outputText, parseMaybeRecord, questionText, safeId, textOf, timestampEvents, toolEvent } from '../events'
import type { AgentEvent, AgentPlugin, ChildLink, ParsedTranscript } from '../types'
import { unwrapExec } from '../script-tool'
export { unwrapExec } from '../script-tool'

/**
 * Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`.
 * Sub-agents are separate rollouts whose `session_meta` names a `parent_thread_id`.
 * Long commands yield to the background ("Script running with cell ID N") and are
 * settled by a later `wait`; sub-agents are settled by `wait` results or notifications.
 */
export const codexPlugin: AgentPlugin = {
  kind: 'codex',
  label: 'Codex',
  defaultRoot: (home, env) => path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions'),
  accepts: (file) => {
    const base = path.basename(file)
    return base.startsWith('rollout-') && base.endsWith('.jsonl')
  },
  sessionIdFrom: codexSessionId,
  parse: (text) => createCodexParser()(text),
  createParser: createCodexParser,
  executables: ['codex'],
  scripts: [/\/@openai\/codex\//i],
  child: codexChild
}

const HEAD_BYTES = 16 * 1024
/** Injected user-role messages that are not prompts. */
const INJECTED = /^<(turn_aborted|environment_context|recommended_plugins|user_instructions|system-reminder)>/

interface Call {
  name: string
  input: Record<string, unknown>
  title: string
  /** Waiting on sub-agents is already shown by their own tasks. */
  background: boolean
  at?: number
}

function codexSessionId(file: string): string {
  const base = path.basename(file).replace(/\.jsonl?$/, '')
  return base.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i)?.[1] ?? base
}

function createCodexParser(): (text: string) => ParsedTranscript {
  const calls = new Map<string, Call>()
  /** Call ids whose question was already recorded or answered. Later copies must not reopen it. */
  const questions = new Set<string>()
  /** Preserve request identity and its original candidates across incremental log reads. */
  const elicitations = new Map<string, { callId: string; pending: Set<string> }>()
  let elicitationSequence = 0
  /** Background script cells and unified-exec sessions, keyed to their starting call. */
  const cells = new Map<string, string>()
  const processes = new Map<string, string>()
  const open = new Set<string>()
  let events: AgentEvent[] = []
  let sessionId: string | undefined
  let cwd: string | undefined
  let client: string | undefined
  let metadataSeen = false
  let historyStart: number | undefined
  /** Whether a person answers sandbox escalations in this turn, per the latest `turn_context`. */
  let humanReviews = true

  const settleTurn = (): void => {
    // Codex never records whether yielded work survived the turn, so stop claiming it runs.
    for (const taskId of open) events.push({ kind: 'task_drop', taskId })
    open.clear()
    cells.clear()
    processes.clear()
    calls.clear()
    elicitations.clear()
  }

  const parse = (text: string): ParsedTranscript => {
    events = []
    for (const row of jsonlRows(text)) {
      if (!isRecord(row)) continue
      if (row.type === 'session_meta') {
        // Forked transcripts replay their parent's metadata after their own header.
        // The first header owns this file, including across incremental read batches.
        if (!metadataSeen) {
          metadataSeen = true
          const meta = isRecord(row.payload) ? row.payload : {}
          sessionId = textOf(meta.id) || undefined
          cwd = textOf(meta.cwd) || undefined
          client = codexClient(meta)
          const start = meta.subagent_history_start_ordinal
          if (typeof start === 'number' && Number.isSafeInteger(start) && start > 0) historyStart = start
        }
        continue
      }
      // Ordinals before this explicit boundary are inherited context, not work
      // performed by this child (including old approvals and spawned siblings).
      if (historyStart !== undefined && typeof row.ordinal === 'number' && row.ordinal < historyStart) continue
      if (row.type === 'event_msg') {
        const payload = isRecord(row.payload) ? row.payload : {}
        const type = textOf(payload.type)
        if (type === 'task_complete' || type === 'turn_aborted' || type === 'error' || type === 'user_message') settleTurn()
        const produced = (type === 'elicitation_request' ? elicitationEvents(payload) : codexEvent(payload, calls)).filter((event) => {
          if (event.kind !== 'tool' && event.kind !== 'approval') return true
          if (!event.callId || !isUserInputTool(event.operation?.name) || !questions.has(event.callId)) return true
          return false
        })
        for (const event of produced) {
          if ((event.kind === 'tool' || event.kind === 'approval') && event.callId && isUserInputTool(event.operation?.name)) questions.add(event.callId)
        }
        events.push(...timestampEvents(produced, row))
        continue
      }
      if (row.type === 'response_item') {
        events.push(...timestampEvents(responseItem(isRecord(row.payload) ? row.payload : {}, eventTimestamp(row)), row))
        continue
      }
      if (row.type === 'turn_context') {
        humanReviews = escalationReviewedByHuman(isRecord(row.payload) ? row.payload : {})
        continue
      }
      events.push(...timestampEvents(messageEvents(row), row))
    }
    return { events, sessionId, client, cwd }
  }
  return parse

  function responseItem(payload: Record<string, unknown>, at?: number): AgentEvent[] {
    const type = textOf(payload.type)
    if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_call') {
      let name = textOf(payload.name) || 'tool'
      let input = parseMaybeRecord(payload.arguments ?? payload.input ?? payload.args)
      // Code mode wraps every tool in a script; show the tool it actually calls.
      if (name.split('.').pop() === 'exec' && typeof payload.input === 'string') {
        const inner = unwrapExec(payload.input)
        if (inner) ({ name, input } = inner)
      }
      const callId = textOf(payload.call_id) || undefined
      // `require_escalated` is only a request. Under auto-review or `never`, nobody is asked.
      const event = toolEvent(name, input, callId, humanReviews ? undefined : false)
      if (callId) {
        calls.set(callId, { name: name.split('.').pop() ?? name, input, title: event.title, background: event.operation?.kind !== 'agent', at })
        if (isUserInputTool(event.operation?.name)) questions.add(callId)
      }
      return [event]
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'tool_result') {
      const callId = textOf(payload.call_id) || undefined
      const call = callId ? calls.get(callId) : undefined
      const output = outputText(payload.output)
      // Async questions return immediately with accepted:true. That is not an answer,
      // and it is not an interruption: the user still has to reply.
      if (call && isUserInputTool(call.name) && unansweredAccept(payload.output)) return []
      const ok = payload.is_error !== true && payload.status !== 'error'
      const result: AgentEvent = { kind: 'tool_result', title: ok ? '工具完成' : '工具失败', ok, callId }
      const events = call && callId ? backgroundEvents(call, callId, output, result) : [result]
      if (callId) calls.delete(callId)
      for (const event of [...events]) {
        if (event.kind !== 'tool_result' || !event.callId) continue
        for (const request of elicitations.values()) {
          if (!request.pending.delete(event.callId) || request.pending.size || request.callId === event.callId) continue
          // An ambiguous approval cannot be retired by just one candidate's result.
          events.push({ kind: 'tool_result', title: '审批结束', ok: true, callId: request.callId })
        }
      }
      return events
    }
    if (type === 'reasoning') {
      const summary = Array.isArray(payload.summary) ? payload.summary : []
      const title = summary.map((item) => (isRecord(item) ? textOf(item.text) : '')).find(Boolean)
      return [{ kind: 'thinking', title: title ? cleanText(title) : '思考中' }]
    }
    if (type === 'message') {
      const role = textOf(payload.role)
      if (role === 'user') {
        const first = outputText(payload.content).trimStart()
        if (first.startsWith('<subagent_notification>')) return notificationEvents(first)
        if (INJECTED.test(first)) return []
        const prompt = contentEvents(payload.content, role)
        if (prompt.some((event) => event.kind === 'user')) settleTurn()
        return prompt
      }
      const result = contentEvents(payload.content, role)
      // Async questions are delivered as a final message without ending the turn.
      const asks = payload.delivery === 'async' || (Array.isArray(payload.questions) && payload.questions.length > 0)
      if (role === 'assistant' && payload.phase === 'final_answer' && !asks) result.push({ kind: 'done', title: '' })
      return result
    }
    return []
  }

  function elicitationEvents(payload: Record<string, unknown>): AgentEvent[] {
    const server = textOf(payload.server_name)
    const id = payload.id
    const key = JSON.stringify([server, typeof id, typeof id === 'string' || typeof id === 'number' ? id : ++elicitationSequence])
    if (elicitations.has(key)) return []
    const request = isRecord(payload.request) ? payload.request : {}
    const reason = cleanText(textOf(request.message) || textOf(request.url))
    const explicit = textOf(payload.call_id)
    const candidates = [...calls.entries()].filter(([callId, call]) => {
      const operation = describeOperation(call.name, call.input)
      if (operation.kind !== 'mcp' || (explicit && callId !== explicit)) return false
      // Never infer an owner from another server, or from ordering alone.
      return server ? operation.name?.split(' / ')[0] === server : !!explicit
    })
    const owner = candidates.length === 1 ? candidates[0] : undefined
    const callId = owner?.[0] ?? `elicitation:${key}`
    elicitations.set(key, { callId, pending: new Set(candidates.map(([id]) => id)) })
    if (owner) return [mcpApproval(owner[1], callId, reason)]
    // Keep an unmatched/ambiguous request independent. End-of-turn events also clear it.
    return [{ kind: 'approval', title: server ? `MCP 授权：${server}` : 'MCP 授权', callId, ...(reason ? { reason } : {}) }]
  }

  /** Keep a yielded call running until the wait that observes its end. */
  function backgroundEvents(call: Call, callId: string, output: string, result: AgentEvent): AgentEvent[] {
    const head = output.slice(0, 600)
    const cell = head.match(/^Script running with cell ID (\S+)/m)?.[1]
    const session = head.match(/Process running with session ID (\d+)/)?.[1]
    if (call.name === 'wait' || call.name === 'write_stdin') {
      const key = call.name === 'wait' ? textOf(call.input.cell_id) : String(call.input.session_id ?? '')
      const owners = call.name === 'wait' ? cells : processes
      const owner = owners.get(key)
      if (!owner || cell || session) return [result]
      const taskId = taskKey(call.name === 'wait' ? 'cell' : 'proc', key)
      const status = call.name === 'wait' ? scriptStatus(head) : processStatus(head)
      if (!status) return [result]
      owners.delete(key)
      open.delete(taskId)
      return [result, { kind: 'tool_result', title: '工具完成', ok: true, callId: owner }, { kind: 'task_end', taskId, status }]
    }
    const key = cell ?? session
    if (!key) return [result]
    const owners = cell ? cells : processes
    owners.set(key, callId)
    if (!call.background) return []
    const taskId = taskKey(cell ? 'cell' : 'proc', key)
    open.add(taskId)
    return [{ kind: 'task_start', taskId, task: 'command', label: call.title, at: call.at }]
  }
}

function codexClient(meta: Record<string, unknown>): string | undefined {
  const originator = textOf(meta.originator).toLowerCase()
  // The VS Code extension also runs in compatible editors, so it cannot prove the host.
  if (originator === 'codex_vscode' || meta.source === 'vscode') return 'IDE 扩展'
  if (originator === 'codex-tui' || originator === 'codex_exec' || meta.source === 'cli' || meta.source === 'exec') return 'CLI'
  return undefined
}

function codexEvent(payload: Record<string, unknown>, calls: Map<string, Call>): AgentEvent[] {
  const type = textOf(payload.type)
  if (type === 'user_message') return [{ kind: 'user', title: cleanText(textOf(payload.message) || textOf(payload.text)) }]
  if (type === 'agent_message' || type === 'agent_reasoning') {
    const title = cleanText(textOf(payload.message) || textOf(payload.text))
    return title ? [{ kind: type === 'agent_reasoning' ? 'thinking' : 'text', title }] : []
  }
  if (type === 'task_started') return [{ kind: 'turn_start' }, { kind: 'thinking', title: '开始执行' }]
  if (type === 'task_complete') return [{ kind: 'done', title: cleanText(textOf(payload.last_agent_message) || textOf(payload.message)) || '已完成' }]
  if (type === 'turn_aborted') {
    const title = cleanText(textOf(payload.message) || textOf(payload.error))
    if (payload.reason === 'interrupted' && !payload.error) return [{ kind: 'stop', title: title || '已中断' }]
    return [{ kind: 'error', title: title || '执行失败' }]
  }
  if (type === 'error') {
    return [{ kind: 'error', title: cleanText(textOf(payload.message) || textOf(payload.error)) || '执行失败' }]
  }
  if (type === 'exec_command_begin' || type === 'exec_command_end') {
    const command = commandText(payload.command) || commandText(payload.parsed_cmd)
    const callId = textOf(payload.call_id) || undefined
    if (type === 'exec_command_begin') return [toolEvent('shell', { ...payload, command }, callId, false)]
    const ok = payload.exit_code === undefined || payload.exit_code === 0
    return [{ kind: 'tool_result', title: ok ? '命令完成' : '命令失败', ok, callId }]
  }
  if (type === 'exec_approval_request' || type === 'apply_patch_approval_request') {
    return [toolEvent(type === 'exec_approval_request' ? 'shell' : 'apply_patch', payload, textOf(payload.call_id) || undefined, true)]
  }
  if (type === 'request_user_input') {
    const callId = textOf(payload.call_id) || undefined
    const call = callId ? calls.get(callId) : undefined
    // MCP tool approval rides on the same event; its call id belongs to the MCP call.
    if (call && describeOperation(call.name, call.input).kind === 'mcp') return [mcpApproval(call, callId, questionText(payload.questions))]
    return [toolEvent('request_user_input', { questions: payload.questions }, callId)]
  }
  if (type === 'request_permissions') {
    const callId = textOf(payload.call_id) || undefined
    const call = callId ? calls.get(callId) : undefined
    const reason = cleanText(textOf(payload.reason))
    if (call) {
      const approval = toolEvent(call.name, call.input, callId, true)
      return [reason ? { ...approval, reason } : approval]
    }
    return [{ kind: 'approval', title: '申请额外权限', callId, ...(reason ? { reason } : {}) }]
  }
  if (type === 'item_completed' && isRecord(payload.item)) {
    if (payload.item.type === 'CollabAgentToolCall' || payload.item.type === 'collabAgentToolCall') return collabEvents(payload.item)
    const questions = payload.item.questions
    if (payload.item.type === 'AgentMessage' && Array.isArray(questions) && questions.length > 0) {
      return [toolEvent('request_user_input_async', { questions }, textOf(payload.item.id) || undefined)]
    }
    if (payload.item.type === 'SubAgentActivity' || payload.item.type === 'subAgentActivity') {
      const item = payload.item
      const nativeId = textOf(item.agent_thread_id) || textOf(item.agentThreadId)
      if (!nativeId) return []
      const taskId = safeId(nativeId)
      if (!taskId) return []
      if (item.kind === 'completed' || item.kind === 'interrupted') return [{ kind: 'task_end', taskId,
        status: item.kind === 'completed' ? 'done' : 'stopped', at: eventTimestamp({ timestamp: payload.completed_at_ms }) }]
      if (item.kind !== 'started') return []
      const label = (textOf(item.agent_path) || textOf(item.agentPath)).split('/').filter(Boolean).pop() || '子 Agent'
      return [{ kind: 'task_start', taskId, task: 'agent', label,
        at: eventTimestamp({ timestamp: payload.started_at_ms }) }]
    }
  }
  return []
}

function collabEvents(item: Record<string, unknown>): AgentEvent[] {
  const tool = textOf(item.tool).replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
  const agents = Array.isArray(item.receiver_agents) ? item.receiver_agents.filter(isRecord) : []
  const receivers = item.receiver_thread_ids ?? item.receiverThreadIds
  const ids = Array.isArray(receivers)
    ? receivers.map(textOf).filter(Boolean)
    : agents.map((agent) => textOf(agent.thread_id)).filter(Boolean)
  const nickname = (id: string): string => textOf(agents.find((agent) => agent.thread_id === id)?.agent_nickname)
  if (tool === 'spawn_agent') {
    if (item.status === 'failed') return []
    const prompt = cleanText(textOf(item.prompt))
    return ids.map((id) => ({ kind: 'task_start', taskId: safeId(id), task: 'agent', label: nickname(id) || '子 Agent', ...(prompt ? { detail: prompt } : {}) }))
  }
  if (tool === 'wait' || tool === 'wait_agent') {
    const raw = item.agents_states ?? item.agentsStates
    const states = isRecord(raw) ? raw : {}
    return Object.entries(states).flatMap(([id, state]) => agentEnd(id, state))
  }
  if (tool === 'close_agent' && item.status === 'completed') return ids.map((id) => ({ kind: 'task_end', taskId: safeId(id), status: 'stopped' }))
  return []
}

function notificationEvents(text: string): AgentEvent[] {
  const body = text.match(/<subagent_notification>([\s\S]*?)<\/subagent_notification>/)?.[1] ?? ''
  const notice = parseMaybeRecord(body.trim())
  const id = textOf(notice.agent_path) || textOf(notice.agent_id) || textOf(notice.thread_id)
  return id ? agentEnd(id, notice.status) : []
}

/** Agent states look like `"running"` or `{ "completed": "last message" }`. */
function agentEnd(id: string, state: unknown): AgentEvent[] {
  const [key, message] = typeof state === 'string'
    ? [state, '']
    : isRecord(state) ? typeof state.status === 'string' ? [state.status, textOf(state.message)]
      : [Object.keys(state)[0] ?? '', textOf(Object.values(state)[0])] : ['', '']
  const status = key === 'completed' ? 'done'
    : key === 'errored' || key === 'error' || key === 'failed' ? 'error'
      : key === 'shutdown' || key === 'interrupted' || key === 'not_found' ? 'stopped' : undefined
  if (!status) return []
  const detail = cleanText(message)
  return [{ kind: 'task_end', taskId: safeId(id), status, ...(detail ? { detail } : {}) }]
}

/** Older transcripts omit these fields; they keep treating an escalation request as a human approval. */
function escalationReviewedByHuman(context: Record<string, unknown>): boolean {
  return context.approval_policy !== 'never' && context.approvals_reviewer !== 'auto_review'
}

/** `{"accepted":true}` only means the question is on screen. An empty or missing answer map is still unanswered. */
function unansweredAccept(output: unknown): boolean {
  const text = outputText(output).trim()
  const body = isRecord(output) && typeof output.accepted === 'boolean' ? output : parseMaybeRecord(text)
  if (body.interrupted === true || body.accepted !== true) return false
  if (body.answers === undefined) return true
  return isRecord(body.answers) && Object.keys(body.answers).length === 0
}

/** An MCP call asking the human to authorize it shows as an approval, not a plain tool run. */
function mcpApproval(call: Call, callId: string | undefined, reason: string): AgentEvent {
  const approval = toolEvent(call.name, call.input, callId, true)
  return reason ? { ...approval, reason } : approval
}

function scriptStatus(head: string): 'done' | 'error' | 'stopped' | undefined {
  const word = head.match(/^Script (completed|failed|terminated|error)/m)?.[1]
  if (word === 'completed') return 'done'
  if (word === 'terminated') return 'stopped'
  return word ? 'error' : undefined
}

function processStatus(head: string): 'done' | 'error' | undefined {
  const code = head.match(/Process exited with code (-?\d+)/)?.[1]
  if (code === undefined) return undefined
  return code === '0' ? 'done' : 'error'
}

function taskKey(prefix: string, key: string): string {
  return `${prefix}-${safeId(key, 40)}`
}

async function codexChild(file: string): Promise<ChildLink | null | undefined> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const decoder = new StringDecoder('utf8')
    let head = ''
    let offset = 0
    while (offset < 16 * 1024 * 1024) {
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, offset)
      offset += bytesRead
      head += decoder.write(buffer.subarray(0, bytesRead))
      const newline = head.indexOf('\n')
      const meta = newline < 0 ? head : head.slice(0, newline)
      const parent = meta.match(/"parent_thread_id"\s*:\s*"([^"\\]+)"/)?.[1]
      if (/"type"\s*:\s*"session_meta"/.test(meta) && parent) {
        // Auto-review runs each escalation in its own child thread; it is not a delegated agent.
        const review = /"thread_source"\s*:\s*"guardian_review"/.test(meta)
        return { parentSessionId: parent, taskId: safeId(codexSessionId(file)),
          label: review ? '自动审查' : meta.match(/"agent_nickname"\s*:\s*"([^"\\]+)"/)?.[1] || '子 Agent' }
      }
      if (newline >= 0 || bytesRead < HEAD_BYTES) {
        try { JSON.parse(meta); return null } catch { return undefined }
      }
    }
    return undefined
  } finally {
    await handle.close()
  }
}
