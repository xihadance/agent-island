import { useState } from 'react'
import type { Activity } from '../shared/activity'
import { Island } from '../renderer/src/Island'
import type { useIslandDrag } from '../renderer/src/useIslandDrag'

const drag: ReturnType<typeof useIslandDrag> = {
  offset: { x: 0, y: 0 }, dragging: false, dock: { edge: null, collapsed: false },
  setDockExpanded() {}, onPointerDownCapture() {}, onClickCapture() {}
}

function sampleActivities(now: number): Activity[] {
  return [
    {
      id: 'site-claude', agent: 'Claude Code', client: 'VS Code', state: 'running',
      title: '正在修改登录页', detail: '补上表单校验和错误提示',
      steps: [
        { id: 'read', label: '阅读现有界面', status: 'done', kind: 'read' },
        { id: 'edit', label: '补上登录表单校验', status: 'active', kind: 'edit' },
        { id: 'check', label: '检查错误提示', status: 'pending', kind: 'command' }
      ], startedAt: now - 83000, updatedAt: now
    },
    {
      id: 'site-codex', agent: 'Codex', client: '终端', state: 'thinking',
      title: '梳理 API 的调用关系', steps: [], startedAt: now - 47000, updatedAt: now
    },
    {
      id: 'site-gemini', agent: 'Gemini', client: '终端', state: 'success',
      title: '文档已经整理好了', steps: [], startedAt: now - 123000,
      endedAt: now - 4000, updatedAt: now
    }
  ]
}

export function IslandDemo() {
  const [samples] = useState(() => sampleActivities(Date.now()))
  const [scene, setScene] = useState('sessions')
  const [selectedId, setSelectedId] = useState<string | null>('site-claude')
  const [expanded, setExpanded] = useState(true)
  const [hovered, setHovered] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const scenes = [
    { id: 'sessions', label: '多任务进行中', description: '点一下会话，展开它正在做的事。' },
    { id: 'approval', label: '需要你确认', description: '有事才提醒，处理后回到原来的位置。' },
    { id: 'idle', label: '安静待命', description: '没有任务时，收成一条不打扰你的细线。' }
  ]
  const approval: Activity = {
    ...samples[0], state: 'approval', title: '运行检查前，需要你的确认',
    detail: 'Agent 请求执行以下命令', operation: { kind: 'command', command: 'npm run typecheck' },
    steps: []
  }
  const activities = scene === 'idle' ? [] : scene === 'approval' ? [approval] : samples
  const changeScene = (id: string) => {
    setScene(id)
    setSelectedId(id === 'sessions' ? 'site-claude' : null)
    setExpanded(true)
    setAcknowledged(false)
  }

  return (
    <div className="demo" id="demo">
      <div className="demo-tabs" role="tablist" aria-label="灵动岛演示场景" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const current = scenes.findIndex(item => item.id === scene)
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? scenes.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + scenes.length) % scenes.length
        changeScene(scenes[index].id)
        document.getElementById(`tab-${scenes[index].id}`)?.focus()
      }}>
        {scenes.map(item => <button key={item.id} id={`tab-${item.id}`} role="tab"
          aria-selected={scene === item.id} aria-controls="demo-panel" tabIndex={scene === item.id ? 0 : -1}
          onClick={() => changeScene(item.id)}>{item.label}</button>)}
      </div>
      <div className="demo-canvas" id="demo-panel" role="tabpanel" aria-labelledby={`tab-${scene}`}>
        <div className="demo-island">
          <Island embedded drag={drag} behaviorMode="focus" passive={false}
            attention={scene === 'approval' && !acknowledged}
            onAcknowledge={scene === 'approval' && !acknowledged ? () => { setAcknowledged(true); setExpanded(false) } : undefined}
            hovered={hovered} onHover={setHovered} activities={activities}
            expanded={expanded} selectedId={selectedId} resting={scene === 'idle'}
            onToggle={() => setExpanded(value => !value)} onSelect={setSelectedId}
            onDismiss={() => changeScene('idle')} />
        </div>
        <div className="demo-bottom">
          <span className="demo-caption" aria-live="polite">{scenes.find(item => item.id === scene)?.description}</span>
          <span className="demo-note">交互演示 · 示例数据</span>
        </div>
      </div>
    </div>
  )
}
