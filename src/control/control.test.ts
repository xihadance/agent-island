import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActivityStore } from '../shared/activity'
import { startStatusServer, type StatusServer } from '../main/server'
import { ControlStore } from './store'
import { ControlHub, redact } from './hub'
import { HookController, hookDecision } from './hooks'
import { createControlRuntime } from './runtime'
import { runRemoteCli } from './cli'
import type { ChannelAdapter, RequestInput } from './types'
import { formQuestions, formAnswers } from './forms'

const folders: string[] = []
const servers: StatusServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
function folder(): string { const dir = mkdtempSync(path.join(tmpdir(), 'cute-control-')); folders.push(dir); return dir }
function setup(file?: string, now?: () => number) {
  const store = new ControlStore(file, now)
  store.session({ id: 's', agent: 'claude', adapter: 'hook', nativeId: 'native', connected: true, label: '项目', capabilities: ['approve', 'answer', 'message'] })
  const hub = new ControlHub(store, () => {})
  return { store, hub, hooks: new HookController(hub) }
}
const input = (): RequestInput => ({ sourceKey: 'one', sessionId: 's', origin: 'hook', kind: 'approval', title: '运行测试', detail: 'npm test', questions: [], actions: ['approve', 'deny'], expiresAt: Date.now() + 60000 })
const channel = (): ChannelAdapter => ({ id: 'tg', destination: 'chat', allowedUsers: ['owner'], start: vi.fn(), send: vi.fn(async () => 'msg'), update: vi.fn(async () => {}), close: vi.fn() })

describe('credential redaction', () => {
  it.each([
    'Authorization: Bearer arbitrary.jwt.credential',
    'authorization:\tBasic dXNlcjpwYXNz',
    'Proxy-Authorization: Bearer arbitrary.jwt.credential',
    'Authorization: Digest username="alice", realm="example", response="digest-secret"',
    '{"Authorization":"Bearer arbitrary.jwt.credential","Accept":"application/json"}',
    "{'Authorization': 'Bearer arbitrary.jwt.credential'}",
    JSON.stringify({ command: 'curl -H "Authorization: Bearer arbitrary.jwt.credential" https://example.test' }),
    JSON.stringify({ headers: JSON.stringify({ Authorization: 'Bearer arbitrary.jwt.credential' }) })
  ])('removes the entire authorization value from %s', value => {
    const output = redact(value)
    expect(output).toContain('[REDACTED]')
    for (const secret of ['arbitrary.jwt.credential', 'dXNlcjpwYXNz', 'digest-secret', 'Bearer', 'Basic', 'Digest']) expect(output).not.toContain(secret)
  })

  it('preserves subsequent lines and continues masking other credential fields', () => {
    expect(redact('Authorization: Bearer credential\r\nAccept: application/json\r\npassword=secret-value'))
      .toBe('Authorization: [REDACTED]\r\nAccept: application/json\r\npassword=[REDACTED]')
  })

  it('masks credentials in both outbound notifications and detail replies', async () => {
    const { store, hub } = setup()
    const r = store.create({ ...input(), detail: 'curl -H "Authorization: Bearer opaque-credential" https://example.test' })
    const c = channel()
    await hub.addChannel(c); await hub.flush()
    const detail = await hub.receive(c, { eventId: 'details', sender: 'owner', chat: 'chat', text: `/detail ${r.id}` })
    expect(vi.mocked(c.send).mock.calls[0][0]).not.toContain('opaque-credential')
    expect(detail).not.toContain('opaque-credential')
    expect(store.get(r.id).detail).toContain('opaque-credential')
    hub.close()
  })
})

