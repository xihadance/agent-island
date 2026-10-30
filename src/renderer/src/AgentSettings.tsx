import { useEffect, useState } from 'react'
import { AGENT_NAMES, agentCapabilities, agentSummary, remoteSummary, rulesSummary, type AgentId } from '../../shared/settings-summary'
import { getBridge } from './bridge'
import { CodexCommandSettings } from './CodexCommandSettings'
import { CodexServerSettings } from './CodexServerSettings'
import { AgentMark, Capabilities, Group, Hero, LinkRow, Row, type PageProps } from './settings-ui'

const INTRO: Record<AgentId, string> = {
  claude: '通过原生 Hook 接入。安装后新开的会话生效。',
  codex: '通过本机 app-server 接入，沿用你的 Codex 登录。',
  cursor: '通过远程 Hook 接入。批准只通过本次 Hook 门禁，Cursor 原生权限策略仍然生效。',
  gemini: '通过远程 Hook 接入。批准只通过本次 Hook 门禁，Gemini 原生权限策略仍然生效。'
}

function RemoteHook({ agent, busy, remoteDirty, snapshot, run, setSnapshot }: PageProps & { agent: 'claude' | 'cursor' | 'gemini' }) {
  const hook = snapshot.remoteHooks[agent]
  const what = agent === 'claude' ? '权限审批、问题回答与补充指令发到消息渠道' : agent === 'cursor' ? 'Shell／MCP 执行前确认与后续指导' : 'BeforeTool 执行前确认与上下文指导'
  return <>
    <Row title="远程接管 Hook" description={<>{what}<br /><code className="setting-path">{hook.file}</code></>}>
      <span className="setting-value" data-tone={hook.installed ? 'ok' : 'off'}>{hook.installed ? '已安装' : '未安装'}</span>
      <button type="button" className={`settings-button${hook.installed ? ' settings-button-danger' : ' settings-button-primary'}`} disabled={busy || snapshot.preview || remoteDirty}
        onClick={() => void run(async () => setSnapshot(await getBridge().setRemoteIntegration(agent, !hook.installed)),
          hook.installed ? `${AGENT_NAMES[agent]} 远程 Hook 已移除` : `${AGENT_NAMES[agent]} 远程 Hook 已安装，请重新打开会话`)}>{hook.installed ? '移除远程 Hook' : '安装远程 Hook'}</button>
    </Row>
    {remoteDirty && <p className="setting-inline-note" role="status">远程接管有未保存的渠道修改，保存或重新读取后才能修改 Hook。</p>}
    {hook.error && <p className="setting-inline-note" data-tone="error" role="alert">{hook.error}</p>}
  </>
}

function Related(props: PageProps) {
  const rules = rulesSummary(props.snapshot), remote = remoteSummary(props.snapshot)
  return <Group title="适用的规则">
    <LinkRow title="自动规则" description="所有已接入 Agent 共用" value={rules.value} tone={rules.tone} onClick={() => props.navigate('rules')} />
    <LinkRow title="远程接管" description="规则处理不了的请求发到这里" value={remote.value} tone={remote.tone} onClick={() => props.navigate('remote')} />
  </Group>
}

function ExistingCodex({ snapshot, busy, update }: PageProps) {
  const auto = snapshot.preferences.automation
  const [codexUrl, setCodexUrl] = useState(auto.codexUrl)
  useEffect(() => { setCodexUrl(auto.codexUrl) }, [auto.codexUrl])
  const locked = busy || snapshot.preview || snapshot.preferences.codexServer.enabled
  return <details className="settings-group settings-disclosure existing-codex">
    <summary className="settings-card"><span className="setting-row"><span className="setting-copy"><strong>连接已有的 app-server</strong>
      <span className="setting-description">{auto.codexUrl || '本机无认证 WebSocket，托管服务开启时不可用'}</span></span><span className="setting-chevron" aria-hidden="true">›</span></span></summary>
    <div className="settings-card">
      <form className="setting-field" onSubmit={event => { event.preventDefault(); update({ automation: { codexUrl: codexUrl.trim() } }) }}>
        <label htmlFor="codex-url">WebSocket 地址</label>
        <div className="connection-form"><input id="codex-url" type="text" spellCheck={false} autoComplete="off" placeholder="ws://127.0.0.1:4500" value={codexUrl}
          onChange={event => setCodexUrl(event.target.value)} disabled={locked} aria-describedby="codex-help" />
          <button className="settings-button" type="submit" disabled={locked || codexUrl.trim() === auto.codexUrl}>保存地址</button></div>
        <p className="setting-hint" id="codex-help">开启自动规则后连接，清空地址可移除。普通 CLI、桌面应用和插件的日志不会自动建立此连接。远程接管使用的其他 app-server 请在「远程接管」中添加。</p>
      </form>
    </div>
  </details>
}

export function AgentSettings(props: PageProps & { agent: AgentId }) {
  const { agent, snapshot, busy, run, setSnapshot } = props
  const summary = agentSummary(agent, snapshot)
  return <>
    <Hero mark={<AgentMark agent={AGENT_NAMES[agent]} large />} title={AGENT_NAMES[agent]} description={INTRO[agent]} status={summary.value} tone={summary.tone} />
    <Group title="灵动岛能替你做什么"><Capabilities items={agentCapabilities(agent, snapshot)} /></Group>
    {agent === 'claude' && <Group title="接入" footer="修改前备份，只增删自己那部分。灵动岛退出或暂停时，恢复 Claude Code 原有的审批流程。改了端口或令牌后需要重新安装。">
      <Row title="本机审批 Hook" description={<>按自动规则批准权限、回答选择题<br /><code className="setting-path">~/.claude/settings.json</code></>}>
        <span className="setting-value" data-tone={snapshot.claudeInstalled ? 'ok' : 'off'}>{snapshot.claudeInstalled ? '已安装' : '未安装'}</span>
        <button type="button" className={`settings-button${snapshot.claudeInstalled ? ' settings-button-danger' : ' settings-button-primary'}`} disabled={busy || snapshot.preview}
          onClick={() => void run(async () => setSnapshot(await getBridge().setClaudeIntegration(!snapshot.claudeInstalled)),
            snapshot.claudeInstalled ? '本机 Hook 已移除' : '本机 Hook 已安装，请重新打开 Claude Code 会话')}>{snapshot.claudeInstalled ? '移除本机 Hook' : '安装本机 Hook'}</button>
      </Row>
      <RemoteHook {...props} agent="claude" />
    </Group>}
    {agent === 'codex' && <>
      <CodexServerSettings snapshot={snapshot} busy={busy} update={props.update} />
      {snapshot.codexDetail && <p className="setting-inline-note" role="status">{snapshot.codexDetail}</p>}
      <CodexCommandSettings snapshot={snapshot} busy={busy} onSnapshot={setSnapshot} />
      <ExistingCodex {...props} />
    </>}
    {(agent === 'cursor' || agent === 'gemini') && <Group title="接入" footer="需先在「远程接管」配置消息渠道。修改前备份，保留你的其他 Hook；安装后重新打开客户端。启动脚本使用应用内附的 Node 运行时。">
      <RemoteHook {...props} agent={agent} />
    </Group>}
    <Related {...props} />
  </>
}
