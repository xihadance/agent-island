import { AGENT_IDS, AGENT_NAMES, agentSummary, liveSessions, pendingRequests, remoteSummary, rulesSummary } from '../../shared/settings-summary'
import { getBridge } from './bridge'
import { AgentMark, Group, Hero, LinkRow, Row, type PageProps } from './settings-ui'

export function HomeSettings({ snapshot, activities, busy, run, navigate }: PageProps) {
  const pending = pendingRequests(activities)
  const sessions = liveSessions(activities)
  const total = Object.values(sessions).reduce((sum, count) => sum + count, 0)
  const rules = rulesSummary(snapshot), remote = remoteSummary(snapshot)
  const mark = <span className="settings-brand-tile" aria-hidden="true"><span className="settings-brand-mark"><i /><i /><i /></span></span>
  return <>
    <Hero mark={mark} title="Cute Island" description={total ? `你的 Agent，就在身边。灵动岛正在看着 ${total} 个会话。` : '你的 Agent，就在身边。'}
      status={`自动规则${rules.value} · 远程接管${remote.value}`} tone={rules.tone === 'ok' || remote.tone === 'ok' ? 'ok' : remote.tone === 'warn' ? 'warn' : 'off'} />
    {pending.length > 0 && <Group title="等你处理" aside={`${pending.length} 个请求`}
      footer={snapshot.remote.enabled ? '在灵动岛或远程渠道中处理，任一端处理后另一端的同一请求失效。' : '在灵动岛或原 Agent 中处理。'}>
      <ul className="pending-list">{pending.map(item => <li key={item.id} className="setting-row" data-kind={item.kind}>
        <AgentMark agent={item.agent} />
        <span className="setting-copy"><strong>{item.title}</strong>
          <span className="setting-description">{item.kind === 'approval' ? '等待审批' : '等待回答'}{item.detail ? ` · ${item.detail}` : ''}</span></span>
        <button type="button" className="settings-button" disabled={busy || snapshot.preview}
          onClick={() => void run(() => getBridge().settingsAction('show'), '已显示灵动岛')}>在灵动岛查看</button>
      </li>)}</ul>
    </Group>}
    <Group title="Agent">
      {AGENT_IDS.map(id => {
        const summary = agentSummary(id, snapshot)
        const count = sessions[id]
        return <LinkRow key={id} lead={<AgentMark agent={AGENT_NAMES[id]} />} title={AGENT_NAMES[id]}
          description={[count ? `${count} 个会话进行中` : '', summary.detail].filter(Boolean).join(' · ')}
          value={summary.value} tone={summary.tone} onClick={() => navigate(id)} />
      })}
    </Group>
    <Group title="处理方式">
      <LinkRow title="自动规则" description={rules.detail} value={rules.value} tone={rules.tone} onClick={() => navigate('rules')} />
      <LinkRow title="远程接管" description={remote.detail} value={remote.value} tone={remote.tone} onClick={() => navigate('remote')} />
      <LinkRow title="处理记录" description="本次启动后的自动处理结果" value={snapshot.history.length ? `${snapshot.history.length} 条` : '暂无'} onClick={() => navigate('history')} />
    </Group>
    {snapshot.preview && <Group><Row title="浏览器预览" description="设置仅保存在此浏览器，实际审批与 Agent 接入请使用桌面应用。" /></Group>}
  </>
}