describe('intervention lifecycle', () => {
  it('durably serializes decisions, rejects stale/repeated actions, and recovers conservatively', async () => {
    const file = path.join(folder(), 'state.json')
    const { store, hub } = setup(file)
    const r = store.create(input())
    await hub.respond(r.id, 1, { action: 'approve' }, 'owner')
    await expect(hub.respond(r.id, 1, { action: 'deny' }, 'owner')).rejects.toThrow('失效')
    expect(JSON.parse(readFileSync(file, 'utf8')).requests[0].status).toBe('queued')
    const recovered = new ControlStore(file)
    expect(recovered.get(r.id).status).toBe('uncertain')
    expect(recovered.snapshot().sessions[0].connected).toBe(false)
  })
  it('expires requests without granting permission and does not replay a reused source key', () => {
    const { store } = setup(undefined, () => 100)
    const r = store.create({ ...input(), expiresAt: 50 })
    store.expire()
    expect(store.get(r.id).status).toBe('expired')
    expect(store.create({ ...input(), expiresAt: 500 }).id).toBe(r.id)
    expect(() => store.decide(r.id, 1, { action: 'approve' }, 'owner')).toThrow()
  })
  it('validates all questions, multiselect cardinality, options, and free text', () => {
    const { store } = setup()
    const r = store.create({ ...input(), kind: 'input', actions: ['answer'], questions: [
      { id: 'q1', text: '环境', options: ['dev', 'prod'], multi: false, freeText: false },
      { id: 'q2', text: '模块', options: ['a', 'b'], multi: true, freeText: true }
    ] })
    expect(() => store.decide(r.id, 1, { action: 'answer', answers: { q1: ['dev'] } }, 'u')).toThrow('全部')
    expect(() => store.decide(r.id, 1, { action: 'answer', answers: { q1: ['invalid'], q2: ['a'] } }, 'u')).toThrow('选项')
    expect(store.decide(r.id, 1, { action: 'answer', answers: { q1: ['dev'], q2: ['a', '自定义'] } }, 'u').status).toBe('queued')
  })
  it('keeps parallel parent and child requests independent', async () => {
    const { store, hub } = setup()
    const a = store.create(input())
    const b = store.create({ ...input(), sourceKey: 'child', title: '子请求' })
    await hub.respond(a.id, 1, { action: 'deny' }, 'owner')
    expect(store.get(b.id).status).toBe('pending')
  })
})

describe('remote routing and delivery', () => {
  it('bounds cloned history during an unchanged multi-channel delivery scan', async () => {
    const { store, hub } = setup()
    const channels = ['tg', 'fs', 'wc', 'dc'].map(id => ({ ...channel(), id }))
    store.change(state => {
      for (let i = 0; i < 500; i++) {
        const id = `done-${i}`
        state.requests.push({ ...input(), sourceKey: id, id, detail: 'x'.repeat(1024), status: 'resolved', revision: 2, createdAt: 1 })
        for (const c of channels) state.deliveries[`${c.id}/${id}`] = { messageId: id, revision: 2, attempts: 0, retryAt: 0 }
      }
    })
    for (const c of channels) await hub.addChannel(c)
    const snapshot = vi.spyOn(store, 'snapshot')
    try {
      await hub.flush()
      // Permit a snapshot per channel, but never a full history clone per item.
      const clonedRequests = snapshot.mock.results.reduce((sum, result) => sum + (result.type === 'return' ? result.value.requests.length : 0), 0)
      expect(clonedRequests).toBeLessThanOrEqual(500 * channels.length)
      for (const c of channels) { expect(c.send).not.toHaveBeenCalled(); expect(c.update).not.toHaveBeenCalled() }
    } finally { snapshot.mockRestore(); hub.close() }
  })

  it('refreshes a decision made while the original notification is still being sent', async () => {
    const { store, hub } = setup()
    const r = store.create(input())
    let delivered!: (id: string) => void
    const c = channel()
    vi.mocked(c.send).mockImplementationOnce(() => new Promise(resolve => { delivered = resolve }))
    await hub.addChannel(c)
    const flush = hub.flush()
    store.mark(r.id, 'resolved')
    delivered('message'); await flush
    expect(store.snapshot().deliveries[`tg/${r.id}`].revision).toBe(1)
    await hub.flush()
    expect(c.update).toHaveBeenCalledWith('message', expect.any(String), expect.objectContaining({ status: 'resolved', revision: 2 }))
    expect(store.snapshot().deliveries[`tg/${r.id}`].revision).toBe(2)
    hub.close()
  })
  it('gates sender and chat, routes referenced answers, and deduplicates messages', async () => {
    const { store, hub } = setup()
    const r = store.create({ ...input(), kind: 'input', actions: ['answer'], questions: [{ id: 'q', text: '问题', options: [], multi: false, freeText: true }] })
    const c = channel()
    await hub.addChannel(c); await hub.flush()
    expect(await hub.receive(c, { eventId: 'evil', sender: 'stranger', chat: 'chat', text: `/answer ${r.id} bad` })).toBe('')
    expect(await hub.receive(c, { eventId: 'wrong', sender: 'owner', chat: 'other', text: `/answer ${r.id} bad` })).toBe('')
    const message = { eventId: '1', sender: 'owner', chat: 'chat', text: '中文回答', replyTo: 'msg' }
    expect(await hub.receive(c, message)).toContain('回复已收到')
    expect(await hub.receive(c, message)).toBe('此消息已处理')
    expect(store.get(r.id).decision?.answers).toEqual({ q: ['中文回答'] })
    await hub.flush()
    expect(c.send).toHaveBeenCalledTimes(1)
    expect(c.update).toHaveBeenCalledTimes(1)
  })
  it('retries notification delivery, but never repeats a committed control decision', async () => {
    let now = 1000
    const { store, hub } = setup(undefined, () => now)
    store.create(input())
    const c = channel()
    vi.mocked(c.send).mockRejectedValueOnce(new Error('network'))
    await hub.addChannel(c); await hub.flush(); await hub.flush()
    expect(c.send).toHaveBeenCalledTimes(1)
    now += 10000; await hub.flush()
    expect(c.send).toHaveBeenCalledTimes(2)
  })
  it('never interprets arbitrary chat as approval or targets a guessed session', async () => {
    const { store, hub } = setup()
    const r = store.create(input())
    expect(await hub.receive(channel(), { eventId: 'free', sender: 'owner', chat: 'chat', text: 'yes' })).toContain('选择会话')
    expect(store.get(r.id).status).toBe('pending')
  })
  it('reports every child issue, suppresses refreshes and acknowledged occurrences, reopens recurrences', () => {
    const { store, hub } = setup()
    const activities = new ActivityStore()
    activities.upsert({ id: 'codex-parent', state: 'running', tasks: [{ id: 'a', kind: 'agent', label: 'A', status: 'error' }, { id: 'b', kind: 'agent', label: 'B', status: 'active', state: 'approval' }] })
    hub.observe(activities.list()); hub.observe(activities.list())
    expect(store.snapshot().requests).toHaveLength(2)
    const r = store.snapshot().requests[0]
    store.decide(r.id, r.revision, { action: 'ack' }, 'u')
    hub.observe(activities.list()); expect(store.snapshot().requests).toHaveLength(2)
    hub.observe([]); hub.observe(activities.list()); expect(store.snapshot().requests).toHaveLength(4)
    activities.dispose()
  })
})

