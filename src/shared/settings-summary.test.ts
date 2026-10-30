import { expect, it } from 'vitest'
import type { Activity } from './activity'
import { normalizePreferences, patchPreferences, type PreferencesPatch, type SettingsSnapshot } from './preferences'
import type { QuestionRequest } from './question-request'
import { agentCapabilities, agentIdOf, agentSummary, liveSessions, pendingRequests, remoteSummary, rulesSummary } from './settings-summary'

const activity = (patch: Partial<Activity> & Pick<Activity, 'id'>): Activity =>
  ({ agent: 'Codex', state: 'running', title: '任务', steps: [], startedAt: 1, updatedAt: 1, ...patch })
const question = (status: QuestionRequest['status']) => ({ id: 'q1', status }) as QuestionRequest

it.each([
  { agent: 'Claude Code', id: 'claude' }, { agent: 'codex', id: 'codex' }, { agent: 'Gemini', id: 'gemini' },
  { agent: ' Cursor ', id: 'cursor' }, { agent: 'Aider', id: undefined }
])('groups $agent as $id', ({ agent, id }) => {
  expect(agentIdOf(agent)).toBe(id)
})

it('lists only recorded requests a person can act on', () => {
  const list = pendingRequests([
    activity({ id: 'approve', state: 'approval', title: '安装依赖', operation: { kind: 'command', command: 'npm install' } }),
    activity({ id: 'ask', agent: 'Claude Code', state: 'waiting', title: '选择环境', questionRequest: question('pending') }),
    activity({ id: 'answered', state: 'waiting', questionRequest: question('resolved') }),
    activity({ id: 'failed', state: 'error', title: '无法写入' }),
    activity({ id: 'quiet', state: 'waiting', title: '等待模型' }),
    activity({ id: 'done', state: 'success', tasks: [{ id: 't', kind: 'agent', label: '子任务', status: 'active', requestKind: 'approval' }] })
  ])
  expect(list).toEqual([
    { id: 'approve', agent: 'Codex', kind: 'approval', title: '安装依赖', detail: 'npm install' },
    { id: 'ask', agent: 'Claude Code', kind: 'input', title: '选择环境', detail: '需要你回答' }
  ])
})

it('puts direct requests before child requests and keeps first-appearance order', () => {
  const child = activity({ id: 'child', startedAt: 1, title: '父会话',
    tasks: [{ id: 't', kind: 'agent', label: 'Newton', status: 'active', requestKind: 'input', detail: '确认范围' }] })
  const later = activity({ id: 'later', state: 'approval', startedAt: 30, title: '第二个' })
  const earlier = activity({ id: 'earlier', state: 'approval', startedAt: 10, title: '第一个' })
  const list = pendingRequests([child, later, earlier])
  expect(list.map(item => item.id)).toEqual(['earlier', 'later', 'child'])
  expect(list[2]).toMatchObject({ kind: 'input', title: '子任务需要回答：Newton', detail: '确认范围' })
})

it('counts only live, fresh sessions per agent', () => {
  expect(liveSessions([
    activity({ id: 'a', agent: 'Claude Code', state: 'running' }), activity({ id: 'b', agent: 'Claude Code', state: 'approval' }),
    activity({ id: 'c', agent: 'Claude Code', state: 'success' }), activity({ id: 'd', agent: 'Codex', state: 'thinking', stale: true }),
    activity({ id: 'e', agent: 'Gemini', state: 'waiting' }), activity({ id: 'f', agent: 'Aider', state: 'running' })
  ])).toEqual({ claude: 2, codex: 0, cursor: 0, gemini: 1 })
})

type Input = Parameters<typeof agentSummary>[1]
const remote = (patch: Partial<SettingsSnapshot['remote']> = {}): SettingsSnapshot['remote'] =>
  ({ configured: true, enabled: false, running: false, configFile: '', revision: '1', channels: [], codex: [], missingCredentials: [], ...patch })
const hooks = (installed: Partial<Record<'claude' | 'cursor' | 'gemini', boolean>> = {}): SettingsSnapshot['remoteHooks'] =>
  ({ claude: { installed: !!installed.claude, file: '' }, cursor: { installed: !!installed.cursor, file: '' }, gemini: { installed: !!installed.gemini, file: '' } })
const input = (patch: PreferencesPatch, rest: Partial<Input> = {}): Input => ({
  preferences: patchPreferences(normalizePreferences(undefined), patch), remote: remote(), remoteHooks: hooks(),
  claudeInstalled: false, codexServer: { status: 'stopped', url: '', detail: '' }, codexStatus: 'disabled', watchDisabledByEnvironment: false, ...rest
})

