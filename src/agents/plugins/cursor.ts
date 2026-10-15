import path from 'node:path'
import { isUserInputTool } from '../../shared/island-behavior'
import { endedEvent, isRecord, jsonlRows, messageEvents, parseMaybeRecord, textOf, timestampEvents, toolEvent, toolTitle } from '../events'
import type { AgentEvent, AgentPlugin, ParsedTranscript, ToolEvent } from '../types'

/** Cursor agent: `~/.cursor/projects/<workspace>/agent-transcripts/<id>/<id>.jsonl`. */
export const cursorPlugin: AgentPlugin = {
  kind: 'cursor',
  label: 'Cursor',
  defaultRoot: (home, env) => path.join(env.CURSOR_HOME || path.join(home, '.cursor'), 'projects'),
  accepts: (file) => file.includes(`${path.sep}agent-transcripts${path.sep}`) && file.endsWith('.jsonl'),
  sessionIdFrom: (file) => path.basename(file).replace(/\.jsonl$/, ''),
  parse: parseCursor,
  createParser: createCursorParser,
  // Desktop presence permits recovery, but is not a per-session heartbeat.
  executables: ['cursor', 'cursor-agent', 'agent'],
  uncertainWhenSilent: true,
  scripts: [/\/cursor-agent\//i]
}

function parseCursor(text: string): ParsedTranscript {
  return createCursorParser()(text)
}

function createCursorParser(): (text: string) => ParsedTranscript {
  const anonymous = new Map<string, ToolEvent>()
  let sequence = 0
  return (text) => ({ events: jsonlRows(text).flatMap((row): AgentEvent[] => {
    if (!isRecord(row)) return []
    const events = rowEvents(row)
    const message = isRecord(row.message) ? row.message : row
    const role = textOf(row.role) || textOf(message.role) || textOf(row.type)
    const assistant = role === 'assistant'
    const continues = events.some((event) => event.kind === 'tool' || event.kind === 'approval')
    const prefix: AgentEvent[] = []
    if (assistant && events.some((event) => ['text', 'thinking', 'tool', 'approval'].includes(event.kind))) {
      // Desktop transcripts omit ids and tool results. A later assistant message
      // retires ordinary calls; a new tool also proves a question/approval resumed.
      // Text alone may be commentary while the user is still deciding.
      for (const [callId, event] of anonymous) {
        if (!continues && (event.kind === 'approval' || isUserInputTool(event.operation?.name))) continue
        prefix.push({ kind: 'tool_result', title: '工具完成', callId, ok: true })
        anonymous.delete(callId)
      }
    }
    for (const event of events) {
      if (assistant && (event.kind === 'tool' || event.kind === 'approval') && !event.callId) {
        event.callId = `cursor-anonymous:${++sequence}`
        anonymous.set(event.callId, event)
      } else if (event.kind === 'tool_result') {
        if (event.callId) anonymous.delete(event.callId)
        else {
          const last = [...anonymous.keys()].at(-1)
          if (last) { event.callId = last; anonymous.delete(last) }
        }
      } else if (event.kind === 'user' || event.kind === 'error') anonymous.clear()
      else if (event.kind === 'done') {
        for (const [callId, call] of anonymous) {
          if (!isUserInputTool(call.operation?.name)) anonymous.delete(callId)
        }
      }
    }
    return [...timestampEvents(prefix, row), ...events]
  }) })
}

function rowEvents(row: unknown): AgentEvent[] {
  if (!isRecord(row)) return []
  if (row.type === 'turn_ended') return timestampEvents([endedEvent(row.status, row.error)], row)
  if (row.type === 'tool_call') return timestampEvents(toolCallRow(row), row)
  return timestampEvents(messageEvents(row), row)
}

function toolCallRow(row: Record<string, unknown>): AgentEvent[] {
  const call = isRecord(row.tool_call) ? row.tool_call : {}
  const name = Object.keys(call)[0] || textOf(row.name) || 'tool'
  const body = isRecord(call[name]) ? call[name] : call
  const args = parseMaybeRecord(body.args ?? body.input ?? row.args ?? row.input)
  const callId = textOf(row.call_id) || textOf(row.tool_call_id) || textOf(body.id) || undefined
  const short = name.replace(/ToolCall$/, '')
  const status = textOf(row.subtype) || textOf(body.status) || textOf(row.status)
  if (status === 'completed' || status === 'error' || body.result !== undefined) {
    const ok = status !== 'error' && row.is_error !== true && (!isRecord(body.result) || body.result.error == null)
    return [{ kind: 'tool_result', title: toolTitle(short, args), callId, ok }]
  }
  const approval = status === 'awaiting_approval' || status === 'awaitingApproval' ? !isUserInputTool(short)
    : status === 'executing' || status === 'running' ? false : undefined
  return [toolEvent(short, args, callId, approval)]
}