describe('native Hook takeover', () => {
  it('does not settle indistinguishable sibling approvals from one tool completion', () => {
    const { hooks, store } = setup()
    const event = { session_id: 'native', hook_event_name: 'PermissionRequest', cwd: 'D:/project', tool_name: 'Bash', tool_input: { command: 'npm test' } }
    const a = hooks.handle({ agent: 'claude', invocationId: 'a', event }).requestId!
    const b = hooks.handle({ agent: 'claude', invocationId: 'b', event }).requestId!
    hooks.handle({ agent: 'claude', invocationId: 'completion', event: { ...event, hook_event_name: 'PostToolUse' } })
    expect(store.get(a).status).toBe('pending')
    expect(store.get(b).status).toBe('pending')
    expect(() => hooks.handle({ agent: 'claude', invocationId: 'a', event: { ...event, tool_input: { command: 'different command' } } })).toThrow('其他操作')
  })
  it('passes the reviewed plan through unchanged only after approval', async () => {
    const { hooks, hub, store } = setup()
    const event = { session_id: 'plan-session', hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: '先迁移，再验证', planFilePath: 'D:/plans/one.md' } }
    const reply = hooks.handle({ agent: 'claude', invocationId: 'plan', event })
    const r = store.get(reply.requestId!)
    expect(r.kind).toBe('plan')
    await hub.respond(r.id, 1, { action: 'approve' }, 'owner')
    const decision = hooks.poll(r.id, 'plan').decision
    expect(hookDecision('claude', event, decision)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: event.tool_input } })
  })
  it('maps simple MCP forms and defers schemas whose constraints cannot be preserved', () => {
    const questions = formQuestions({ type: 'object', properties: { project: { type: 'string', enum: ['A', 'B'] }, ready: { type: 'boolean' } }, required: ['project', 'ready'] })!
    expect(formAnswers(questions, { project: ['A'], ready: ['false'] })).toEqual({ project: 'A', ready: false })
    expect(formQuestions({ type: 'object', properties: { secret: { type: 'string', format: 'password' } } })).toBeUndefined()
    expect(formQuestions({ type: 'object', properties: { value: { type: 'string', pattern: '^x' } } })).toBeUndefined()
    expect(formQuestions({ type: 'object', properties: { nested: { type: 'array' } } })).toBeUndefined()
    expect(hookDecision('claude', { hook_event_name: 'Elicitation' }, { action: 'answer', answers: { project: ['B'], ready: ['true'] } }, questions))
      .toEqual({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { project: 'B', ready: true } } })
  })
  it('answers Claude questions using original input and does not alter unrelated arguments', async () => {
    const { hooks, store, hub } = setup()
    const event = { session_id: 'native', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '选模块', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }], extra: 'preserve' } }
    const reply = hooks.handle({ agent: 'claude', invocationId: 'i', event })
    const r = store.get(reply.requestId!)
    await hub.respond(r.id, r.revision, { action: 'answer', answers: { q1: ['A', 'B'] } }, 'owner')
    const polled = hooks.poll(r.id, 'i')
    expect(hookDecision('claude', event, polled.decision, polled.questions)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { ...event.tool_input, answers: { '选模块': 'A, B' } } } })
    expect(() => hooks.poll(r.id, 'another')).toThrow('不属于')
    hooks.handle({ agent: 'claude', invocationId: 'post', event: { ...event, hook_event_name: 'PostToolUse', tool_input: { ...event.tool_input, answers: { '选模块': 'A, B' } } } })
    expect(store.get(r.id).status).toBe('resolved')
  })
  it('keeps queued guidance across a new user turn and consumes it once at the Hook boundary', async () => {
    const { hooks, hub, store } = setup()
    hooks.handle({ agent: 'claude', invocationId: 'start', event: { session_id: 'native', hook_event_name: 'SessionStart' } })
    const session = store.snapshot().sessions.find(s => s.id.startsWith('hook-'))!
    const m = await hub.send(session.id, '先修复测试', 'owner')
    const event = { session_id: 'native', hook_event_name: 'UserPromptSubmit' }
    expect(hooks.handle({ agent: 'claude', invocationId: 'next', event }).output).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining('先修复测试') } })
    expect(store.snapshot().guidance.find(x => x.id === m.id)?.status).toBe('submitted')
    expect(hooks.handle({ agent: 'claude', invocationId: 'again', event }).output).toEqual({})
  })
  it('fails closed for permission decisions and lets Gemini retain its own native checks', () => {
    expect(hookDecision('claude', { hook_event_name: 'PermissionRequest' }, undefined)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
    expect(hookDecision('cursor', {}, undefined)).toMatchObject({ permission: 'deny' })
    expect(hookDecision('gemini', {}, undefined)).toMatchObject({ decision: 'deny' })
    expect(hookDecision('gemini', {}, { action: 'approve' })).toEqual({})
  })
})