it.each([
  { name: 'native hook with rules on', state: input({ automation: { enabled: true } }, { claudeInstalled: true }), tone: 'ok', value: '自动审批 · 回答' },
  { name: 'native hook with rules paused', state: input({}, { claudeInstalled: true }), tone: 'off', value: '自动规则已暂停' },
  // Takeover pauses the independent channel, so a native-only install cannot reply.
  { name: 'takeover without remote hook', state: input({ automation: { enabled: true } }, { claudeInstalled: true, remote: remote({ enabled: true }) }), tone: 'warn', value: '需安装远程 Hook' },
  { name: 'takeover with remote hook', state: input({}, { remoteHooks: hooks({ claude: true }), remote: remote({ enabled: true }) }), tone: 'ok', value: '审批 · 回答 · 指令' },
  { name: 'nothing installed', state: input({}), tone: 'off', value: '仅显示状态' },
  { name: 'recognition disabled', state: input({}, { watchDisabledByEnvironment: true }), tone: 'off', value: '会话识别已关闭' }
])('summarizes Claude Code: $name', ({ state, tone, value }) => {
  expect(agentSummary('claude', state)).toMatchObject({ tone, value })
})

it.each([
  { name: 'service stopped', state: input({ codexServer: { enabled: false } }), tone: 'off', value: '仅显示状态' },
  { name: 'service starting', state: input({ codexServer: { enabled: true } }, { codexServer: { status: 'starting', url: '', detail: '' } }), tone: 'off', value: '正在启动' },
  { name: 'service failed', state: input({ codexServer: { enabled: true } }, { codexServer: { status: 'error', url: '', detail: '找不到 codex' } }), tone: 'warn', value: '启动失败' },
  { name: 'running and connected', state: input({ codexServer: { enabled: true }, automation: { enabled: true } },
    { codexServer: { status: 'running', url: 'ws://127.0.0.1:4500', detail: '' }, codexStatus: 'connected' }), tone: 'ok', value: '自动审批 · 回答' },
  { name: 'running with rules paused', state: input({ codexServer: { enabled: true } }, { codexServer: { status: 'running', url: 'ws://127.0.0.1:4500', detail: '' } }), tone: 'off', value: '自动规则已暂停' },
  { name: 'running under takeover', state: input({ codexServer: { enabled: true } },
    { codexServer: { status: 'running', url: 'ws://127.0.0.1:4500', detail: '' }, remote: remote({ enabled: true }) }), tone: 'ok', value: '审批 · 回答 · 指令' },
  { name: 'external server under takeover', state: input({ automation: { codexUrl: 'ws://127.0.0.1:4600' } }, { remote: remote({ enabled: true }) }), tone: 'warn', value: '在远程接管中添加连接' },
  { name: 'saved connection under takeover', state: input({}, { remote: remote({ enabled: true, codex: [{ id: 'other', url: 'ws://127.0.0.1:4700', threads: [] }] }) }), tone: 'ok', value: '审批 · 回答 · 指令' },
  { name: 'external server with rules on', state: input({ automation: { enabled: true, codexUrl: 'ws://127.0.0.1:4600' } }, { codexStatus: 'connected' }), tone: 'ok', value: '自动审批 · 回答' }
])('summarizes Codex: $name', ({ state, tone, value }) => {
  expect(agentSummary('codex', state)).toMatchObject({ tone, value })
})

it('reports the running address without the scheme', () => {
  const state = input({ codexServer: { enabled: true }, automation: { enabled: true } },
    { codexServer: { status: 'running', url: 'ws://127.0.0.1:4500', detail: '' }, codexStatus: 'connected' })
  expect(agentSummary('codex', state).detail).toBe('托管服务运行中 · 127.0.0.1:4500')
})

it.each([
  { id: 'cursor' as const, installed: true, enabled: true, tone: 'ok', value: '执行前确认' },
  { id: 'gemini' as const, installed: true, enabled: true, tone: 'ok', value: 'BeforeTool 确认' },
  { id: 'cursor' as const, installed: true, enabled: false, tone: 'off', value: '远程接管已关闭' },
  { id: 'gemini' as const, installed: false, enabled: true, tone: 'off', value: '仅显示状态' }
])('summarizes $id hook installed=$installed takeover=$enabled', ({ id, installed, enabled, tone, value }) => {
  expect(agentSummary(id, input({}, { remoteHooks: hooks({ [id]: installed }), remote: remote({ enabled }) }))).toMatchObject({ tone, value })
})

