import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlHub } from '../control/hub'
import { ControlStore } from '../control/store'
import { HookController, hookSessionId } from '../control/hooks'
import { createReducer } from '../agents/reduce'
import { ActivityStore } from './activity'
import { AttentionTracker, attentionKind } from './island-behavior'

const stores: ActivityStore[] = []
const hubs: ControlHub[] = []
afterEach(() => {
  stores.splice(0).forEach(store => store.dispose())
  hubs.splice(0).forEach(hub => hub.close())
})

function fixture(agent = 'Codex') {
  const activities = new ActivityStore()
  const control = new ControlStore(undefined, () => 10000)
  const hub = new ControlHub(control, () => {})
  const tracker = new AttentionTracker()
  stores.push(activities)
  hubs.push(hub)
  activities.upsert({ id: 'session', agent, startedAt: 1000, state: 'running' })
  const publish = () => {
    tracker.update(activities.list())
    hub.observe(activities.list())
  }
  return { activities, control, hub, tracker, publish }
}

describe('global notification lifecycle', () => {
  it.each(['Claude Code', 'Codex', 'Gemini', 'Cursor'])('retires historical task failures after %s completes or stops', agent => {
    const f = fixture(agent)
    f.activities.upsert({ id: 'session', tasks: [{ id: 'child', kind: 'agent', label: '审查', status: 'error', startedAt: 1000 }] })
    f.publish()
    expect(f.tracker.pendingIds()).toEqual(['session'])
    for (const state of ['success', 'stopped'] as const) {
      f.activities.upsert({ id: 'session', state, endedAt: 2000 })
      f.publish()
      expect(attentionKind(f.activities.get('session')!)).toBeUndefined()
      expect(f.tracker.pendingIds()).toEqual([])
      expect(f.control.requests().filter(request => request.status === 'pending')).toEqual([])
    }
  })

  it('keeps an acknowledged session failure quiet when its title and diagnostic steps refresh', () => {
    const f = fixture()
    f.activities.upsert({ id: 'session', state: 'error', title: '连接中断', endedAt: 2000 })
    f.publish()
    f.tracker.acknowledge('session')
    const request = f.control.requests()[0]
    f.control.decide(request.id, request.revision, { action: 'ack' }, 'owner')
    f.activities.upsert({ id: 'session', title: '执行失败：连接中断', detail: '补充原因', steps: [{ id: 'diagnostic', label: '诊断', status: 'error' }] })
    f.publish()
    expect(f.tracker.pendingIds()).toEqual([])
    expect(f.control.requests().filter(request => request.status === 'pending')).toEqual([])
    expect(f.control.requests()).toHaveLength(1)
  })

  it('does not resurrect a child failure after a higher-priority approval is resolved', () => {
    const f = fixture()
    f.activities.upsert({ id: 'session', tasks: [{ id: 'child', kind: 'agent', label: '审查', status: 'error', startedAt: 1000 }] })
    f.publish()
    f.tracker.acknowledge('session')
    f.activities.upsert({ id: 'session', state: 'approval', operation: { kind: 'command', command: 'npm test' }, steps: [{ id: 'approval', label: '测试', status: 'waiting' }] })
    f.publish()
    expect(f.tracker.pendingIds()).toEqual(['session'])
    f.tracker.acknowledge('session')
    f.activities.upsert({ id: 'session', state: 'thinking', operation: null, steps: [{ id: 'approval', label: '测试', status: 'done' }] })
    f.publish()
    expect(f.tracker.pendingIds()).toEqual([])
  })

  it('keeps a child approval quiet when only its progress description changes', () => {
    const f = fixture()
    const task = { id: 'child', kind: 'agent' as const, label: '审查', status: 'active' as const, state: 'approval' as const, startedAt: 1000 }
    f.activities.upsert({ id: 'session', tasks: [{ ...task, detail: '等待审批' }] })
    f.publish()
    f.tracker.acknowledge('session')
    const request = f.control.requests()[0]
    f.control.decide(request.id, request.revision, { action: 'ack' }, 'owner')
    f.activities.upsert({ id: 'session', tasks: [{ ...task, detail: '客户端更新了审批说明' }] })
    f.publish()
    expect(f.tracker.pendingIds()).toEqual([])
    expect(f.control.requests().filter(request => request.status === 'pending')).toEqual([])
  })

  it('keeps acknowledged failures quiet across a temporarily missing snapshot', () => {
    const f = fixture()
    f.activities.upsert({ id: 'session', tasks: [{ id: 'child', kind: 'agent', label: '审查', status: 'error', startedAt: 1000 }] })
    f.publish()
    f.tracker.acknowledge('session')
    const request = f.control.requests()[0]
    f.control.decide(request.id, request.revision, { action: 'ack' }, 'owner')
    f.tracker.update([])
    f.hub.observe([])
    f.publish()
    expect(f.tracker.pendingIds()).toEqual([])
    expect(f.control.requests()).toHaveLength(1)
    expect(f.control.get(request.id).status).toBe('resolved')
    f.activities.upsert({ id: 'session', tasks: [{ id: 'child', kind: 'agent', label: '重试审查', status: 'error', startedAt: 3000 }] })
    f.publish()
    expect(f.tracker.pendingIds()).toEqual(['session'])
    expect(f.control.requests().filter(request => request.status === 'pending')).toHaveLength(1)
  })

  it('keeps an explicit pending question visible while unrelated tools continue', () => {
    const f = fixture()
    const reducer = createReducer()
    reducer.push([{ kind: 'user', title: '检查', at: 1000 },
      { kind: 'tool', title: '选择方案', callId: 'question', operation: { kind: 'tool', name: 'request_user_input_async' } },
      { kind: 'tool', title: '读取文件', callId: 'read', operation: { kind: 'read', name: 'read' } }])
    f.activities.upsert({ id: 'session', ...reducer.snapshot() })
    f.publish()
    expect(attentionKind(f.activities.get('session')!)).toBe('input')
    expect(f.tracker.pendingIds()).toEqual(['session'])
  })

  it('puts actionable requests first and preserves notification order through metadata refreshes', () => {
    const f = fixture()
    f.activities.upsert({ id: 'first', state: 'error', startedAt: 1000, endedAt: 2000 })
    f.publish()
    f.activities.upsert({ id: 'second', state: 'error', startedAt: 1000, endedAt: 2000 })
    f.publish()
    expect(f.tracker.pendingIds()).toEqual(['first', 'second'])
    f.activities.upsert({ id: 'second', title: '补充错误说明' })
    f.publish()
    expect(f.tracker.pendingIds()).toEqual(['first', 'second'])
    f.activities.upsert({ id: 'approval', state: 'approval', startedAt: 1000 })
    f.publish()
    expect(f.tracker.pendingIds()).toEqual(['approval', 'first', 'second'])
  })

  it('does not fan one terminal session failure out into additional failed-task alerts', () => {
    const f = fixture()
    f.activities.upsert({ id: 'session', state: 'error', title: '执行失败', tasks: [
      { id: 'a', kind: 'agent', label: 'A', status: 'error' },
      { id: 'b', kind: 'command', label: 'B', status: 'error' }
    ] })
    f.publish()
    expect(f.control.requests().filter(request => request.status === 'pending')).toHaveLength(1)
  })

  it('clears the previous failure as soon as a native new turn starts', () => {
    const reducer = createReducer()
    reducer.push([{ kind: 'user', title: '检查', at: 1000 }, { kind: 'error', title: '执行失败', at: 2000 }])
    reducer.push([{ kind: 'turn_start', at: 3000 }])
    expect(reducer.snapshot()).toMatchObject({ state: 'thinking', terminal: false, startedAt: 3000, endedAt: undefined })
  })

  it.each([
    ['claude', 'PostToolUseFailure'], ['cursor', 'postToolUseFailure'], ['claude', 'Notification']
  ])('does not turn %s %s into a terminal failure notification', (agent, eventName) => {
    const f = fixture()
    const hooks = new HookController(f.hub)
    hooks.handle({ agent, invocationId: 'notice', event: { session_id: 'native', hook_event_name: eventName,
      tool_name: 'Bash', tool_input: { command: 'npm test' }, notification_type: 'idle_prompt', message: '等待用户' } })
    expect(f.control.requests()).toEqual([])
  })

  it.each([['claude', 'Stop'], ['gemini', 'AfterAgent'], ['cursor', 'stop']])('retires stale native notifications on %s %s', (agent, eventName) => {
    const f = fixture()
    const hooks = new HookController(f.hub)
    hooks.handle({ agent, invocationId: 'register', event: { session_id: 'native', hook_event_name: 'SessionStart' } })
    const sessionId = hookSessionId(agent, 'native')
    const request = f.control.create({ sourceKey: 'old-error', sessionId, origin: 'observation', kind: 'error',
      title: '旧异常', detail: '', questions: [], actions: ['ack'], expiresAt: 30000 })
    hooks.handle({ agent, invocationId: 'finished', event: { session_id: 'native', hook_event_name: eventName } })
    expect(f.control.get(request.id).status).toBe('cancelled')
  })

  it('skips a queued notification that became obsolete while another message was being sent', async () => {
    const f = fixture()
    f.activities.upsert({ id: 'session', tasks: [
      { id: 'a', kind: 'agent', label: 'A', status: 'error' }, { id: 'b', kind: 'agent', label: 'B', status: 'error' }
    ] })
    f.publish()
    const send = vi.fn(async () => {
      f.control.mark(f.control.requests()[1].id, 'cancelled')
      return 'message'
    })
    await f.hub.addChannel({ id: 'test', destination: 'chat', allowedUsers: [], start: async () => {}, send, update: async () => {}, close() {} })
    await f.hub.flush()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
