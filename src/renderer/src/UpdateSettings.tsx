import type { PreferencesPatch, SettingsSnapshot } from '../../shared/preferences'

function checkedLabel(checkedAt: number | undefined): string {
  if (!checkedAt) return '尚未检查'
  const minutes = Math.floor((Date.now() - checkedAt) / 60_000)
  if (minutes < 1) return '刚刚检查过'
  if (minutes < 60) return `${minutes} 分钟前检查过`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前检查过`
  return `${new Date(checkedAt).toLocaleDateString('zh-CN')} 检查过`
}

export function UpdateSettings({ snapshot, busy, update, action }: {
  snapshot: SettingsSnapshot; busy: boolean; update: (patch: PreferencesPatch) => void
  action: (action: 'update-check' | 'update-page' | 'update-download' | 'update-install', success: string) => void
}) {
  const state = snapshot.update
  const enabled = snapshot.preferences.update.enabled
  const disabled = busy || snapshot.preview
  const next = state.available
  const status = state.status === 'disabled' ? (snapshot.preview ? '浏览器预览不检查更新' : enabled ? '当前环境已关闭更新检查' : '自动检查已关闭')
    : state.status === 'checking' ? '正在检查…' : state.status === 'downloading' ? `正在下载 ${state.progress ?? 0}%`
    : state.status === 'downloaded' ? `${next?.version} 已下载，重启后生效`
    : state.status === 'error' ? state.error ?? '检查失败'
    : next ? `有新版本 ${next.version}` : `已是最新版本 · ${checkedLabel(state.checkedAt)}`

  return <section className="settings-group" aria-labelledby="update-title">
    <h2 className="settings-group-label" id="update-title">软件更新</h2>
    <span className="settings-group-aside">当前版本 {state.current}</span>
    <div className="settings-card">
    <div className="setting-row"><div className="setting-copy"><strong>版本状态</strong><p className="settings-description" role="status" data-status={state.status}>{status}</p></div></div>
    {next && <div className="update-available">
      <div className="update-available-head"><strong>{next.version}</strong>{next.publishedAt > 0 && <time dateTime={new Date(next.publishedAt).toISOString()}>{new Date(next.publishedAt).toLocaleDateString('zh-CN')} 发布</time>}</div>
      {next.notes && <pre className="update-notes">{next.notes}</pre>}
      {state.status === 'downloading' && <div className="update-progress"><div className="update-progress-bar" role="progressbar" aria-valuenow={state.progress ?? 0}
        aria-valuemin={0} aria-valuemax={100} aria-label="下载进度"><span style={{ width: `${state.progress ?? 0}%` }} /></div><span>{state.progress ?? 0}%</span></div>}
      <div className="settings-actions">
        {!state.autoInstall && <button className="settings-button settings-button-primary" disabled={disabled} onClick={() => action('update-page', '已打开发布页')}>前往下载</button>}
        {state.autoInstall && state.status !== 'downloaded' && <button className="settings-button settings-button-primary" disabled={disabled || state.status === 'downloading'}
          onClick={() => action('update-download', '下载完成')}>{state.status === 'downloading' ? '正在下载…' : '下载更新'}</button>}
        {state.autoInstall && state.status === 'downloaded' && <button className="settings-button settings-button-primary" disabled={disabled || !!state.blockedReason}
          onClick={() => action('update-install', '正在重启安装')}>重启并安装</button>}
        {state.autoInstall && <button className="settings-button" disabled={disabled} onClick={() => action('update-page', '已打开发布页')}>查看发布页</button>}
        <button className="settings-button" disabled={disabled || state.status === 'downloading'} onClick={() => update({ update: { skippedVersion: next.version } })}>跳过此版本</button>
      </div>
      {state.blockedReason && <p className="settings-help" role="status">{state.blockedReason}。也可以关闭配置窗口，下次退出灵动岛时自动安装。</p>}
      <p className="settings-help">{state.autoInstall
        ? state.status === 'downloaded' ? '安装会关闭托管 Codex 服务并重启灵动岛。端口和令牌不变，已安装的 Agent 接入无需重装。'
          : '下载后可选择重启安装，或等到下次退出灵动岛时自动安装。'
        : '当前安装方式需要手动下载安装包覆盖当前版本。端口和令牌不变，已安装的 Agent 接入无需重装。'}</p>
    </div>}
    <div className="setting-row"><div className="setting-copy"><strong id="update-enabled-label">自动检查新版本</strong>
      <p id="update-enabled-description">每天向 GitHub 查询一次最新版本号，只读取版本信息，不上传任何本机内容。</p></div>
      <div className="setting-control"><button className="setting-switch" type="button" role="switch" aria-checked={enabled} aria-labelledby="update-enabled-label"
        aria-describedby="update-enabled-description" disabled={busy} onClick={() => update({ update: { enabled: !enabled } })}><span /></button></div></div>
    <div className="setting-row"><div className="setting-copy"><strong>手动检查</strong><p>跟随远程接管配置的全局代理。</p></div>
      <div className="setting-control">
        {snapshot.preferences.update.skippedVersion && <button className="settings-button" disabled={disabled} onClick={() => update({ update: { skippedVersion: '' } })}>
          取消跳过 {snapshot.preferences.update.skippedVersion}</button>}
        <button className="settings-button" disabled={disabled || !enabled || state.status === 'checking'} onClick={() => action('update-check', '已开始检查')}>立即检查</button>
      </div></div>
    </div>
  </section>
}
