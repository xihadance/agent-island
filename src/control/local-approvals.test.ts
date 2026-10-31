import { expect, it } from 'vitest'
import { ControlStore } from './store'
import { ControlHub } from './hub'
import { HookController } from './hooks'
import { localApprovals } from './local-approvals'
import { withNativeApprovals } from '../shared/native-approval'
import { AttentionTracker } from '../shared/island-behavior'

it('presents a remote Claude MCP permission and removes its alert after native submission', async () => {
  const store = new ControlStore()
  const hub = new ControlHub(store)
  const hooks = new HookController(hub)
  const reply = hooks.handle({ agent: 'claude', invocationId: 'chrome', event: { session_id: 'native',
    hook_event_name: 'PermissionRequest', tool_name: 'mcp__chrome_devtools__take_snapshot', tool_input: {} } })
  const tracker = new AttentionTracker()
  const activities = withNativeApprovals([], localApprovals(store.snapshot()))
  expect(activities[0]).toMatchObject({ id: 'claude-native', state: 'approval', operation: { kind: 'mcp', name: 'chrome_devtools / take_snapshot' } })
  tracker.update(activities)
  expect(tracker.pendingIds()).toEqual(['claude-native'])
  tracker.acknowledge('claude-native')
  tracker.update(withNativeApprovals([], localApprovals(store.snapshot())))
  expect(tracker.pendingIds()).toEqual([])
  const request = store.get(reply.requestId!)
  await hub.respond(request.id, request.revision, { action: 'approve' }, 'local')
  expect(localApprovals(store.snapshot())).toEqual([])
  expect(withNativeApprovals([], localApprovals(store.snapshot()))).toEqual([])
  hub.close()
})

it('never promotes an observation or released request to a native permission', () => {
  const store = new ControlStore()
  store.session({ id: 's', agent: 'claude', nativeId: 'native', adapter: 'observation', label: 'Claude', connected: false, capabilities: [] })
  store.create({ sourceKey: 'observation', sessionId: 's', origin: 'observation', kind: 'approval', title: '审批', detail: '', questions: [], actions: ['ack'], expiresAt: Date.now() + 10000 })
  expect(localApprovals(store.snapshot())).toEqual([])
  const hub = new ControlHub(store)
  new HookController(hub).handle({ agent: 'claude', invocationId: 'chrome', event: { session_id: 'active', hook_event_name: 'PermissionRequest', tool_name: 'mcp__chrome_devtools__take_snapshot', tool_input: {} } })
  expect(localApprovals(store.snapshot())).toHaveLength(1)
  store.releaseControl()
  expect(localApprovals(store.snapshot())).toEqual([])
  hub.close()
})

it('includes pending Codex MCP authentication requests in local attention', () => {
  const store = new ControlStore()
  store.session({ id: 'codex', agent: 'codex', nativeId: 'native', adapter: 'codex', label: 'Codex', connected: true, capabilities: [] })
  store.create({ sourceKey: 'mcp', sessionId: 'codex', origin: 'codex', kind: 'authentication', title: 'MCP 请求，请通过原生界面完成',
    detail: JSON.stringify({ serverName: 'chrome_devtools', mode: 'openai/userVerification' }), questions: [], actions: ['cancel'], expiresAt: Date.now() + 10000 })
  expect(localApprovals(store.snapshot())).toMatchObject([{ activityId: 'codex-native', operation: { kind: 'mcp', name: 'chrome_devtools' } }])
})
