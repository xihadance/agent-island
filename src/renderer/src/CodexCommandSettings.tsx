import { useState } from 'react'
import type { SettingsSnapshot } from '../../shared/preferences'
import { getBridge } from './bridge'

export function CodexCommandSettings({ snapshot, busy, onSnapshot }: { snapshot: SettingsSnapshot; busy: boolean; onSnapshot: (snapshot: SettingsSnapshot) => void }) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const command = snapshot.codexCommand
  return <div className="hook-integration">
    <div className="setting-row"><div className="setting-copy"><strong>直接使用 codex 命令</strong>
      <p>自动审批或远程接管开启时，自动连接配置的服务；两者都关闭时恢复普通启动方式。</p>
      <p>{command.installed ? `${command.shell} 命令接入已安装` : `可安装 ${command.shell} 命令接入`}</p></div>
      <button type="button" className="settings-button" disabled={busy || working || snapshot.preview} onClick={() => {
        setWorking(true); setError('')
        void getBridge().setCodexCommandIntegration(!command.installed).then(onSnapshot)
          .catch(error => setError(error instanceof Error ? error.message : '命令接入失败，请重试'))
          .finally(() => setWorking(false))
      }}>{working ? '正在处理…' : command.installed ? '移除命令接入' : '安装命令接入'}</button></div>
    <p className="settings-help">安装或移除后重新打开终端。先启动托管服务或配置已有服务地址，再开启对应模式。已运行的会话继续使用原连接；VS Code 的 Codex 插件独立运行。</p>
    {command.installed && <p className="settings-help">保留原有命令参数；手动指定 --remote 或 --no-daemon 时沿用你的选择。灵动岛退出或服务不可用时，恢复普通启动。</p>}
    {(error || command.error) && <p className="settings-error" role="alert">{error || command.error}</p>}
  </div>
}