it('surfaces a hook error before its install state', () => {
  const remoteHooks = { ...hooks({ cursor: true }), cursor: { installed: true, file: '', error: '无法写入 hooks.json' } }
  expect(agentSummary('cursor', input({}, { remoteHooks }))).toEqual({ tone: 'warn', value: 'Hook 需要检查', detail: '无法写入 hooks.json' })
})

const available = (id: Parameters<typeof agentCapabilities>[0], state: Input) => agentCapabilities(id, state).map(item => item.available)
it('lists what each agent can do now and what would enable the rest', () => {
  expect(available('claude', input({}, { claudeInstalled: true }))).toEqual([true, true, true, false])
  // A native-only install stops replying once takeover pauses the independent channel.
  expect(available('claude', input({}, { claudeInstalled: true, remote: remote({ enabled: true }) }))).toEqual([true, false, false, false])
  expect(agentCapabilities('claude', input({}, { claudeInstalled: true, remote: remote({ enabled: true }) }))[1].detail).toBe('远程接管开启时需安装远程 Hook')
  expect(available('claude', input({}, { remoteHooks: hooks({ claude: true }), remote: remote({ enabled: true }) }))).toEqual([true, true, true, true])
  const running = { codexServer: { status: 'running' as const, url: 'ws://127.0.0.1:4500', detail: '' } }
  expect(available('codex', input({ codexServer: { enabled: true } }, running))).toEqual([true, true, false])
  expect(available('codex', input({ codexServer: { enabled: true } }, { ...running, remote: remote({ enabled: true }) }))).toEqual([true, true, true])
  expect(available('codex', input({}))).toEqual([true, false, false])
  expect(available('cursor', input({}, { remoteHooks: hooks({ cursor: true }) }))).toEqual([true, false, false, false])
  expect(agentCapabilities('cursor', input({}, { remoteHooks: hooks({ cursor: true }) }))[1].detail).toBe('需开启远程接管')
  expect(available('gemini', input({}, { remoteHooks: hooks({ gemini: true }), remote: remote({ enabled: true }) }))).toEqual([true, true, true, false])
  expect(agentCapabilities('gemini', input({}, { watchDisabledByEnvironment: true }))[0]).toEqual({ title: '显示状态和操作', available: false, detail: '启动环境已关闭会话识别' })
})

const channel = (type: 'telegram' | 'feishu') => ({ id: type, type, destination: 'chat', allowedUsers: ['owner'] })
it.each([
  { name: 'missing config', state: remote({ configured: false }), summary: { tone: 'off', value: '未配置' } },
  { name: 'broken config', state: remote({ error: '无法解析 remote.json' }), summary: { tone: 'warn', value: '配置需要检查', detail: '无法解析 remote.json' } },
  { name: 'missing credential', state: remote({ missingCredentials: ['FEISHU_APP_SECRET'] }), summary: { tone: 'warn', value: '缺少凭据', detail: 'FEISHU_APP_SECRET' } },
  { name: 'running', state: remote({ enabled: true, running: true, channels: [channel('telegram'), channel('feishu'), channel('telegram')] }), summary: { tone: 'ok', value: '运行中', detail: 'Telegram、飞书' } },
  { name: 'enabled but stopped', state: remote({ enabled: true }), summary: { tone: 'warn', value: '未运行', detail: '尚未添加渠道' } },
  { name: 'off', state: remote({ channels: [channel('telegram')] }), summary: { tone: 'off', value: '已关闭', detail: 'Telegram' } }
])('summarizes remote takeover: $name', ({ state, summary }) => {
  expect(remoteSummary({ remote: state })).toMatchObject(summary)
})

it('summarizes the enabled rules', () => {
  const preferences = (patch: PreferencesPatch) => ({ preferences: patchPreferences(normalizePreferences(undefined), patch) })
  expect(rulesSummary(preferences({ automation: { enabled: true, blacklist: ['git push', '.env'] } })))
    .toEqual({ tone: 'ok', value: '已开启', detail: '批准权限 · 回答推荐项 · 黑名单 2 条' })
  expect(rulesSummary(preferences({ automation: { approvePermissions: false, answerQuestions: false } })))
    .toEqual({ tone: 'off', value: '已暂停', detail: '未启用任何规则' })
})