describe('authenticated HTTP and CLI round trip', () => {
  it('returns a native denial when a takeover hook has no usable configuration', async () => {
    const stdout = vi.fn()
    await runRemoteCli(['hook', '--agent', 'cursor', '--config', path.join(folder(), 'missing.json')], {
      stdout, stderr: vi.fn(), stdin: async () => JSON.stringify({ hook_event_name: 'beforeShellExecution' })
    })
    expect(JSON.parse(stdout.mock.calls[0][0]).permission).toBe('deny')
    expect(hookDecision('gemini', { hook_event_name: 'AfterTool' }, undefined)).toEqual({})
  })
  it('isolates control authentication from the existing public status API', async () => {
    const activities = new ActivityStore()
    const runtime = createControlRuntime({ mode: 'takeover', controlToken: 'x'.repeat(32), port: 17321, stateFile: path.join(folder(), 'state.json'), channels: [], codex: [] }, activities)
    const server = await startStatusServer(activities, { port: 0, control: runtime }); servers.push(server)
    const url = `http://127.0.0.1:${server.port}`
    expect((await fetch(`${url}/v1/activities`)).status).toBe(200)
    expect((await fetch(`${url}/v1/control`)).status).toBe(401)
    expect((await fetch(`${url}/v1/control`, { headers: { authorization: `Bearer ${'x'.repeat(32)}` } })).status).toBe(200)
    runtime.close(); activities.dispose()
  })
  it('runs a Claude permission hook through HTTP, remote decision, and native stdout', async () => {
    const dir = folder()
    const config = { mode: 'takeover' as const, controlToken: 'x'.repeat(32), port: 17321, stateFile: path.join(dir, 'state.json'), channels: [], codex: [] }
    const activities = new ActivityStore()
    const runtime = createControlRuntime(config, activities)
    const server = await startStatusServer(activities, { port: 0, control: runtime }); servers.push(server)
    const file = path.join(dir, 'remote.json'); writeFileSync(file, JSON.stringify({ ...config, port: server.port }))
    const stdout = vi.fn()
    const run = runRemoteCli(['hook', '--agent', 'claude', '--config', file], { stdout, stderr: vi.fn(), stdin: async () => JSON.stringify({ session_id: 'native', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } }) })
    await vi.waitFor(() => expect(runtime.hub.store.snapshot().requests).toHaveLength(1))
    const r = runtime.hub.store.snapshot().requests[0]
    await runtime.hub.respond(r.id, r.revision, { action: 'approve' }, 'test-owner')
    expect(await run).toBe(0)
    expect(JSON.parse(stdout.mock.calls[0][0])).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    expect(runtime.hub.store.get(r.id).status).toBe('submitted')
    runtime.close(); activities.dispose()
  })
})
