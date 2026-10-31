import { describe, expect, it } from 'vitest'
import { ActivityStore } from '../shared/activity'
import { AttentionTracker, attentionKind } from '../shared/island-behavior'
import { createReducer, mergeChildTasks } from './reduce'
import type { ChildSession } from './reduce'

function child(terminal: boolean, at: number): ChildSession {
  return { live: true, link: { parentSessionId: 'parent', taskId: 'child', label: '检查' }, view: {
    id: 'codex-child', kind: 'codex', agent: 'Codex', state: terminal ? 'error' : 'thinking',
    title: terminal ? '执行失败' : '检查中', startedAt: 1000, endedAt: terminal ? at : undefined,
    terminal, steps: [], tasks: []
  } }
}

describe('child attention across parent turns', () => {
  it('links Claude child ids to their spawn and preserves an idle notice across parent turns', () => {
    const reducer = createReducer()
    reducer.push([{ kind: 'task_start', taskId: 'spawn', task: 'agent', label: '检查', at: 1000 },
      { kind: 'task_link', taskId: 'spawn', childId: 'native-child' },
      { kind: 'task_end', taskId: 'spawn', status: 'done', at: 2000 }])
    const linked = child(false, 0)
    linked.link = { parentSessionId: 'parent', taskId: 'agent-native-child', childId: 'native-child', label: '检查' }
    expect(mergeChildTasks(reducer.snapshot(), [linked]).tasks).toMatchObject([{ id: 'spawn', status: 'done' }])
    reducer.push([{ kind: 'user', title: '继续', at: 3000 }])
    expect(mergeChildTasks(reducer.snapshot(), [linked]).tasks).toEqual([])
    linked.view.startedAt = 4000
    expect(mergeChildTasks(reducer.snapshot(), [linked]).tasks).toMatchObject([{ id: 'spawn', status: 'active', startedAt: 4000 }])
  })

  it.each(['claude', 'codex', 'gemini', 'cursor'])('recognizes a new native child turn for %s after a recorded completion', agent => {
    const reducer = createReducer()
    reducer.push([{ kind: 'task_start', taskId: 'child', task: 'agent', label: '检查', at: 1000 },
      { kind: 'task_end', taskId: 'child', status: 'done', at: 2000 }])
    const linked = child(false, 0)
    linked.view.kind = agent
    linked.view.startedAt = 3000
    expect(mergeChildTasks(reducer.snapshot(), [linked]).tasks[0]).toMatchObject({ status: 'active', startedAt: 3000 })
    linked.view.startedAt = 1000
    expect(mergeChildTasks(reducer.snapshot(), [linked]).tasks[0].status).toBe('done')
  })

  it('settles a reused child on its later native idle notice', () => {
    const reducer = createReducer()
    reducer.push([{ kind: 'task_start', taskId: 'child', task: 'agent', label: '检查', at: 1000 },
      { kind: 'task_end', taskId: 'child', status: 'done', at: 2000 }])
    const reused = child(false, 0)
    reused.view.startedAt = 3000
    expect(mergeChildTasks(reducer.snapshot(), [reused]).tasks[0]).toMatchObject({ status: 'active', startedAt: 3000 })
    reducer.push([{ kind: 'task_end', taskId: 'child', status: 'done', at: 4000 }])
    expect(mergeChildTasks(reducer.snapshot(), [reused]).tasks[0]).toMatchObject({ status: 'done', startedAt: 3000, endedAt: 4000 })
    reducer.push([{ kind: 'task_end', taskId: 'child', status: 'done', at: 1500 }])
    expect(mergeChildTasks(reducer.snapshot(), [reused]).tasks[0]).toMatchObject({ status: 'done', startedAt: 3000, endedAt: 4000 })
  })

  it('settles a linked child reused after the parent moved to a new turn', () => {
    const reducer = createReducer()
    reducer.push([{ kind: 'task_start', taskId: 'spawn', task: 'agent', label: '检查', at: 1000 },
      { kind: 'task_link', taskId: 'spawn', childId: 'native-child' },
      { kind: 'task_end', taskId: 'spawn', status: 'done', at: 2000 },
      { kind: 'user', title: '继续', at: 2500 }])
    const linked = child(false, 0)
    linked.link = { parentSessionId: 'parent', taskId: 'agent-native-child', childId: 'native-child', label: '检查' }
    linked.view.startedAt = 3000
    expect(mergeChildTasks(reducer.snapshot(), [linked]).tasks).toMatchObject([{ id: 'spawn', status: 'active' }])
    reducer.push([{ kind: 'task_end', taskId: 'spawn', status: 'done', at: 4000 }])
    expect(mergeChildTasks(reducer.snapshot(), [linked]).tasks).toEqual([])
    linked.view.startedAt = 5000
    expect(mergeChildTasks(reducer.snapshot(), [linked]).tasks).toMatchObject([{ id: 'spawn', status: 'active', startedAt: 5000 }])
  })

  it('ignores a delayed notice for an earlier assignment after the same task restarts', () => {
    const reducer = createReducer()
    reducer.push([{ kind: 'task_start', taskId: 'child', task: 'agent', label: '检查', at: 1000 },
      { kind: 'task_end', taskId: 'child', status: 'done', at: 2000 },
      { kind: 'task_start', taskId: 'child', task: 'agent', label: '重新检查', at: 3000 },
      { kind: 'task_end', taskId: 'child', status: 'error', at: 2000 }])
    expect(reducer.snapshot().tasks[0]).toMatchObject({ status: 'active', startedAt: 3000 })
  })

  it.each(['claude', 'codex', 'gemini', 'cursor'])('shows explicit child questions for %s and separates consecutive approvals', agent => {
    const reducer = createReducer()
    const store = new ActivityStore()
    const tracker = new AttentionTracker()
    reducer.push([{ kind: 'user', title: '检查', at: 1000 }, { kind: 'task_start', taskId: 'child', task: 'agent', label: '检查', at: 1000 }])
    const linked = child(false, 0)
    linked.view.kind = agent
    const publish = () => {
      const view = mergeChildTasks(reducer.snapshot(), [linked])
      const activity = store.upsert({ id: 'parent', ...view, operation: view.operation ?? null })
      tracker.update(store.list())
      return activity
    }
    linked.view.state = 'running'
    linked.view.operation = { kind: 'tool', name: 'request_user_input' }
    linked.view.steps = [{ id: 'q', label: '选择方案', status: 'active' }]
    expect(attentionKind(publish())).toBe('task-input')
    tracker.acknowledge('parent')
    linked.view.state = 'approval'
    linked.view.steps = [{ id: 'a', label: '运行测试', status: 'waiting' }]
    linked.view.operation = { kind: 'command', command: 'npm test' }
    expect(attentionKind(publish())).toBe('task-approval')
    tracker.acknowledge('parent')
    linked.view.title = '更新了审批说明'
    publish()
    expect(tracker.pendingIds()).toEqual([])
    linked.view.steps = [{ id: 'b', label: '安装依赖', status: 'waiting' }]
    publish()
    expect(tracker.pendingIds()).toEqual(['parent'])
    store.dispose()
  })

  it('retires a child failure on the next parent turn even when only the child records its completion', () => {
    const reducer = createReducer()
    const store = new ActivityStore()
    const tracker = new AttentionTracker()
    reducer.push([{ kind: 'user', title: '检查', at: 1000 }, { kind: 'task_start', taskId: 'child', task: 'agent', label: '检查', at: 1000 }])
    const publish = () => {
      const view = mergeChildTasks(reducer.snapshot(), [child(true, 2000)])
      const activity = store.upsert({ id: 'parent', ...view, operation: view.operation ?? null, tasks: view.tasks.length ? view.tasks : null })
      tracker.update(store.list())
      return activity
    }
    expect(attentionKind(publish())).toBe('task-error')
    tracker.acknowledge('parent')
    reducer.push([{ kind: 'user', title: '继续', at: 3000 }])
    expect(publish().tasks).toBeUndefined()
    expect(tracker.pendingIds()).toEqual([])
    reducer.push([{ kind: 'thinking', title: '当前工作', at: 4000 }])
    expect(attentionKind(publish())).toBeUndefined()
    store.dispose()
  })

  it('keeps work spanning turns and still alerts when it fails during the current turn', () => {
    const reducer = createReducer()
    reducer.push([{ kind: 'user', title: '检查', at: 1000 }, { kind: 'task_start', taskId: 'child', task: 'agent', label: '检查', at: 1000 },
      { kind: 'user', title: '继续', at: 3000 }])
    expect(mergeChildTasks(reducer.snapshot(), [child(false, 0)]).tasks[0].status).toBe('active')
    const view = mergeChildTasks(reducer.snapshot(), [child(true, 4000)])
    const store = new ActivityStore()
    expect(attentionKind(store.upsert({ id: 'parent', ...view, operation: view.operation ?? null }))).toBe('task-error')
    expect(view.tasks[0]).toMatchObject({ status: 'error', endedAt: 4000 })
    store.dispose()
  })

  it('does not apply a previous child failure to a reused task waiting for new log records', () => {
    const reducer = createReducer()
    reducer.push([{ kind: 'user', title: '重试', at: 3000 }, { kind: 'task_start', taskId: 'child', task: 'agent', label: '重新检查', at: 3000 }])
    expect(mergeChildTasks(reducer.snapshot(), [child(true, 2000)]).tasks[0])
      .toMatchObject({ status: 'active', startedAt: 3000 })
    expect(mergeChildTasks(reducer.snapshot(), [child(true, 4000)]).tasks[0])
      .toMatchObject({ status: 'error', startedAt: 3000, endedAt: 4000 })
  })

  it('keeps an unresolved failure when its end time is unknown', () => {
    const reducer = createReducer()
    reducer.push([{ kind: 'user', title: '检查', at: 1000 }, { kind: 'task_start', taskId: 'child', task: 'agent', label: '检查', at: 1000 },
      { kind: 'user', title: '继续', at: 3000 }])
    const unresolved = child(true, 2000)
    unresolved.view.endedAt = undefined
    expect(mergeChildTasks(reducer.snapshot(), [unresolved]).tasks[0].status).toBe('error')
  })
})
