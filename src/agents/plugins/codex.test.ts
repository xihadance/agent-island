import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseTranscript } from '../parse'
import { codexPlugin } from './codex'

const jsonl = (rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n')
const context = (payload: Record<string, unknown>) => ({ type: 'turn_context', payload: { cwd: 'D:\\app', ...payload } })
/** Code mode as the desktop app records it: the escalation rides inside an `exec` script. */
const escalated = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_esc',
  input: "text(await tools.exec_command({cmd: 'docker compose up -d', sandbox_permissions: 'require_escalated', justification: '需要访问 Docker'}));" } }

describe('Codex sandbox escalation', () => {
  it.each([
    ['a person reviews on-request escalations', { approval_policy: 'on-request', approvals_reviewer: 'user' }, 'approval'],
    ['older transcripts record no reviewer', { approval_policy: 'on-request' }, 'approval'],
    ['auto-review answers escalations itself', { approval_policy: 'on-request', approvals_reviewer: 'auto_review' }, 'running'],
    ['the never policy asks nobody', { approval_policy: 'never', approvals_reviewer: 'auto_review' }, 'running'],
    ['the never policy asks nobody without auto-review', { approval_policy: 'never', approvals_reviewer: 'user' }, 'running']
  ])('marks approval only when %s', (_name, policy, state) => {
    const view = parseTranscript('codex', 'esc', jsonl([context(policy), escalated]))
    expect(view).toMatchObject({ state, operation: { command: 'docker compose up -d' } })
  })

  it('follows the policy of the turn that issued the call', () => {
    const view = parseTranscript('codex', 'esc', jsonl([
      context({ approval_policy: 'on-request', approvals_reviewer: 'auto_review' }), escalated,
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_esc', output: 'Script completed' } },
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '已启动' } },
      context({ approval_policy: 'on-request', approvals_reviewer: 'user' }),
      { ...escalated, payload: { ...escalated.payload, call_id: 'call_next' } }
    ]))
    expect(view?.state).toBe('approval')
  })

  it('still reports an approval the native client actually requested under auto-review', () => {
    const view = parseTranscript('codex', 'esc', jsonl([
      context({ approval_policy: 'on-request', approvals_reviewer: 'auto_review' }),
      { type: 'event_msg', payload: { type: 'exec_approval_request', call_id: 'call_req', command: ['npm', 'install'], reason: '需要网络' } }
    ]))
    expect(view).toMatchObject({ state: 'approval', detail: '需要网络' })
  })
})

describe('Codex child threads', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
  const child = async (meta: Record<string, unknown>) => {
    dir = mkdtempSync(path.join(tmpdir(), 'codex-child-'))
    const file = path.join(dir, 'rollout-2026-10-22T16-29-05-01a162ba-641a-7000-8000-000000000001.jsonl')
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: '01a162ba-641a-7000-8000-000000000001', parent_thread_id: 'parent', ...meta } }) + '\n')
    return codexPlugin.child!(file)
  }

  it.each([
    ['auto-review threads', { source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review' }, '自动审查'],
    ['named sub-agents', { source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } }, agent_nickname: 'Helmholtz' }, 'Helmholtz'],
    ['unnamed sub-agents', {}, '子 Agent']
  ])('labels %s', async (_name, meta, label) => {
    expect(await child(meta)).toMatchObject({ parentSessionId: 'parent', label })
  })
})
