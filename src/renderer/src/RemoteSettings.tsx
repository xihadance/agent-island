import type { ProxyOverride, ProxySettings } from '../../shared/proxy'
import { useEffect, useId, useRef, useState } from 'react'
import type { RemoteConnectionTest, RemoteConnectionTestResult, RemoteDraft, RemoteSettings as RemoteState } from '../../shared/remote-settings'
import type { SettingsSnapshot } from '../../shared/preferences'
import type { SettingsPage } from '../../shared/settings-nav'
import { CHANNEL_NAMES as channelNames } from '../../shared/settings-summary'
import { getBridge } from './bridge'
import { AgentMark, LinkRow, Notice, Row } from './settings-ui'

const split = (value: string) => value.split(/[\s,，]+/).filter(Boolean)
const normalizeChannel = (c: RemoteDraft['channels'][number]) => ({ ...c, id: c.id.trim(), destination: c.destination.trim(), allowedUsers: split(c.allowedUsers.join(',')),
  tokenEnv: c.tokenEnv?.trim(), secretEnv: c.secretEnv?.trim(), appId: c.appId?.trim() })
const normalizeCodex = (c: RemoteDraft['codex'][number]) => ({ ...c, id: c.id.trim(), url: c.url.trim(), threads: split(c.threads.join(',')), tokenEnv: c.tokenEnv?.trim() || undefined })
const usesSecret = (type: RemoteDraft['channels'][number]['type']) => type === 'feishu' || type === 'wecom'

function ConnectionActions({ target, label, disabled, onRemove, onTesting }: {
  target: RemoteConnectionTest; label: string; disabled: boolean; onRemove: () => void; onTesting: (testing: boolean) => void
}) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<RemoteConnectionTestResult>()
  const generation = useRef(0)
  const signature = JSON.stringify(target)
  useEffect(() => {
    setResult(undefined)
    return () => { generation.current++ }
  }, [signature])
  const test = async () => {
    if (testing || disabled) return
    const current = ++generation.current
    setTesting(true); setResult(undefined); onTesting(true)
    try {
      const next = await getBridge().testRemoteConnection(target)
      if (generation.current === current) setResult(next)
    } catch (error) {
      if (generation.current === current) setResult({ ok: false, message: error instanceof Error ? error.message : '测试失败，请重试。' })
    } finally { setTesting(false); onTesting(false) }
  }
  return <div className="remote-editor-actions">
    <div className="settings-actions">
      <button type="button" className="settings-button" disabled={disabled || testing} aria-label={`测试 ${label} 的连通性`} onClick={() => void test()}>{testing ? '测试中…' : '测试连通性'}</button>
      <button type="button" className="settings-button settings-button-danger" disabled={disabled || testing} onClick={onRemove}>移除 {label}</button>
    </div>
    <p className="remote-test-result" role="status" aria-live="polite" data-state={testing ? 'testing' : result ? result.ok ? 'success' : 'error' : undefined}>
      {testing ? '正在测试连接，请稍候…' : result ? `${result.ok ? '连接成功' : '连接失败'}：${result.message}` : ''}
    </p>
  </div>
}

function Field({ label, value, onChange, placeholder, optional = false }: {
  label: string; value: string; onChange: (value: string) => void; placeholder?: string; optional?: boolean
}) {
  const id = useId()
  return <div className="remote-field"><label htmlFor={id}>{label}</label><input id={id} value={value} onChange={event => onChange(event.target.value)}
    placeholder={placeholder} required={!optional} spellCheck={false} autoComplete="off" /></div>
}

