import type { Activity } from './activity'
import { attentionIssues, type AttentionKind } from './island-behavior'
import type { SettingsSnapshot } from './preferences'

export type AgentId = 'claude' | 'codex' | 'cursor' | 'gemini'
export type Tone = 'ok' | 'warn' | 'off'

export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'cursor', 'gemini']
export const AGENT_NAMES: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini CLI' }
export const CHANNEL_NAMES = { telegram: 'Telegram', feishu: '飞书', wecom: '企业微信', discord: 'Discord' } as const

/** Mirrors the island's agent matching so both surfaces group sessions the same way. */
export function agentIdOf(agent: string): AgentId | undefined {
  const name = agent.trim().toLowerCase()
  return AGENT_IDS.find(id => name.includes(id))
}

export interface PendingRequest { id: string; agent: string; kind: 'approval' | 'input'; title: string; detail: string }

// Errors already surface on the island; this list is only for requests a person can act on.
const ACTIONABLE: Partial<Record<AttentionKind, { kind: PendingRequest['kind']; rank: number }>> = {
  approval: { kind: 'approval', rank: 2 }, input: { kind: 'input', rank: 2 },
  'task-approval': { kind: 'approval', rank: 1 }, 'task-input': { kind: 'input', rank: 1 }
}

/** Only recorded requests count, never elapsed time; ties keep first-appearance order. */
export function pendingRequests(activities: Activity[]): PendingRequest[] {
  return activities.flatMap(activity => {
    const issue = attentionIssues(activity).find(item => ACTIONABLE[item.kind])
    if (!issue) return []
    const { kind, rank } = ACTIONABLE[issue.kind]!
    const child = issue.kind.startsWith('task-')
    const title = child ? issue.title : activity.title
    const detail = (child ? issue.detail : issue.kind === 'input' ? issue.title : issue.detail) || ''
    return [{ request: { id: activity.id, agent: activity.agent, kind, title, detail }, rank, startedAt: activity.startedAt }]
  }).sort((a, b) => b.rank - a.rank || a.startedAt - b.startedAt).map(item => item.request)
}

const LIVE = new Set<Activity['state']>(['thinking', 'running', 'waiting', 'approval'])

export function liveSessions(activities: Activity[]): Record<AgentId, number> {
  const counts: Record<AgentId, number> = { claude: 0, codex: 0, cursor: 0, gemini: 0 }
  for (const activity of activities) {
    const id = agentIdOf(activity.agent)
    if (id && LIVE.has(activity.state) && !activity.stale) counts[id]++
  }
  return counts
}

export interface Summary { tone: Tone; value: string; detail: string }

type SummaryInput = Pick<SettingsSnapshot, 'preferences' | 'remote' | 'remoteHooks' | 'claudeInstalled' | 'codexServer' | 'codexStatus' | 'watchDisabledByEnvironment'>

function codexRoutes(snapshot: SummaryInput): { hosted: boolean; running: boolean; external: boolean; links: number } {
  const hosted = snapshot.preferences.codexServer.enabled
  return { hosted, running: hosted && snapshot.codexServer.status === 'running',
    external: !hosted && !!snapshot.preferences.automation.codexUrl, links: snapshot.remote.codex.length }
}

export interface Capability { title: string; available: boolean; detail: string }

/** Each line states what works now, and when it does not, the one step that enables it. */
export function agentCapabilities(id: AgentId, snapshot: SummaryInput): Capability[] {
  const watching = snapshot.preferences.watchSessions && !snapshot.watchDisabledByEnvironment
  const remoteOn = snapshot.remote.enabled
  const observe: Capability = { title: id === 'codex' || id === 'claude' ? '显示状态、操作和子任务' : '显示状态和操作', available: watching,
    detail: watching ? '读取会话日志，只读，不注入' : snapshot.watchDisabledByEnvironment ? '启动环境已关闭会话识别' : '在「灵动岛」开启会话识别' }
  if (id === 'claude') {
    const remote = snapshot.remoteHooks.claude.installed && remoteOn
    const reply = remoteOn ? remote : snapshot.claudeInstalled
    const need = remoteOn ? '远程接管开启时需安装远程 Hook' : '安装本机 Hook 或远程 Hook'
    return [observe,
      { title: '权限审批', available: reply, detail: reply ? remoteOn ? '自动规则先处理，其余转到远程渠道' : '按自动规则批准，其余交给你' : need },
      { title: '回答 AskUserQuestion 选择题', available: reply, detail: reply ? '自由输入和密码类问题始终交给你' : need },
      { title: '补充指令、异常后继续会话', available: remote, detail: remote ? '在原工作目录运行原生 CLI，保留 Hook 权限门禁' : '需安装远程 Hook 并开启远程接管' }]
  }
  if (id === 'codex') {
    const { running, external, links } = codexRoutes(snapshot)
    const reply = remoteOn ? running || links > 0 : running || external
    const steer = remoteOn && (running || links > 0)
    return [observe,
      { title: '权限审批、问题回答', available: reply, detail: reply ? '仅限连到这个服务的会话' : '启动托管服务，或连接已有的 app-server' },
      { title: '补充指令、异常后继续线程', available: steer, detail: steer ? '经远程渠道发送' : '需开启远程接管' }]
  }
  const hook = snapshot.remoteHooks[id].installed && remoteOn
  const need = snapshot.remoteHooks[id].installed ? '需开启远程接管' : '需安装远程 Hook'
  return [observe,
    { title: id === 'cursor' ? 'Shell／MCP 执行前确认' : 'BeforeTool 执行前确认', available: hook, detail: hook ? '原生权限策略仍然生效' : need },
    { title: id === 'cursor' ? '后续指导' : '上下文指导', available: hook, detail: hook ? '经远程渠道发送' : need },
    { title: '原生问答界面', available: false, detail: '不在接管范围，仍在客户端中回答' }]
}

