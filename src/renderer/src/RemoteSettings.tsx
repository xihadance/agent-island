import { useEffect, useId, useState } from 'react'
import type { RemoteDraft, RemoteSettings as RemoteState } from '../../shared/remote-settings'
import type { SettingsSnapshot } from '../../shared/preferences'
import { getBridge } from './bridge'

const channelNames = { telegram: 'Telegram', feishu: '飞书', wecom: '企业微信', discord: 'Discord' }
const split = (value: string) => value.split(/[\s,，]+/).filter(Boolean)

function Field({ label, value, onChange, placeholder, optional = false }: {
  label: string; value: string; onChange: (value: string) => void; placeholder?: string; optional?: boolean
}) {
  const id = useId()
  return <div className="remote-field"><label htmlFor={id}>{label}</label><input id={id} value={value} onChange={event => onChange(event.target.value)}
    placeholder={placeholder} required={!optional} spellCheck={false} autoComplete="off" /></div>
}

export function RemoteSettings({ remote, hooks, preview, onSnapshot, onDirty }: {
  remote: RemoteState; hooks: SettingsSnapshot['remoteHooks']; preview?: boolean; onSnapshot: (snapshot: SettingsSnapshot) => void; onDirty: (dirty: boolean) => void
}) {
  const bridge = getBridge()
  const [draft, setDraft] = useState<RemoteDraft>({ channels: remote.channels, codex: remote.codex })
  const [base, setBase] = useState(remote.revision)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('渠道配置修改后，请点击保存。')
  const [type, setType] = useState<keyof typeof channelNames>('telegram')
  useEffect(() => {
    if (!dirty) { setDraft({ channels: remote.channels, codex: remote.codex }); setBase(remote.revision) }
  }, [remote.revision, dirty])
  const edit = (next: RemoteDraft) => { setDraft(next); setDirty(true); onDirty(true); setNotice('有未保存的修改') }
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const disabled = busy || preview || remote.enabled || !!remote.error && !remote.revision
  const changeChannel = (index: number, patch: Partial<RemoteDraft['channels'][number]>) => edit({ ...draft, channels: draft.channels.map((c, i) => i === index ? { ...c, ...patch } : c) })
  const changeCodex = (index: number, patch: Partial<RemoteDraft['codex'][number]>) => edit({ ...draft, codex: draft.codex.map((c, i) => i === index ? { ...c, ...patch } : c) })
  return <div className="remote-settings">
    <div className="automation-master" data-enabled={remote.enabled}>
      <div className="setting-row setting-row-prominent"><div className="setting-copy"><label id="remote-switch-label" htmlFor="remote-switch">远程接管</label>
        <p id="remote-switch-help">{remote.enabled ? '通过远程渠道处理请求。自动审批暂时让位于远程接管。' : '从手机接收提醒、批准权限、回答问题和追加指令。'}</p></div>
        <button id="remote-switch" className="setting-switch" role="switch" aria-checked={remote.enabled} aria-labelledby="remote-switch-label" aria-describedby="remote-switch-help"
          disabled={busy || preview || !remote.configured || dirty} onClick={() => void run(async () => {
            onSnapshot(await bridge.setRemoteEnabled(!remote.enabled)); setNotice(remote.enabled ? '远程接管已关闭' : '远程接管已开启')
          })}><span /></button></div>
      <div className="automation-master-foot"><span className="connection-dot" data-active={remote.running} />{remote.error ? '配置需要检查' : remote.running ? '接管服务运行中' : remote.configured ? '已关闭' : '添加渠道并保存后即可开启'}</div>
    </div>
    <p className="settings-help">开启服务不代表所有渠道已经连通。先在渠道中发送 /sessions 验证；旧配置会自动读取。编辑连接前请关闭远程接管。</p>
    {(error || remote.error) && <p className="settings-error" role="alert">{error || remote.error}</p>}
    {remote.missingCredentials.length > 0 && <p className="connection-detail">当前进程未读取到凭据：{remote.missingCredentials.join('、')}。请设置这些环境变量后重启应用。</p>}
    <section className="settings-section" aria-labelledby="remote-hooks-title"><h2 id="remote-hooks-title">Agent Hook 接管</h2>
      <p className="settings-description">安装后重新打开对应客户端或会话，再配置消息渠道并开启上方远程接管。安装和移除均会备份文件，保留其他 Hook。</p>
      {(['claude', 'cursor', 'gemini'] as const).map(agent => {
        const label = { claude: 'Claude Code', cursor: 'Cursor', gemini: 'Gemini CLI' }[agent]
        const hook = hooks[agent]
        return <div className="hook-integration" key={agent}><div className="setting-row"><div className="setting-copy"><strong>{label}</strong>
          <p>{agent === 'claude' ? '权限审批、选择题回答与补充指令。' : agent === 'cursor' ? 'Shell / MCP 执行前确认与后续指导；原生问答仍在 Cursor 中处理。' : 'BeforeTool 执行前确认与上下文指导；原生问答仍在 Gemini 中处理。'}</p>
          <p>{hook.installed ? '已安装接管' : '尚未安装接管'}</p></div>
          <button className="settings-button" disabled={busy || preview || dirty} onClick={() => void run(async () => {
            onSnapshot(await bridge.setRemoteIntegration(agent, !hook.installed)); setNotice(hook.installed ? `${label} 接管已移除` : `${label} 接管已安装，请重新打开会话`)
          })}>{hook.installed ? '移除' : '安装'} {label} 接管</button></div>
          {hook.error && <p className="connection-detail" role="alert">{hook.error}</p>}
          <p className="settings-help">配置文件：{hook.file}</p></div>
      })}
      <p className="settings-help">Cursor 与 Gemini 的批准仅通过本次 Hook 门禁，各客户端原有的权限检查仍然生效。</p>
    </section>
    <form onSubmit={event => { event.preventDefault(); void run(async () => {
      const normalized = { channels: draft.channels.map(c => ({ ...c, id: c.id.trim(), destination: c.destination.trim(), allowedUsers: split(c.allowedUsers.join(',')) })),
        codex: draft.codex.map(c => ({ ...c, id: c.id.trim(), url: c.url.trim(), threads: split(c.threads.join(',')) })) }
      const snapshot = await bridge.saveRemote(normalized, base)
      setDirty(false); onDirty(false); onSnapshot(snapshot); setNotice('渠道配置已保存，可开启远程接管')
    }) }}>
      <fieldset disabled={disabled} className="remote-fields">
        <section className="settings-section" aria-labelledby="remote-channels-title"><h2 id="remote-channels-title">消息渠道</h2>
          <p className="settings-description">使用专用机器人。目标会话和允许操作的用户均填写平台 ID；凭据填写环境变量名称。</p>
          {!draft.channels.length && <p className="settings-help">还没有渠道。选择平台，添加你的第一个机器人。</p>}
          {draft.channels.map((channel, index) => <fieldset className="remote-editor" key={index}>
            <legend>{channelNames[channel.type]} · {index + 1}</legend>
            <div className="remote-grid">
              <Field label="渠道 ID" value={channel.id} onChange={id => changeChannel(index, { id })} placeholder="telegram-main" />
              <Field label={channel.type === 'discord' ? '目标频道 ID' : '目标会话 ID'} value={channel.destination} onChange={destination => changeChannel(index, { destination })} />
              {(channel.type === 'feishu' || channel.type === 'wecom') && <Field label={channel.type === 'feishu' ? '应用 App ID' : '机器人 Bot ID'} value={channel.appId ?? ''} onChange={appId => changeChannel(index, { appId })} />}
              <Field label="凭据环境变量名" value={(channel.type === 'feishu' || channel.type === 'wecom' ? channel.secretEnv : channel.tokenEnv) ?? ''}
                onChange={name => changeChannel(index, channel.type === 'feishu' || channel.type === 'wecom' ? { secretEnv: name } : { tokenEnv: name })} />
              <Field label="允许操作的用户 ID（逗号分隔）" value={channel.allowedUsers.join(',')} onChange={value => changeChannel(index, { allowedUsers: value.split(/[,，]/) })} />
            </div>
            <button type="button" className="settings-button" onClick={() => edit({ ...draft, channels: draft.channels.filter((_, i) => i !== index) })}>移除 {channelNames[channel.type]} 渠道 {index + 1}</button>
          </fieldset>)}
          <div className="settings-actions remote-add"><label htmlFor="remote-channel-type">平台</label><select id="remote-channel-type" value={type} onChange={event => setType(event.target.value as typeof type)}>
            {Object.entries(channelNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>
            <button type="button" className="settings-button" onClick={() => {
              const id = `${type}-${Date.now().toString(36)}`
              edit({ ...draft, channels: [...draft.channels, { id, type, destination: '', allowedUsers: [],
                ...(type === 'feishu' || type === 'wecom' ? { appId: '', secretEnv: `CUTE_ISLAND_${type.toUpperCase()}_SECRET` } : { tokenEnv: `CUTE_ISLAND_${type.toUpperCase()}_TOKEN` }) }] })
            }}>添加渠道</button></div>
        </section>
        <section className="settings-section" aria-labelledby="remote-codex-title"><h2 id="remote-codex-title">Codex 远程控制连接</h2>
          <p className="settings-description">仅接入同一 app-server 中已加载的原生线程。Claude、Cursor、Gemini 使用 Hook，配置步骤见接入说明。</p>
          {draft.codex.map((connection, index) => <fieldset className="remote-editor" key={index}><legend>Codex · {index + 1}</legend><div className="remote-grid">
            <Field label="连接 ID" value={connection.id} onChange={id => changeCodex(index, { id })} />
            <Field label="WebSocket 地址" value={connection.url} onChange={url => changeCodex(index, { url })} placeholder="ws://127.0.0.1:4500" />
            <Field label="原生 thread ID（逗号分隔）" value={connection.threads.join(',')} onChange={value => changeCodex(index, { threads: value.split(/[,，]/) })} />
            <Field label="认证环境变量名（可选）" optional value={connection.tokenEnv ?? ''} onChange={tokenEnv => changeCodex(index, { tokenEnv: tokenEnv || undefined })} />
          </div><button type="button" className="settings-button" onClick={() => edit({ ...draft, codex: draft.codex.filter((_, i) => i !== index) })}>移除 Codex 连接 {index + 1}</button></fieldset>)}
          <button type="button" className="settings-button" onClick={() => edit({ ...draft, codex: [...draft.codex, { id: `codex-${Date.now().toString(36)}`, url: 'ws://127.0.0.1:4500', threads: [] }] })}>添加 Codex 连接</button>
        </section>
      </fieldset>
      <div className="remote-save"><button className="settings-button settings-button-primary" type="submit" disabled={disabled || !dirty}>保存渠道配置</button><button className="settings-button" type="button" disabled={busy} onClick={() => void run(async () => {
        const next = await bridge.getSettings(); setDraft({ channels: next.remote.channels, codex: next.remote.codex }); setBase(next.remote.revision)
        setDirty(false); onDirty(false); onSnapshot(next); setNotice('已重新读取配置')
      })}>重新读取</button><span role="status">{busy ? '正在处理…' : notice}</span></div>
    </form>
    <div className="settings-note"><div><p>配置文件：{remote.configFile}</p><div className="settings-actions">
      <button type="button" className="settings-button" disabled={busy || preview} onClick={() => void run(async () => { await bridge.settingsAction('remote-file'); onSnapshot(await bridge.getSettings()) })}>打开配置文件</button>
      <button type="button" className="settings-button" disabled={busy || preview} onClick={() => void run(() => bridge.settingsAction('remote-docs'))}>渠道与 Hook 接入说明</button>
    </div></div></div>
  </div>
}
