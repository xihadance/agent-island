import { useEffect, useState } from 'react'
import type { PreferencesPatch, SettingsSnapshot } from '../../shared/preferences'
import { SettingsHelp } from './SettingsHelp'

export function CodexServerSettings({ snapshot, busy, update }: { snapshot: SettingsSnapshot; busy: boolean; update: (patch: PreferencesPatch) => void }) {
  const configured = snapshot.preferences.codexServer
  const server = snapshot.codexServer
  const [port, setPort] = useState(String(configured.port))
  const [executable, setExecutable] = useState(configured.executable)
  const [copied, setCopied] = useState('')
  useEffect(() => { setPort(String(configured.port)); setExecutable(configured.executable) }, [configured.port, configured.executable])
  const dirty = port !== String(configured.port) || executable.trim() !== configured.executable
  const disabled = busy || snapshot.preview
  const command = `codex --remote ws://127.0.0.1:${configured.port}`
  return <section className="settings-section hosted-codex">
    <SettingsHelp title="应用内托管服务">
      <p>自动查找已安装的 Codex CLI，沿用本机 Codex 登录。</p>
      <p>仅连接到此服务的会话可被接管；已有的桌面应用、IDE 插件或独立 CLI 会话不会自动迁入。停止服务或退出灵动岛会断开相关客户端。</p>
      <p>普通 codex 使用默认配置，codex -p 名称自动使用对应 profile。同一配置复用服务；配置文件修改后，新命令使用新实例，已有会话保持原连接。</p>
    </SettingsHelp>
    <div className="setting-row codex-service-status"><p className="connection-state" data-status={server.status} role="status"><span className="connection-dot" data-active={server.status === 'running'} />
      {server.status === 'running' ? snapshot.remote.enabled ? '运行中 · 已启用远程接管' : '运行中' : server.status === 'starting' ? '正在启动…' : server.status === 'error' ? '启动失败' : '尚未启动'}</p>
      <button className={`settings-button ${configured.enabled ? 'settings-button-danger' : 'settings-button-primary'}`} disabled={disabled || (!configured.enabled && dirty)} onClick={() => update({ codexServer: { enabled: !configured.enabled } })}>
        {configured.enabled ? '停止托管服务' : '启动托管服务'}</button></div>
    {server.status !== 'running' && <p className="connection-detail" data-status={server.status} role="status">{server.detail || '首次使用请先安装并登录 Codex CLI。'}</p>}
    {server.status === 'running' && <div className="codex-client-command"><label className="settings-field-label" htmlFor="codex-connect-command">在新的终端中连接此服务</label>
      <div className="connection-form"><input id="codex-connect-command" value={command} readOnly spellCheck={false} onFocus={event => event.target.select()} />
        <button type="button" className="settings-button settings-button-primary" onClick={() => { void navigator.clipboard.writeText(command).then(() => setCopied('命令已复制')).catch(() => setCopied('请选中命令后复制')) }}>复制命令</button></div>
      <p className="settings-help" role="status">{copied || '手动连接默认服务；使用 profile 时，安装命令接入后直接运行 codex -p 名称。停止服务或退出会断开已接管的会话。'}</p>
    </div>}
    <form className="codex-service-form" onSubmit={event => { event.preventDefault(); update({ codexServer: { port: Number(port), executable: executable.trim() } }) }}>
      <details className="codex-service-options"><summary>服务端口与程序路径</summary><div className="remote-grid">
        <div className="remote-field"><label htmlFor="codex-server-port">本机端口</label><input id="codex-server-port" type="number" min="1" max="65535" required value={port} onChange={event => setPort(event.target.value)} disabled={disabled || configured.enabled} /></div>
        <div className="remote-field"><label htmlFor="codex-server-executable">Codex 程序路径（可选）</label><input id="codex-server-executable" value={executable} onChange={event => setExecutable(event.target.value)} placeholder="留空自动检测；Windows 可选 codex.exe" spellCheck={false} disabled={disabled || configured.enabled} /></div>
      </div></details>
      <button className="settings-button" type="submit" disabled={disabled || configured.enabled || !dirty}>保存服务配置</button>
    </form>
  </section>
}