/** Describes what will actually happen to the next request, not merely what is installed. */
export function agentSummary(id: AgentId, snapshot: SummaryInput): Summary {
  const remoteOn = snapshot.remote.enabled
  const auto = snapshot.preferences.automation.enabled
  const watching = snapshot.preferences.watchSessions && !snapshot.watchDisabledByEnvironment
  const observe: Summary = { tone: 'off', value: watching ? '仅显示状态' : '会话识别已关闭', detail: '' }
  if (id === 'claude') {
    const native = snapshot.claudeInstalled, remote = snapshot.remoteHooks.claude.installed
    const detail = native && remote ? '本机 Hook · 远程 Hook 已安装' : native ? '本机 Hook 已安装' : remote ? '远程 Hook 已安装' : '尚未安装 Hook'
    if (snapshot.remoteHooks.claude.error) return { tone: 'warn', value: 'Hook 需要检查', detail: snapshot.remoteHooks.claude.error }
    // Takeover pauses the independent native channel, so only the remote Hook can reply.
    if (remoteOn) return remote ? { tone: 'ok', value: '审批 · 回答 · 指令', detail }
      : native ? { tone: 'warn', value: '需安装远程 Hook', detail } : { ...observe, detail }
    if (native) return auto ? { tone: 'ok', value: '自动审批 · 回答', detail } : { tone: 'off', value: '自动规则已暂停', detail }
    return { ...observe, detail }
  }
  if (id === 'codex') {
    const server = snapshot.codexServer
    const { hosted, running, external, links } = codexRoutes(snapshot)
    if (hosted && server.status === 'starting') return { tone: 'off', value: '正在启动', detail: '托管服务' }
    if (hosted && server.status === 'error') return { tone: 'warn', value: '启动失败', detail: server.detail || '托管服务' }
    const hostedDetail = `托管服务运行中 · ${server.url.replace(/^ws:\/\//, '')}`
    // Takeover answers through the managed service or saved remote connections, never the automation URL.
    if (remoteOn) return running ? { tone: 'ok', value: '审批 · 回答 · 指令', detail: hostedDetail }
      : links ? { tone: 'ok', value: '审批 · 回答 · 指令', detail: `${links} 个 app-server 连接` }
      : external ? { tone: 'warn', value: '在远程接管中添加连接', detail: '已有 app-server' } : { ...observe, detail: '托管服务未启动' }
    if (!running && !external) return { ...observe, detail: '托管服务未启动' }
    const detail = running ? hostedDetail : '已有 app-server'
    if (!auto) return { tone: 'off', value: '自动规则已暂停', detail }
    if (snapshot.codexStatus === 'error') return { tone: 'warn', value: '连接失败', detail }
    if (snapshot.codexStatus === 'connected') return { tone: 'ok', value: '自动审批 · 回答', detail }
    return { tone: 'off', value: '连接中', detail }
  }
  const hook = snapshot.remoteHooks[id]
  if (hook.error) return { tone: 'warn', value: 'Hook 需要检查', detail: hook.error }
  if (!hook.installed) return { ...observe, detail: '尚未安装远程 Hook' }
  return remoteOn ? { tone: 'ok', value: id === 'cursor' ? '执行前确认' : 'BeforeTool 确认', detail: '远程 Hook 已安装' }
    : { tone: 'off', value: '远程接管已关闭', detail: '远程 Hook 已安装' }
}

export function remoteSummary(snapshot: Pick<SettingsSnapshot, 'remote'>): Summary {
  const remote = snapshot.remote
  const names = remote.channels.map(channel => CHANNEL_NAMES[channel.type])
  const listed = names.length ? [...new Set(names)].join('、') : '尚未添加渠道'
  if (remote.error) return { tone: 'warn', value: '配置需要检查', detail: remote.error }
  if (remote.missingCredentials.length) return { tone: 'warn', value: '缺少凭据', detail: remote.missingCredentials.join('、') }
  if (!remote.configured) return { tone: 'off', value: '未配置', detail: '添加渠道并保存后即可开启' }
  if (remote.enabled) return remote.running ? { tone: 'ok', value: '运行中', detail: listed } : { tone: 'warn', value: '未运行', detail: listed }
  return { tone: 'off', value: '已关闭', detail: listed }
}

export function rulesSummary(snapshot: Pick<SettingsSnapshot, 'preferences'>): Summary {
  const auto = snapshot.preferences.automation
  const parts = [auto.approvePermissions && '批准权限', auto.answerQuestions && '回答推荐项', auto.blacklist.length && `黑名单 ${auto.blacklist.length} 条`]
    .filter((part): part is string => !!part)
  return { tone: auto.enabled ? 'ok' : 'off', value: auto.enabled ? '已开启' : '已暂停', detail: parts.join(' · ') || '未启用任何规则' }
}
