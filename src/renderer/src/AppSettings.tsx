import { useState } from 'react'
import { getBridge } from './bridge'
import { AgentMark, Group, Icon, Row, Switch, type PageProps } from './settings-ui'
import { ThemePicker } from './ThemePicker'
import { UpdateSettings } from './UpdateSettings'

const MODES = [
  { id: 'focus', title: '关注模式', text: '悬浮查看、点击展开。贴边隐藏时，待审批和异常会主动展开提醒。' },
  { id: 'managed', title: '托管模式', text: '平时淡显并让鼠标穿透，需要你时再提醒。' }
] as const

export function IslandSettings({ snapshot, busy, run, update }: PageProps) {
  const bridge = getBridge()
  return <>
    <section className="settings-group" aria-labelledby="mode-title">
      <h2 className="settings-group-label" id="mode-title">显示模式</h2>
      <span className="settings-group-aside">不影响自动规则</span>
      <div className="mode-options" role="radiogroup" aria-labelledby="mode-title">{MODES.map(mode => <label key={mode.id} className="mode-option" data-selected={snapshot.preferences.mode === mode.id}>
        <span className="mode-preview" data-mode={mode.id} aria-hidden="true"><span className="mode-preview-island"><i />{mode.id === 'focus' ? 'Claude Code · 改登录页' : '3 个任务'}</span><span className="mode-preview-window" /></span>
        <span className="mode-option-copy"><input type="radio" name="island-mode" checked={snapshot.preferences.mode === mode.id} disabled={busy} onChange={() => update({ mode: mode.id })} />
          <span><strong>{mode.title}</strong><small>{mode.text}</small></span></span>
      </label>)}</div>
    </section>
    <Group title="行为" footer="提醒按「本次发生」记确认，进度或元数据刷新不会重复弹出；新一轮或新异常才再提醒。关闭配置窗口后，灵动岛继续在托盘中运行。">
      <Switch title="自动识别本机会话" checked={snapshot.preferences.watchSessions && !snapshot.watchDisabledByEnvironment} disabled={busy || snapshot.watchDisabledByEnvironment}
        description={snapshot.watchDisabledByEnvironment ? '启动环境已关闭会话识别；修改启动环境后重启应用生效。' : '持续跟踪 Claude Code、Codex、Gemini 和 Cursor 的会话日志。'}
        onChange={watchSessions => update({ watchSessions })} />
      <Row title="灵动岛显示" description="隐藏仅收起窗口，识别、审批和接管按各自开关运行。">
        <span className="connection-state" role="status"><span className="connection-dot" data-active={snapshot.islandVisible} aria-hidden="true" />{snapshot.preview ? '浏览器预览' : snapshot.islandVisible ? '已显示' : '已隐藏'}</span>
        <button className="settings-button" data-testid="toggle-island-visibility" disabled={busy || snapshot.preview}
          onClick={() => void run(() => bridge.settingsAction(snapshot.islandVisible ? 'hide' : 'show'), snapshot.islandVisible ? '已隐藏灵动岛' : '已显示灵动岛')}>{snapshot.islandVisible ? '隐藏灵动岛' : '显示灵动岛'}</button>
      </Row>
      <Row title="灵动岛位置" description="拖动后自动记住位置。找不到窗口时，可恢复到屏幕顶部。">
        <button className="settings-button" disabled={busy || snapshot.preview} onClick={() => void run(() => bridge.settingsAction('reset-position'), '已恢复顶部居中')}>恢复顶部居中</button>
      </Row>
      <Row title="功能演示" description="预览任务进度、审批和异常提醒。">
        <button className="settings-button" disabled={busy} onClick={() => void run(() => bridge.playDemo(), '演示已开始')}>播放演示</button>
      </Row>
    </Group>
  </>
}

export function GeneralSettings({ snapshot, busy, run, update }: PageProps) {
  const action = (name: 'update-check' | 'update-page' | 'update-download' | 'update-install', success: string): void => { void run(() => getBridge().settingsAction(name), success) }
  return <>
    <UpdateSettings snapshot={snapshot} busy={busy} update={update} action={action} />
    <Group title="启动">
      <Switch title="开机自动启动" description={snapshot.launchAtLogin.detail} checked={snapshot.launchAtLogin.enabled}
        disabled={busy || !snapshot.launchAtLogin.supported} onChange={launchAtLogin => update({ launchAtLogin })} />
    </Group>
    <Group title="外观" footer={`Cute Island ${snapshot.version} · 状态服务只监听 127.0.0.1。`}>
      <Row title="配置页外观" description="只改变配置页面，黑色灵动岛保持不变。跟随系统时会自动切换。">
        <ThemePicker value={snapshot.preferences.theme} disabled={busy} onChange={theme => update({ theme })} />
      </Row>
    </Group>
  </>
}

const FILTERS = [{ id: 'all', label: '全部' }, { id: 'approved', label: '已批准' }, { id: 'answered', label: '已回答' }, { id: 'manual', label: '转交手动' }] as const
const ACTION_LABEL = { approved: '已批准', answered: '已回答', manual: '转交手动' }

export function HistorySettings({ snapshot, busy, run, navigate }: PageProps) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all')
  const history = snapshot.history.filter(entry => filter === 'all' || entry.action === filter)
  return <>
    <div className="history-toolbar">
      <div className="settings-segmented history-filters" role="group" aria-label="按处理结果筛选">{FILTERS.map(item =>
        <button type="button" key={item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
      <button type="button" className="settings-button" disabled={busy || !snapshot.history.length} onClick={() => void run(() => getBridge().settingsAction('clear-history'), '记录已清空')}>清空记录</button>
    </div>
    {history.length ? <section className="settings-group" aria-label="处理记录">
      <ol className="settings-card automation-history">{history.map(entry => <li key={entry.id} className="setting-row" data-action={entry.action}>
        <AgentMark agent={entry.agent} />
        <span className="setting-copy"><strong><span className="history-action">{ACTION_LABEL[entry.action]}</span> · {entry.summary}</strong>
          <span className="setting-description history-agent">{entry.agent}</span></span>
        <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
      </li>)}</ol>
      <p className="settings-group-foot">「已批准」「已回答」只表示结果已回传给 Agent，不代表工具执行成功。保留最近 50 条，退出应用后清空。</p>
    </section> : <div className="settings-card settings-empty">
      <Icon size={34}><circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 2" /></Icon>
      <h2>{snapshot.history.length ? '没有这类处理记录' : '还没有处理记录'}</h2>
      {snapshot.history.length ? <><p>当前没有{ACTION_LABEL[filter as keyof typeof ACTION_LABEL]}的请求。</p>
        <button type="button" className="settings-button" onClick={() => setFilter('all')}>查看全部记录</button></>
        : <><p>完成下面两步后，新请求的处理结果会出现在这里。</p><ol><li>在某个 Agent 页面安装原生接入</li><li>在「自动规则」开启需要的规则</li></ol>
          <div className="settings-actions"><button type="button" className="settings-button settings-button-primary" onClick={() => navigate('claude')}>设置 Claude Code</button>
            <button type="button" className="settings-button" onClick={() => navigate('rules')}>前往自动规则</button></div></>}
    </div>}
  </>
}
