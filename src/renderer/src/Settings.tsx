import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { PreferencesPatch, SettingsSnapshot } from '../../shared/preferences'
import { getBridge } from './bridge'
import './settings.css'
import { RemoteSettings } from './RemoteSettings'

type Section = 'general' | 'automation' | 'connections' | 'remote' | 'history'
const sections: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'general', label: '常规', icon: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></> },
  { id: 'automation', label: '自动审批', icon: <><path d="m13 3-8 11h6l-1 7 9-12h-6z" /></> },
  { id: 'connections', label: 'Agent 接入', icon: <><path d="m9 15 6-6m-7 3-2 2a4 4 0 0 0 6 6l2-2m-2-12 2-2a4 4 0 0 1 6 6l-2 2" /></> },
  { id: 'remote', label: '远程接管', icon: <><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M10 18h4m-4-12h4" /></> },
  { id: 'history', label: '处理记录', icon: <><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v5l3 2" /></> }
]

function Icon({ children }: { children: ReactNode }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
}

function Switch({ title, description, checked, disabled, onChange, prominent }: {
  title: string; description: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; prominent?: boolean
}) {
  const id = useId()
  return <div className={`setting-row${prominent ? ' setting-row-prominent' : ''}`}>
    <div className="setting-copy"><label id={`${id}-label`} htmlFor={id}>{title}</label><p id={`${id}-description`}>{description}</p></div>
    <button id={id} className="setting-switch" type="button" role="switch" aria-checked={checked} aria-labelledby={`${id}-label`}
      aria-describedby={`${id}-description`} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>
  </div>
}

export function Settings() {
  const bridge = getBridge()
  const [section, setSection] = useState<Section>(window.location.hash === '#settings/remote' ? 'remote' : 'automation')
  const [remoteDirty, setRemoteDirty] = useState(false)
  useEffect(() => {
    const navigate = () => { const section = window.location.hash.slice('#settings/'.length); if (sections.some(item => item.id === section)) setSection(section as Section) }
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [message, setMessage] = useState('设置自动保存')
  const [error, setError] = useState('')
  const [codexUrl, setCodexUrl] = useState('')

  useEffect(() => {
    let active = true
    let received = false
    const stop = bridge.onSettings(next => { received = true; if (active) setSnapshot(next) })
    void bridge.getSettings().then(next => { if (active && !received) setSnapshot(next) })
      .catch(error => { if (active) setError(String(error)) })
    return () => { active = false; stop() }
  }, [bridge])
  useEffect(() => { setCodexUrl(snapshot?.preferences.automation.codexUrl ?? '') }, [snapshot?.preferences.automation.codexUrl])

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
  const auto = snapshot?.preferences.automation
  const title = sections.find(item => item.id === section)!.label

  return <div className="settings-shell">
    <aside className="settings-sidebar">
      <div className="settings-brand"><span className="settings-brand-mark" aria-hidden="true"><i /><i /><i /></span><strong>Cute Island</strong></div>
      <nav aria-label="配置分类">{sections.map(item => <button type="button" key={item.id} aria-current={section === item.id ? 'page' : undefined}
        onClick={() => { setSection(item.id); window.location.hash = `settings/${item.id}`; setError('') }}><Icon>{item.icon}</Icon><span>{item.label}</span></button>)}</nav>
      <div className="settings-sidebar-foot"><span className="settings-version">Cute Island {snapshot?.version}</span><span>你的 Agent，就在身边。</span>
        {snapshot?.preview && <a href="#">返回灵动岛预览</a>}</div>
    </aside>
    <main className="settings-main" id="settings-main">
      <header className="settings-header"><div><h1>{title}</h1><p>{section === 'automation' ? '把重复确认交给灵动岛。' : section === 'general' ? '让灵动岛按你的习惯工作。' : section === 'connections' ? '连接可以接收审批和回答的 Agent。' : section === 'remote' ? '把已有会话接到你的消息渠道。' : '查看本次启动后的自动处理结果。'}</p></div>
        <span className="settings-save-status" role="status">{remoteDirty ? '远程配置有未保存修改' : section === 'remote' ? '渠道配置需点击保存' : message}</span></header>
      {error && <div className="settings-error" role="alert">{error}<button type="button" onClick={() => { void run(async () => setSnapshot(await bridge.getSettings()), '设置已重新加载') }}>重新读取设置</button></div>}
      {!snapshot || !auto ? <p role="status">正在读取配置…</p> : <>
        {snapshot.preview && <p className="settings-preview">浏览器预览 · 设置仅保存在此浏览器，实际审批与 Agent 接入请使用桌面应用。</p>}
        {section === 'automation' && <>
          <div className="automation-master" data-enabled={auto.enabled && !snapshot.remote.enabled}>
            <Switch prominent title="自动审批模式" description={snapshot.remote.enabled ? '远程接管已开启，自动审批暂停响应；关闭接管后恢复此设置。' : auto.enabled ? '已开启。按下方规则处理已接入 Agent 的请求。' : '当前已暂停，所有请求由你在原 Agent 中处理。'} checked={auto.enabled} disabled={busy}
              onChange={enabled => update({ automation: { enabled } })} />
            <div className="automation-master-foot"><span className="connection-dot" data-active={auto.enabled && !snapshot.remote.enabled} />{snapshot.remote.enabled ? '远程接管优先' : auto.enabled ? (snapshot.claudeInstalled || snapshot.codexStatus === 'connected' ? '规则已生效' : '等待接入 Agent') : '需要时可随时开启'}<button type="button" onClick={() => setSection('connections')}>管理接入 <span aria-hidden="true">→</span></button></div>
          </div>
          <section className="settings-section" aria-labelledby="rules-title"><h2 id="rules-title">处理规则</h2>
            <Switch title="自动批准权限请求" description="批准命令执行、文件修改等工具权限。仅批准当前请求。" checked={auto.approvePermissions} disabled={busy} onChange={approvePermissions => update({ automation: { approvePermissions } })} />
            <Switch title="自动回答选择题" description="选择标注「推荐」或「Recommended」的选项并提交回答。" checked={auto.answerQuestions} disabled={busy} onChange={answerQuestions => update({ automation: { answerQuestions } })} />
            <div className="setting-row"><div className="setting-copy"><label htmlFor="question-fallback">没有推荐选项时</label><p>仅适用于有明确选项的问题。</p></div><select id="question-fallback" value={auto.fallback} disabled={busy || !auto.answerQuestions}
              onChange={event => update({ automation: { fallback: event.target.value as 'manual' | 'first' } })}><option value="manual">保留手动回答</option><option value="first">选择第一个选项</option></select></div>
          </section>
          <div className="settings-note"><Icon><path d="M12 8h.01M11 12h1v4" /><circle cx="12" cy="12" r="9" /></Icon><p>自由输入、密码问题和无法确定答案的问题仍交给你处理。显示模式不影响自动审批规则。</p></div>
        </>}
        {section === 'general' && <>
          <section className="settings-section settings-section-first" aria-labelledby="mode-title"><h2 id="mode-title">灵动岛显示</h2>
            <div className="mode-options" role="radiogroup" aria-label="显示模式">{(['focus', 'managed'] as const).map(mode => <label key={mode} className="mode-option" data-selected={snapshot.preferences.mode === mode}>
              <input type="radio" name="island-mode" checked={snapshot.preferences.mode === mode} disabled={busy} onChange={() => update({ mode })} /><span><strong>{mode === 'focus' ? '关注模式' : '托管模式'}</strong><small>{mode === 'focus' ? '悬浮查看、点击展开，随时关注进展。' : '平时淡显并穿透鼠标，需要你时再提醒。'}</small></span></label>)}</div>
            <Switch title="自动识别本机会话" description={snapshot.watchDisabledByEnvironment ? '启动环境已关闭会话识别；修改启动环境后重启应用生效。' : '持续跟踪 Claude Code、Codex、Gemini 和 Cursor 的会话日志。'} checked={snapshot.preferences.watchSessions && !snapshot.watchDisabledByEnvironment}
              disabled={busy || snapshot.watchDisabledByEnvironment} onChange={watchSessions => update({ watchSessions })} />
          </section>
          <section className="settings-section" aria-labelledby="window-title"><h2 id="window-title">窗口与位置</h2><div className="setting-row"><div className="setting-copy"><strong>灵动岛位置</strong><p>拖动后自动记住位置，也可以一键回到屏幕顶部。</p></div><button className="settings-button" disabled={busy || snapshot.preview} onClick={() => void run(() => bridge.settingsAction('reset-position'), '已恢复顶部居中')}>恢复顶部居中</button></div>
            <div className="settings-actions"><button className="settings-button" disabled={busy || snapshot.preview} onClick={() => void run(() => bridge.settingsAction('show'), '已显示灵动岛')}>显示灵动岛</button><button className="settings-button" disabled={busy || snapshot.preview} onClick={() => void run(() => bridge.settingsAction('hide'), '已隐藏灵动岛')}>隐藏灵动岛</button><button className="settings-button" disabled={busy} onClick={() => void run(() => bridge.playDemo(), '演示已开始')}>播放演示</button></div>
          </section><p className="settings-help">关闭配置窗口后，灵动岛继续在托盘中运行。可从托盘或灵动岛的右键菜单再次打开配置。</p>
        </>}
        {section === 'connections' && <>
          <section className="settings-section settings-section-first" aria-labelledby="claude-title"><div className="section-heading"><h2 id="claude-title">Claude Code</h2><span className="connection-state"><span className="connection-dot" data-active={snapshot.claudeInstalled} />{snapshot.claudeInstalled ? '已安装接入' : '尚未接入'}</span></div>
            <p className="settings-description">通过原生 Hook 自动批准权限、回答 AskUserQuestion 选择题。适用于支持 HTTP Hook 的 Claude Code 客户端。</p>
            <div className="integration-action"><button className="settings-button settings-button-primary" disabled={busy || snapshot.preview} onClick={() => void run(async () => {
              setSnapshot(await bridge.setClaudeIntegration(!snapshot.claudeInstalled))
            }, snapshot.claudeInstalled ? '接入已移除' : '接入已安装，请重新打开 Claude Code 会话')}>{snapshot.claudeInstalled ? '移除接入' : '安装接入'}</button><span>保留其他配置，并在修改前创建备份。</span></div>
            <p className="settings-help">安装到本机 Claude Code 的 settings.json。安装后重新打开会话；灵动岛退出或暂停时，恢复原 Agent 的审批流程。</p>
          </section>
          <section className="settings-section" aria-labelledby="codex-title"><div className="section-heading"><h2 id="codex-title">Codex app-server</h2><span className="connection-state"><span className="connection-dot" data-active={snapshot.codexStatus === 'connected'} />{({ disabled: '未连接', connecting: '连接中', connected: '已连接', error: '连接失败' })[snapshot.codexStatus]}</span></div>
            <p className="settings-description">连接与你的 Codex 客户端共用的本机 app-server，处理命令、文件、权限审批和选择题。</p>
            <label className="settings-field-label" htmlFor="codex-url">WebSocket 地址</label><form className="connection-form" onSubmit={event => { event.preventDefault(); update({ automation: { codexUrl: codexUrl.trim() } }) }}><input id="codex-url" type="text" spellCheck={false} autoComplete="off" placeholder="ws://127.0.0.1:4500" value={codexUrl} onChange={event => setCodexUrl(event.target.value)} disabled={busy || snapshot.preview} aria-describedby="codex-help" /><button className="settings-button" type="submit" disabled={busy || snapshot.preview || codexUrl.trim() === auto.codexUrl}>保存地址</button></form>
            <p className="settings-help" id="codex-help">开启自动审批后连接，清空地址可移除。仅支持本机无认证的 WebSocket 服务；普通 CLI、桌面应用和插件的日志不会自动建立此连接。</p>
            {snapshot.codexDetail && <p className="connection-detail" role="status">{snapshot.codexDetail}</p>}
          </section>
          <div className="settings-note"><Icon><path d="M12 8h.01M11 12h1v4" /><circle cx="12" cy="12" r="9" /></Icon><p>Claude、Cursor、Gemini 的远程 Hook 和 Telegram、飞书、企业微信、Discord 渠道请在“远程接管”中配置。未接入的会话仍由原客户端处理。</p></div>
        </>}
        <div hidden={section !== 'remote'}><RemoteSettings remote={snapshot.remote} preview={snapshot.preview} onSnapshot={setSnapshot} onDirty={setRemoteDirty} /></div>
        {section === 'history' && <>
          <div className="history-toolbar"><p>保留最近 50 条，退出应用后清空。</p><button className="settings-button" disabled={busy || !snapshot.history.length} onClick={() => void run(() => bridge.settingsAction('clear-history'), '记录已清空')}>清空记录</button></div>
          {snapshot.history.length ? <ol className="automation-history">{snapshot.history.map(entry => <li key={entry.id} data-action={entry.action}><div><span className="history-action">{entry.action === 'approved' ? '已批准' : entry.action === 'answered' ? '已回答' : '交给你处理'}</span><span className="history-agent">{entry.agent}</span><time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })}</time></div><p>{entry.summary}</p></li>)}</ol> : <div className="settings-empty"><Icon><path d="M8 3h8l4 4v14H4V3zm0 8h8m-8 4h5" /></Icon><h2>还没有处理记录</h2><p>开启自动审批并接入 Agent 后，新的请求处理结果会出现在这里。</p><button className="settings-button" onClick={() => setSection('connections')}>设置 Agent 接入</button></div>}
        </>}
      </>}
    </main>
  </div>
}