function ProxyFields({ value, global = false, onChange }: {
  value?: ProxyOverride; global?: boolean; onChange: (value: ProxyOverride) => void
}) {
  const id = useId()
  const mode = value?.mode ?? (global ? 'system' : 'inherit')
  return <>
    <div className="remote-field"><label htmlFor={id}>{global ? '全局代理模式' : '连接代理'}</label>
      <select id={id} value={mode} onChange={event => onChange({ mode: event.target.value as ProxyOverride['mode'], ...(event.target.value === 'custom' ? { url: value?.url ?? '' } : {}) })}>
        {!global && <option value="inherit">继承全局代理</option>}
        <option value="system">跟随系统代理</option><option value="direct">直连（不使用代理）</option><option value="custom">自定义代理</option>
      </select></div>
    {mode === 'custom' && <Field label="代理地址" value={value?.url ?? ''} onChange={url => onChange({ mode: 'custom', url })} placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080" />}
  </>
}

type Editing = { kind: 'channel' | 'codex'; index: number } | undefined

export function RemoteSettings({ remote, hooks, preview, managedCodex, onSnapshot, onDirty, onNavigate }: {
  remote: RemoteState; hooks: SettingsSnapshot['remoteHooks']; preview?: boolean; managedCodex: boolean
  onSnapshot: (snapshot: SettingsSnapshot) => void; onDirty: (dirty: boolean) => void; onNavigate: (page: SettingsPage) => void
}) {
  const bridge = getBridge()
  const [draft, setDraft] = useState<RemoteDraft>({ proxy: remote.proxy, channels: remote.channels, codex: remote.codex })
  const [base, setBase] = useState(remote.revision)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('渠道配置修改后，请点击保存。')
  const [type, setType] = useState<keyof typeof channelNames>('telegram')
  const [editing, setEditing] = useState<Editing>()
  useEffect(() => {
    if (!dirty) { setDraft({ proxy: remote.proxy, channels: remote.channels, codex: remote.codex }); setBase(remote.revision) }
  }, [remote.revision, dirty])
  // A reload or save can shrink the lists; never leave an editor open on an entry that is gone.
  const open = editing && (editing.kind === 'channel' ? draft.channels : draft.codex)[editing.index] ? editing : undefined
  const edit = (next: RemoteDraft) => { setDraft(next); setDirty(true); onDirty(true); setNotice('有未保存的修改') }
  const run = async (action: () => Promise<void>) => {
    if (busy || testing) return
    setBusy(true); setError('')
    try { await action() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const working = busy || testing
  const disabled = working || !!preview || remote.enabled || !!remote.error && !remote.revision
  const changeChannel = (index: number, patch: Partial<RemoteDraft['channels'][number]>) => edit({ ...draft, channels: draft.channels.map((c, i) => i === index ? { ...c, ...patch } : c) })
  const changeCodex = (index: number, patch: Partial<RemoteDraft['codex'][number]>) => edit({ ...draft, codex: draft.codex.map((c, i) => i === index ? { ...c, ...patch } : c) })
  const removeAt = (kind: 'channel' | 'codex', index: number) => {
    edit(kind === 'channel' ? { ...draft, channels: draft.channels.filter((_, i) => i !== index) } : { ...draft, codex: draft.codex.filter((_, i) => i !== index) })
    if (open?.kind === kind) setEditing(open.index === index ? undefined : open.index > index ? { kind, index: open.index - 1 } : open)
  }
  const saved = new Set(remote.channels.map(channel => channel.id))
  const toggle = () => void run(async () => {
    onSnapshot(await bridge.setRemoteEnabled(!remote.enabled)); setNotice(remote.enabled ? '远程接管已关闭' : '远程接管已开启')
  })
  return <div className="remote-settings">
    <section className="settings-group automation-master settings-master" data-enabled={remote.enabled} aria-labelledby="remote-switch-label">
      <div className="settings-card">
        <div className="setting-row"><div className="setting-copy"><label id="remote-switch-label" htmlFor="remote-switch">远程接管</label>
          <p id="remote-switch-help">{remote.enabled ? '已接入的请求统一由远程入口回传；自动规则开启时，先按规则处理，其余交给你。' : '在手机上接收提醒、批准权限、回答问题和追加指令。'}</p></div>
          <div className="setting-control"><button id="remote-switch" className="setting-switch" role="switch" aria-checked={remote.enabled} aria-labelledby="remote-switch-label" aria-describedby="remote-switch-help"
            disabled={working || preview || !remote.configured || dirty} onClick={toggle}><span /></button></div></div>
        <div className="automation-master-foot settings-master-foot"><span className="connection-dot" data-active={remote.running} />{remote.error ? '配置需要检查' : remote.running ? '接管服务运行中' : remote.configured ? '已关闭' : '添加渠道并保存后即可开启'}
          {remote.enabled && <span className="remote-verify">在渠道发送 /sessions 验证双向通信</span>}</div>
      </div>
      <p className="settings-group-foot">接管服务运行不代表外部渠道已经连通。任一端处理后，另一端的同一请求失效。</p>
    </section>
    {(error || remote.error) && <Notice tone="error">{error || remote.error}</Notice>}
    {remote.missingCredentials.length > 0 && <Notice>当前进程未读取到凭据：{remote.missingCredentials.join('、')}。请设置这些环境变量后重启应用。</Notice>}
    {remote.enabled && !open && <Notice action={<button type="button" className="settings-button" disabled={working || preview} onClick={toggle}>关闭并编辑</button>}>接管运行中，渠道配置只读。</Notice>}
    <form onSubmit={event => { event.preventDefault(); void run(async () => {
      const normalized = { proxy: draft.proxy, channels: draft.channels.map(normalizeChannel), codex: draft.codex.map(normalizeCodex) }
      const snapshot = await bridge.saveRemote(normalized, base)
      setDirty(false); onDirty(false); onSnapshot(snapshot); setNotice('渠道配置已保存，可开启远程接管')
    }) }}>
      <div className="remote-list" hidden={!!open}>
        <section className="settings-group" aria-labelledby="remote-channels-title">
          <h2 className="settings-group-label" id="remote-channels-title">消息渠道</h2>
          <div className="settings-card">
            {draft.channels.map((channel, index) => {
              const credential = (usesSecret(channel.type) ? channel.secretEnv : channel.tokenEnv) ?? ''
              const missing = !!credential && remote.missingCredentials.includes(credential)
              const fresh = !saved.has(channel.id)
              return <LinkRow key={index} lead={<span className="channel-mark" data-channel={channel.type} aria-hidden="true">{channelNames[channel.type].slice(0, 2)}</span>}
                title={`${channelNames[channel.type]} · ${index + 1}`}
                description={[channel.destination || '未填写目标会话', channel.allowedUsers.filter(Boolean).length ? `允许 ${channel.allowedUsers.filter(Boolean).length} 位用户` : '未限制用户', credential || '未填写凭据变量'].join(' · ')}
                value={missing ? '缺少凭据' : fresh || dirty ? '未保存' : remote.running ? '服务运行中' : '已保存'} tone={missing ? 'warn' : fresh || dirty ? 'warn' : remote.running ? 'ok' : 'off'}
                onClick={() => setEditing({ kind: 'channel', index })} />
            })}
            {!draft.channels.length && <Row title="还没有渠道" description="选择平台，添加你的第一个机器人。" />}
            <fieldset disabled={disabled} className="remote-fields setting-row remote-add">
              <label htmlFor="remote-channel-type">平台</label>
              <select id="remote-channel-type" value={type} onChange={event => setType(event.target.value as typeof type)}>
                {Object.entries(channelNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>
              <button type="button" className="settings-button" onClick={() => {
                const id = `${type}-${Date.now().toString(36)}`
                edit({ ...draft, channels: [...draft.channels, { id, type, destination: '', allowedUsers: [],
                  ...(usesSecret(type) ? { appId: '', secretEnv: `CUTE_ISLAND_${type.toUpperCase()}_SECRET` } : { tokenEnv: `CUTE_ISLAND_${type.toUpperCase()}_TOKEN` }) }] })
                setEditing({ kind: 'channel', index: draft.channels.length })
              }}>添加渠道</button>
            </fieldset>
          </div>
          <p className="settings-group-foot">使用专用机器人。表单里只填环境变量名称，凭据值从进程环境读取，不写入配置文件。测试会向目标会话发送一条测试消息，无需先保存。</p>
        </section>
        <section className="settings-group" aria-labelledby="remote-codex-title">
          <h2 className="settings-group-label" id="remote-codex-title">Codex 连接</h2>
          <div className="settings-card">
            <LinkRow lead={<AgentMark agent="Codex" />} title="托管服务" description="原生审批和问题自动转发，终端和远程均可处理，先处理的一端生效"
              value={managedCodex ? remote.enabled ? '已关联' : '运行中' : '未启动'} tone={managedCodex && remote.enabled ? 'ok' : 'off'} onClick={() => onNavigate('codex')} />
            {draft.codex.map((connection, index) => <LinkRow key={index} title={`${connection.id || 'Codex'} · ${index + 1}`}
              description={[connection.url || '未填写地址', connection.threads.filter(Boolean).length ? `限定 ${connection.threads.filter(Boolean).length} 个会话` : '接管全部会话'].join(' · ')}
              value={dirty ? '未保存' : '已保存'} tone={dirty ? 'warn' : 'off'} onClick={() => setEditing({ kind: 'codex', index })} />)}
            <fieldset disabled={disabled} className="remote-fields setting-row remote-add-codex">
              <span className="setting-copy"><strong>其他 app-server</strong><span className="setting-description">单独填写地址，可限定会话 ID</span></span>
              <button type="button" className="settings-button" onClick={() => {
                edit({ ...draft, codex: [...draft.codex, { id: `codex-${Date.now().toString(36)}`, url: 'ws://127.0.0.1:4500', threads: [] }] })
                setEditing({ kind: 'codex', index: draft.codex.length })
              }}>添加 Codex 连接</button>
            </fieldset>
          </div>
        </section>
        <section className="settings-group" aria-labelledby="remote-hooks-title">
          <h2 className="settings-group-label" id="remote-hooks-title">Agent 远程 Hook</h2>
          <div className="settings-card">{(['claude', 'cursor', 'gemini'] as const).map(agent => {
            const label = { claude: 'Claude Code', cursor: 'Cursor', gemini: 'Gemini CLI' }[agent]
            return <LinkRow key={agent} lead={<AgentMark agent={label} />} title={label}
              description={{ claude: '权限审批、选择题回答与补充指令', cursor: 'Shell／MCP 执行前确认与后续指导', gemini: 'BeforeTool 执行前确认与上下文指导' }[agent]}
              value={hooks[agent].error ? '需要检查' : hooks[agent].installed ? '已安装' : '未安装'} tone={hooks[agent].error ? 'warn' : hooks[agent].installed ? 'ok' : 'off'} onClick={() => onNavigate(agent)} />
          })}</div>
          <p className="settings-group-foot">在对应 Agent 页面安装或移除。Cursor 与 Gemini 的批准仅通过本次 Hook 门禁，原有的权限检查仍然生效。</p>
        </section>
        <fieldset disabled={disabled} className="remote-fields">
          <section className="settings-group" aria-labelledby="remote-proxy-title">
            <h2 className="settings-group-label" id="remote-proxy-title">灵动岛全局代理</h2>
            <div className="settings-card"><div className="remote-grid"><ProxyFields value={draft.proxy} global onChange={proxy => edit({ ...draft, proxy: proxy as ProxySettings })} /></div></div>
            <p className="settings-group-foot">默认跟随系统代理。所有消息渠道及远程 Codex 连接继承此设置，也可单独覆盖；本机连接始终直连。保存并开启远程接管后生效。</p>
          </section>
        </fieldset>
        <section className="settings-group" aria-label="配置文件">
          <div className="settings-card"><Row title="配置文件" description={<code className="setting-path">{remote.configFile}</code>}>
            <button type="button" className="settings-button" disabled={working || preview} onClick={() => void run(async () => { await bridge.settingsAction('remote-file'); onSnapshot(await bridge.getSettings()) })}>打开配置文件</button>
            <button type="button" className="settings-button" disabled={working || preview} onClick={() => void run(() => bridge.settingsAction('remote-docs'))}>渠道与 Hook 接入说明</button>
          </Row></div>
        </section>
      </div>
      <div className="remote-editors" hidden={!open}>
        <button type="button" className="settings-back" onClick={() => setEditing(undefined)}><span aria-hidden="true">‹</span> 返回渠道列表</button>
        <fieldset disabled={disabled} className="remote-fields">
          {draft.channels.map((channel, index) => <fieldset className="remote-editor settings-card" key={index} hidden={!(open?.kind === 'channel' && open.index === index)}>
            <legend>{channelNames[channel.type]} · {index + 1}</legend>
            <div className="remote-grid">
              <Field label="渠道 ID" value={channel.id} onChange={id => changeChannel(index, { id })} placeholder="telegram-main" />
              <Field label={channel.type === 'discord' ? '目标频道 ID' : '目标会话 ID'} value={channel.destination} onChange={destination => changeChannel(index, { destination })} />
              {usesSecret(channel.type) && <Field label={channel.type === 'feishu' ? '应用 App ID' : '机器人 Bot ID'} value={channel.appId ?? ''} onChange={appId => changeChannel(index, { appId })} />}
              <Field label="凭据环境变量名" value={(usesSecret(channel.type) ? channel.secretEnv : channel.tokenEnv) ?? ''}
                onChange={name => changeChannel(index, usesSecret(channel.type) ? { secretEnv: name } : { tokenEnv: name })} />
              <Field label="允许操作的用户 ID（逗号分隔）" value={channel.allowedUsers.join(',')} onChange={value => changeChannel(index, { allowedUsers: value.split(/[,，]/) })} />
              <ProxyFields value={channel.proxy} onChange={proxy => changeChannel(index, { proxy })} />
            </div>
            <ConnectionActions target={{ kind: 'channel', proxy: draft.proxy, config: normalizeChannel(channel) }} label={`${channelNames[channel.type]} 渠道 ${index + 1}`} disabled={disabled} onTesting={setTesting}
              onRemove={() => removeAt('channel', index)} />
          </fieldset>)}
          {draft.codex.map((connection, index) => <fieldset className="remote-editor settings-card" key={index} hidden={!(open?.kind === 'codex' && open.index === index)}>
            <legend>Codex · {index + 1}</legend>
            <div className="remote-grid">
              <Field label="连接 ID" value={connection.id} onChange={id => changeCodex(index, { id })} />
              <Field label="WebSocket 地址" value={connection.url} onChange={url => changeCodex(index, { url })} placeholder="ws://127.0.0.1:4500" />
              <Field label="会话 ID（可选，逗号分隔）" optional placeholder="留空自动接管此服务的全部会话" value={connection.threads.join(',')} onChange={value => changeCodex(index, { threads: value.split(/[,，]/) })} />
              <Field label="认证环境变量名（可选）" optional value={connection.tokenEnv ?? ''} onChange={tokenEnv => changeCodex(index, { tokenEnv: tokenEnv || undefined })} />
              <ProxyFields value={connection.proxy} onChange={proxy => changeCodex(index, { proxy })} />
            </div>
            <ConnectionActions target={{ kind: 'codex', proxy: draft.proxy, config: normalizeCodex(connection) }} label={`Codex 连接 ${index + 1}`} disabled={disabled} onTesting={setTesting}
              onRemove={() => removeAt('codex', index)} />
          </fieldset>)}
        </fieldset>
      </div>
      <div className="remote-save" data-dirty={dirty}>
        <button className="settings-button settings-button-primary" type="submit" disabled={disabled || !dirty}>保存渠道配置</button>
        <button className="settings-button" type="button" disabled={working} onClick={() => void run(async () => {
          const next = await bridge.getSettings(); setDraft({ proxy: next.remote.proxy, channels: next.remote.channels, codex: next.remote.codex }); setBase(next.remote.revision)
          setDirty(false); onDirty(false); onSnapshot(next); setEditing(undefined); setNotice('已重新读取配置')
        })}>重新读取</button>
        <span role="status">{working ? '正在处理…' : notice}</span>
      </div>
    </form>
  </div>
}
