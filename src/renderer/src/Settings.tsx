import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Activity } from '../../shared/activity'
import type { PreferencesPatch, SettingsSnapshot } from '../../shared/preferences'
import { settingsHash, settingsPageFromHash, type SettingsPage } from '../../shared/settings-nav'
import { AGENT_NAMES, agentSummary, pendingRequests, remoteSummary, rulesSummary, type AgentId, type Tone } from '../../shared/settings-summary'
import { AgentSettings } from './AgentSettings'
import { GeneralSettings, HistorySettings, IslandSettings } from './AppSettings'
import { getBridge } from './bridge'
import { HomeSettings } from './HomeSettings'
import { RemoteSettings } from './RemoteSettings'
import { RulesSettings } from './RulesSettings'
import { AgentMark, Dot, Icon, type PageProps } from './settings-ui'
import { useSettingsTheme } from './ThemePicker'
import './settings.css'

const TITLES: Partial<Record<SettingsPage, string>> = { rules: '自动规则', remote: '远程接管', history: '处理记录', island: '灵动岛', general: '通用' }
const AGENTS: AgentId[] = ['claude', 'codex', 'cursor', 'gemini']
const TOOLS: { id: SettingsPage; label: string; color: string; icon: ReactNode }[] = [
  { id: 'rules', label: '自动规则', color: '#2f9e63', icon: <path d="m13 3-8 11h6l-1 7 9-12h-6z" /> },
  { id: 'remote', label: '远程接管', color: '#2f7de1', icon: <><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M10 18.5h4" /></> },
  { id: 'history', label: '处理记录', color: '#7a6bd1', icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 2" /></> }
]
const APP: { id: SettingsPage; label: string; color: string; icon: ReactNode }[] = [
  { id: 'island', label: '灵动岛', color: '#101014', icon: <rect x="4" y="9" width="16" height="6" rx="3" /> },
  { id: 'general', label: '通用', color: '#7d7d87', icon: <><circle cx="12" cy="12" r="3.2" /><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1" /></> }
]

function NavItem({ current, label, lead, tone, count, alert, note, onClick }: {
  current: boolean; label: string; lead: ReactNode; tone?: Tone; count?: number; alert?: boolean; note?: string; onClick: () => void
}) {
  // Counts live in attributes so the visible name stays exactly the label.
  return <button type="button" className="settings-nav-item" aria-current={current ? 'page' : undefined} aria-label={note ? `${label}，${note}` : undefined} onClick={onClick}>
    {lead}<span className="settings-nav-label">{label}</span>
    {count !== undefined && count > 0 && <span className="settings-nav-count" data-alert={alert} data-count={count} aria-hidden="true" />}
    {tone && count === undefined && <Dot tone={tone} />}
  </button>
}

export function Settings() {
  const bridge = getBridge()
  const [page, setPage] = useState<SettingsPage>(() => settingsPageFromHash(window.location.hash) ?? 'home')
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>()
  const [activities, setActivities] = useState<Activity[]>([])
  const [remoteDirty, setRemoteDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [message, setMessage] = useState('设置自动保存')
  const [error, setError] = useState('')
  const main = useRef<HTMLElement>(null)
  useSettingsTheme(snapshot?.preferences.theme)

  useEffect(() => {
    const sync = (): void => { const next = settingsPageFromHash(window.location.hash); if (next) setPage(next) }
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  useEffect(() => {
    let active = true
    let received = false
    const stop = bridge.onSettings(next => { received = true; if (active) setSnapshot(next) })
    void bridge.getSettings().then(next => { if (active && !received) setSnapshot(next) })
      .catch(error => { if (active) setError(String(error)) })
    return () => { active = false; stop() }
  }, [bridge])
  useEffect(() => {
    let active = true
    let received = false
    const stop = bridge.onActivities(next => { received = true; if (active) setActivities(next) })
    void bridge.getActivities().then(next => { if (active && !received) setActivities(next) }).catch(() => {})
    return () => { active = false; stop() }
  }, [bridge])

  const run = async (action: () => Promise<unknown>, success = '已保存'): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setMessage('正在保存…')
    try { await action(); setMessage(success) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); setMessage('未保存') }
    finally { busyRef.current = false; setBusy(false) }
  }
  const update = (patch: PreferencesPatch): void => { void run(async () => { setSnapshot(await bridge.updateSettings(patch)) }) }
  const navigate = (next: SettingsPage): void => {
    setPage(next); setError('')
    window.location.hash = settingsHash(next)
    main.current?.scrollTo(0, 0)
  }

  const pending = pendingRequests(activities)
  const remote = snapshot ? remoteSummary(snapshot) : undefined
  const rules = snapshot ? rulesSummary(snapshot) : undefined
  const update$ = snapshot?.update.available
  const props: PageProps | undefined = snapshot && { snapshot, activities, busy, remoteDirty, run, update, setSnapshot, navigate }
  const title = TITLES[page]
  const status = remoteDirty ? '远程配置有未保存修改' : page === 'remote' ? '渠道配置需点击保存' : message

  return <div className="settings-shell" data-page={page} data-ready={snapshot ? 'true' : undefined}>
    <aside className="settings-sidebar">
      <button type="button" className="settings-home" aria-current={page === 'home' ? 'page' : undefined} onClick={() => navigate('home')}>
        <span className="settings-brand-tile" aria-hidden="true"><span className="settings-brand-mark"><i /><i /><i /></span></span>
        <span className="settings-home-copy"><strong>Cute Island</strong><small>{pending.length ? `${pending.length} 个请求等你处理` : '你的 Agent，就在身边'}</small></span>
        {pending.length > 0 && <span className="settings-nav-count" data-alert="true" data-count={pending.length} aria-hidden="true" />}
      </button>
      <nav aria-label="配置分类">
        <p className="settings-nav-group">Agent</p>
        {AGENTS.map(id => {
          const summary = snapshot ? agentSummary(id, snapshot) : undefined
          return <NavItem key={id} current={page === id} label={AGENT_NAMES[id]} lead={<AgentMark agent={AGENT_NAMES[id]} />} tone={summary?.tone} note={summary?.value} onClick={() => navigate(id)} />
        })}
        <p className="settings-nav-group">处理方式</p>
        {TOOLS.map(item => <NavItem key={item.id} current={page === item.id} label={item.label} onClick={() => navigate(item.id)}
          lead={<span className="settings-nav-tile" style={{ background: item.color }}><Icon size={14}>{item.icon}</Icon></span>}
          tone={item.id === 'rules' ? rules?.tone : item.id === 'remote' ? remote?.tone : undefined}
          note={item.id === 'rules' ? rules?.value : item.id === 'remote' ? remote?.value : snapshot?.history.length ? `${snapshot.history.length} 条` : undefined}
          count={item.id === 'history' ? snapshot?.history.length ?? 0 : undefined} />)}
        <p className="settings-nav-group">应用</p>
        {APP.map(item => <NavItem key={item.id} current={page === item.id} label={item.label} onClick={() => navigate(item.id)}
          lead={<span className="settings-nav-tile" style={{ background: item.color }}><Icon size={14}>{item.icon}</Icon></span>}
          count={item.id === 'general' && update$ ? 1 : undefined} alert note={item.id === 'general' && update$ ? `有新版本 ${update$.version}` : undefined} />)}
      </nav>
      <div className="settings-sidebar-foot">
        {update$ ? <button type="button" className="settings-update-link" onClick={() => navigate('general')}><Dot tone="ok" />有新版本 {update$.version}</button>
          : <span>Cute Island {snapshot?.version}</span>}
        {snapshot?.preview && <a href="#">返回灵动岛预览</a>}
      </div>
    </aside>
    <main className="settings-main" id="settings-main" ref={main}>
      <div className="settings-content">
        <div className="settings-topbar">
          {title && <h1>{title}</h1>}
          <span className="settings-save-status" data-dirty={remoteDirty || !!error} role="status"><span className="save-status-dot" aria-hidden="true" />{status}</span>
        </div>
        {error && <div className="settings-error" role="alert">{error}<button type="button" onClick={() => { void run(async () => setSnapshot(await bridge.getSettings()), '设置已重新加载') }}>重新读取设置</button></div>}
        {!props ? <p role="status">正在读取配置…</p> : <>
          {snapshot!.preview && page !== 'home' && <p className="settings-preview">浏览器预览 · 设置仅保存在此浏览器，实际审批与 Agent 接入请使用桌面应用。</p>}
          {page === 'home' && <HomeSettings {...props} />}
          {(page === 'claude' || page === 'codex' || page === 'cursor' || page === 'gemini') && <AgentSettings key={page} {...props} agent={page} />}
          {page === 'rules' && <RulesSettings {...props} />}
          {/* Kept mounted so an unsaved channel draft survives visits to other pages. */}
          <div hidden={page !== 'remote'}><RemoteSettings remote={snapshot!.remote} hooks={snapshot!.remoteHooks} preview={snapshot!.preview}
            managedCodex={snapshot!.codexServer.status === 'running'} onSnapshot={setSnapshot} onDirty={setRemoteDirty} onNavigate={navigate} /></div>
          {page === 'history' && <HistorySettings {...props} />}
          {page === 'island' && <IslandSettings {...props} />}
          {page === 'general' && <GeneralSettings {...props} />}
        </>}
      </div>
    </main>
  </div>
}
