import { useEffect, useState } from 'react'
import type { PreferencesPatch, SettingsSnapshot } from '../../shared/preferences'

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
  return <div className="hosted-codex">
    <div className="setting-row"><div className="setting-copy"><strong>应用内托管服务</strong><p>自动查找已安装的 Codex CLI，随灵动岛启动服务并填写连接地址。沿用本机 Codex 登录。</p></div>
      <button className="settings-button settings-button-primary" disabled={disabled || (!configured.enabled && dirty)} onClick={() => update({ codexServer: { enabled: !configured.enabled } })}>
        {configured.enabled ? '停止托管服务' : '启动托管服务'}</button></div>
    <p className="connection-detail" data-status={server.status} role="status">{server.detail || '服务尚未启动。首次使用请先安装并登录 Codex CLI。'}</p>
    <p className="settings-help">仅连接到这个服务的会话可被接管。已有的 Codex 桌面应用、IDE 插件或独立 CLI 会话不会自动迁入。停止服务或退出灵动岛会断开相关客户端。</p>
    <form onSubmit={event => { event.preventDefault(); update({ codexServer: { port: Number(port), executable: executable.trim() } }) }}>
      <details className="codex-service-options"><summary>服务端口与程序路径</summary><div className="remote-grid">
        <div className="remote-field"><label htmlFor="codex-server-port">本机端口</label><input id="codex-server-port" type="number" min="1" max="65535" required value={port} onChange={event => setPort(event.target.value)} disabled={disabled || configured.enabled} /></div>
        <div className="remote-field"><label htmlFor="codex-server-executable">Codex 程序路径（可选）</label><input id="codex-server-executable" value={executable} onChange={event => setExecutable(event.target.value)} placeholder="留空自动检测；Windows 可选 codex.exe" spellCheck={false} disabled={disabled || configured.enabled} /></div>
      </div><button className="settings-button" type="submit" disabled={disabled || configured.enabled || !dirty}>保存服务配置</button></details>
    </form>
    {server.status === 'running' && <div className="codex-client-command"><label className="settings-field-label" htmlFor="codex-connect-command">在新的终端中连接此服务</label>
      <div className="connection-form"><input id="codex-connect-command" value={command} readOnly spellCheck={false} onFocus={event => event.target.select()} />
        <button className="settings-button" onClick={() => { void navigator.clipboard.writeText(command).then(() => setCopied('命令已复制')).catch(() => setCopied('请选中命令后复制')) }}>复制命令</button></div>
      <p className="settings-help" role="status">{copied || '安装命令接入后可直接运行 codex；也可复制此命令手动连接。远程消息操作需添加同一服务地址，会话 ID 可留空。'}</p>
    </div>}
  </div>
}
