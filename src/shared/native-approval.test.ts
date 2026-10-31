import { expect, it } from 'vitest'
import type { Activity } from './activity'
import { AttentionTracker } from './island-behavior'
import { withNativeApprovals, type NativeApproval } from './native-approval'

const base: Activity = { id: 'claude-native', agent: 'Claude Code', state: 'running', title: '检查页面', startedAt: 500, updatedAt: 1000, steps: [] }
const permission: NativeApproval = { id: 'permission', activityId: base.id, agent: base.agent, title: 'MCP 授权',
  operation: { kind: 'mcp', name: 'chrome_devtools' }, createdAt: 1100 }

it('keeps a native permission acknowledged while its transcript catches up', () => {
  const tracker = new AttentionTracker()
  tracker.update(withNativeApprovals([base], [permission]))
  tracker.acknowledge(base.id)
  const caughtUp: Activity = { ...base, state: 'approval', updatedAt: 1200,
    steps: [{ id: 'logged-permission', label: 'MCP 授权', kind: 'mcp', status: 'waiting' }] }
  tracker.update(withNativeApprovals([caughtUp], [permission]))
  expect(tracker.pendingIds()).toEqual([])
  tracker.update(withNativeApprovals([caughtUp], [permission, { ...permission, id: 'next-permission', createdAt: 1300 }]))
  expect(tracker.pendingIds()).toEqual([base.id])
})

it('keeps a permission acknowledged when its transcript is discovered after the prompt', () => {
  const tracker = new AttentionTracker()
  tracker.update(withNativeApprovals([], [permission]))
  expect(tracker.pendingIds()).toEqual([base.id])
  tracker.acknowledge(base.id)
  tracker.update(withNativeApprovals([base], [permission]))
  expect(tracker.pendingIds()).toEqual([])
  tracker.update(withNativeApprovals([{ ...base, startedAt: 2000, updatedAt: 2000 }], [{ ...permission, id: 'next-round', createdAt: 2100 }]))
  expect(tracker.pendingIds()).toEqual([base.id])
})

it('overlays permissions without mutating or inventing a completed execution', () => {
  const finished: Activity = { ...base, state: 'success', stale: true, endedAt: 1050 }
  const overlaid = withNativeApprovals([finished], [permission])[0]
  expect(overlaid).toMatchObject({ state: 'approval', stale: false, startedAt: 500, endedAt: undefined })
  expect(finished).toMatchObject({ state: 'success', stale: true, endedAt: 1050, steps: [] })
  expect(withNativeApprovals([finished], [])).toEqual([finished])
})
