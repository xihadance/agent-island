import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ActivityStore } from '../shared/activity'
import { ControlHub, RESUME_PROMPT, formatRequest } from './hub'
import { ControlStore } from './store'
import type { ChannelAdapter, SessionResumer } from './types'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(close => close()))
const nativeId = '01234567-89ab-cdef-0123-456789abcdef'
function fixture(file?: string) {
  const store = new ControlStore(file)
  const hub = new ControlHub(store)
  cleanups.push(() => hub.close())
  const run = vi.fn(async () => {})
  const resumer: SessionResumer = { available: () => true, prepare: vi.fn(async () => run), close: vi.fn() }
  hub.setResumer(resumer)
  store.session({ id: 's', nativeId, agent: 'claude', adapter: 'hook', cwd: 'D:/project', label: '项目', connected: false, capabilities: [] })
  const request = store.create({ sourceKey: 'failure', sessionId: 's', origin: 'observation', kind: 'error', title: '会话异常中断', detail: '',
    actions: ['resume', 'ack'], questions: [], expiresAt: Date.now() + 60000 })
  const channel: ChannelAdapter = { id: 'channel', destination: 'chat', allowedUsers: ['owner'], start: vi.fn(), send: vi.fn(async () => 'sent'), update: vi.fn(), close: vi.fn() }
  store.change(state => { state.deliveries[`channel/${request.id}`] = { messageId: 'sent', revision: 1, attempts: 0, retryAt: 0 } })
  return { store, hub, request, channel, run, resumer }
}

it('offers recovery only for top-level failures with original local metadata, never public pushes or silence', () => {
  const { hub, store, resumer } = fixture()
  const activities = new ActivityStore()
  cleanups.push(() => activities.dispose())
  hub.setResumer(resumer, id => activities.sessionSource(id))
  activities.upsert({ id: 'public', agent: 'Claude Code', state: 'error', title: '异常' })
  activities.upsert({ id: 'silent', agent: 'Codex', stale: true, state: 'running', title: '处理中' })
  const id = `claude-${nativeId}`
  activities.setSessionSource(id, { agent: 'claude', nativeId, cwd: 'D:/原项目' })
  activities.upsert({ id, agent: 'Claude Code', state: 'error', title: '原生异常', tasks: [{ id: 'child', kind: 'agent', label: '子任务', status: 'error' }] })
  hub.observe(activities.list())
  expect(store.snapshot().requests.find(r => r.title === '异常')?.actions).toEqual(['ack'])
  expect(store.snapshot().requests.find(r => r.title === '原生异常')?.actions).toEqual(['resume', 'ack'])
  expect(store.snapshot().requests.find(r => r.title === '子任务：子任务')?.actions).toEqual(['ack'])
  expect(store.snapshot().requests.some(r => r.title === '处理中')).toBe(false)
  const before = store.snapshot().requests.length
  hub.observe(activities.list())
  expect(store.snapshot().requests).toHaveLength(before)
})

it('authorizes recovery buttons and commits the request before native side effects without blocking approvals', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'island-resume-'))
  cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state.json')
  const { hub, store, request, channel, run } = fixture(file)
  let complete!: () => void
  run.mockImplementation(() => {
    expect(JSON.parse(readFileSync(file, 'utf8')).requests[0]).toMatchObject({ status: 'submitted', decision: { action: 'resume' }, decidedBy: 'channel:owner' })
    return new Promise<void>(resolve => { complete = resolve })
  })
  const message = { eventId: 'one', sender: 'stranger', chat: 'chat', action: { requestId: request.id, revision: 1, decision: { action: 'resume' as const } } }
  expect(await hub.receive(channel, message)).toBe('')
  expect(run).not.toHaveBeenCalled()
  expect(await hub.receive(channel, { ...message, sender: 'owner' })).toContain('等待确认')
  expect(await hub.receive(channel, { ...message, sender: 'owner' })).toBe('此消息已处理')
  expect(await hub.receive(channel, { ...message, eventId: 'second-click', sender: 'owner' })).toContain('已处理')
  expect(run).toHaveBeenCalledTimes(1)
  complete()
  await vi.waitFor(() => expect(store.get(request.id).status).toBe('resolved'))
})

it('records custom continuation text, masks outbound secrets, and resumes by unambiguous native ID', async () => {
  const { hub, store, request, channel, resumer } = fixture()
  const prompt = '先检查测试\npassword=private-value'
  await hub.receive(channel, { eventId: 'command', sender: 'owner', chat: 'chat', text: `/resume ${nativeId} ${prompt}` })
  expect(resumer.prepare).toHaveBeenCalledWith(expect.objectContaining({ nativeId }), prompt, request)
  await vi.waitFor(() => expect(store.get(request.id).status).toBe('resolved'))
  expect(formatRequest(store.get(request.id))).not.toContain('private-value')
})

it('keeps a refused preflight pending and never recovers after the notification becomes stale during preparation', async () => {
  const { hub, store, request, resumer, run } = fixture()
  vi.mocked(resumer.prepare).mockRejectedValueOnce(new Error('原会话仍在运行'))
  await expect(hub.resume(request.id, 1, 'owner')).rejects.toThrow('仍在运行')
  expect(store.get(request.id).status).toBe('pending')
  vi.mocked(resumer.prepare).mockImplementationOnce(async () => { store.mark(request.id, 'cancelled'); return run })
  await expect(hub.resume(request.id, 1, 'owner')).rejects.toThrow('已处理')
  expect(run).not.toHaveBeenCalled()
})

it.each(['reject', 'disable'] as const)('does not replay uncertain recovery after %s or restart', async action => {
  const dir = mkdtempSync(path.join(tmpdir(), 'island-resume-'))
  cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state.json')
  const { hub, store, request, run, resumer } = fixture(file)
  let reject!: (error: Error) => void
  run.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  await hub.resume(request.id, 1, 'owner')
  expect(resumer.prepare).toHaveBeenCalledWith(expect.anything(), RESUME_PROMPT, request)
  if (action === 'disable') { hub.close(); store.releaseControl() }
  reject(new Error('服务断开'))
  await vi.waitFor(() => expect(store.get(request.id).status).toBe('uncertain'))
  const restarted = new ControlStore(file)
  expect(restarted.get(request.id).status).toBe('uncertain')
  expect(run).toHaveBeenCalledTimes(1)
})

it('marks an in-flight observation recovery uncertain on crash and lets ack dismiss without launching', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'island-resume-'))
  cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state.json')
  const { store, hub, request, run } = fixture(file)
  await hub.respond(request.id, 1, { action: 'ack' }, 'owner')
  expect(run).not.toHaveBeenCalled()
  store.change(state => { const r = state.requests[0]; r.decision = { action: 'resume' }; r.status = 'submitted' })
  expect(new ControlStore(file).get(request.id).status).toBe('uncertain')
})
