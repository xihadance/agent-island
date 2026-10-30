import { STATUS_LABEL, type ControlAction, type ControlSession, type InterventionKind, type InterventionRequest } from './types'

export const KIND_LABEL: Record<InterventionKind, string> = {
  approval: '审批请求', plan: '方案确认', input: '需要回答', error: '执行异常', authentication: '需要认证', terminal: '终端提醒'
}
export const ACTION_LABEL: Record<ControlAction, string> = {
  approve: '批准一次', deny: '拒绝', cancel: '取消', answer: '提交回答', ack: '知道了', resume: '继续会话'
}
const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini' }
const OBSERVATION_SUFFIX = '\n仅通知；此事件没有可用的原生控制请求。'

export interface NotificationSection { label: string; text: string; style: 'text' | 'code' | 'diff' }
export interface Notification {
  heading: string
  status: string
  title: string
  agent: string
  context: { label: string; text: string }[]
  sections: NotificationSection[]
  hint: string
  shortcuts: { label: string; text: string }[]
  truncated: boolean
  tone: 'amber' | 'blue' | 'red' | 'green' | 'grey'
}

export function redact(text: string): string {
  // An Authorization header owns the rest of its line, including spaces and quotes.
  return text.replace(/(\b(?:proxy-)?authorization[\t ]*(?:\\?["'])?[\t ]*[:=][\t ]*)(?:\\"(?:(?!\\").)*\\"|"(?:\\.|[^"\\])*"|'[^']*'|[^\r\n]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{16,}|xox[baprs]-[\w-]+|\d{6,}:[\w-]{25,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?-----END [\w ]*PRIVATE KEY-----/g, '[REDACTED]')
}

export function recoveryHint(r: InterventionRequest, session?: ControlSession): string {
  if (!r.actions.includes('resume')) return ''
  if (r.status !== 'pending' && r.decision?.action !== 'resume') return '已关闭提醒。'
  const status = r.status === 'pending' ? '选择“继续会话”恢复原会话并继续未完成的任务；“知道了”只关闭提醒。'
    : r.status === 'resolved' ? '已确认接收继续指令，不代表任务已完成。'
      : r.status === 'submitted' ? '已提交恢复请求，等待原生确认。'
        : '恢复结果待确认，请检查会话日志；系统不会自动重试。'
  if (session?.agent !== 'claude') return status
  if (session.terminal) return `${status}\n继续指令通过原生 Channels 发送到当前终端；收到 Agent 确认后更新状态。`
  return `${status}\nClaude Code 在后台延续同一会话，原终端不会同步显示。请在灵动岛查看进度；后台执行结束后，可在本机使用 claude --resume ${session.nativeId} 查看会话。`
}

export function clip(text: string, size: number): string {
  if (text.length <= size) return text
  // Keep emoji intact at every platform's display boundary.
  let end = Math.max(0, size - 1)
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--
  return `${text.slice(0, end)}…`
}

export function textChunks(text: string, size: number, bytes = false): string[] {
  const result: string[] = []
  let chunk = '', length = 0
  for (const character of text) {
    const next = bytes ? Buffer.byteLength(character) : character.length
    if (length + next > size) { result.push(chunk); chunk = ''; length = 0 }
    chunk += character; length += next
  }
  if (chunk) result.push(chunk)
  return result
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function display(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''
}

function content(r: InterventionRequest): NotificationSection[] {
  const raw = (r.detail.endsWith(OBSERVATION_SUFFIX) ? r.detail.slice(0, -OBSERVATION_SUFFIX.length) : r.detail).trim()
  if (!raw) return []
  let value: Record<string, unknown> | undefined
  try { value = object(JSON.parse(raw)) } catch { /* Native hooks also send plain commands. */ }
  if (!value) return [{ label: r.kind === 'approval' ? '执行命令' : r.kind === 'plan' ? '执行方案' : '事件详情', text: raw, style: r.kind === 'approval' ? 'code' : 'text' }]
  const args = object(value.tool_input) ?? value
  const sections: NotificationSection[] = []
  const used = new Set<string>()
  const add = (key: string, label: string, style: NotificationSection['style'] = 'text') => {
    if (args[key] === undefined || args[key] === null) return
    used.add(key)
    const text = display(args[key])
    sections.push({ label, text: text || '（空内容）', style })
  }
  add('command', '执行命令', 'code')
  add('file_path', '目标文件', 'code')
  add('path', '目标路径', 'code')
  add('grantRoot', '授权目录', 'code')
  add('reason', '请求原因')
  add('justification', '请求原因')
  add('description', '操作说明')
  add('old_string', '变更前', 'code')
  add('new_string', '变更后', 'code')
  add('content', '写入内容', 'code')
  add('diff', '变更对比', 'diff')
  add('unified_diff', '变更对比', 'diff')
  add('patch', '变更对比', 'diff')
  if (Array.isArray(args.edits)) {
    used.add('edits')
    args.edits.forEach((edit, index) => {
      const item = object(edit)
      if (!item) return
      for (const [key, label] of [['old_string', '变更前'], ['new_string', '变更后']] as const) {
        if (typeof item[key] === 'string') sections.push({ label: `第 ${index + 1} 处 · ${label}`, text: item[key] as string || '（空内容）', style: 'code' })
      }
    })
  }
  if (args.changes && typeof args.changes === 'object') {
    used.add('changes')
    const changes = Array.isArray(args.changes) ? args.changes.map(change => ['', change] as const) : Object.entries(args.changes)
    changes.forEach(([path, change], index) => {
      const item = object(change)
      if (!item) { sections.push({ label: `文件 ${index + 1}`, text: display(change), style: 'code' }); return }
      const kind = typeof item.kind === 'string' ? item.kind : object(item.kind)?.type ?? item.type
      const action = kind === 'add' ? '新增' : kind === 'delete' ? '删除' : kind === 'update' ? '修改' : '变更'
      sections.push({ label: `文件 ${index + 1} · ${action}`, text: display(item.path ?? path), style: 'code' })
      const diff = item.diff ?? item.unified_diff
      if (typeof diff === 'string') sections.push({ label: '变更对比', text: diff || '（空内容）', style: 'diff' })
      if (typeof item.content === 'string') sections.push({ label: kind === 'delete' ? '删除内容' : '写入内容', text: item.content || '（空内容）', style: 'code' })
      if (item.move_path) sections.push({ label: '移动到', text: display(item.move_path), style: 'code' })
      if (diff === undefined && item.content === undefined) sections.push({ label: '变更详情', text: display(item), style: 'code' })
    })
  } else add('changes', '文件变更', 'code')
  add('permissions', '请求权限', 'code')
  add('plan', '执行方案')
  add('message', '事件说明')
  add('error', '异常详情')
  // Routing IDs are already carried by the footer, rather than the decision content.
  for (const key of ['cwd', 'working_directory', 'threadId', 'turnId', 'itemId', 'availableDecisions', 'startedAtMs']) used.add(key)
  if (r.questions.length) for (const key of ['questions', 'requestedSchema', 'requested_schema']) used.add(key)
  const remaining = Object.fromEntries(Object.entries(args).filter(([key]) => !used.has(key)))
  if (Object.keys(remaining).length) sections.push({ label: sections.length ? '其他参数' : '请求详情', text: JSON.stringify(remaining, null, 2), style: 'code' })
  return sections
}

export function notification(r: InterventionRequest, session?: ControlSession): Notification {
  const recovery = r.actions.includes('resume')
  const observation = r.origin === 'observation' && !recovery
  const status = observation && r.status === 'pending' ? '待查看'
    : observation && r.status === 'resolved' ? '已知悉'
      : r.status === 'pending' && r.actions.includes('answer') ? '待回答'
        : r.status === 'pending' && r.actions.includes('approve') ? '待审批' : STATUS_LABEL[r.status]
  const agent = session ? AGENT_LABEL[session.agent] : 'Agent'
  const context: Notification['context'] = []
  if (session && ![agent.toLowerCase(), session.agent].includes(session.label.toLowerCase())) context.push({ label: '会话', text: clip(redact(session.label), 100) })
  let args: Record<string, unknown> | undefined
  try { const value = object(JSON.parse(r.detail)); args = { ...value, ...object(value?.tool_input) } } catch { /* A plain detail has no structured directory. */ }
  const cwd = args?.cwd ?? args?.working_directory ?? session?.cwd
  if (typeof cwd === 'string' && cwd) context.push({ label: '工作目录', text: clip(redact(cwd), 180) })
  context.push({ label: '处理方式', text: observation ? '仅通知' : recovery ? '可恢复原会话' : '原生交互' })
  const time = new Date(r.createdAt)
  if (Number.isFinite(time.getTime())) context.push({ label: '发生时间', text: `${time.getFullYear()}/${String(time.getMonth() + 1).padStart(2, '0')}/${String(time.getDate()).padStart(2, '0')} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}` })
  let truncated = false
  const sections: NotificationSection[] = []
  const append = (full: NotificationSection[], budget: number) => {
    const visible = full.slice(0, 12)
    truncated ||= full.length > visible.length
    // Reserve space for each comparison side and each question before clipping long content.
    const limit = Math.min(700, Math.max(40, Math.floor(budget / Math.max(1, visible.length)) - 30))
    for (const section of visible) {
      const text = redact(section.text)
      sections.push({ ...section, text: clip(text, limit) })
      truncated ||= text.length > limit
    }
  }
  const full = content(r)
  append(full, r.questions.length ? 800 : 1800)
  const questions: NotificationSection[] = r.questions.map((q, index) => ({ label: `问题 ${index + 1} · ${q.multi ? '多选' : q.options.length ? '单选' : '自由回答'}`,
    text: `${q.id} · ${q.text}\n${q.options.map((option, i) => `${i + 1}) ${option}${q.descriptions?.[i] ? ` — ${q.descriptions[i]}` : ''}`).join('\n')}${q.freeText && q.options.length ? '\n也可填写其他回答。' : ''}`, style: 'text' }))
  if (r.decision?.answers) questions.push({ label: '已提交回答', text: r.questions.map(q => `${q.id}：${r.decision!.answers![q.id]?.join('、') ?? ''}`).join('\n'), style: 'text' })
  append(questions, 900)
  const title = clip(redact(r.title), 180)
  let hint = recovery ? recoveryHint(r, session) : observation ? '此事件仅用于提醒，无法在这里批准或回答。请回到原会话处理；“知道了”只关闭提醒。'
    : r.status === 'pending' && r.actions.includes('answer') ? '请按问题逐项回答。可在本地灵动岛回答，或使用下方命令提交；多选与多个问题使用 JSON 答案。'
      : r.status === 'pending' && r.actions.includes('approve') ? '核对命令、路径和变更内容后处理本次请求；“批准一次”仅批准这次操作。'
        : r.status === 'uncertain' ? '请检查原会话确认处理结果，避免重复提交。' : ''
  hint = clip(redact(hint), 750)
  const shortcuts: Notification['shortcuts'] = [{ label: '完整详情', text: `/detail ${r.id}` }]
  if (r.status === 'pending') {
    for (const action of r.actions.filter(a => a !== 'answer')) shortcuts.push({ label: ACTION_LABEL[action], text: `/${action} ${r.id}` })
    if (r.actions.includes('answer')) {
      const example = `/answer ${r.id} ${JSON.stringify(Object.fromEntries(r.questions.map(q => {
        const option = q.options[0]
        return [q.id, [option && redact(option) === option ? option : '你的回答']]
      })) )}`
      shortcuts.push({ label: '提交回答', text: example.length <= 500 ? example : `/answer ${r.id} {"问题ID":["你的回答"]}` })
    }
  }
  if (session?.connected && session.capabilities.includes('message') && r.sessionId.length <= 200) shortcuts.push({ label: '补充指导', text: `/send ${r.sessionId} 内容` })
  const tone = r.status === 'resolved' ? 'green' : ['cancelled', 'expired'].includes(r.status) ? 'grey'
    : r.kind === 'error' ? 'red' : ['approval', 'plan', 'authentication'].includes(r.kind) ? 'amber' : 'blue'
  return { heading: `${KIND_LABEL[r.kind]} · ${status}`, status, title, agent, context, sections, hint, shortcuts: shortcuts.map(s => ({ ...s, text: redact(s.text) })), truncated: truncated || redact(r.title).length > 180, tone }
}

export function formatRequest(r: InterventionRequest, session?: ControlSession): string {
  const n = notification(r, session)
  const label = n.context.find(item => item.label === '会话')?.text
  const title = n.sections.some(section => section.text === n.title) ? '' : n.title
  return [n.heading, `${n.agent}${label ? ` · ${label}` : ''}`, title,
    ...n.context.filter(item => item.label !== '会话').map(item => `${item.label}：${item.text}`), '',
    ...n.sections.flatMap(section => [`【${section.label}】`, section.text, '']), n.truncated ? '以上为摘要，请查看完整内容。' : '',
    n.hint, '', `请求 #${r.id}`, ...n.shortcuts.map(s => `${s.label}：${s.text}`)].filter((line, i, all) => line || all[i - 1]).join('\n')
}
