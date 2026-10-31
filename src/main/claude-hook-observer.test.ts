import { expect, it } from 'vitest'
import { ClaudeHookObserver } from './claude-hook-observer'
import { toolEvent } from '../agents/events'
import type { Activity } from '../shared/activity'

const permission = { session_id: 'native', hook_event_name: 'PermissionRequest', tool_name: 'mcp__chrome_devtools__take_snapshot', tool_input: {} }
const base: Activity = { id: 'claude-native', agent: 'Claude Code', state: 'running', title: '检查页面', updatedAt: 1000, startedAt: 500, steps: [] }

it('shows a manual Chrome DevTools MCP permission and settles only its matching native result', () => {
  const observer = new ClaudeHookObserver(() => {}, () => 1000)
  observer.transcript('claude', 'native', [toolEvent(permission.tool_name, {}, 'chrome'), toolEvent('Read', {}, 'read')])
  observer.hook(permission, 'manual')
  expect(observer.present([base])[0]).toMatchObject({ state: 'approval', startedAt: 500, operation: { kind: 'mcp', name: 'chrome_devtools / take_snapshot' } })
  observer.transcript('claude', 'native', [{ kind: 'tool_result', callId: 'read', title: '完成', ok: true }])
  expect(observer.present([base])[0].state).toBe('approval')
  observer.transcript('claude', 'native', [{ kind: 'done', title: '并行任务说明', at: 2000 }])
  expect(observer.present([base])[0].state).toBe('approval')
  observer.transcript('claude', 'native', [{ kind: 'tool_result', callId: 'chrome', title: '完成', ok: true }])
  expect(observer.present([base])[0]).toEqual(base)
})

it('does not show automatically handled permissions or ordinary MCP calls as pending approvals', () => {
  const observer = new ClaudeHookObserver(() => {})
  observer.transcript('claude', 'native', [toolEvent(permission.tool_name, {}, 'chrome')])
  expect(observer.present([base])[0]).toEqual(base)
  observer.hook(permission, 'approved')
  expect(observer.present([base])[0]).toEqual(base)
  observer.hook({ ...permission, hook_event_name: 'PreToolUse' }, 'manual')
  expect(observer.present([base])[0]).toEqual(base)
})

it('preserves manual permission identity through duplicates and unrelated session completions', () => {
  const observer = new ClaudeHookObserver(() => {}, () => 1000)
  observer.hook(permission, 'manual')
  const first = observer.present([])[0]
  observer.hook(permission, 'manual')
  observer.transcript('claude', 'other', [{ kind: 'done', title: '完成', at: 2000 }])
  expect(observer.present([])[0]).toEqual(first)
  observer.transcript('claude', 'native', [{ kind: 'done', title: '旧完成记录', at: 500 }])
  expect(observer.present([])[0]).toEqual(first)
  observer.hook({ ...permission, hook_event_name: 'Stop' }, 'manual')
  expect(observer.present([])).toEqual([])
})

it('keeps ambiguous concurrent calls pending until all matching candidates finish', () => {
  const observer = new ClaudeHookObserver(() => {}, () => 1000)
  observer.transcript('claude', 'native', [toolEvent(permission.tool_name, {}, 'a'), toolEvent(permission.tool_name, {}, 'b')])
  observer.hook(permission, 'manual')
  observer.transcript('claude', 'native', [{ kind: 'tool_result', callId: 'a', title: '完成', ok: true }])
  expect(observer.present([base])[0].state).toBe('approval')
  observer.transcript('claude', 'native', [{ kind: 'tool_result', callId: 'b', title: '完成', ok: true }])
  expect(observer.present([base])[0]).toEqual(base)
})

it('gives a repeated permission a new occurrence after its native result', () => {
  const observer = new ClaudeHookObserver(() => {}, () => 1000)
  observer.hook(permission, 'manual')
  const first = observer.present([base])[0].steps.at(-1)!.id
  observer.hook({ ...permission, hook_event_name: 'PostToolUse' }, 'manual')
  observer.hook(permission, 'manual')
  expect(observer.present([base])[0].steps.at(-1)!.id).not.toBe(first)
})

it('forgets pending permissions when no transcript can settle them', () => {
  let changes = 0
  const observer = new ClaudeHookObserver(() => { changes++ }, () => 1000)
  observer.clear()
  expect(changes).toBe(0)
  observer.transcript('claude', 'native', [toolEvent(permission.tool_name, {}, 'chrome')])
  observer.hook(permission, 'manual')
  observer.clear()
  expect(observer.present([base])).toEqual([base])
  expect(changes).toBe(2)
  observer.hook(permission, 'manual')
  observer.transcript('claude', 'native', [{ kind: 'tool_result', callId: 'chrome', title: '完成', ok: true }])
  expect(observer.present([base])[0].state).toBe('approval')
})

it('keeps a current permission while the watcher replays an older call to the same MCP tool', () => {
  const observer = new ClaudeHookObserver(() => {}, () => 1000)
  observer.hook(permission, 'manual')
  const first = observer.present([base])[0]
  observer.transcript('claude', 'native', [
    { ...toolEvent(permission.tool_name, {}, 'old'), at: 500 },
    { kind: 'tool_result', callId: 'old', title: '完成', ok: true, at: 600 }
  ])
  expect(observer.present([base])[0]).toEqual(first)
  observer.transcript('claude', 'native', [
    { ...toolEvent(permission.tool_name, {}, 'current'), at: 900 },
    { kind: 'tool_result', callId: 'current', title: '完成', ok: true, at: 1100 }
  ])
  expect(observer.present([base])[0]).toEqual(base)
})
