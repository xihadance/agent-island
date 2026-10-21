import { useState } from 'react'
import type { SettingsSnapshot } from '../../shared/preferences'
import { getBridge } from './bridge'
import { SettingsHelp } from './SettingsHelp'

export function CodexCommandSettings({ snapshot, busy, onSnapshot }: { snapshot: SettingsSnapshot; busy: boolean; onSnapshot: (snapshot: SettingsSnapshot) => void }) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const command = snapshot.codexCommand
  return <section className="settings-section codex-command-settings">
    <SettingsHelp title="直接使用 codex 命令">
      <p>安装或移除后请重新打开终端；已运行的会话继续使用原连接，VS Code 的 Codex 插件独立运行。</p>
      <p>使用 -p / --profile 时自动读取对应配置，不同配置可同时使用。</p>
      <p>保留原有命令参数；手动指定 --remote 或 --no-daemon 时沿用你的选择。灵动岛退出或服务不可用时恢复普通启动。</p>
    </SettingsHelp>
    <div className="setting-row"><span className="connection-state" data-active={command.installed}><span className="connection-dot" data-active={command.installed} />
      {command.installed ? `${command.shell} 命令接入已安装` : `${command.shell} 命令接入未安装`}</span>
      <button type="button" className={`settings-button${command.installed ? ' settings-button-danger' : ''}`} disabled={busy || working || snapshot.preview} onClick={() => {
        setWorking(true); setError('')
        void getBridge().setCodexCommandIntegration(!command.installed).then(onSnapshot)
          .catch(error => setError(error instanceof Error ? error.message : '命令接入失败，请重试'))
          .finally(() => setWorking(false))
      }}>{working ? '正在处理…' : command.installed ? '移除命令接入' : '安装命令接入'}</button></div>
    <p className="settings-description">先启动托管服务或配置已有服务地址。开启自动审批或远程接管后，新启动的 codex 会自动连接可用服务；两者都关闭时恢复普通启动。</p>
    {(error || command.error) && <p className="settings-error" role="alert">{error || command.error}</p>}
  </section>
}
