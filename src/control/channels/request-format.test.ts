import { expect, it } from 'vitest'
import { formatRequest, notification } from '../notification'
import type { ControlSession, InterventionKind, InterventionRequest } from '../types'
import { telegramRequest } from './telegram-format'
import { discordRequest, feishuCard, wecomRequest } from './request-format'

const session: ControlSession = { id: 'claude-project', nativeId: 'native', agent: 'claude', label: 'Cute Island', cwd: 'D:/project', adapter: 'hook', connected: true, capabilities: ['approve', 'answer', 'message'], lastSeenAt: 1 }
const request: InterventionRequest = { id: 'request123', sessionId: session.id, sourceKey: 'source', origin: 'hook', kind: 'approval', title: '确认 Edit',
  detail: JSON.stringify({ file_path: 'src/login.ts', old_string: 'return false', new_string: 'return true' }), questions: [], actions: ['approve', 'deny', 'cancel'], status: 'pending', createdAt: 1, expiresAt: 60000, revision: 1 }
const renderers = [formatRequest, telegramRequest, (r: InterventionRequest, s?: ControlSession) => feishuCard('', r, s),
  (r: InterventionRequest, s?: ControlSession) => JSON.stringify(discordRequest(r, s)), (r: InterventionRequest, s?: ControlSession) => wecomRequest(r, s).join('\n')]

it.each<[InterventionKind, string]>([['approval', '审批请求'], ['plan', '方案确认'], ['input', '需要回答'], ['error', '执行异常'], ['authentication', '需要认证'], ['terminal', '终端提醒']])
('preserves the %s type across native and observation notifications in every channel', (kind, label) => {
  for (const origin of ['hook', 'observation'] as const) for (const render of renderers) {
    const text = render({ ...request, origin, kind, actions: origin === 'observation' ? ['ack'] : request.actions }, session)
    expect(text).toContain(label)
    if (origin === 'observation') {
      expect(text).toContain('待查看')
      expect(text).toContain('仅通知')
      expect(text).not.toContain('/approve')
    }
  }
})

it('shows both sides of an edit, including empty insertion and deletion content', () => {
  for (const [old_string, new_string] of [['', 'return true'], ['return false', '']]) {
    for (const render of renderers) {
      const text = render({ ...request, detail: JSON.stringify({ file_path: 'src/login.ts', old_string, new_string }) }, session)
      for (const value of ['目标文件', 'src/login.ts', '变更前', '变更后', '（空内容）', old_string || new_string]) expect(text).toContain(value)
    }
  }
})

it('renders native file additions, deletions, moves and unified diffs without inventing absent changes', () => {
  const r = { ...request, detail: JSON.stringify({ changes: {
    'src/new.ts': { type: 'add', content: 'new code' }, 'src/old.ts': { type: 'delete', content: 'old code' },
    'src/login.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-return false\n+return true', move_path: 'src/auth.ts' }
  } }) }
  for (const render of renderers) {
    const text = render(r, session)
    for (const value of ['新增', '删除', '修改', '写入内容', '删除内容', '变更对比', 'src/auth.ts', '-return false', '+return true']) expect(text).toContain(value)
  }
  const native = notification({ ...request, detail: JSON.stringify({ threadId: 'internal-thread', itemId: 'file-item', grantRoot: 'D:/project', reason: '需要写入权限' }) }, session)
  expect(native.sections.map(section => section.label)).toEqual(['授权目录', '请求原因'])
})

it('keeps questions, selection modes and explanations readable without repeating protocol payloads', () => {
  const questions = [{ id: 'q1', text: '选择发布平台', options: ['Windows', 'Linux'], descriptions: ['安装包', '便携应用'], multi: true, freeText: true },
    { id: 'q2', text: '填写发布说明', options: [], multi: false, freeText: true }]
  const r = { ...request, kind: 'input' as const, actions: ['answer' as const, 'cancel' as const], questions, detail: JSON.stringify({ threadId: 'hidden-routing-id', questions }) }
  for (const render of renderers) {
    const text = render(r, session)
    for (const value of ['待回答', '选择发布平台', '多选', '安装包', '填写发布说明', '自由回答', '/answer request123']) expect(text).toContain(value)
    expect(text.match(/选择发布平台/g)).toHaveLength(1)
    expect(text).not.toContain('hidden-routing-id')
  }
})

it('redacts all displayed surfaces before truncation and leaves native requests untouched', () => {
  const r = { ...request, title: 'password="hidden-title"', detail: JSON.stringify({ file_path: 'src/login.ts',
    old_string: '-----BEGIN PRIVATE KEY-----\nprivate-content\n-----END PRIVATE KEY-----', new_string: 'api_key="hidden-key"',
    extra: { Authorization: 'Bearer hidden-header' } }), questions: [{ id: 'q1', text: '选择', options: ['password=hidden-option'], descriptions: ['secret="hidden-description"'], multi: false, freeText: true }], actions: ['answer' as const] }
  const s = { ...session, label: 'password="hidden-label"', cwd: 'sk-hidden-directory-123456789' }
  const before = JSON.stringify(r)
  for (const render of renderers) {
    const text = render(r, s)
    for (const secret of ['hidden-title', 'private-content', 'hidden-key', 'hidden-header', 'hidden-option', 'hidden-description', 'hidden-label', 'sk-hidden-directory']) expect(text).not.toContain(secret)
  }
  const answer = notification(r, s).shortcuts.find(s => s.label === '提交回答')!.text
  expect(JSON.parse(answer.slice('/answer request123 '.length))).toEqual({ q1: ['你的回答'] })
  expect(JSON.stringify(r)).toBe(before)
})

it('keeps long and escaped requests within platform limits while reserving details and recovery guidance', () => {
  const r = { ...request, title: '*长标题🧪*'.repeat(200), origin: 'observation' as const, kind: 'error' as const, actions: ['resume' as const, 'ack' as const],
    detail: JSON.stringify({ command: '```🧪**'.repeat(2000), reason: '异常原因'.repeat(1000), edits: Array.from({ length: 20 }, () => ({ old_string: '*'.repeat(2000), new_string: '新内容'.repeat(1000) })) }) }
  const embed = discordRequest(r, session)
  expect(embed.fields.length).toBeLessThanOrEqual(25)
  for (const field of embed.fields) expect(field.value.length).toBeLessThanOrEqual(1024)
  expect(embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0)).toBeLessThanOrEqual(6000)
  for (const page of wecomRequest(r, session)) {
    expect(Buffer.byteLength(page)).toBeLessThanOrEqual(3500)
    expect((page.match(/```/g)?.length ?? 0) % 2).toBe(0)
    expect(Buffer.from(page).toString('utf8')).toBe(page)
  }
  for (const render of renderers) {
    const text = render(r, session)
    expect(text).toContain('/detail request123')
    expect(text).toContain('/resume request123')
    expect(text).toContain('原终端不会同步显示')
    expect(text).toContain('以上为摘要')
  }
})

it('removes Feishu actions once settled while retaining details and accurate result status', () => {
  const pending = JSON.parse(feishuCard('', request, session))
  expect(pending.header.template).toBe('orange')
  expect(pending.elements.find((element: any) => element.tag === 'action').actions.map((action: any) => action.type)).toEqual(['primary', 'danger', 'default'])
  const closed = JSON.parse(feishuCard('', { ...request, status: 'uncertain' }, session))
  expect(closed.header.title.content).toContain('结果待确认')
  expect(closed.elements.some((element: any) => element.tag === 'action')).toBe(false)
  expect(JSON.stringify(closed)).toContain('/detail request123')
})
