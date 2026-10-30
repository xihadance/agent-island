import { useState } from 'react'
import type { SettingsSnapshot } from '../../shared/preferences'
import { getBridge } from './bridge'
import { SettingsHelp } from './SettingsHelp'

export function CodexCommandSettings({ snapshot, busy, onSnapshot }: { snapshot: SettingsSnapshot; busy: boolean; onSnapshot: (snapshot: SettingsSnapshot) => void }) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const command = snapshot.codexCommand
  return <section className="settings-group codex-command-settings">
    <SettingsHelp title="命令接入">
      <p>安装或移除后请重新打开终端；已运行的会话继续使用原连接，VS Code 的 Codex 插件独立运行。</p>
      <p>使用 -p / --profile 时自动读取对应配置，不同配置可同时使用。</p>
      <p>保留原有命令参数；手动指定 --remote 或 --no-daemon 时沿用你的选择。灵动岛退出或服务不可用时恢复普通启动。</p>
    </SettingsHelp>
    <div className="settings-card">
      <div className="setting-row"><div className="setting-copy"><strong>让 codex 直接连上服务</strong>
        <p className="connection-state" data-active={command.installed}><span className="connection-dot" data-active={command.installed} />{command.installed ? `${command.shell} 命令接入已安装` : `${command.shell} 命令接入未安装`}</p></div>
        <div className="setting-control"><button type="button" className={`settings-button${command.installed ? ' settings-button-danger' : ' settings-button-primary'}`} disabled={busy || working || snapshot.preview} onClick={() => {
          setWorking(true); setError('')
          void getBridge().setCodexCommandIntegration(!command.installed).then(onSnapshot)
            .catch(error => setError(error instanceof Error ? error.message : '命令接入失败，请重试'))
            .finally(() => setWorking(false))
        }}>{working ? '正在处理…' : command.installed ? '移除命令接入' : '安装命令接入'}</button></div></div>
      {(error || command.error) && <p className="setting-inline-note" data-tone="error" role="alert">{error || command.error}</p>}
    </div>
    <p className="settings-group-foot">安装后重新打开终端。按当前开关自动选择连接方式，远程接管优先；两者都关闭或服务不可用时恢复普通启动。安装前备份 Shell 配置，移除时保留其他内容。</p>
  </section>
}
